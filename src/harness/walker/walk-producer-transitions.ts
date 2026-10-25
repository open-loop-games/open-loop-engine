/**
 * Producer transition walker — enumerate pending producer transitions.
 *
 * Returns one {@link Transition} per producer whose purchasable is not yet
 * maxed. It answers "when can the player afford the next purchase of this
 * producer?" The prediction uses the cost resource's current amount and
 * accessor-reported rate, as the purchasable walker does.
 *
 * Transitions per producer:
 *
 * - `producer-becomes-affordable` — the producer has a `purchasable` with
 *   at least one {@link CostRequirement}. Distance is
 *   `timeUntilResource(costReq.resource.id, producer.purchasable.getCost(1),
 *   accessor)`. Returns `{ seconds: null, reason: 'no-rate' }` when the
 *   cost resource has no positive rate.
 *
 * Manual producers with no `purchasable` give nothing, because there's no
 * purchase to become affordable. Neither does a producer whose purchasable is
 * maxed. A producer whose purchasable has no cost requirement (only boolean
 * requirements) is skipped too: the walker can't compute a distance without
 * a cost resource to meter against.
 *
 * ## Separation from `producer.purchaseBeatSeconds`
 *
 * `purchaseBeatSeconds` is a **stack-earning** metric: `cost / (rate ×
 * max(1, count))`. It uses the producer's own output as the denominator,
 * whatever the cost resource's actual rate is. A `selectionPaybackPeriod`
 * auto-purchase policy and UI code that formats a beat time read it directly
 * off the producer instance. It is *not* a prediction of when the producer
 * becomes affordable at the cost resource's actual rate. The walker's
 * snapshot feeds next-event consumers (`runUntil`'s `'next-event'` mode,
 * countdown hints, stasis analyzers), so the walker returns the
 * accessor-driven prediction instead. Keeping the two apart lets each
 * consumer read the value its question needs: the beat time on the instance,
 * the transition distance on the snapshot.
 *
 * A purchasable with several costs uses the first cost requirement's
 * resource, as `walk-purchasable-transitions` does. `count-threshold` and
 * `rate-chain-crosses-threshold` lookaheads are deliberately absent: they
 * need a planner on top of the walker, not more cases inside it.
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

  // Manual producers with no `purchasable` have no "next purchase" transition
  // to describe. Skip them entirely rather than return a null/no-rate placeholder.
  if (!producer.purchasable) return;
  const affordable = predictAffordable(producer.purchasable, accessor);
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
 * Walk every producer across every `CategoriesKey.producers` slice. Return
 * one {@link Transition} per pending becomes-affordable flip.
 *
 * @param engine - Engine to introspect. Categories are read via
 *   `engine.tryInject(CategoriesKey)`; a missing key gives `[]`.
 * @param accessor - The game-state accessor that reads the cost resource's
 *   current amount and rate. It is a parameter, not an ambient value, so
 *   callers outside install/connect can call the walker (probes, devtools,
 *   tests).
 */
export function walkProducerTransitions(engine: Engine, accessor: GameStateAccessor): Transition[] {
  return collectProducerTransitionsWithDeps(engine, accessor).map((entry) => entry.transition);
}

/**
 * Like {@link walkProducerTransitions}, but also reports the accessor reads
 * each transition's distance arithmetic depends on.
 * {@link createIncrementalSnapshot} uses them to invalidate the right
 * transitions on a resource or rate change.
 *
 * Otherwise the same: same signature, same engine introspection, same rules
 * per category entry, and the same `[]` for a missing `CategoriesKey`.
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
 * Rebuild the producer transitions of one cached category entry, for
 * {@link createIncrementalSnapshot}'s selective rebuild.
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
