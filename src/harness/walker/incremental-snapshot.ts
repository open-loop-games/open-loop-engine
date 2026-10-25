/**
 * Caching overlay on {@link createTransitionSnapshot} for `runUntil`'s
 * `'next-event'` mode.
 *
 * Stores the last-built `TransitionSnapshot`, plus per-key `TransitionDeps`
 * and reverse indices keyed by resource, rate, flag and state id. Consumers
 * report state changes through `invalidateResource` / `invalidateRate` /
 * `invalidateFlag` / `invalidateState` / `invalidateAll`. The next
 * `rebuild()` acts on those reports and rebuilds only the affected transitions.
 *
 * Two things decide a leaf walker's output for one category entry. The
 * entry's own blocking state (a purchasable's count and limit, a challenge's
 * `entered` and completions, ...) decides *which* transitions it gives. The
 * accessor reads in each transition's `TransitionDeps` decide their
 * distances. The cache keeps a record of every walkable category entry,
 * whatever it currently gives, with a small signature per entry read
 * straight off the instance.
 *
 * Rebuild paths:
 *
 * - `dirty.all` (or no walkable category entry at all) → **full rebuild**:
 *   walk every category entry via `forEachCategoryEntry`, and refill the
 *   records, cached transitions and reverse indices. This is the path for a
 *   change to the set of category entries, and the fallback when targeted
 *   invalidation isn't possible.
 * - Otherwise → **selective rebuild**: a category entry is dirty when
 *   `dirty.*` reaches one of its cached transitions through the reverse
 *   indices, or when its signature changed since the last rebuild. Each dirty
 *   entry's cached transitions are removed and rebuilt through its per-entry
 *   collector, then re-sorted.
 *
 * Invariants:
 *
 * - **The set of category entries is fixed at the last full walk.** A
 *   selective rebuild re-reads every recorded entry's signature, but does not
 *   re-walk the categories. A consumer that registers new categories or new
 *   defs mid-run must call `invalidateAll()`, to force a full re-walk on the
 *   next rebuild. The sample-diff wiring in
 *   `run-until-helpers/next-event-mode.ts` depends on this, because it cannot
 *   observe def registration through accessor reads.
 * - **Blocking state needs no invalidation; deps do.** A category entry whose
 *   transitions went empty (maxed, not entered) stays recorded. It comes back
 *   when its signature changes: a reset, or an automation policy entering a
 *   challenge.
 * - **A transition with empty deps is rebuilt only when its signature
 *   changes.** No `invalidate*` call reaches an opaque predicate (closure
 *   goal, category-aware Gate), and none needs to: see {@link ReadSignature}.
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
import { collectChallengeTransitionsForEntity } from './walk-challenge-transitions';
import { collectPurchasableTransitionsForEntity } from './walk-purchasable-transitions';
import { collectProducerTransitionsForEntity } from './walk-producer-transitions';
import { profile } from '@/core/profiler';
import { forEachCategoryEntry } from '../walk';

/**
 * Caching overlay on the transition-walker snapshot. Built once, rebuilt on
 * demand via {@link rebuild}.
 */
export interface IncrementalSnapshot {
  /** Most recent rebuild output. Initially the factory's full walk. */
  readonly snapshot: TransitionSnapshot;
  /**
   * Resource ids whose change would require a rebuild of at least one cached
   * transition. A view over the index, so its contents change with each
   * rebuild. A consumer that diffs game state reads each id here: its
   * amount, and its lifetime total where it has one.
   */
  readonly trackedResources: Iterable<string>;
  /**
   * Rate analogue of {@link trackedResources}: read the net rate, and the
   * inflow rate where the accessor has one.
   */
  readonly trackedRates: Iterable<string>;
  /** Flag analogue of {@link trackedResources}. */
  readonly trackedFlags: Iterable<string>;
  /** State-path analogue of {@link trackedResources}. */
  readonly trackedStates: Iterable<string>;
  /** Report that the named resource has changed. */
  invalidateResource(id: string): void;
  /** Report that the named resource's rate has changed. */
  invalidateRate(id: string): void;
  /** Report that the named flag has flipped. */
  invalidateFlag(id: string): void;
  /** Report that the named state path has been written. */
  invalidateState(path: string): void;
  /**
   * Coarse invalidation — force a full re-walk of every category entry on
   * the next `rebuild()`. Call it after the set of category entries changes
   * (content registry patches, new categories provided). Also call it after
   * long periods where the caller cannot track which keys changed (e.g.
   * fast-tick stasis).
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

type PerEntityCollect = (
  categoryId: string,
  entity: unknown,
  accessor: GameStateAccessor,
) => { transition: Transition; deps: TransitionDeps }[];

/**
 * Refresh `gate` in place from the category entry's current blocking state;
 * true when any element changed. It reads what the matching leaf walker's
 * guards, cost lookup, `currentValue` and distance read off the instance,
 * not through the accessor. A transition reads nothing beyond these elements
 * and its deps. That is why the selective rebuild can skip it until one
 * changes. A leaf walker whose transitions read other state must add that
 * state to its signature.
 */
type ReadSignature = (entity: unknown, gate: unknown[]) => boolean;

interface CategoryWalk {
  collect: PerEntityCollect;
  readSignature: ReadSignature;
}

/** A walkable category entry, recorded whether or not it currently gives a transition. */
interface EntityRecord {
  categoryId: string;
  entity: unknown;
  walk: CategoryWalk;
  signature: unknown[];
  keys: Set<string>;
}

/**
 * Store `value` in `gate[i]` if it differs from what's there; true when it
 * did. Decimals are compared by value and stored as copies, so an in-place
 * mutation can't alias the stored value.
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
  // `maxed` and the `count === limit - 1` limit check are functions of these two.
  let moved = updateSlot(gate, 0, purchasable?.count.value);
  moved = updateSlot(gate, 1, purchasable && unref(purchasable.limit)) || moved;
  return moved;
}

const CATEGORY_WALKS: Partial<Record<keyof EngineCategories, CategoryWalk>> = {
  challenges: {
    collect: collectChallengeTransitionsForEntity,
    readSignature(entity, gate) {
      const { def, challenge } = entity as { def: ChallengeDef; challenge: Challenge };
      let moved = updateSlot(gate, 0, challenge.entered.value);
      moved = updateSlot(gate, 1, challenge.completions.value) || moved;
      moved = updateSlot(gate, 2, challenge.visible.value) || moved;
      moved = updateSlot(gate, 3, challenge.canEnter.value) || moved;
      moved = updateSlot(gate, 4, challenge.canComplete.value) || moved;
      // A category leaf changes with no dep changing. Inside a combinator that
      // doesn't flip, its truth still picks which children give the Gate's
      // distance.
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
    collect: collectPurchasableTransitionsForEntity,
    readSignature: (entity, gate) =>
      readPurchasableGate((entity as { purchasable: Purchasable }).purchasable, gate),
  },
  producers: {
    collect: collectProducerTransitionsForEntity,
    readSignature: (entity, gate) =>
      readPurchasableGate((entity as { producer: Producer }).producer.purchasable, gate),
  },
};

/**
 * Build an incremental-snapshot cache over the given engine. The factory
 * runs one full walk to fill the cache. Later reads go through
 * {@link IncrementalSnapshot.snapshot} or {@link IncrementalSnapshot.rebuild}.
 *
 * @param engine - Engine to introspect. It reads what
 *   {@link createTransitionSnapshot} reads: categories via
 *   `engine.tryInject(CategoriesKey)`.
 * @param accessor - The game-state accessor; wrapped with
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
    key: string,
  ): void {
    for (const id of ids) {
      let bucket = index.get(id);
      if (!bucket) {
        bucket = new Set();
        index.set(id, bucket);
      }
      bucket.add(key);
    }
  }

  function removeFromReverseIndex(
    index: Map<string, Set<string>>,
    ids: ReadonlySet<string>,
    key: string,
  ): void {
    for (const id of ids) {
      const bucket = index.get(id);
      if (!bucket) continue;
      bucket.delete(key);
      if (bucket.size === 0) index.delete(id);
    }
  }

  function indexEntry(entry: CacheEntry): void {
    const key = entry.transition.key;
    entries.set(key, entry);
    addToReverseIndex(byResource, entry.deps.resources, key);
    addToReverseIndex(byRate, entry.deps.rates, key);
    addToReverseIndex(byFlag, entry.deps.flags, key);
    addToReverseIndex(byState, entry.deps.states, key);
  }

  function dropEntry(key: string): void {
    const entry = entries.get(key);
    if (!entry) return;
    entries.delete(key);
    removeFromReverseIndex(byResource, entry.deps.resources, key);
    removeFromReverseIndex(byRate, entry.deps.rates, key);
    removeFromReverseIndex(byFlag, entry.deps.flags, key);
    removeFromReverseIndex(byState, entry.deps.states, key);
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

  function collectForRecord(record: EntityRecord, memo: GameStateAccessor): void {
    const emissions = record.walk.collect(record.categoryId, record.entity, memo);
    for (const { transition, deps } of emissions) {
      indexEntry({ transition, deps, record });
      record.keys.add(transition.key);
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
        keys: new Set(),
      };
      walk.readSignature(entity, record.signature);
      entities.push(record);
      collectForRecord(record, memo);
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
      const keys = index.get(id);
      if (!keys) continue;
      for (const key of keys) {
        const entry = entries.get(key);
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
    // Every record's signature is refreshed, dirty or not, so the stored
    // signature always describes the state its transitions were built from.
    for (const record of entities) {
      if (record.walk.readSignature(record.entity, record.signature)) dirtyEntities.add(record);
    }

    if (dirtyEntities.size === 0) {
      clearDirty();
      return snapshotFromEntries();
    }

    const memo = memoizeAccessor(accessor);
    for (const record of dirtyEntities) {
      for (const key of record.keys) dropEntry(key);
      record.keys.clear();
      collectForRecord(record, memo);
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
