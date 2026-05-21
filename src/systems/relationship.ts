/**
 * Relationship system — variant shapes and category dispatch
 *
 * Five typed relationship shapes (scalar / tiered / vector / faction / flag)
 * registered through {@link createRelationshipCategory}, which dispatches
 * per-def by `kind`. The raw `createRelationship` factory underneath is
 * engine-internal.
 *
 * Don't mix shapes within an owner class. If guilds are tier-ladders and
 * NPCs are multi-dim vectors, register them as two separate defs (each with
 * its own kind) — not as two dimensions on one def.
 */

import { persistent, type Persistent } from '@/core/persistence';
import { createEmitHandle, type Emittable } from '@/core/events';
import { evaluateCondition } from '@/core/conditions';
import { getCurrentGameStateAccessor } from '@/core/game-state-accessor';
import type { GameStateAccessor } from '@/primitives/types';
import type {
  RelationshipDef,
  ScalarRelationshipDef,
  TieredRelationshipDef,
  VectorRelationshipDef,
  FactionRelationshipDef,
  FlagRelationshipDef,
} from '@/primitives/relationship';
import { createCategoryBase } from './category-base';
import type { ContentRegistry } from './content-registry';
import { Resettable, type ResettableObject } from './resettable';

// === TYPES ===

/**
 * Shared fields present on every relationship variant. Structural backbone
 * for the per-variant interfaces below; consumers reach instances through
 * {@link RelationshipInstance} (the union) and narrow via
 * {@link RelationshipCategory.getInstance}.
 *
 * @internal
 */
export interface RelationshipBase<
  TKind extends RelationshipInstance['kind'],
  TDef extends RelationshipDef,
> {
  readonly kind: TKind;
  readonly id: string;
  readonly def: TDef;
}

// -- Scalar --

interface ScalarRelationshipEvents {
  change: (info: { actor: string; old: number; next: number }) => void;
}

/**
 * Scalar relationship instance — one persistent number per actor with optional
 * clamping and an optional `derive` projection. Built when `def.kind === 'scalar'`.
 *
 * @internal Reach through {@link RelationshipCategory.getInstance}`<'scalar'>`;
 *   type locally as `ReturnType<typeof cat.getInstance<'scalar'>>`.
 */
export interface ScalarRelationship
  extends RelationshipBase<'scalar', ScalarRelationshipDef>, Emittable<ScalarRelationshipEvents> {
  /** Per-actor persistent refs — exposed for `reset.keep()` / `retain()` selectivity. */
  readonly refs: ReadonlyMap<string, Persistent<number>>;
  get(actor: string): number;
  set(actor: string, value: number): void;
  add(actor: string, delta: number): void;
  /** Re-derives via `def.derive` if present, otherwise returns `get(actor)`. */
  read(actor: string): number;
}

// -- Tiered --

interface TieredRelationshipEvents {
  advance: (info: { actor: string; from: number; to: number }) => void;
}

/**
 * Tiered relationship instance — per-actor discrete tier index 0..N-1 with
 * per-transition advancement gates. Built when `def.kind === 'tiered'`.
 *
 * @internal Reach through {@link RelationshipCategory.getInstance}`<'tiered'>`;
 *   type locally as `ReturnType<typeof cat.getInstance<'tiered'>>`.
 */
export interface TieredRelationship
  extends RelationshipBase<'tiered', TieredRelationshipDef>, Emittable<TieredRelationshipEvents> {
  /** Per-actor persistent refs holding the tier index. */
  readonly refs: ReadonlyMap<string, Persistent<number>>;
  /** Numeric tier index (0..tiers.length-1). Defaults to 0 if actor unknown. */
  getIndex(actor: string): number;
  /** Tier name string at the actor's current index. */
  getTier(actor: string): string | undefined;
  /**
   * Try to advance one tier. Evaluates `def.gates[currentIndex]` against the
   * supplied accessor (or the ambient one) before incrementing. Returns the
   * new tier name, or `null` when blocked / already at max.
   */
  tryAdvance(actor: string, accessor?: GameStateAccessor): string | null;
  /** Hard set the tier index, bypassing gates. For migrations / reset / cheats. */
  setIndex(actor: string, index: number): void;
}

// -- Vector --

interface VectorRelationshipEvents {
  change: (info: { actor: string; dim: string; old: number; next: number }) => void;
}

/**
 * Vector relationship instance — N independent scalar dimensions per actor,
 * each with its own bounds and policy. Built when `def.kind === 'vector'`.
 *
 * @internal Reach through {@link RelationshipCategory.getInstance}`<'vector'>`;
 *   type locally as `ReturnType<typeof cat.getInstance<'vector'>>`.
 */
export interface VectorRelationship
  extends RelationshipBase<'vector', VectorRelationshipDef>, Emittable<VectorRelationshipEvents> {
  /** Per-actor map of per-dim persistent refs. */
  readonly refs: ReadonlyMap<string, ReadonlyMap<string, Persistent<number>>>;
  get(actor: string, dim: string): number;
  set(actor: string, dim: string, value: number): void;
  add(actor: string, dim: string, delta: number): void;
}

// -- Faction --

interface FactionRelationshipEvents {
  change: (info: { faction: string; old: number; next: number }) => void;
}

/**
 * Faction relationship instance — one persistent scalar per faction, with
 * attitude-matrix propagation via `applyTo`. Built when `def.kind === 'faction'`.
 *
 * @internal Reach through {@link RelationshipCategory.getInstance}`<'faction'>`;
 *   type locally as `ReturnType<typeof cat.getInstance<'faction'>>`.
 */
export interface FactionRelationship
  extends
    RelationshipBase<'faction', FactionRelationshipDef>,
    Emittable<FactionRelationshipEvents> {
  /** Per-faction persistent refs. */
  readonly refs: ReadonlyMap<string, Persistent<number>>;
  get(faction: string): number;
  set(faction: string, value: number): void;
  /**
   * Apply a delta to a faction with attitude propagation. For each other
   * faction with `|attitude[from][other]| >= weightFloor`, adds
   * `delta * attitude[from][other]` (clamped to [min, max]). The acting
   * faction itself receives the delta via the diagonal default of 1.
   */
  applyTo(faction: string, delta: number): void;
}

// -- Flag --

interface FlagRelationshipEvents {
  change: (info: { actor: string; flag: string; value: boolean }) => void;
}

/**
 * Flag relationship instance — per-actor named booleans encoding scripted
 * social events. Built when `def.kind === 'flag'`.
 *
 * @internal Reach through {@link RelationshipCategory.getInstance}`<'flag'>`;
 *   type locally as `ReturnType<typeof cat.getInstance<'flag'>>`.
 */
export interface FlagRelationship
  extends RelationshipBase<'flag', FlagRelationshipDef>, Emittable<FlagRelationshipEvents> {
  /** Per-actor map of per-flag persistent refs. */
  readonly refs: ReadonlyMap<string, ReadonlyMap<string, Persistent<boolean>>>;
  get(actor: string, flag: string): boolean;
  set(actor: string, flag: string, value: boolean): void;
}

// -- Union --

/** Discriminated runtime instance — one variant per registered def. */
export type RelationshipInstance =
  | ScalarRelationship
  | TieredRelationship
  | VectorRelationship
  | FactionRelationship
  | FlagRelationship;

// -- Category --

/** Options for {@link createRelationshipCategory}. */
export interface RelationshipCategoryOptions {
  /** Persistence context name. Each def gets a sub-context `{id}/{def.id}`. */
  id: string;
}

/**
 * One entry inside a {@link RelationshipCategory} — the authored def paired
 * with the live {@link RelationshipInstance} dispatched from it.
 */
export interface RelationshipCategoryEntry<Def extends RelationshipDef> {
  readonly def: Def;
  readonly instance: RelationshipInstance;
}

/**
 * Container that registers a heterogeneous mix of relationship defs (scalar /
 * vector / tiered / faction / flag) and builds the matching live instance
 * for each by dispatching on `def.kind`.
 */
export interface RelationshipCategory<Def extends RelationshipDef> extends ResettableObject {
  readonly registry: ContentRegistry<Def>;
  register(defs: Def | Def[]): void;
  getDef(id: string): Def | undefined;
  getEntry(id: string): RelationshipCategoryEntry<Def> | undefined;
  getAll(): RelationshipCategoryEntry<Def>[];
  /**
   * Type-narrowed instance lookup. Pass the discriminator literal as the K
   * type parameter to narrow the return type to the matching variant:
   *
   * ```ts
   * const trust = rel.getInstance<'tiered'>('mentor-rask');
   * trust?.tryAdvance('mentor-rask');  // typed as TieredRelationship.tryAdvance
   * ```
   */
  getInstance<K extends RelationshipInstance['kind'] = RelationshipInstance['kind']>(
    id: string,
  ): Extract<RelationshipInstance, { kind: K }> | undefined;
  readonly size: number;
}

// === PRIVATE BUILDERS ===

function buildScalar(def: ScalarRelationshipDef): ScalarRelationship {
  const min = def.min ?? -Infinity;
  const max = def.max ?? Infinity;
  const initial = def.initial ?? 0;

  const refs = new Map<string, Persistent<number>>();
  for (const actor of def.actors) {
    refs.set(actor, persistent<number>(initial, { name: actor }));
  }

  const events = createEmitHandle<ScalarRelationshipEvents>();

  function clamp(value: number): number {
    return Math.min(max, Math.max(min, value));
  }

  function get(actor: string): number {
    const r = refs.get(actor);
    return r ? r.value : initial;
  }

  function set(actor: string, value: number): void {
    const r = refs.get(actor);
    if (!r) throw new Error(`Unknown actor "${actor}" on scalar relationship "${def.id}"`);
    const next = clamp(value);
    const old = r.value;
    if (next === old) return;
    r.value = next;
    events.emit('change', { actor, old, next });
  }

  function add(actor: string, delta: number): void {
    set(actor, get(actor) + delta);
  }

  function read(actor: string): number {
    if (!def.derive) return get(actor);
    const inputs: Record<string, number> = {};
    for (const [a, r] of refs) inputs[a] = r.value;
    return def.derive(inputs);
  }

  return {
    kind: 'scalar',
    id: def.id,
    def,
    refs,
    get,
    set,
    add,
    read,
    on: events.on,
  };
}

function buildTiered(def: TieredRelationshipDef): TieredRelationship {
  if (def.tiers.length === 0) {
    throw new Error(`Tiered relationship "${def.id}" must have at least one tier`);
  }
  const initial = def.initial ?? 0;
  const maxIndex = def.tiers.length - 1;

  const refs = new Map<string, Persistent<number>>();
  for (const actor of def.actors) {
    refs.set(actor, persistent<number>(initial, { name: actor }));
  }

  const events = createEmitHandle<TieredRelationshipEvents>();

  function clampIndex(i: number): number {
    return Math.max(0, Math.min(maxIndex, Math.floor(i)));
  }

  function getIndex(actor: string): number {
    const r = refs.get(actor);
    return r ? r.value : initial;
  }

  function getTier(actor: string): string | undefined {
    return def.tiers[getIndex(actor)];
  }

  function setIndex(actor: string, index: number): void {
    const r = refs.get(actor);
    if (!r) throw new Error(`Unknown actor "${actor}" on tiered relationship "${def.id}"`);
    const next = clampIndex(index);
    const old = r.value;
    if (next === old) return;
    r.value = next;
    events.emit('advance', { actor, from: old, to: next });
  }

  function tryAdvance(actor: string, accessor?: GameStateAccessor): string | null {
    const r = refs.get(actor);
    if (!r) throw new Error(`Unknown actor "${actor}" on tiered relationship "${def.id}"`);
    const current = r.value;
    if (current >= maxIndex) return null;
    const gate = def.gates?.[current];
    if (gate) {
      const eff = accessor ?? getCurrentGameStateAccessor();
      if (!eff) {
        throw new Error(
          `Tiered relationship "${def.id}" has gates but no accessor — pass one to tryAdvance() or wire ambient accessor`,
        );
      }
      if (!evaluateCondition(gate, eff)) return null;
    }
    setIndex(actor, current + 1);
    return def.tiers[current + 1] ?? null;
  }

  return {
    kind: 'tiered',
    id: def.id,
    def,
    refs,
    getIndex,
    getTier,
    tryAdvance,
    setIndex,
    on: events.on,
  };
}

function buildVector(def: VectorRelationshipDef): VectorRelationship {
  if (def.dimensions.length === 0) {
    throw new Error(`Vector relationship "${def.id}" must have at least one dimension`);
  }

  const refs = new Map<string, Map<string, Persistent<number>>>();
  for (const actor of def.actors) {
    const dimMap = new Map<string, Persistent<number>>();
    for (const dim of def.dimensions) {
      const cfg = def.dimensionConfig?.[dim];
      const initial = cfg?.initial ?? 0;
      // Persistent name combines actor and dim — flat namespace within the
      // category's per-def persistent context.
      dimMap.set(dim, persistent<number>(initial, { name: `${actor}/${dim}` }));
    }
    refs.set(actor, dimMap);
  }

  const events = createEmitHandle<VectorRelationshipEvents>();

  function clampForDim(dim: string, value: number): number {
    const cfg = def.dimensionConfig?.[dim];
    const min = cfg?.min ?? -Infinity;
    const max = cfg?.max ?? Infinity;
    return Math.min(max, Math.max(min, value));
  }

  function get(actor: string, dim: string): number {
    const r = refs.get(actor)?.get(dim);
    return r ? r.value : (def.dimensionConfig?.[dim]?.initial ?? 0);
  }

  function set(actor: string, dim: string, value: number): void {
    const r = refs.get(actor)?.get(dim);
    if (!r) {
      throw new Error(`Unknown actor/dim "${actor}/${dim}" on vector relationship "${def.id}"`);
    }
    const next = clampForDim(dim, value);
    const old = r.value;
    if (next === old) return;
    r.value = next;
    events.emit('change', { actor, dim, old, next });
  }

  function add(actor: string, dim: string, delta: number): void {
    set(actor, dim, get(actor, dim) + delta);
  }

  return {
    kind: 'vector',
    id: def.id,
    def,
    refs,
    get,
    set,
    add,
    on: events.on,
  };
}

function buildFaction(def: FactionRelationshipDef): FactionRelationship {
  const min = def.min ?? -Infinity;
  const max = def.max ?? Infinity;
  const initial = def.initial ?? 0;
  const weightFloor = def.weightFloor ?? 0.05;

  const refs = new Map<string, Persistent<number>>();
  for (const faction of def.factions) {
    refs.set(faction, persistent<number>(initial, { name: faction }));
  }

  const events = createEmitHandle<FactionRelationshipEvents>();

  function clamp(value: number): number {
    return Math.min(max, Math.max(min, value));
  }

  function get(faction: string): number {
    const r = refs.get(faction);
    return r ? r.value : initial;
  }

  function set(faction: string, value: number): void {
    const r = refs.get(faction);
    if (!r) throw new Error(`Unknown faction "${faction}" on faction relationship "${def.id}"`);
    const next = clamp(value);
    const old = r.value;
    if (next === old) return;
    r.value = next;
    events.emit('change', { faction, old, next });
  }

  function attitudeWeight(from: string, to: string): number {
    const explicit = def.attitude?.[from]?.[to];
    if (explicit !== undefined) return explicit;
    return from === to ? 1 : 0;
  }

  function applyTo(faction: string, delta: number): void {
    for (const other of def.factions) {
      const w = attitudeWeight(faction, other);
      if (Math.abs(w) < weightFloor) continue;
      const r = refs.get(other);
      if (!r) continue;
      const next = clamp(r.value + delta * w);
      if (next === r.value) continue;
      const old = r.value;
      r.value = next;
      events.emit('change', { faction: other, old, next });
    }
  }

  return {
    kind: 'faction',
    id: def.id,
    def,
    refs,
    get,
    set,
    applyTo,
    on: events.on,
  };
}

function buildFlag(def: FlagRelationshipDef): FlagRelationship {
  const refs = new Map<string, Map<string, Persistent<boolean>>>();
  for (const actor of def.actors) {
    const flagMap = new Map<string, Persistent<boolean>>();
    for (const flag of def.flags) {
      flagMap.set(flag, persistent<boolean>(false, { name: `${actor}/${flag}` }));
    }
    refs.set(actor, flagMap);
  }

  const events = createEmitHandle<FlagRelationshipEvents>();

  function get(actor: string, flag: string): boolean {
    return refs.get(actor)?.get(flag)?.value ?? false;
  }

  function set(actor: string, flag: string, value: boolean): void {
    const r = refs.get(actor)?.get(flag);
    if (!r) {
      throw new Error(`Unknown actor/flag "${actor}/${flag}" on flag relationship "${def.id}"`);
    }
    if (r.value === value) return;
    r.value = value;
    events.emit('change', { actor, flag, value });
  }

  return {
    kind: 'flag',
    id: def.id,
    def,
    refs,
    get,
    set,
    on: events.on,
  };
}

// === FACTORIES ===

/**
 * Engine-internal raw relationship factory dispatching by `def.kind` to the
 * matching variant builder. Consumers reach this through
 * {@link createRelationshipCategory}, which opens the per-def persistent
 * context and dispatches automatically.
 *
 * @internal
 */
export function createRelationship(def: ScalarRelationshipDef): ScalarRelationship;
export function createRelationship(def: TieredRelationshipDef): TieredRelationship;
export function createRelationship(def: VectorRelationshipDef): VectorRelationship;
export function createRelationship(def: FactionRelationshipDef): FactionRelationship;
export function createRelationship(def: FlagRelationshipDef): FlagRelationship;
export function createRelationship(def: RelationshipDef): RelationshipInstance;
export function createRelationship(def: RelationshipDef): RelationshipInstance {
  switch (def.kind) {
    case 'scalar':
      return buildScalar(def);
    case 'tiered':
      return buildTiered(def);
    case 'vector':
      return buildVector(def);
    case 'faction':
      return buildFaction(def);
    case 'flag':
      return buildFlag(def);
  }
}

/**
 * Create a relationship category that dispatches per-def to one of the five
 * variant shapes by `def.kind`.
 *
 * @param options - Persistence-context id; per-def sub-context is `{id}/{def.id}`.
 * @returns A {@link RelationshipCategory} with `register` / `getDef` /
 *   `getEntry` / `getAll` / `getInstance<K>()` (type-narrowed by `kind`).
 *
 * @example
 * ```ts
 * const rel = createRelationshipCategory<TieredRelationshipDef>({ id: 'npc-trust' });
 *
 * rel.register({
 *   id: 'mentor-rask',
 *   kind: 'tiered',
 *   actors: ['mentor-rask'],
 *   tiers: ['stranger', 'acquaintance', 'student', 'trusted'],
 *   gates: [
 *     C.unlock('knowledge-rask-approach'),
 *     C.unlock('knowledge-rask-competence'),
 *     C.unlock('knowledge-rask-task'),
 *   ],
 * });
 *
 * const trust = rel.getInstance<'tiered'>('mentor-rask');
 * trust?.tryAdvance('mentor-rask');
 * ```
 */
export function createRelationshipCategory<Def extends RelationshipDef = RelationshipDef>(
  options: RelationshipCategoryOptions,
): RelationshipCategory<Def> {
  const base = createCategoryBase<Def, RelationshipInstance, void>({
    id: options.id,
    buildInstance: (def) => createRelationship(def),
  });

  return {
    registry: base.registry,
    register: base.register,
    getDef: base.getDef,
    getEntry(id) {
      const e = base.getEntry(id);
      return e ? { def: e.def, instance: e.instance } : undefined;
    },
    getAll() {
      return base.getAll().map((e) => ({ def: e.def, instance: e.instance }));
    },
    getInstance<K extends RelationshipInstance['kind'] = RelationshipInstance['kind']>(
      id: string,
    ): Extract<RelationshipInstance, { kind: K }> | undefined {
      return base.getEntry(id)?.instance as Extract<RelationshipInstance, { kind: K }> | undefined;
    },
    get size() {
      return base.size;
    },

    [Resettable]: base[Resettable],
  };
}
