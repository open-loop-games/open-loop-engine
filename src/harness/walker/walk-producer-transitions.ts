/**
 * Content walker — enumerate pending producer transitions.
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
 * to become affordable — and neither does a producer whose repeatable is
 * maxed. Producers whose repeatable carries no cost
 * requirement (boolean-only gate) also skip; the walker can't resolve a
 * distance without a cost resource to meter against.
 *
 * ## Separation from `producer.purchaseBeatSeconds`
 *
 * `purchaseBeatSeconds` is a **stack-earning** metric: `cost / (rate ×
 * max(1, count))`, using the producer's own output as the denominator
 * regardless of whether the player has any income. It is consumed
 * directly off the producer instance by the `payback-period` auto-buy
 * policy and by UI bindings that format a per-purchase beat. It is
 * *not* a prediction of when the producer will become buyable from the
 * player's actual funding sources, so the walker — whose snapshot feeds
 * event-chain consumers (event-driven probe, countdown hints, stasis
 * analyzers) — emits the accessor-driven prediction instead. Keeping the
 * two surfaces disjoint means consumers always read the primitive their
 * question is framed against: the beat on the instance, event prediction
 * on the snapshot.
 *
 * Multi-cost repeatables use the first cost requirement's resource —
 * matches the `walk-purchasable-transitions` convention. `count-threshold`
 * and `rate-chain-crosses-threshold` lookaheads are deliberately absent:
 * they want a planner above this layer, not more cases inside it.
 */

import type { Producer } from '@/systems/producer-category';
import type { GameStateAccessor } from '@/primitives/types';
import type { TransitionDeps } from '@/core/transitions';
import { CategoriesKey } from '@/systems/engine-categories';
import type { Engine } from '@/engine';
import { forEachCategoryEntry } from '../walk';
import type { Transition } from './types';
import { predictAffordable } from './walk-purchasable-transitions';

// ============================================================================
// TYPES (private)
// ============================================================================

/** Shape yielded by `forEachCategoryEntry` for the `producers` slice. */
interface ProducerEntity {
  readonly def: { readonly id: string };
  readonly producer: Producer;
}

// ============================================================================
// PRIVATE BUILDERS
// ============================================================================

function buildTransition(
  categoryId: string,
  defId: string,
  kind: string,
  currentValue: Transition['currentValue'],
  distance: Transition['distance'],
): Transition {
  return {
    walker: 'producer',
    kind,
    categoryId,
    defId,
    currentValue,
    distance,
    key: `${categoryId}.${defId}.${kind}`,
  };
}

function collectForEntity(
  categoryId: string,
  entity: ProducerEntity,
  accessor: GameStateAccessor,
  out: { transition: Transition; deps: TransitionDeps }[],
): void {
  const { def, producer } = entity;
  const defId = def.id;

  // Manual producers with no `repeatable` have no "next purchase" transition
  // to describe — skip entirely rather than emit a null/no-rate placeholder.
  if (!producer.repeatable) return;
  const affordable = predictAffordable(producer.repeatable, accessor);
  if (!affordable) return;

  out.push({
    transition: buildTransition(
      categoryId,
      defId,
      'producer-becomes-affordable',
      affordable.currentValue,
      affordable.distance,
    ),
    deps: affordable.deps,
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
  return collectProducerTransitionsWithDeps(engine, accessor).map((entry) => entry.transition);
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
export function collectProducerTransitionsWithDeps(
  engine: Engine,
  accessor: GameStateAccessor,
): { transition: Transition; deps: TransitionDeps }[] {
  const categories = engine.tryInject(CategoriesKey);
  if (!categories) return [];

  const out: { transition: Transition; deps: TransitionDeps }[] = [];
  forEachCategoryEntry(categories, ({ categoryKey, categoryId, entry: entity }) => {
    if (categoryKey !== 'producers') return;
    collectForEntity(categoryId, entity as unknown as ProducerEntity, accessor, out);
  });
  return out;
}

/**
 * Re-emit producer transitions for a single cached entity. Consumed by
 * {@link createIncrementalSnapshot}'s selective-rebuild path.
 *
 * @internal — harness-internal. Not re-exported from the walker barrel.
 */
export function collectProducerTransitionsForEntity(
  categoryId: string,
  entity: unknown,
  accessor: GameStateAccessor,
): { transition: Transition; deps: TransitionDeps }[] {
  const out: { transition: Transition; deps: TransitionDeps }[] = [];
  collectForEntity(categoryId, entity as ProducerEntity, accessor, out);
  return out;
}
