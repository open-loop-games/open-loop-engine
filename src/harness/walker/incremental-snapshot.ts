/**
 * Caching overlay on {@link createTransitionSnapshot} for the event-driven probe.
 *
 * Stores the last-built `TransitionSnapshot` plus per-label `TransitionDeps`
 * and reverse indices keyed by resource / rate / unlock / state id. Consumers
 * signal state changes via `invalidateResource` / `invalidateRate` /
 * `invalidateFlag` / `invalidateState` / `invalidateAll`; the next
 * `rebuild()` honors those signals and re-emits only the affected entries.
 *
 * Two things decide a leaf's output for one entity. The entity's own gating
 * state (a purchasable's level and limit, a challenge's `active` flag and
 * completions, ...) decides *which* transitions it emits; the accessor slots
 * in each emission's `TransitionDeps` decide their distances. The cache keeps
 * a registry of every walkable entity, independent of what it currently
 * emits, with a small gate signature per entity read straight off the
 * instance.
 *
 * Rebuild paths:
 *
 * - `dirty.all` (or no walkable entity at all) → **full rebuild**: walk every
 *   category entity via `forEachCategoryEntry`, re-populate the entity
 *   registry, entries and reverse indices. This is the escape hatch for
 *   entity-set changes and the fallback when targeted invalidation isn't
 *   possible.
 * - Otherwise → **selective rebuild**: an entity is dirty when `dirty.*`
 *   reaches one of its entries through the reverse indices, or when its gate
 *   signature moved since the last rebuild. Each dirty entity's entries are
 *   dropped and re-emitted through its per-entity emitter, then re-sorted.
 *
 * Invariants:
 *
 * - **Entity set fixed at the last full walk.** A selective rebuild re-reads
 *   every registered entity's gate signature but does not re-walk the
 *   category registries. Consumers that register new categories or new
 *   entities mid-run must call `invalidateAll()` to force a full re-walk on
 *   the next rebuild. This is load-bearing for the sample-diff wiring in
 *   `run-until-helpers/event-mode.ts`, which cannot observe entity
 *   registration through accessor reads.
 * - **Gating state needs no invalidation; dep slots do.** An entity whose
 *   emissions went empty (maxed, inactive) stays registered and comes back
 *   when its signature moves — a reset, an automation policy entering a
 *   challenge.
 * - **An emission with empty deps is re-emitted only when its signature
 *   moves.** No `invalidate*` call reaches an opaque predicate (closure goal,
 *   category-aware Gate), and none needs to: see {@link ReadSignature}.
 * - `rebuild()` returns a fresh `TransitionSnapshot` object per call. Callers
 *   must not memoize on identity; use deep-equal on `.all` / group arrays.
 * - `accessor` is wrapped with a fresh {@link memoizeAccessor} per rebuild,
 *   mirroring {@link createTransitionSnapshot}. Duplicate reads within one
 *   rebuild collapse; reads across rebuilds do not.
 */

import { unref } from 'vue';
import { Decimal } from '@/primitives/decimal';
import { CategoriesKey, type EngineCategories } from '@/systems/engine-categories';
import type { Engine } from '@/engine';
import type { GameStateAccessor } from '@/primitives/types';
import type { TransitionDeps } from '@/core/transitions';
import type { Purchasable } from '@/systems/purchasable';
import type { Producer } from '@/systems/producer-category';
import type { Challenge, ChallengeDef } from '@/systems/challenge-category';
import { forEachGateLeaf } from '@/core/gate';
import { evaluateGate, getBoundGateServices, isGate } from '@/systems/gate';
import type { Transition, TransitionWalker } from './types';
import type { TransitionSnapshot } from './index';
import { compareTransitions } from './compare-transitions';
import { memoizeAccessor } from './memoize-accessor';
import { emitChallengeTransitionsForEntity } from './walk-challenge-transitions';
import { emitPurchasableTransitionsForEntity } from './walk-purchasable-transitions';
import { emitProducerTransitionsForEntity } from './walk-producer-transitions';
import { profile } from '@/core/profiler';
import { forEachCategoryEntry } from '../walk';

/**
 * Caching overlay on the transition-walker snapshot. Built once, rebuilt on
 * demand via {@link rebuild}.
 */
export interface IncrementalSnapshot {
  /** Most recent rebuild output. Initially the constructor's full walk. */
  readonly snapshot: TransitionSnapshot;
  /**
   * Resource ids that, if mutated, would require re-emission of at least one
   * cached entry. Live iterable — contents shift with each rebuild.
   * Consumers diffing engine state should read every id in this iterable:
   * its balance, and its lifetime total where it has one.
   */
  readonly trackedResources: Iterable<string>;
  /**
   * Rate-axis analogue of {@link trackedResources}: read the net rate, and
   * the inflow rate where the accessor serves one.
   */
  readonly trackedRates: Iterable<string>;
  /** Unlock-axis analogue of {@link trackedResources}. */
  readonly trackedFlags: Iterable<string>;
  /** State-path analogue of {@link trackedResources}. */
  readonly trackedStates: Iterable<string>;
  /** Signal that the named resource id has changed. */
  invalidateResource(id: string): void;
  /** Signal that the named rate-producing resource's rate has changed. */
  invalidateRate(id: string): void;
  /** Signal that the named unlock flag has flipped. */
  invalidateFlag(id: string): void;
  /** Signal that the named state path has been written. */
  invalidateState(path: string): void;
  /**
   * Coarse invalidation — force a full re-walk of every registered entity
   * on the next `rebuild()`. Required after entity-set mutations (registry
   * patches, new categories provided) and after long periods where the
   * caller cannot reliably track which keys changed (e.g. fast-tick stasis).
   */
  invalidateAll(): void;
  /** Produce a fresh {@link TransitionSnapshot} honoring current dirty state. */
  rebuild(): TransitionSnapshot;
}

interface CacheEntry {
  transition: Transition;
  deps: TransitionDeps;
  record: EntityRecord;
}

type PerEntityEmit = (
  categoryId: string,
  entity: unknown,
  accessor: GameStateAccessor,
) => { transition: Transition; deps: TransitionDeps }[];

/**
 * Refresh `gate` in place from the entity's live gating state; true when any
 * slot moved. Reads what the matching leaf's emission guards, cost lookup,
 * `currentValue` and distance read off the instance rather than through the
 * accessor. An emission reads nothing beyond these slots and its deps, which
 * is what lets the selective rebuild skip it until one moves; a leaf whose
 * emission reads other live state must add that state to its signature.
 */
type ReadSignature = (entity: unknown, gate: unknown[]) => boolean;

interface CategoryWalk {
  emit: PerEntityEmit;
  readSignature: ReadSignature;
}

/** A walkable entity, registered whether or not it currently emits. */
interface EntityRecord {
  categoryId: string;
  entity: unknown;
  walk: CategoryWalk;
  signature: unknown[];
  labels: Set<string>;
}

/**
 * Store `value` in `gate[i]` if it differs from what's there; true when it
 * did. Decimals are compared by value and stored as copies, so an in-place
 * mutation can't alias the stored slot.
 */
function updateSlot(gate: unknown[], i: number, value: unknown): boolean {
  const prev = gate[i];
  if (prev === value) return false;
  if (prev instanceof Decimal && value instanceof Decimal) {
    if (prev.eq(value)) return false;
  }
  gate[i] = value instanceof Decimal ? new Decimal(value) : value;
  return true;
}

function readPurchasableGate(purchasable: Purchasable | undefined, gate: unknown[]): boolean {
  // `maxed` and the `amount === limit - 1` cap check are functions of these two.
  let moved = updateSlot(gate, 0, purchasable?.count.value);
  moved = updateSlot(gate, 1, purchasable && unref(purchasable.limit)) || moved;
  return moved;
}

const CATEGORY_WALKS: Partial<Record<keyof EngineCategories, CategoryWalk>> = {
  challenges: {
    emit: emitChallengeTransitionsForEntity,
    readSignature(entity, gate) {
      const { def, challenge } = entity as { def: ChallengeDef; challenge: Challenge };
      let moved = updateSlot(gate, 0, challenge.entered.value);
      moved = updateSlot(gate, 1, challenge.completions.value) || moved;
      moved = updateSlot(gate, 2, challenge.visible.value) || moved;
      moved = updateSlot(gate, 3, challenge.canEnter.value) || moved;
      moved = updateSlot(gate, 4, challenge.canComplete.value) || moved;
      // A category leaf moves with no dep slot moving, and inside a combinator
      // that doesn't flip, its truth still picks which children carry the
      // gate's distance.
      const runtime = getBoundGateServices(challenge);
      if (!runtime) return moved;
      let slot = 5;
      for (const field of [def.visible, def.canEnter, def.goal]) {
        if (!isGate(field)) continue;
        forEachGateLeaf(field, (leaf) => {
          if (leaf.kind !== 'count-gte' && leaf.kind !== 'active') return;
          moved = updateSlot(gate, slot++, evaluateGate(leaf, runtime)) || moved;
        });
      }
      return moved;
    },
  },
  purchasables: {
    emit: emitPurchasableTransitionsForEntity,
    readSignature: (entity, gate) =>
      readPurchasableGate((entity as { purchasable: Purchasable }).purchasable, gate),
  },
  producers: {
    emit: emitProducerTransitionsForEntity,
    readSignature: (entity, gate) =>
      readPurchasableGate((entity as { producer: Producer }).producer.repeatable, gate),
  },
};

/**
 * Build an incremental-snapshot cache over the given engine. The constructor
 * runs one full walk to populate state; subsequent reads go through
 * {@link IncrementalSnapshot.snapshot} or {@link IncrementalSnapshot.rebuild}.
 *
 * @param engine - Engine to introspect. Same surface
 *   {@link createTransitionSnapshot} reads — categories via
 *   `engine.tryInject(CategoriesKey)`.
 * @param accessor - Read-side accessor; wrapped with
 *   {@link memoizeAccessor} per rebuild.
 *
 * @example
 * ```ts
 * const inc = createIncrementalSnapshot(engine, accessor);
 * // ... player action mutates state ...
 * inc.invalidateResource('gold');
 * const snap = inc.rebuild();
 * const next = snap.all[0]; // the soonest pending transition, if any
 * ```
 */
export function createIncrementalSnapshot(
  engine: Engine,
  accessor: GameStateAccessor,
): IncrementalSnapshot {
  const entries = new Map<string, CacheEntry>();
  const entities: EntityRecord[] = [];
  const byResource = new Map<string, Set<string>>();
  const byRate = new Map<string, Set<string>>();
  const byFlag = new Map<string, Set<string>>();
  const byState = new Map<string, Set<string>>();
  const dirty = {
    resources: new Set<string>(),
    rates: new Set<string>(),
    flags: new Set<string>(),
    states: new Set<string>(),
    all: false,
  };

  function addToReverseIndex(
    index: Map<string, Set<string>>,
    ids: ReadonlySet<string>,
    label: string,
  ): void {
    for (const id of ids) {
      let bucket = index.get(id);
      if (!bucket) {
        bucket = new Set();
        index.set(id, bucket);
      }
      bucket.add(label);
    }
  }

  function removeFromReverseIndex(
    index: Map<string, Set<string>>,
    ids: ReadonlySet<string>,
    label: string,
  ): void {
    for (const id of ids) {
      const bucket = index.get(id);
      if (!bucket) continue;
      bucket.delete(label);
      if (bucket.size === 0) index.delete(id);
    }
  }

  function indexEntry(entry: CacheEntry): void {
    const label = entry.transition.label;
    entries.set(label, entry);
    addToReverseIndex(byResource, entry.deps.resources, label);
    addToReverseIndex(byRate, entry.deps.rates, label);
    addToReverseIndex(byFlag, entry.deps.flags, label);
    addToReverseIndex(byState, entry.deps.states, label);
  }

  function dropEntry(label: string): void {
    const entry = entries.get(label);
    if (!entry) return;
    entries.delete(label);
    removeFromReverseIndex(byResource, entry.deps.resources, label);
    removeFromReverseIndex(byRate, entry.deps.rates, label);
    removeFromReverseIndex(byFlag, entry.deps.flags, label);
    removeFromReverseIndex(byState, entry.deps.states, label);
  }

  function snapshotFromEntries(): TransitionSnapshot {
    const all: Transition[] = [];
    for (const entry of entries.values()) all.push(entry.transition);
    all.sort(compareTransitions);
    const groups: Record<TransitionWalker, Transition[]> = {
      challenge: [],
      purchasable: [],
      producer: [],
    };
    for (const t of all) groups[t.walker].push(t);
    return {
      all,
      challenges: groups.challenge,
      purchasables: groups.purchasable,
      producers: groups.producer,
    };
  }

  function clearDirty(): void {
    dirty.resources.clear();
    dirty.rates.clear();
    dirty.flags.clear();
    dirty.states.clear();
    dirty.all = false;
  }

  function emitForRecord(record: EntityRecord, memo: GameStateAccessor): void {
    const emissions = record.walk.emit(record.categoryId, record.entity, memo);
    for (const { transition, deps } of emissions) {
      indexEntry({ transition, deps, record });
      record.labels.add(transition.label);
    }
  }

  function fullRebuild(): TransitionSnapshot {
    const memo = memoizeAccessor(accessor);
    const categories = engine.tryInject(CategoriesKey);

    entries.clear();
    entities.length = 0;
    byResource.clear();
    byRate.clear();
    byFlag.clear();
    byState.clear();

    forEachCategoryEntry(categories, ({ categoryKey, categoryId, entry: entity }) => {
      const walk = CATEGORY_WALKS[categoryKey];
      if (!walk) return;
      const record: EntityRecord = {
        categoryId,
        entity,
        walk,
        signature: [],
        labels: new Set(),
      };
      walk.readSignature(entity, record.signature);
      entities.push(record);
      emitForRecord(record, memo);
    });

    clearDirty();
    return snapshotFromEntries();
  }

  function collectDirtyEntities(
    index: Map<string, Set<string>>,
    dirtyIds: ReadonlySet<string>,
    out: Set<EntityRecord>,
  ): void {
    for (const id of dirtyIds) {
      const labels = index.get(id);
      if (!labels) continue;
      for (const label of labels) {
        const entry = entries.get(label);
        if (entry) out.add(entry.record);
      }
    }
  }

  function selectiveRebuild(): TransitionSnapshot {
    const dirtyEntities = new Set<EntityRecord>();
    collectDirtyEntities(byResource, dirty.resources, dirtyEntities);
    collectDirtyEntities(byRate, dirty.rates, dirtyEntities);
    collectDirtyEntities(byFlag, dirty.flags, dirtyEntities);
    collectDirtyEntities(byState, dirty.states, dirtyEntities);
    // Every record's signature is refreshed, dirty or not, so the stored gate
    // always describes the state its entries were emitted from.
    for (const record of entities) {
      if (record.walk.readSignature(record.entity, record.signature)) dirtyEntities.add(record);
    }

    if (dirtyEntities.size === 0) {
      clearDirty();
      return snapshotFromEntries();
    }

    const memo = memoizeAccessor(accessor);
    for (const record of dirtyEntities) {
      for (const label of record.labels) dropEntry(label);
      record.labels.clear();
      emitForRecord(record, memo);
    }

    clearDirty();
    return snapshotFromEntries();
  }

  function rebuild(): TransitionSnapshot {
    if (dirty.all || entities.length === 0) return profile('walker.incFullRebuild', fullRebuild);
    return profile('walker.incSelectiveRebuild', selectiveRebuild);
  }

  let cachedSnapshot: TransitionSnapshot = fullRebuild();

  const trackedView = (index: Map<string, Set<string>>): Iterable<string> => ({
    [Symbol.iterator]: () => index.keys(),
  });

  return {
    get snapshot() {
      return cachedSnapshot;
    },
    get trackedResources() {
      return trackedView(byResource);
    },
    get trackedRates() {
      return trackedView(byRate);
    },
    get trackedFlags() {
      return trackedView(byFlag);
    },
    get trackedStates() {
      return trackedView(byState);
    },
    invalidateResource(id) {
      dirty.resources.add(id);
    },
    invalidateRate(id) {
      dirty.rates.add(id);
    },
    invalidateFlag(id) {
      dirty.flags.add(id);
    },
    invalidateState(path) {
      dirty.states.add(path);
    },
    invalidateAll() {
      dirty.all = true;
    },
    rebuild() {
      cachedSnapshot = rebuild();
      return cachedSnapshot;
    },
  };
}
