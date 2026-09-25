/**
 * Caching overlay on {@link createTransitionSnapshot} for the event-driven probe.
 *
 * Stores the last-built `TransitionSnapshot` plus per-label `TransitionDeps`
 * and reverse indices keyed by resource / rate / unlock / state id. Consumers
 * signal state changes via `invalidateResource` / `invalidateRate` /
 * `invalidateUnlock` / `invalidateState` / `invalidateAll`; the next
 * `rebuild()` honors those signals and re-emits only the affected entries.
 *
 * Rebuild paths:
 *
 * - `dirty.all` (or first call after construction) → **full rebuild**: walk
 *   every category entity via `forEachCategoryEntity`-style traversal and
 *   re-populate entries + reverse indices. This is the escape hatch for
 *   entity-set changes and the fallback when targeted invalidation isn't
 *   possible.
 * - Otherwise → **selective rebuild**: fan `dirty.*` through the reverse
 *   indices to a set of dirty entities, delete those entities' entries,
 *   re-emit each via the per-entity emitter attached to the cached
 *   `entityRef`/`entity`, merge back in, re-sort.
 *
 * Invariants:
 *
 * - **Entity set frozen per instance.** A selective rebuild trusts the cached
 *   entities — it does not re-walk the registry. Consumers that register new
 *   categories or new entities mid-run must call `invalidateAll()` to force a
 *   full re-walk on the next rebuild. This is load-bearing for the
 *   sample-diff wiring in `run-until-helpers/event-mode.ts`, which cannot
 *   observe entity registration through accessor reads.
 * - `rebuild()` returns a fresh `TransitionSnapshot` object per call. Callers
 *   must not memoize on identity; use deep-equal on `.all` / group arrays.
 * - `accessor` is wrapped with a fresh {@link memoizeAccessor} per rebuild,
 *   mirroring {@link createTransitionSnapshot}. Duplicate reads within one
 *   rebuild collapse; reads across rebuilds do not.
 */

import { CategoriesKey, type EngineCategories } from '@/systems/engine-categories';
import type { Engine } from '@/engine';
import type { GameStateAccessor } from '@/primitives/types';
import type { TransitionDeps } from '@/core/transitions';
import type { Transition, TransitionSource } from './types';
import type { TransitionSnapshot } from './index';
import { compareTransitions } from './compare-transitions';
import { memoizeAccessor } from './memoize-accessor';
import { emitChallengeTransitionsForEntity } from './walk-challenge-transitions';
import { emitPurchasableTransitionsForEntity } from './walk-purchasable-transitions';
import { emitProducerTransitionsForEntity } from './walk-producer-transitions';
import { profile } from '@/core/profiler';
import { forEachCategoryEntity } from '../walk';

/**
 * Minimal reference to the source entity behind a cached transition.
 *
 * `categoryKey` is the {@link EngineCategories} slice (`challenges` /
 * `purchasables` / `producers`); `source` is the narrower tag already on
 * `Transition.source`.
 */
export interface IncrementalSnapshotEntityRef {
  source: TransitionSource;
  categoryKey: keyof EngineCategories;
  categoryId: string;
  entityId: string;
}

/**
 * Caching overlay on the content-walker snapshot. Built once, rebuilt on
 * demand via {@link rebuild}.
 */
export interface IncrementalSnapshot {
  /** Most recent rebuild output. Initially the constructor's full walk. */
  readonly snapshot: TransitionSnapshot;
  /**
   * Resource ids that, if mutated, would require re-emission of at least one
   * cached entry. Live iterable — contents shift with each rebuild.
   * Consumers diffing engine state should read every id in this iterable.
   */
  readonly trackedResources: Iterable<string>;
  /** Rate-axis analogue of {@link trackedResources}. */
  readonly trackedRates: Iterable<string>;
  /** Unlock-axis analogue of {@link trackedResources}. */
  readonly trackedUnlocks: Iterable<string>;
  /** State-path analogue of {@link trackedResources}. */
  readonly trackedStates: Iterable<string>;
  /** Signal that the named resource id has changed. */
  invalidateResource(id: string): void;
  /** Signal that the named rate-producing resource's rate has changed. */
  invalidateRate(id: string): void;
  /** Signal that the named unlock flag has flipped. */
  invalidateUnlock(id: string): void;
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
  entityRef: IncrementalSnapshotEntityRef;
  entity: unknown;
}

const CATEGORY_KEY_TO_SOURCE: Partial<Record<keyof EngineCategories, TransitionSource>> = {
  challenges: 'challenge',
  purchasables: 'purchasable',
  producers: 'producer',
};

type PerEntityEmit = (
  categoryId: string,
  entity: unknown,
  accessor: GameStateAccessor,
) => { transition: Transition; deps: TransitionDeps }[];

const PER_ENTITY_EMIT: Partial<Record<keyof EngineCategories, PerEntityEmit>> = {
  challenges: emitChallengeTransitionsForEntity,
  purchasables: emitPurchasableTransitionsForEntity,
  producers: emitProducerTransitionsForEntity,
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
 * advanceToNextEvent(engine, snap);
 * ```
 */
export function createIncrementalSnapshot(
  engine: Engine,
  accessor: GameStateAccessor,
): IncrementalSnapshot {
  const entries = new Map<string, CacheEntry>();
  // Per-entity bucket: entityKey → set of labels emitted by that entity.
  // Used on the selective path to drop all of an entity's stale emissions
  // before re-emitting — an entity may emit multiple transitions whose
  // labels aren't fully discoverable from a single dep-axis hit (e.g. a
  // challenge's `goal-complete` + `challenge-maxed` pair share a dep set,
  // and a state-path mutation should refresh the whole pair).
  const byEntity = new Map<string, Set<string>>();
  const byResource = new Map<string, Set<string>>();
  const byRate = new Map<string, Set<string>>();
  const byUnlock = new Map<string, Set<string>>();
  const byState = new Map<string, Set<string>>();
  const dirty = {
    resources: new Set<string>(),
    rates: new Set<string>(),
    unlocks: new Set<string>(),
    states: new Set<string>(),
    all: false,
  };

  function entityKey(ref: IncrementalSnapshotEntityRef): string {
    return `${ref.categoryKey}:${ref.categoryId}:${ref.entityId}`;
  }

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
    const ek = entityKey(entry.entityRef);
    let bucket = byEntity.get(ek);
    if (!bucket) {
      bucket = new Set();
      byEntity.set(ek, bucket);
    }
    bucket.add(label);
    addToReverseIndex(byResource, entry.deps.resources, label);
    addToReverseIndex(byRate, entry.deps.rates, label);
    addToReverseIndex(byUnlock, entry.deps.unlocks, label);
    addToReverseIndex(byState, entry.deps.states, label);
  }

  function dropEntry(label: string): void {
    const entry = entries.get(label);
    if (!entry) return;
    entries.delete(label);
    const ek = entityKey(entry.entityRef);
    const bucket = byEntity.get(ek);
    if (bucket) {
      bucket.delete(label);
      if (bucket.size === 0) byEntity.delete(ek);
    }
    removeFromReverseIndex(byResource, entry.deps.resources, label);
    removeFromReverseIndex(byRate, entry.deps.rates, label);
    removeFromReverseIndex(byUnlock, entry.deps.unlocks, label);
    removeFromReverseIndex(byState, entry.deps.states, label);
  }

  function snapshotFromEntries(): TransitionSnapshot {
    const all: Transition[] = [];
    for (const entry of entries.values()) all.push(entry.transition);
    all.sort(compareTransitions);
    const groups: Record<TransitionSource, Transition[]> = {
      challenge: [],
      purchasable: [],
      producer: [],
    };
    for (const t of all) groups[t.source].push(t);
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
    dirty.unlocks.clear();
    dirty.states.clear();
    dirty.all = false;
  }

  function emitForEntityRef(
    entityRef: IncrementalSnapshotEntityRef,
    entity: unknown,
    memo: GameStateAccessor,
  ): void {
    const emit = PER_ENTITY_EMIT[entityRef.categoryKey];
    if (!emit) return;
    const emissions = emit(entityRef.categoryId, entity, memo);
    for (const { transition, deps } of emissions) {
      indexEntry({ transition, deps, entityRef, entity });
    }
  }

  function fullRebuild(): TransitionSnapshot {
    const memo = memoizeAccessor(accessor);
    const categories = engine.tryInject(CategoriesKey);

    entries.clear();
    byEntity.clear();
    byResource.clear();
    byRate.clear();
    byUnlock.clear();
    byState.clear();

    forEachCategoryEntity(categories, ({ categoryKey, categoryId, entityId, entity }) => {
      const source = CATEGORY_KEY_TO_SOURCE[categoryKey];
      if (!source) return;
      const entityRef: IncrementalSnapshotEntityRef = {
        source,
        categoryKey,
        categoryId,
        entityId,
      };
      emitForEntityRef(entityRef, entity, memo);
    });

    clearDirty();
    return snapshotFromEntries();
  }

  function collectDirtyEntities(
    index: Map<string, Set<string>>,
    dirtyIds: ReadonlySet<string>,
    out: Set<string>,
  ): void {
    for (const id of dirtyIds) {
      const labels = index.get(id);
      if (!labels) continue;
      for (const label of labels) {
        const entry = entries.get(label);
        if (!entry) continue;
        out.add(entityKey(entry.entityRef));
      }
    }
  }

  function selectiveRebuild(): TransitionSnapshot {
    const dirtyEntities = new Set<string>();
    collectDirtyEntities(byResource, dirty.resources, dirtyEntities);
    collectDirtyEntities(byRate, dirty.rates, dirtyEntities);
    collectDirtyEntities(byUnlock, dirty.unlocks, dirtyEntities);
    collectDirtyEntities(byState, dirty.states, dirtyEntities);

    if (dirtyEntities.size === 0) {
      clearDirty();
      return snapshotFromEntries();
    }

    const memo = memoizeAccessor(accessor);
    for (const ek of dirtyEntities) {
      const bucket = byEntity.get(ek);
      if (!bucket || bucket.size === 0) continue;
      const labels = Array.from(bucket);
      const sample = entries.get(labels[0]);
      if (!sample) continue;
      const { entityRef, entity } = sample;
      for (const label of labels) dropEntry(label);
      emitForEntityRef(entityRef, entity, memo);
    }

    clearDirty();
    return snapshotFromEntries();
  }

  function rebuild(): TransitionSnapshot {
    if (dirty.all || entries.size === 0) return profile('walker.incFullRebuild', fullRebuild);
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
    get trackedUnlocks() {
      return trackedView(byUnlock);
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
    invalidateUnlock(id) {
      dirty.unlocks.add(id);
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
