/**
 * Subject Category — addressable subjects with typed multi-field state
 *
 * One category, one Instance type, one Def type. Each registered subject
 * (NPC, faction, region, single entity) holds typed state per schema field:
 * scalar, vector, tier ladder, boolean flag, or named enum. Field kinds are
 * config data — `subject.fields.<name>` access is typed at the callsite, no
 * runtime narrowing.
 *
 * Wraps {@link createCategoryBase}; per-subject persistent context is
 * `{categoryId}/{subjectId}`. Auto-registers into `EngineCategories.subjects`.
 * The five field kinds map to research's substrate shapes (scalar per-entity,
 * tier/rank ladder, multi-dim vector, flags) plus `enum` for nullable
 * single-choice state (commitment locks, path selection). Cross-cutting axes
 * (decay, propagation, layered perma+temp) are intentionally **not** schema
 * fields — compose at the consumer until a primitive earns itself.
 *
 * @cluster subject-category
 */

import { computed } from 'vue';
import { Decimal } from '@/primitives/decimal';
import { isAtDefault, persistent, type Persistent } from '@/core/persistence';
import { createEmitHandle, type Emittable } from '@/core/events';
import type { GameStateAccessor } from '@/primitives/types';
import { evaluateGate, getAmbientGateRuntime, type Gate, type GateRuntime } from './gate';
import { createCategoryBase, type CategoryBase, type CategoryEntrySignals } from './category-base';
import type { ContentRegistry } from './content-registry';
import { Resettable, type ResettableObject } from './resettable';
import { getCurrentEngineCategories } from './engine-categories';

// === TYPES ===

// -- Field defs --

/**
 * Single persistent number per subject. `derive` rewrites reads as a pure
 * projection over the stored inputs (Level13 trust shape: per-input
 * denominators with a `max` combinator sidesteps farmable affinity).
 */
export interface ScalarFieldDef {
  kind: 'scalar';
  initial?: number;
  min?: number;
  max?: number;
  derive?: (input: number) => number;
}

/** N persistent numbers per subject, one per named dimension. */
export interface VectorFieldDef<Dims extends string = string> {
  kind: 'vector';
  dimensions: readonly Dims[];
  dimensionConfig?: Partial<Record<Dims, { initial?: number; min?: number; max?: number }>>;
}

/**
 * Ordered tier ladder with per-transition advancement gates. `gates[from]`
 * must evaluate true (or be absent) to advance from index `from` to `from+1`.
 * Per-subject overrides typically replace `gates` to give each subject its
 * own protocol; the tier list itself is schema-frozen.
 */
export interface TierFieldDef {
  kind: 'tier';
  tiers: readonly string[];
  initial?: number;
  gates?: ReadonlyArray<Gate | undefined>;
}

/** Single persistent boolean per subject. */
export interface FlagFieldDef {
  kind: 'flag';
  initial?: boolean;
}

/**
 * Single nullable enum value per subject. Use for one-of-many state where
 * `null` is the unset/uncommitted reading (path selection before commit,
 * faction allegiance before sign-up).
 */
export interface EnumFieldDef<V extends string = string> {
  kind: 'enum';
  values: readonly V[];
  initial?: V | null;
}

/** Discriminated field def — every schema field is one of these. */
export type FieldDef = ScalarFieldDef | VectorFieldDef | TierFieldDef | FlagFieldDef | EnumFieldDef;

/** A schema describes the shared field shape every registered subject carries. */
export type FieldSchema = Record<string, FieldDef>;

// -- Field instances --

interface ScalarFieldEvents {
  change: (info: { old: number; next: number }) => void;
}

/** Live scalar accessor built from a {@link ScalarFieldDef}. */
export interface ScalarFieldInstance extends Emittable<ScalarFieldEvents> {
  readonly kind: 'scalar';
  readonly ref: Persistent<number>;
  get(): number;
  set(value: number): void;
  add(delta: number): void;
  /** Re-derives via `def.derive` if present, otherwise returns `get()`. */
  read(): number;
}

interface VectorFieldEvents<Dims extends string> {
  change: (info: { dim: Dims; old: number; next: number }) => void;
}

/** Live vector accessor built from a {@link VectorFieldDef}. */
export interface VectorFieldInstance<Dims extends string = string> extends Emittable<
  VectorFieldEvents<Dims>
> {
  readonly kind: 'vector';
  readonly refs: ReadonlyMap<Dims, Persistent<number>>;
  get(dim: Dims): number;
  set(dim: Dims, value: number): void;
  add(dim: Dims, delta: number): void;
}

interface TierFieldEvents {
  /**
   * Fires on any tier-index change via `setIndex` — including regressions
   * (`to < from`), despite the name. Read `from`/`to` to distinguish direction.
   */
  advance: (info: { from: number; to: number }) => void;
}

/** Live tier-ladder accessor built from a {@link TierFieldDef}. */
export interface TierFieldInstance extends Emittable<TierFieldEvents> {
  readonly kind: 'tier';
  readonly ref: Persistent<number>;
  readonly tiers: readonly string[];
  getIndex(): number;
  getTier(): string | undefined;
  /**
   * Try to advance one tier. Evaluates `gates[currentIndex]` against the
   * supplied accessor (or the ambient one) before incrementing. Returns the
   * new tier name, or `null` when blocked / already at max.
   */
  tryAdvance(accessor?: GameStateAccessor): string | null;
  /** Hard set the tier index, bypassing gates. For migrations / reset / cheats. */
  setIndex(index: number): void;
}

interface FlagFieldEvents {
  change: (info: { value: boolean }) => void;
}

/** Live boolean accessor built from a {@link FlagFieldDef}. */
export interface FlagFieldInstance extends Emittable<FlagFieldEvents> {
  readonly kind: 'flag';
  readonly ref: Persistent<boolean>;
  get(): boolean;
  set(value: boolean): void;
  toggle(): void;
}

interface EnumFieldEvents<V extends string> {
  change: (info: { old: V | null; next: V | null }) => void;
}

/** Live nullable-enum accessor built from an {@link EnumFieldDef}. */
export interface EnumFieldInstance<V extends string = string> extends Emittable<
  EnumFieldEvents<V>
> {
  readonly kind: 'enum';
  readonly ref: Persistent<V | null>;
  readonly values: readonly V[];
  get(): V | null;
  set(value: V | null): void;
}

/** Mapped type — produces the right accessor per field kind without runtime narrowing. */
export type FieldInstance<F extends FieldDef> = F extends ScalarFieldDef
  ? ScalarFieldInstance
  : F extends VectorFieldDef<infer Dims>
    ? VectorFieldInstance<Dims>
    : F extends TierFieldDef
      ? TierFieldInstance
      : F extends FlagFieldDef
        ? FlagFieldInstance
        : F extends EnumFieldDef<infer V>
          ? EnumFieldInstance<V>
          : never;

// -- Per-subject override shape --

/**
 * Per-subject overrides — only the obviously-per-subject bits (initial
 * values, tier gates). Structural shape (tiers list, dimensions, min/max)
 * stays schema-frozen so save round-trip is stable across subjects.
 */
export type PerSubjectOverride<F extends FieldDef> = F extends ScalarFieldDef
  ? { initial?: number }
  : F extends VectorFieldDef<infer Dims>
    ? { initialPerDim?: Partial<Record<Dims, number>> }
    : F extends TierFieldDef
      ? { initial?: number; gates?: ReadonlyArray<Gate | undefined> }
      : F extends FlagFieldDef
        ? { initial?: boolean }
        : F extends EnumFieldDef<infer V>
          ? { initial?: V | null }
          : never;

// -- Subject def / instance / category --

/** Authoring shape for one subject in a {@link SubjectCategory}. */
export interface SubjectDef<S extends FieldSchema> {
  id: string;
  /** Per-subject overrides keyed by field name. Omit entirely to use schema defaults. */
  fields?: { [K in keyof S]?: PerSubjectOverride<S[K]> };
}

/** Live subject — typed field accessors keyed by schema field name. */
export interface SubjectInstance<S extends FieldSchema> {
  readonly id: string;
  readonly fields: { [K in keyof S]: FieldInstance<S[K]> };
}

/** One entry inside a {@link SubjectCategory} — authored def + live instance. */
export interface SubjectCategoryEntry<S extends FieldSchema> {
  readonly def: SubjectDef<S>;
  readonly instance: SubjectInstance<S>;
  readonly signals?: CategoryEntrySignals;
}

/** Options for {@link createSubjectCategory}. */
export interface SubjectCategoryOptions<S extends FieldSchema> {
  /** Persistence context name. Each registered subject gets a sub-context `{id}/{subjectId}`. */
  id: string;
  /** Shared field schema applied to every registered subject. */
  fields: S;
  /**
   * Accessor tier gates read through. Falls back to the ambient accessor
   * wired by `createEngine`. The category captures the Gate runtime
   * (accessor + categories + registry) once, at construction, so subjects
   * registered after install advance against it too.
   */
  accessor?: GameStateAccessor;
}

/**
 * Container that registers subjects against a shared schema and builds the
 * matching typed instance for each.
 *
 * @typeParam S - Field schema shape; carries through to typed `fields` access.
 */
export interface SubjectCategory<S extends FieldSchema> extends ResettableObject {
  /** Persistence context id this category was constructed under. */
  readonly id: string;
  /** Shared schema; readable for introspection and tooling. */
  readonly schema: S;
  /**
   * The content registry. `registry.patch()` / `pushPatches()` change the def;
   * an instance sees the change only through a getter that reads `getDef(id)`
   * or `registry.get(id)`, since value fields and closures over `def` are
   * copied or frozen at register. Add defs with `register` — `registry.register()`
   * leaves a def with no instance or state.
   */
  readonly registry: ContentRegistry<SubjectDef<S>>;
  /** Register subjects against the shared schema. Can be called multiple times (base game + mods). */
  register(defs: SubjectDef<S> | SubjectDef<S>[]): void;
  /** Get the authored def for a subject id (delegates to the registry). */
  getDef(id: string): SubjectDef<S> | undefined;
  /** Get the typed live instance for a subject id. Replaces variant-narrowing `getInstance<K>`. */
  get(id: string): SubjectInstance<S> | undefined;
  /** Get the full entry (def + instance) for a subject id. */
  getEntry(id: string): SubjectCategoryEntry<S> | undefined;
  /** All entries in registration order. */
  getAll(): SubjectCategoryEntry<S>[];
  /** Number of registered subjects. */
  readonly size: number;
}

// === PRIVATE BUILDERS ===

function buildScalarField(
  fieldName: string,
  schema: ScalarFieldDef,
  override: PerSubjectOverride<ScalarFieldDef> | undefined,
): ScalarFieldInstance {
  const min = schema.min ?? -Infinity;
  const max = schema.max ?? Infinity;
  const initial = override?.initial ?? schema.initial ?? 0;

  function clamp(v: number): number {
    return Math.min(max, Math.max(min, v));
  }
  // Clamp the authored initial too — set() clamps, but a raw seed would let a
  // field sit outside its declared [min, max] until the first set().
  const ref = persistent<number>(clamp(initial), { name: fieldName });
  const events = createEmitHandle<ScalarFieldEvents>();
  function get(): number {
    return ref.value;
  }
  function set(value: number): void {
    const next = clamp(value);
    const old = ref.value;
    if (next === old) return;
    ref.value = next;
    events.emit('change', { old, next });
  }
  function add(delta: number): void {
    set(get() + delta);
  }
  function read(): number {
    return schema.derive ? schema.derive(get()) : get();
  }

  return { kind: 'scalar', ref, get, set, add, read, on: events.on };
}

function buildVectorField<Dims extends string>(
  fieldName: string,
  schema: VectorFieldDef<Dims>,
  override: PerSubjectOverride<VectorFieldDef<Dims>> | undefined,
): VectorFieldInstance<Dims> {
  if (schema.dimensions.length === 0) {
    throw new Error(`Subject vector field "${fieldName}" must declare at least one dimension`);
  }

  const events = createEmitHandle<VectorFieldEvents<Dims>>();

  function clampForDim(dim: Dims, v: number): number {
    const cfg = schema.dimensionConfig?.[dim];
    const min = cfg?.min ?? -Infinity;
    const max = cfg?.max ?? Infinity;
    return Math.min(max, Math.max(min, v));
  }

  const refs = new Map<Dims, Persistent<number>>();
  for (const dim of schema.dimensions) {
    const cfg = schema.dimensionConfig?.[dim];
    // Clamp the authored initial to the dim's range (set() clamps; a raw seed would not).
    const initial = clampForDim(dim, override?.initialPerDim?.[dim] ?? cfg?.initial ?? 0);
    refs.set(dim, persistent<number>(initial, { name: `${fieldName}/${dim}` }));
  }
  function get(dim: Dims): number {
    return refs.get(dim)?.value ?? schema.dimensionConfig?.[dim]?.initial ?? 0;
  }
  function set(dim: Dims, value: number): void {
    const r = refs.get(dim);
    if (!r) throw new Error(`Unknown dim "${dim}" on vector field "${fieldName}"`);
    const next = clampForDim(dim, value);
    const old = r.value;
    if (next === old) return;
    r.value = next;
    events.emit('change', { dim, old, next });
  }
  function add(dim: Dims, delta: number): void {
    set(dim, get(dim) + delta);
  }

  return { kind: 'vector', refs, get, set, add, on: events.on };
}

function buildTierField(
  fieldName: string,
  schema: TierFieldDef,
  override: PerSubjectOverride<TierFieldDef> | undefined,
  gateRuntime: GateRuntime,
): TierFieldInstance {
  if (schema.tiers.length === 0) {
    throw new Error(`Subject tier field "${fieldName}" must declare at least one tier`);
  }
  const initial = override?.initial ?? schema.initial ?? 0;
  const maxIndex = schema.tiers.length - 1;
  const gates = override?.gates ?? schema.gates;

  function clampIndex(i: number): number {
    return Math.max(0, Math.min(maxIndex, Math.floor(i)));
  }
  // Clamp the authored initial index into [0, maxIndex] (setIndex clamps; a raw
  // seed would let an out-of-range initial produce an undefined getTier()).
  const ref = persistent<number>(clampIndex(initial), { name: fieldName });
  const events = createEmitHandle<TierFieldEvents>();
  function getIndex(): number {
    return ref.value;
  }
  function getTier(): string | undefined {
    return schema.tiers[ref.value];
  }
  function setIndex(index: number): void {
    const next = clampIndex(index);
    const old = ref.value;
    if (next === old) return;
    ref.value = next;
    events.emit('advance', { from: old, to: next });
  }
  function tryAdvance(accessor?: GameStateAccessor): string | null {
    const current = ref.value;
    if (current >= maxIndex) return null;
    const gate = gates?.[current];
    if (gate) {
      const runtime = accessor ? { ...gateRuntime, accessor } : gateRuntime;
      if (!evaluateGate(gate, runtime)) return null;
    }
    setIndex(current + 1);
    return schema.tiers[current + 1] ?? null;
  }

  return {
    kind: 'tier',
    ref,
    tiers: schema.tiers,
    getIndex,
    getTier,
    tryAdvance,
    setIndex,
    on: events.on,
  };
}

function buildFlagField(
  fieldName: string,
  schema: FlagFieldDef,
  override: PerSubjectOverride<FlagFieldDef> | undefined,
): FlagFieldInstance {
  const initial = override?.initial ?? schema.initial ?? false;
  const ref = persistent<boolean>(initial, { name: fieldName });
  const events = createEmitHandle<FlagFieldEvents>();

  function get(): boolean {
    return ref.value;
  }
  function set(value: boolean): void {
    if (ref.value === value) return;
    ref.value = value;
    events.emit('change', { value });
  }
  function toggle(): void {
    set(!ref.value);
  }

  return { kind: 'flag', ref, get, set, toggle, on: events.on };
}

function buildEnumField<V extends string>(
  fieldName: string,
  schema: EnumFieldDef<V>,
  override: PerSubjectOverride<EnumFieldDef<V>> | undefined,
): EnumFieldInstance<V> {
  // `?? ` would swallow an explicit `initial: null` override (PerSubjectOverride
  // types it as `V | null`), so a subject can't start 'unset' against a non-null
  // schema default. Treat only `undefined` as "not overridden".
  const initial = override?.initial !== undefined ? override.initial : (schema.initial ?? null);
  if (initial !== null && !schema.values.includes(initial)) {
    throw new Error(
      `Subject enum field "${fieldName}" initial "${initial}" not in declared values [${schema.values.join(', ')}]`,
    );
  }
  // Store as `string | null` so the generic `V` doesn't need to satisfy
  // StateConstraint structurally — V extends string, so the narrowed
  // Persistent<V | null> surface is sound on read.
  const ref = persistent<string | null>(initial, { name: fieldName }) as Persistent<V | null>;
  const events = createEmitHandle<EnumFieldEvents<V>>();

  function get(): V | null {
    return ref.value;
  }
  function set(value: V | null): void {
    if (value !== null && !schema.values.includes(value)) {
      throw new Error(
        `Subject enum field "${fieldName}" value "${value}" not in declared values [${schema.values.join(', ')}]`,
      );
    }
    const old = ref.value;
    if (value === old) return;
    ref.value = value;
    events.emit('change', { old, next: value });
  }

  return { kind: 'enum', ref, values: schema.values, get, set, on: events.on };
}

function buildField(
  fieldName: string,
  schema: FieldDef,
  override: unknown,
  gateRuntime: GateRuntime,
): FieldInstance<FieldDef> {
  switch (schema.kind) {
    case 'scalar':
      return buildScalarField(
        fieldName,
        schema,
        override as PerSubjectOverride<ScalarFieldDef> | undefined,
      );
    case 'vector':
      return buildVectorField(
        fieldName,
        schema,
        override as PerSubjectOverride<VectorFieldDef> | undefined,
      );
    case 'tier':
      return buildTierField(
        fieldName,
        schema,
        override as PerSubjectOverride<TierFieldDef> | undefined,
        gateRuntime,
      );
    case 'flag':
      return buildFlagField(
        fieldName,
        schema,
        override as PerSubjectOverride<FlagFieldDef> | undefined,
      );
    case 'enum':
      return buildEnumField(
        fieldName,
        schema,
        override as PerSubjectOverride<EnumFieldDef> | undefined,
      );
  }
}

// === FACTORIES ===

/**
 * Create a subject category. Registers subjects against a shared field
 * schema and builds typed live instances per subject.
 *
 * Replaces the variant-dispatched relationship surface. Each subject carries
 * the schema's fields under its own persistent context (`{id}/{subjectId}`);
 * `subject.fields.<name>` access is typed at the callsite from the inferred
 * schema, no runtime narrowing needed.
 *
 * @param options - Category id (persistence context root) + shared field schema.
 * @returns A {@link SubjectCategory} with `register` / `get` / `getEntry` / `getAll`.
 *
 * @example
 * ```ts
 * // Many subjects, one tier field per subject (molcremental shape)
 * const npcs = createSubjectCategory({
 *   id: 'npc-trust',
 *   fields: { trust: { kind: 'tier', tiers: ['stranger', 'friend', 'confidant'] } },
 * });
 *
 * npcs.register({
 *   id: 'mentor-rask',
 *   fields: { trust: { gates: [
 *     { kind: 'flag', id: 'knowledge-rask-approach' },
 *     { kind: 'flag', id: 'knowledge-rask-competence' },
 *   ] } },
 * });
 *
 * const rask = npcs.get('mentor-rask')!;
 * rask.fields.trust.tryAdvance();          // typed; no narrowing
 * ```
 *
 * @example
 * ```ts
 * // One subject, many fields (maldacena shape)
 * const entity = createSubjectCategory({
 *   id: 'entity',
 *   fields: {
 *     trust:         { kind: 'scalar', min: 0, max: 100 },
 *     pathTendency:  { kind: 'vector', dimensions: ['scientific', 'cooperative'] },
 *     discovered:    { kind: 'flag' },
 *     pathLocked:    { kind: 'enum', values: ['scientific', 'cooperative'] },
 *   },
 * });
 *
 * entity.register({ id: 'the-entity' });
 *
 * const e = entity.get('the-entity')!;
 * e.fields.trust.add(0.05);
 * e.fields.pathTendency.add('cooperative', 1);
 * e.fields.pathLocked.set('scientific');
 * ```
 */
export function createSubjectCategory<S extends FieldSchema>(
  options: SubjectCategoryOptions<S>,
): SubjectCategory<S> {
  const { id: categoryId, fields: schema, accessor } = options;
  // Captured here, not per register: subjects registered after install (late
  // content, mods) never see the ambient scope. `tryAdvance(accessor)` still
  // layers a per-call override on top.
  const gateRuntime = getAmbientGateRuntime(accessor ? { accessor } : undefined);

  const base: CategoryBase<SubjectDef<S>, SubjectInstance<S>, void> = createCategoryBase<
    SubjectDef<S>,
    SubjectInstance<S>,
    void
  >({
    id: categoryId,
    buildInstance: (def) => {
      const fields = {} as { [K in keyof S]: FieldInstance<S[K]> };
      for (const fieldName of Object.keys(schema) as (keyof S & string)[]) {
        const fieldSchema = schema[fieldName];
        const override = def.fields?.[fieldName];
        fields[fieldName] = buildField(
          fieldName,
          fieldSchema,
          override,
          gateRuntime,
        ) as FieldInstance<S[typeof fieldName]>;
      }
      return { id: def.id, fields };
    },
    buildSignals: (_def, instance) => buildSubjectSignals(instance),
  });

  const category: SubjectCategory<S> = {
    id: base.id,
    schema,
    registry: base.registry,
    register: base.register,
    getDef: base.getDef,
    get(id) {
      return base.getEntry(id)?.instance;
    },
    getEntry(id) {
      const e = base.getEntry(id);
      return e ? { def: e.def, instance: e.instance, signals: e.signals } : undefined;
    },
    getAll() {
      return base.getAll().map((e) => ({ def: e.def, instance: e.instance, signals: e.signals }));
    },
    get size() {
      return base.size;
    },
    [Resettable]: base[Resettable],
  };

  const ec = getCurrentEngineCategories();
  if (ec) (ec.subjects ??= []).push(category);

  return category;
}

// === PUBLIC UTILITIES ===

/**
 * Default Signals projection for a subject instance — `unlock = any non-default
 * field value`, `count = number of fields with non-default state`. Coarse by
 * design; "unlock" doesn't map cleanly onto a multi-field subject the way it
 * does for purchasables (active) or achievements (earned). Consumers needing
 * different semantics can layer their own ComputedRefs in the consumer module.
 */
function buildSubjectSignals<S extends FieldSchema>(
  instance: SubjectInstance<S>,
): CategoryEntrySignals {
  const fields = Object.values(instance.fields) as FieldInstance<FieldDef>[];

  // "Default" is the value the field was seeded with — the ref's default, which
  // already resolves the per-subject override and the clamp.
  function isNonDefault(field: FieldInstance<FieldDef>): boolean {
    return field.kind === 'vector'
      ? [...field.refs.values()].some((ref) => !isAtDefault(ref))
      : !isAtDefault(field.ref as Persistent);
  }

  return {
    unlock: computed(() => fields.some(isNonDefault)),
    count: computed(() => Decimal.fromValue(fields.filter(isNonDefault).length)),
  };
}
