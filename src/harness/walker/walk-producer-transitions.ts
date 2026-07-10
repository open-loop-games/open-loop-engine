/**
 * Content walker leaf C3 — enumerate pending producer transitions.
 *
 * Emits one {@link Transition} per producer whose repeatable is not yet
 * maxed, answering "when will the player be able to afford the next copy
 * of this producer?" — a prediction shaped by the cost resource's current
 * amount and accessor-reported rate, matching what the purchasable leaf
 * emits.
 *
 * Emissions per producer entity:
 *
 * - `producer-becomes-affordable` — the producer has a `repeatable` with
 *   at least one {@link CostRequirement}. Distance is
 *   `timeUntilResource(costReq.resource.id, producer.repeatable.getCost(1),
 *   accessor)`. Returns `{ seconds: null, reason: 'no-rate' }` when the
 *   cost resource has no positive rate.
 *
 * Manual producers with no `repeatable` emit nothing — there's no purchase
 * to become affordable. Producers whose repeatable carries no cost
 * requirement (boolean-only gate) also skip; the walker can't resolve a
 * distance without a cost resource to meter against.
 *
 * ## Separation from `producer.purchaseBeatSeconds`
 *
 * `purchaseBeatSeconds` is a **payback-period** metric: `cost / (rate ×
 * max(1, count))`, using the producer's own per-unit rate as the
 * denominator regardless of whether the player has any income. It is
 * consumed directly off the producer instance by the `payback-period`
 * auto-buy policy and by UI bindings that format "payback in Ns". It is
 * *not* a prediction of when the producer will become buyable from the
 * player's actual funding sources, so the walker — whose snapshot feeds
 * event-chain consumers (event-driven probe, countdown hints, stasis
 * analyzers) — emits the accessor-driven prediction instead. Keeping the
 * two surfaces disjoint means consumers always read the primitive their
 * question is framed against: payback on the instance, event prediction
 * on the snapshot.
 *
 * Multi-cost repeatables use the first cost requirement's resource —
 * matches the `walk-purchasable-transitions` convention. `count-threshold`
 * and `rate-chain-crosses-threshold` lookaheads remain parked under
 * `createTransitionPlanner` in `docs/candidate-primitives.md`.
 */

import type { Producer } from '@/systems/producer-category';
import type { Requirement } from '@/core/requirements';
import { isCostRequirement } from '@/core/requirements';
import type { GameStateAccessor } from '@/primitives/types';
import { timeUntilResource, type TransitionDeps } from '@/core/transitions';
import { CategoriesKey } from '@/systems/engine-categories';
import type { Engine } from '@/engine';
import { forEachCategoryEntity } from '../walk';
import type { Transition } from './types';

// ============================================================================
// TYPES (private)
// ============================================================================

/** Shape yielded by `forEachCategoryEntity` for the `producers` slice. */
interface ProducerEntity {
  readonly def: { readonly id: string };
  readonly producer: Producer;
}

// ============================================================================
// PRIVATE BUILDERS
// ============================================================================

// TODO(expansion): multi-cost producer repeatables. When a repeatable has
// N>1 cost requirements, emit one becomes-affordable per resource (or the
// slowest)? Today we pick the first, mirroring walk-purchasable-transitions.
// Promote on the first consumer that notices.
function firstCostRequirement(requirements: Requirement[]): Requirement | undefined {
  return requirements.find(isCostRequirement);
}

function buildTransition(
  categoryId: string,
  entityId: string,
  kind: string,
  currentValue: Transition['currentValue'],
  distance: Transition['distance'],
): Transition {
  return {
    source: 'producer',
    kind,
    categoryId,
    entityId,
    currentValue,
    distance,
    label: `${categoryId}.${entityId}.${kind}`,
  };
}

function emitForEntity(
  categoryId: string,
  entity: ProducerEntity,
  accessor: GameStateAccessor,
  out: { transition: Transition; deps: TransitionDeps }[],
): void {
  const { def, producer } = entity;
  const entityId = def.id;

  // Manual producers with no `repeatable` have no "next purchase" transition
  // to describe — skip entirely rather than emit a null/no-rate placeholder.
  if (!producer.repeatable) return;

  const reqs = producer.repeatable.requirements;
  const costReq = firstCostRequirement(Array.isArray(reqs) ? reqs : [reqs]);
  if (!costReq || !isCostRequirement(costReq)) return;

  const costId = costReq.resource.id;
  const distance = timeUntilResource(costId, producer.repeatable.getCost(1), accessor);

  out.push({
    transition: buildTransition(
      categoryId,
      entityId,
      'producer-becomes-affordable',
      producer.count.value,
      distance,
    ),
    // `timeUntilResource` reads amount + rate; count/getCost reactivity is
    // gating-only and invalidates transitively through the purchase that
    // writes them — deliberately excluded from the narrow dep set.
    deps: {
      resources: new Set([costId]),
      rates: new Set([costId]),
      unlocks: new Set(),
      states: new Set(),
    },
  });
}

// ============================================================================
// FACTORIES (public)
// ============================================================================

/**
 * Walk every producer across every `CategoriesKey.producers` slice and emit
 * one {@link Transition} per pending becomes-affordable flip.
 *
 * @param engine - Engine to introspect. Categories are read via
 *   `engine.tryInject(CategoriesKey)`; missing key degrades to `[]`.
 * @param accessor - Read-side accessor used to look up the cost resource's
 *   current amount and rate. Explicit rather than ambient so the walker can
 *   be called from non-install contexts (probes, devtools, tests).
 */
export function walkProducerTransitions(engine: Engine, accessor: GameStateAccessor): Transition[] {
  return emitProducerTransitionsWithDeps(engine, accessor).map((entry) => entry.transition);
}

/**
 * Variant of {@link walkProducerTransitions} that also reports the accessor
 * slots each transition's distance arithmetic reads. Consumed by
 * {@link createIncrementalSnapshot} to invalidate the right transitions on
 * resource/rate change.
 *
 * Same signature otherwise — same engine introspection, same per-entity
 * emission rules, same back-compat with respect to missing `CategoriesKey`.
 *
 * @internal — harness-internal. Not re-exported from the walker barrel.
 */
export function emitProducerTransitionsWithDeps(
  engine: Engine,
  accessor: GameStateAccessor,
): { transition: Transition; deps: TransitionDeps }[] {
  const categories = engine.tryInject(CategoriesKey);
  if (!categories) return [];

  const out: { transition: Transition; deps: TransitionDeps }[] = [];
  forEachCategoryEntity(categories, ({ categoryKey, categoryId, entity }) => {
    if (categoryKey !== 'producers') return;
    emitForEntity(categoryId, entity as unknown as ProducerEntity, accessor, out);
  });
  return out;
}

/**
 * Re-emit producer transitions for a single cached entity. Consumed by
 * {@link createIncrementalSnapshot}'s selective-rebuild path.
 *
 * @internal — harness-internal. Not re-exported from the walker barrel.
 */
export function emitProducerTransitionsForEntity(
  categoryId: string,
  entity: unknown,
  accessor: GameStateAccessor,
): { transition: Transition; deps: TransitionDeps }[] {
  const out: { transition: Transition; deps: TransitionDeps }[] = [];
  emitForEntity(categoryId, entity as ProducerEntity, accessor, out);
  return out;
}
