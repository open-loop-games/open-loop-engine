/**
 * Subject Category — addressable subjects with typed multi-field state
 *
 * One category, one Instance type, one Def type. Each registered subject
 * (NPC, faction, region, a singleton subject) holds typed state per schema
 * field: scalar, vector, ladder, flag, or named enum. Field kinds are plain
 * data: `subject.fields.<name>` access is typed at the call site, with no
 * narrowing at run time.
 *
 * Wraps {@link createCategoryBase}; each subject's persistent context is
 * `{categoryId}/{subjectId}`. Auto-registers into `EngineCategories.subjects`.
 * Four field kinds are a scalar per subject, a ladder, a multi-dimension
 * vector and flags. The fifth, `enum`, holds nullable single-choice state
 * (commitment locks, path selection). Cross-cutting axes (decay, propagation, layered
 * lifetime and temporary values) are intentionally **not** schema fields.
 * Compose them in the consumer until a primitive qualifies.
 *
 * @cluster subject-category
 */

import { computed } from 'vue';
import { Decimal } from '@/primitives/decimal';
import {
  isAtDefault,
  onHydrated,
  persistent,
  resetPersistent,
  type Persistent,
} from '@/core/persistence';
import { createEmitHandle, type Emittable } from '@/core/events';
import type { GameStateAccessor } from '@/primitives/types';
import {
  createPredicateResolver,
  evaluateGate,
  type Predicate,
  type PredicateResolver,
} from './gate';
import { createCategoryBase, type CategoryBase, type CategoryEntrySignals } from './category-base';
import type { ContentRegistryView } from './content-registry';
import { Resettable, type ResettableObject } from '@/core/resettable';
import { getCurrentEngineCategories } from './engine-categories';

// === TYPES ===

// -- Field defs --

/**
 * Single persistent number per subject. `derive` is a pure function from the
 * stored value to what `read()` returns. One example is a trust shape with
 * per-input denominators combined by `max`, so affinity can't be farmed.
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
  dimensionOptions?: Partial<Record<Dims, { initial?: number; min?: number; max?: number }>>;
}

/**
 * Ordered ladder with a predicate per step between rungs. `advanceWhen[from]`
 * must hold (or be absent) to advance from rung `from` to `from+1`.
 * Per-subject overrides typically replace `advanceWhen`, so each subject has
 * its own protocol; the rung list itself is fixed by the schema.
 */
export interface LadderFieldDef {
  kind: 'ladder';
  rungs: readonly string[];
  initial?: number;
  advanceWhen?: ReadonlyArray<Predicate | undefined>;
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
export type FieldDef =
  | ScalarFieldDef
  | VectorFieldDef
  | LadderFieldDef
  | FlagFieldDef
  | EnumFieldDef;

/** A schema describes the shared field shape every registered subject has. */
export type FieldSchema = Record<string, FieldDef>;

// -- Field instances --

interface ScalarFieldEvents {
  changed: (info: { old: number; next: number }) => void;
}

/** Live scalar field built from a {@link ScalarFieldDef}. */
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
  changed: (info: { dim: Dims; old: number; next: number }) => void;
}

/** Live vector field built from a {@link VectorFieldDef}. */
export interface VectorFieldInstance<Dims extends string = string> extends Emittable<
  VectorFieldEvents<Dims>
> {
  readonly kind: 'vector';
  readonly refs: ReadonlyMap<Dims, Persistent<number>>;
  get(dim: Dims): number;
  set(dim: Dims, value: number): void;
  add(dim: Dims, delta: number): void;
}

interface LadderFieldEvents {
  /**
   * Emitted on any rung index change through `setIndex` (and so `tryAdvance`),
   * including regressions (`to < from`), despite the name. Read `from`/`to`
   * for the direction.
   */
  advanced: (info: { from: number; to: number }) => void;
}

/** Live ladder field built from a {@link LadderFieldDef}. */
export interface LadderFieldInstance extends Emittable<LadderFieldEvents> {
  readonly kind: 'ladder';
  readonly ref: Persistent<number>;
  readonly rungs: readonly string[];
  getIndex(): number;
  getRung(): string | undefined;
  /**
   * Try to advance one rung. Evaluates `advanceWhen[currentIndex]` before
   * incrementing. Returns the new rung, or `null` when blocked or already at
   * the last rung.
   *
   * @param accessor - used instead of the category's accessor when the
   *   predicate is a Gate; a getter or ref reads its own state and ignores
   *   it. The Gate's services are still asserted against the category's
   *   Gate services at register.
   */
  tryAdvance(accessor?: GameStateAccessor): string | null;
  /** Set the rung index directly, without `advanceWhen`. For save migrations, resets and cheats. */
  setIndex(index: number): void;
}

interface FlagFieldEvents {
  changed: (info: { value: boolean }) => void;
}

/** Live flag field built from a {@link FlagFieldDef}. */
export interface FlagFieldInstance extends Emittable<FlagFieldEvents> {
  readonly kind: 'flag';
  readonly ref: Persistent<boolean>;
  get(): boolean;
  set(value: boolean): void;
  toggle(): void;
}

interface EnumFieldEvents<V extends string> {
  changed: (info: { old: V | null; next: V | null }) => void;
}

/** Live nullable-enum field built from an {@link EnumFieldDef}. */
export interface EnumFieldInstance<V extends string = string> extends Emittable<
  EnumFieldEvents<V>
> {
  readonly kind: 'enum';
  readonly ref: Persistent<V | null>;
  readonly values: readonly V[];
  get(): V | null;
  set(value: V | null): void;
}

/** Conditional type — the right field instance per field kind, with no narrowing at run time. */
export type FieldInstance<F extends FieldDef> = F extends ScalarFieldDef
  ? ScalarFieldInstance
  : F extends VectorFieldDef<infer Dims>
    ? VectorFieldInstance<Dims>
    : F extends LadderFieldDef
      ? LadderFieldInstance
      : F extends FlagFieldDef
        ? FlagFieldInstance
        : F extends EnumFieldDef<infer V>
          ? EnumFieldInstance<V>
          : never;

// -- Per-subject override shape --

/**
 * Per-subject overrides — only the obviously-per-subject bits (initial
 * values, a ladder's `advanceWhen`). Structural shape (rungs, dimensions,
 * min/max) stays fixed by the schema, so every subject has the same save shape.
 */
export type PerSubjectOverride<F extends FieldDef> = F extends ScalarFieldDef
  ? { initial?: number }
  : F extends VectorFieldDef<infer Dims>
    ? { initialPerDim?: Partial<Record<Dims, number>> }
    : F extends LadderFieldDef
      ? { initial?: number; advanceWhen?: ReadonlyArray<Predicate | undefined> }
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

/** Live subject — typed fields keyed by schema field name. */
export interface Subject<S extends FieldSchema> {
  readonly id: string;
  readonly fields: { [K in keyof S]: FieldInstance<S[K]> };
}

/** One category entry of a {@link SubjectCategory} — authored def, subject and signals. */
export interface SubjectCategoryEntry<S extends FieldSchema> {
  readonly def: SubjectDef<S>;
  readonly subject: Subject<S>;
  readonly signals?: CategoryEntrySignals;
}

/** Options for {@link createSubjectCategory}. */
export interface SubjectCategoryOptions<S extends FieldSchema> {
  /** Persistent context id. Each subject gets a child persistent context `{id}/{subjectId}`. */
  id: string;
  /** Shared field schema applied to every registered subject. */
  fields: S;
  /**
   * Accessor that ladder Gates read. Defaults to the ambient accessor
   * `createEngine` wires. The category captures its Gate services (accessor,
   * categories, resource registry) once, at construction. So subjects
   * registered after install advance against them too.
   */
  accessor?: GameStateAccessor;
}

/**
 * Container that registers subjects against a shared schema and builds the
 * matching typed instance for each.
 *
 * @typeParam S - Field schema shape; it types `fields` access.
 */
export interface SubjectCategory<S extends FieldSchema> extends ResettableObject {
  /** Persistent context id this category was created under. */
  readonly id: string;
  /** Shared schema; readable for introspection and tooling. */
  readonly schema: S;
  /**
   * The content registry (see {@link ContentRegistryView} for what a patch
   * reaches). Add defs with the category's `register`, which builds each
   * def's instance.
   */
  readonly registry: ContentRegistryView<SubjectDef<S>>;
  /** Register subjects against the shared schema. Can be called multiple times (base content, then later content). */
  register(defs: SubjectDef<S> | readonly SubjectDef<S>[]): void;
  /** Get the authored def for a subject id (delegates to the registry). */
  getDef(id: string): SubjectDef<S> | undefined;
  /** Get the subject for an id. */
  getSubject(id: string): Subject<S> | undefined;
  /** Get the category entry (def, subject, signals) for a subject id. */
  getEntry(id: string): SubjectCategoryEntry<S> | undefined;
  /** All entries in registration order. */
  getAll(): SubjectCategoryEntry<S>[];
  /** Number of registered subjects. */
  readonly size: number;
}

// === PRIVATE BUILDERS ===

function clampScalar(schema: ScalarFieldDef, v: number): number {
  return Math.min(schema.max ?? Infinity, Math.max(schema.min ?? -Infinity, v));
}

function clampVectorDim(schema: VectorFieldDef, dim: string, v: number): number {
  const cfg = schema.dimensionOptions?.[dim];
  return Math.min(cfg?.max ?? Infinity, Math.max(cfg?.min ?? -Infinity, v));
}

function clampRungIndex(schema: LadderFieldDef, i: number): number {
  return Math.max(0, Math.min(schema.rungs.length - 1, Math.floor(i)));
}

function buildScalarField(
  fieldName: string,
  schema: ScalarFieldDef,
  override: PerSubjectOverride<ScalarFieldDef> | undefined,
): ScalarFieldInstance {
  const initial = override?.initial ?? schema.initial ?? 0;
  const clamp = (v: number): number => clampScalar(schema, v);
  // Clamp the authored initial too — set() clamps, but a raw seed would let a
  // field sit outside its declared [min, max] until the first set().
  const ref = persistent<number>(clamp(initial), { id: fieldName });
  const events = createEmitHandle<ScalarFieldEvents>();
  function get(): number {
    return ref.value;
  }
  function set(value: number): void {
    const next = clamp(value);
    const old = ref.value;
    if (next === old) return;
    ref.value = next;
    events.emit('changed', { old, next });
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

  const clampForDim = (dim: Dims, v: number): number => clampVectorDim(schema, dim, v);

  const refs = new Map<Dims, Persistent<number>>();
  for (const dim of schema.dimensions) {
    const cfg = schema.dimensionOptions?.[dim];
    // Clamp the authored initial to the dim's range (set() clamps; a raw seed would not).
    const initial = clampForDim(dim, override?.initialPerDim?.[dim] ?? cfg?.initial ?? 0);
    refs.set(dim, persistent<number>(initial, { id: `${fieldName}/${dim}` }));
  }
  function get(dim: Dims): number {
    return refs.get(dim)?.value ?? schema.dimensionOptions?.[dim]?.initial ?? 0;
  }
  function set(dim: Dims, value: number): void {
    const r = refs.get(dim);
    if (!r) throw new Error(`Unknown dim "${dim}" on vector field "${fieldName}"`);
    const next = clampForDim(dim, value);
    const old = r.value;
    if (next === old) return;
    r.value = next;
    events.emit('changed', { dim, old, next });
  }
  function add(dim: Dims, delta: number): void {
    set(dim, get(dim) + delta);
  }

  return { kind: 'vector', refs, get, set, add, on: events.on };
}

function buildLadderField(
  fieldName: string,
  schema: LadderFieldDef,
  override: PerSubjectOverride<LadderFieldDef> | undefined,
  predicates: PredicateResolver,
  subjectId: string,
): LadderFieldInstance {
  if (schema.rungs.length === 0) {
    throw new Error(`Subject ladder field "${fieldName}" must declare at least one rung`);
  }
  const initial = override?.initial ?? schema.initial ?? 0;
  const maxIndex = schema.rungs.length - 1;
  const gates = (override?.advanceWhen ?? schema.advanceWhen)?.map((gate, i) =>
    gate === undefined
      ? undefined
      : predicates.adopt(
          gate,
          true,
          `subject '${subjectId}' ladder '${fieldName}' advanceWhen[${i}]`,
        ),
  );

  const clampIndex = (i: number): number => clampRungIndex(schema, i);
  // Clamp the authored initial index into [0, maxIndex] (setIndex clamps; a raw
  // seed would let an out-of-range initial produce an undefined getRung()).
  const ref = persistent<number>(clampIndex(initial), { id: fieldName });
  const events = createEmitHandle<LadderFieldEvents>();
  function getIndex(): number {
    return ref.value;
  }
  function getRung(): string | undefined {
    return schema.rungs[ref.value];
  }
  function setIndex(index: number): void {
    const next = clampIndex(index);
    const old = ref.value;
    if (next === old) return;
    ref.value = next;
    events.emit('advanced', { from: old, to: next });
  }
  function tryAdvance(accessor?: GameStateAccessor): string | null {
    const current = ref.value;
    if (current >= maxIndex) return null;
    const gate = gates?.[current];
    if (gate) {
      const holds =
        accessor && gate.gate
          ? evaluateGate(gate.gate, { ...predicates.services, accessor })
          : gate.read();
      if (!holds) return null;
    }
    setIndex(current + 1);
    return schema.rungs[current + 1] ?? null;
  }

  return {
    kind: 'ladder',
    ref,
    rungs: schema.rungs,
    getIndex,
    getRung,
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
  const ref = persistent<boolean>(initial, { id: fieldName });
  const events = createEmitHandle<FlagFieldEvents>();

  function get(): boolean {
    return ref.value;
  }
  function set(value: boolean): void {
    if (ref.value === value) return;
    ref.value = value;
    events.emit('changed', { value });
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
  // SerializableConstraint structurally — V extends string, so the narrowed
  // Persistent<V | null> surface is sound on read.
  const ref = persistent<string | null>(initial, { id: fieldName }) as Persistent<V | null>;
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
    events.emit('changed', { old, next: value });
  }

  return { kind: 'enum', ref, values: schema.values, get, set, on: events.on };
}

function buildField(
  fieldName: string,
  schema: FieldDef,
  override: unknown,
  predicates: PredicateResolver,
  subjectId: string,
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
    case 'ladder':
      return buildLadderField(
        fieldName,
        schema,
        override as PerSubjectOverride<LadderFieldDef> | undefined,
        predicates,
        subjectId,
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

/**
 * Bring a field's value back inside its schema: clamp numbers, and reset an
 * enum value the schema no longer declares to its seed. Writes the ref, not
 * `set()`, so no event is emitted, and Vue skips a write that changes nothing.
 */
function normalizeField(field: FieldInstance<FieldDef>, schema: FieldDef): void {
  switch (schema.kind) {
    case 'scalar': {
      const ref = (field as ScalarFieldInstance).ref;
      ref.value = clampScalar(schema, ref.value);
      return;
    }
    case 'vector':
      for (const [dim, ref] of (field as VectorFieldInstance).refs) {
        ref.value = clampVectorDim(schema, dim, ref.value);
      }
      return;
    case 'ladder': {
      const ref = (field as LadderFieldInstance).ref;
      ref.value = clampRungIndex(schema, ref.value);
      return;
    }
    case 'enum': {
      const ref = (field as EnumFieldInstance).ref;
      if (ref.value !== null && !schema.values.includes(ref.value)) resetPersistent(ref);
      return;
    }
    case 'flag':
      return;
  }
}

// === FACTORIES ===

/**
 * Create a subject category. Registers subjects against a shared field
 * schema and builds typed live instances per subject.
 *
 * Each subject has the schema's fields under its own persistent context
 * (`{id}/{subjectId}`). `subject.fields.<name>` access is typed at the call
 * site from the inferred schema, with no narrowing.
 *
 * @param options - Category id (the root persistent context), the shared
 *   field schema, and an optional accessor.
 * @returns A {@link SubjectCategory} with `register` / `get` / `getEntry` / `getAll`.
 *
 * @example
 * ```ts
 * // Many subjects, one ladder field each
 * const npcs = createSubjectCategory({
 *   id: 'npc-trust',
 *   fields: { trust: { kind: 'ladder', rungs: ['stranger', 'friend', 'confidant'] } },
 * });
 *
 * npcs.register({
 *   id: 'mentor-rask',
 *   fields: { trust: { advanceWhen: [
 *     { kind: 'flag', id: 'knowledge-rask-approach' },
 *     { kind: 'flag', id: 'knowledge-rask-competence' },
 *   ] } },
 * });
 *
 * const rask = npcs.getSubject('mentor-rask')!;
 * rask.fields.trust.tryAdvance();          // typed; no narrowing
 * ```
 *
 * @example
 * ```ts
 * // One subject, many fields
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
 * const e = entity.getSubject('the-entity')!;
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
  // content) never see the ambient values. `tryAdvance(accessor)` still
  // layers a per-call accessor on top.
  const predicates = createPredicateResolver({ accessor });

  const base: CategoryBase<SubjectDef<S>, Subject<S>, void> = createCategoryBase<
    SubjectDef<S>,
    Subject<S>,
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
          predicates,
          def.id,
        ) as FieldInstance<S[typeof fieldName]>;
      }
      return { id: def.id, fields };
    },
    buildSignals: (_def, subject) => buildSubjectSignals(subject),
  });

  // A load writes field refs directly, past set()'s clamp and enum check,
  // and the schema may have narrowed since that save was written.
  onHydrated(() => {
    for (const { instance } of base.getAll()) {
      for (const fieldName of Object.keys(schema)) {
        normalizeField(instance.fields[fieldName], schema[fieldName]);
      }
    }
  });

  const category: SubjectCategory<S> = {
    id: base.id,
    schema,
    registry: base.registry,
    register: base.register,
    getDef: base.getDef,
    getSubject(id) {
      return base.getEntry(id)?.instance;
    },
    getEntry(id) {
      const e = base.getEntry(id);
      return e ? { def: e.def, subject: e.instance, signals: e.signals } : undefined;
    },
    getAll() {
      return base.getAll().map((e) => ({ def: e.def, subject: e.instance, signals: e.signals }));
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
 * Default signals for a subject — `active = any field off its ref
 * default`, `count = number of fields off their ref default`. Coarse by
 * design: "active" doesn't map cleanly onto a multi-field subject the way it
 * does for purchasables and achievements. Consumers needing different
 * semantics can layer their own ComputedRefs in the consumer module.
 */
function buildSubjectSignals<S extends FieldSchema>(subject: Subject<S>): CategoryEntrySignals {
  const fields = Object.values(subject.fields) as FieldInstance<FieldDef>[];

  // "Default" is the value the field was seeded with — the ref's default, which
  // already resolves the per-subject override and the clamp.
  function isNonDefault(field: FieldInstance<FieldDef>): boolean {
    return field.kind === 'vector'
      ? [...field.refs.values()].some((ref) => !isAtDefault(ref))
      : !isAtDefault(field.ref as Persistent);
  }

  return {
    active: computed(() => fields.some(isNonDefault)),
    count: computed(() => Decimal.fromValue(fields.filter(isNonDefault).length)),
  };
}
