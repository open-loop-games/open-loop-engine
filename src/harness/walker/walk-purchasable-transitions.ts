/**
 * Purchasable transition walker — enumerate pending purchasable transitions.
 *
 * A purchasable is the typical "becomes affordable" transition. The cost
 * requirement names a resource, the accessor reports its current amount and
 * rate, and {@link timeUntilResource} turns those into a distance. For a
 * purchasable with a finite limit, the walker also returns
 * `purchasable-maxed` when the next purchase would reach the limit. The same
 * math gives it.
 *
 * Transitions per purchasable:
 *
 * - `becomes-affordable` — `!maxed` and the purchasable has at least one
 *   {@link CostRequirement}. Uses the first cost requirement's resource
 *   and `purchasable.getCost(1)`.
 * - `purchasable-maxed` — `count === limit - 1` with a finite limit, so the
 *   next purchase would max it. Same distance as `becomes-affordable`.
 *
 * The purchasable keeps no Gate for `visible`, so the walker cannot compute
 * a flip distance for it. A purchasable with `visible` false gives no
 * `visibility-reveal`. It still appears through `becomes-affordable` once a
 * cost resource is present. A purchasable with several cost requirements
 * uses the first requirement's resource. That matches the single-distance
 * shape, and adds no "slowest resource wins" rule before a consumer asks.
 */

import type { Purchasable } from '@/systems/purchasable';
import { isCostRequirement } from '@/core/requirements';
import type { GameStateAccessor } from '@/primitives/types';
import { Decimal } from '@/primitives/decimal';
import { timeUntilResource, type TransitionDeps } from '@/core/transitions';
import { CategoriesKey } from '@/systems/engine-categories';
import type { Engine } from '@/engine';
import { unref } from 'vue';
import { forEachCategoryEntry } from '../walk';
import type { Transition } from './types';

// ============================================================================
// TYPES (private)
// ============================================================================

/** Shape yielded by `forEachCategoryEntry` for the `purchasables` slice. */
interface PurchasableEntity {
  readonly def: { readonly id: string };
  readonly purchasable: Purchasable;
}

// ============================================================================
// PRIVATE BUILDERS
// ============================================================================

/**
 * The shared parts of a purchasable's affordability transition (a producer's
 * `repeatable` included). Undefined when it's maxed or has no cost resource
 * to meter against.
 *
 * @internal
 */
export function predictAffordable(
  purchasable: Purchasable,
  accessor: GameStateAccessor,
):
  | {
      distance: Transition['distance'];
      deps: TransitionDeps;
      currentValue: Transition['currentValue'];
    }
  | undefined {
  if (purchasable.maxed.value) return undefined;

  // TODO(expansion): multi-cost purchasables. When a purchasable has N>1 cost
  // requirements, return one becomes-affordable per resource (or the slowest)?
  // Today we pick the first. Promote on the first consumer that notices.
  const reqs = purchasable.requirements;
  const costReq = (Array.isArray(reqs) ? reqs : [reqs]).find(isCostRequirement);
  if (!costReq) return undefined;

  const costId = costReq.resource.id;
  return {
    distance: timeUntilResource(costId, purchasable.getCost(1), accessor),
    // `timeUntilResource` reads amount + rate of the cost resource. Count,
    // limit and cost are blocking state, which the incremental snapshot's
    // signature covers, so they stay out of the dep set.
    deps: {
      resources: new Set([costId]),
      rates: new Set([costId]),
      flags: new Set(),
      states: new Set(),
    },
    currentValue: accessor.getAmount(costId),
  };
}

function buildTransition(
  categoryId: string,
  defId: string,
  kind: string,
  currentValue: Transition['currentValue'],
  distance: Transition['distance'],
): Transition {
  return {
    walker: 'purchasable',
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
  entity: PurchasableEntity,
  accessor: GameStateAccessor,
  out: { transition: Transition; deps: TransitionDeps }[],
): void {
  const { def, purchasable } = entity;
  const defId = def.id;

  // Maxed, or only boolean, flag or state requirements, with no cost
  // resource to compute a distance from.
  const affordable = predictAffordable(purchasable, accessor);
  if (!affordable) return;
  const { distance, deps } = affordable;

  out.push({
    transition: buildTransition(
      categoryId,
      defId,
      'becomes-affordable',
      affordable.currentValue,
      distance,
    ),
    deps,
  });

  // purchasable-maxed: when the next purchase reaches the limit. Only meaningful
  // for finite limits. `count === limit - 1` uses the same distance as the
  // affordability flip: one more purchase and the count is at `limit`.
  const limit = unref(purchasable.limit);
  if (Decimal.isFinite(limit) && Decimal.eq(purchasable.count.value, Decimal.sub(limit, 1))) {
    out.push({
      transition: buildTransition(
        categoryId,
        defId,
        'purchasable-maxed',
        purchasable.count.value,
        distance,
      ),
      deps,
    });
  }
}

// ============================================================================
// FACTORIES (public)
// ============================================================================

/**
 * Walk every purchasable across every `CategoriesKey.purchasables` slice.
 * Return one {@link Transition} per pending affordability flip.
 *
 * @param engine - Engine to introspect. Categories are read via
 *   `engine.tryInject(CategoriesKey)`; a missing key gives `[]`.
 * @param accessor - The game-state accessor that reads each cost resource's
 *   current amount and rate. It is a parameter, not an ambient value, so
 *   callers outside install/connect can call the walker (probes, devtools,
 *   tests).
 */
export function walkPurchasableTransitions(
  engine: Engine,
  accessor: GameStateAccessor,
): Transition[] {
  return collectPurchasableTransitionsWithDeps(engine, accessor).map((entry) => entry.transition);
}

/**
 * Like {@link walkPurchasableTransitions}, but also reports the accessor reads
 * each transition's distance arithmetic depends on.
 * {@link createIncrementalSnapshot} uses them to invalidate the right
 * transitions on a resource or rate change.
 *
 * `becomes-affordable` and its paired `purchasable-maxed` share the same dep
 * set — both read the same cost resource to compute the same distance.
 *
 * @internal — harness-internal. Not re-exported from the walker barrel.
 */
export function collectPurchasableTransitionsWithDeps(
  engine: Engine,
  accessor: GameStateAccessor,
): { transition: Transition; deps: TransitionDeps }[] {
  const categories = engine.tryInject(CategoriesKey);
  if (!categories) return [];

  const out: { transition: Transition; deps: TransitionDeps }[] = [];
  forEachCategoryEntry(categories, ({ categoryKey, categoryId, entry: entity }) => {
    if (categoryKey !== 'purchasables') return;
    collectForEntity(categoryId, entity as unknown as PurchasableEntity, accessor, out);
  });
  return out;
}

/**
 * Rebuild the purchasable transitions of one cached category entry, for
 * {@link createIncrementalSnapshot}'s selective rebuild.
 *
 * @internal — harness-internal. Not re-exported from the walker barrel.
 */
export function collectPurchasableTransitionsForEntity(
  categoryId: string,
  entity: unknown,
  accessor: GameStateAccessor,
): { transition: Transition; deps: TransitionDeps }[] {
  const out: { transition: Transition; deps: TransitionDeps }[] = [];
  collectForEntity(categoryId, entity as PurchasableEntity, accessor, out);
  return out;
}
