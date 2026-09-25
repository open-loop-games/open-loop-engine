/**
 * Save validation — runtime Zod layer over the persistent-ref registry
 *
 * Auto-derives a Zod schema for every persistent ref from its
 * {@link DefaultValue} and validates raw save data before deserialize. Catches
 * the "I renamed / added / retyped a field mid-dev-cycle" class of save
 * corruption without requiring consumers to hand-write schemas.
 *
 * Architecture vs. Synergism (the inspiration):
 * Synergism hand-writes a ~1000-line `playerSchema` and runs both validation
 * and migration through it. That works because they have no persistent-ref
 * registry. Open Loop Engine has {@link getAllPersistentRefs} + stable named
 * keys, so the registry *is* the schema — we derive ~1000 LOC worth
 * of schema at runtime from the default values the engine already tracks.
 * Migrations stay in the existing `migrations` hook; validation runs once,
 * after the full migration chain.
 *
 * Policy: field-level failures always emit `save:validation-error`. In
 * non-strict mode, the failing leaf is dropped from the raw data and
 * `deserializePersistents` falls back to the ref's default (self-heal). In
 * strict mode, validation failure aborts the load and bubbles up as
 * `save:load-failed` with `reason: 'validation'`.
 *
 * @cluster save
 */

import { z, type ZodType, type ZodIssue } from 'zod';
import { Decimal, type DecimalSource } from '@/primitives/decimal';
import {
  DefaultValue,
  PersistentDecimal,
  PersistentSchema,
  SaveDataPath,
  type Persistent,
} from './persistence';

/**
 * Zod adapter that accepts any value constructable as a `Decimal`, including
 * `string`, `number`, and `Decimal` instances. Does not transform — the
 * engine's existing ref setter accepts `DecimalSource` and the serialize path
 * already encodes Decimals as strings.
 */
// break_eternity's `new Decimal(s)` silently coerces garbage strings to 0
// instead of throwing, so we can't rely on construction alone. Require the
// input to *look* numeric first: either a finite-ish leading character set
// (digit, sign, decimal point, or `(` for hyper-e notation), after the run of
// `e`s that `Decimal.toString` writes from layer 2 up (`ee20`, `-ee-15.9`), or
// one of the special literals serializePersistents emits for non-finite numbers.
const DECIMAL_LITERAL = /^[-+]?(Infinity|NaN)$/;
const DECIMAL_NUMERIC = /^[-+]?e*[-+]?[\d.(]/;

/**
 * Zod schema that accepts the three concrete {@link DecimalSource} shapes a
 * save can hold: a live `Decimal` instance, a finite `number`, or a numeric
 * string (including the `"Infinity"` / `"NaN"` literals
 * `serializePersistents` emits). Stricter than `z.unknown()` so `break_eternity`'s
 * silent garbage-to-zero coercion can't slip past validation.
 */
export const decimalSchema: ZodType<DecimalSource> = z.custom<DecimalSource>((value) => {
  if (value instanceof Decimal) return true;
  if (typeof value === 'number') return true;
  if (typeof value !== 'string') return false;
  if (!DECIMAL_LITERAL.test(value) && !DECIMAL_NUMERIC.test(value)) return false;
  try {
    new Decimal(value);
    return true;
  } catch {
    return false;
  }
});

/** A single field-level validation failure, suitable for `save:validation-error`. */
export interface ValidationIssue {
  path: string;
  expected: string;
  received: unknown;
  action: 'self-heal' | 'fail';
}

/**
 * Derive a Zod schema from a ref's default value and options. Recurses into
 * plain nested objects and arrays. Primitive defaults map to lenient schemas:
 * numeric defaults accept `number | string` so DecimalSource and
 * non-finite-encoded strings (`"Infinity"`, `"NaN"`) both pass.
 *
 * Every derived schema except the Decimal one accepts `null`: a default says
 * what kind a value has, not whether the ref's type admits null, and JSON only
 * writes `null` where the game stored one. Rejecting it would reset a
 * legitimately-unset field on load. A Decimal ref holding `null` is not a
 * `DecimalSource`, so it stays rejected — pass an explicit `schema` for that.
 */
export function deriveSchema(defaultValue: unknown, decimal = false): ZodType {
  if (decimal || defaultValue instanceof Decimal) {
    return decimalSchema;
  }
  return deriveKindSchema(defaultValue).nullable();
}

function deriveKindSchema(defaultValue: unknown): ZodType {
  if (defaultValue === null || defaultValue === undefined) {
    return z.unknown();
  }
  switch (typeof defaultValue) {
    case 'number':
      // Lenient: covers DecimalSource (string|number) and string-encoded
      // non-finite numbers that serializePersistents writes for Infinity/NaN.
      return z.union([z.number(), z.string()]);
    case 'string':
      return z.string();
    case 'boolean':
      return z.boolean();
    case 'object': {
      if (Array.isArray(defaultValue)) {
        return z.array(deriveElementSchema(defaultValue));
      }
      const shape: Record<string, ZodType> = {};
      for (const [k, v] of Object.entries(defaultValue as Record<string, unknown>)) {
        shape[k] = deriveSchema(v);
      }
      // Partial so consumers can add new sub-fields without invalidating
      // old saves — missing sub-fields self-heal via deserialize's fallback.
      return z.object(shape).partial();
    }
    default:
      return z.unknown();
  }
}

/** Element schema for an array default: the one kind its non-null elements share, else unknown. */
function deriveElementSchema(elements: unknown[]): ZodType {
  const present = elements.filter((el) => el !== null && el !== undefined);
  if (present.length === 0) return z.unknown();
  const kind = (el: unknown): string =>
    el instanceof Decimal ? 'decimal' : Array.isArray(el) ? 'array' : typeof el;
  const first = kind(present[0]);
  if (present.some((el) => kind(el) !== first)) return z.unknown();
  return deriveSchema(present[0]);
}

/** Get the effective schema for a persistent ref — explicit override wins, else auto-derive. */
export function getSchemaForRef(ref: Persistent): ZodType {
  const explicit = ref[PersistentSchema];
  if (explicit !== undefined && explicit !== null) {
    return explicit as ZodType;
  }
  return deriveSchema(ref[DefaultValue], ref[PersistentDecimal]);
}

/** Human-readable label for a Zod issue, for `save:validation-error.expected`. */
function describeIssue(issue: ZodIssue): string {
  if (issue.code === 'invalid_type') {
    return String(issue.expected);
  }
  return issue.code;
}

function navigateNested(data: Record<string, unknown>, parts: string[]): unknown {
  let current: unknown = data;
  for (const part of parts) {
    if (current == null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function deleteNested(data: Record<string, unknown>, parts: string[]): void {
  let current: Record<string, unknown> = data;
  for (let i = 0; i < parts.length - 1; i++) {
    const next = current[parts[i]];
    if (next == null || typeof next !== 'object') return;
    current = next as Record<string, unknown>;
  }
  delete current[parts[parts.length - 1]];
}

/**
 * Options for {@link validateSaveData}. `strict` toggles fail-on-first-issue
 * vs self-heal-and-continue; `onIssue` observes each field-level problem the
 * validator finds along the way.
 */
export interface ValidateSaveDataOptions {
  strict: boolean;
  /** Called for each field-level issue. */
  onIssue?: (issue: ValidationIssue) => void;
}

/** Result of {@link validateSaveData}. */
export interface ValidateSaveDataResult {
  /** `true` when every ref's leaf validated, or every failure was self-healed. */
  ok: boolean;
  /** The (possibly healed) data object. In non-strict mode, failing leaves are deleted. */
  data: Record<string, unknown>;
  /** All field-level issues encountered (both healed and fatal). */
  issues: ValidationIssue[];
}

/**
 * Validate raw save data against the live persistent-ref registry.
 *
 * Runs per-ref: navigates each ref's `SaveDataPath` into the data object,
 * runs `schema.safeParse` on the leaf, and in non-strict mode deletes the
 * leaf on failure (letting `deserializePersistents` fall back to the ref's
 * default). In strict mode, the first failure sets `ok: false` but the loop
 * continues so every issue is reported in one pass.
 */
export function validateSaveData(
  refs: Map<string, Persistent>,
  data: Record<string, unknown>,
  options: ValidateSaveDataOptions,
): ValidateSaveDataResult {
  const { strict, onIssue } = options;
  const issues: ValidationIssue[] = [];
  let ok = true;

  for (const [path, ref] of refs) {
    const parts = ref[SaveDataPath] ?? path.split('.');
    const leaf = navigateNested(data, parts);
    // Missing leaves are not a validation error — deserialize will reset the
    // ref to its default, which is exactly the "new persistent in v1.5" case.
    if (leaf === undefined) continue;

    const schema = getSchemaForRef(ref);
    const result = schema.safeParse(leaf);
    if (result.success) continue;

    for (const zIssue of result.error.issues) {
      const issue: ValidationIssue = {
        path,
        expected: describeIssue(zIssue),
        received: leaf,
        action: strict ? 'fail' : 'self-heal',
      };
      issues.push(issue);
      onIssue?.(issue);
    }

    if (strict) {
      ok = false;
    } else {
      deleteNested(data, parts);
    }
  }

  return { ok, data, issues };
}
