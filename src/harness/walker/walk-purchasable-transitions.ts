/**
 * Content walker — enumerate pending purchasable transitions.
 *
 * Purchasables are the canonical "becomes affordable" transition: the cost
 * requirement names a resource, the accessor reports its current amount and
 * rate, and {@link timeUntilResource} turns those into a distance. For
 * leveled purchasables the walker also surfaces `purchasable-maxed` when
 * the next purchase would cap the level — it falls out of the same math.
 *
 * Emissions per purchasable entity:
 *
 * - `becomes-affordable` — `!maxed` and the entity has at least one
 *   {@link CostRequirement}. Uses the first cost requirement's resource
 *   and `purchasable.getCost(1)`.
 * - `purchasable-maxed` — `amount === limit - 1` with a finite limit, so the
 *   next purchase would max out. Same distance as `becomes-affordable`.
 *
 * The purchasable keeps no Gate for `visible`, so the walker cannot
 * compute a flip distance for it. Hidden purchasables emit no
 * `visibility-reveal` — the entity still surfaces via `becomes-affordable`
 * once a cost resource is present. Multi-cost purchasables (N>1 cost
 * requirements) use the first requirement's resource; this matches the
 * single-distance emission shape and avoids imposing a "slowest resource
 * wins" semantic without a consumer asking for it.
 */

import type { Purchasable } from '@/systems/purchasable';
import { isCostRequirement } from '@/core/requirements';
import type { GameStateAccessor } from '@/primitives/types';
import { Decimal } from '@/primitives/decimal';
import { timeUntilResource, type TransitionDeps } from '@/core/transitions';
import { CategoriesKey } from '@/systems/engine-categories';
import type { Engine } from '@/engine';
import { unref } from 'vue';
import { forEachCategoryEntity } from '../walk';
import type { Transition } from './types';

// ============================================================================
// TYPES (private)
// ============================================================================

/** Shape yielded by `forEachCategoryEntity` for the `purchasables` slice. */
interface PurchasableEntity {
  readonly def: { readonly id: string };
  readonly purchasable: Purchasable;
}

// ============================================================================
// PRIVATE BUILDERS
// ============================================================================

/**
 * The affordability emission's shared parts for a purchasable (a producer's
 * `repeatable` included), or undefined when it's maxed or has no cost
 * resource to meter against.
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
  // requirements, emit one becomes-affordable per resource (or the slowest)?
  // Today we pick the first. Promote on the first consumer that notices.
  const reqs = purchasable.requirements;
  const costReq = (Array.isArray(reqs) ? reqs : [reqs]).find(isCostRequirement);
  if (!costReq) return undefined;

  const costId = costReq.resource.id;
  return {
    distance: timeUntilResource(costId, purchasable.getCost(1), accessor),
    // `timeUntilResource` reads amount + rate of the cost resource. Amount,
    // limit and cost are gating state, which the incremental snapshot's gate
    // signature covers, so they stay out of the dep set.
    deps: {
      resources: new Set([costId]),
      rates: new Set([costId]),
      unlocks: new Set(),
      states: new Set(),
    },
    currentValue: accessor.getResource(costId),
  };
}

function buildTransition(
  categoryId: string,
  entityId: string,
  kind: string,
  currentValue: Transition['currentValue'],
  distance: Transition['distance'],
): Transition {
  return {
    source: 'purchasable',
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
  entity: PurchasableEntity,
  accessor: GameStateAccessor,
  out: { transition: Transition; deps: TransitionDeps }[],
): void {
  const { def, purchasable } = entity;
  const entityId = def.id;

  // Maxed, or boolean-only gates and unlock/state predicates with no cost
  // resource to run distance math against.
  const affordable = predictAffordable(purchasable, accessor);
  if (!affordable) return;
  const { distance, deps } = affordable;

  out.push({
    transition: buildTransition(
      categoryId,
      entityId,
      'becomes-affordable',
      affordable.currentValue,
      distance,
    ),
    deps,
  });

  // purchasable-maxed: when the next purchase caps the level. Only meaningful
  // for finite limits. `amount === limit - 1` reads off the same distance as
  // the affordability flip — one more purchase and we're at `limit`.
  const limit = unref(purchasable.limit);
  if (Decimal.isFinite(limit) && Decimal.eq(purchasable.amount.value, Decimal.sub(limit, 1))) {
    out.push({
      transition: buildTransition(
        categoryId,
        entityId,
        'purchasable-maxed',
        purchasable.amount.value,
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
 * Walk every purchasable across every `CategoriesKey.purchasables` slice and
 * emit one {@link Transition} per pending affordability flip.
 *
 * @param engine - Engine to introspect. Categories are read via
 *   `engine.tryInject(CategoriesKey)`; missing key degrades to `[]`.
 * @param accessor - Read-side accessor used to look up each cost resource's
 *   current amount and rate. Explicit rather than ambient so the walker can
 *   be called from non-install contexts (probes, devtools, tests).
 */
export function walkPurchasableTransitions(
  engine: Engine,
  accessor: GameStateAccessor,
): Transition[] {
  return emitPurchasableTransitionsWithDeps(engine, accessor).map((entry) => entry.transition);
}

/**
 * Variant of {@link walkPurchasableTransitions} that also reports the accessor
 * slots each transition's distance arithmetic reads. Consumed by
 * {@link createIncrementalSnapshot} to invalidate the right transitions on
 * resource/rate change.
 *
 * `becomes-affordable` and its paired `purchasable-maxed` share the same dep
 * set — both read the same cost resource to compute the same distance.
 *
 * @internal — harness-internal. Not re-exported from the walker barrel.
 */
export function emitPurchasableTransitionsWithDeps(
  engine: Engine,
  accessor: GameStateAccessor,
): { transition: Transition; deps: TransitionDeps }[] {
  const categories = engine.tryInject(CategoriesKey);
  if (!categories) return [];

  const out: { transition: Transition; deps: TransitionDeps }[] = [];
  forEachCategoryEntity(categories, ({ categoryKey, categoryId, entity }) => {
    if (categoryKey !== 'purchasables') return;
    emitForEntity(categoryId, entity as unknown as PurchasableEntity, accessor, out);
  });
  return out;
}

/**
 * Re-emit purchasable transitions for a single cached entity. Consumed by
 * {@link createIncrementalSnapshot}'s selective-rebuild path.
 *
 * @internal — harness-internal. Not re-exported from the walker barrel.
 */
export function emitPurchasableTransitionsForEntity(
  categoryId: string,
  entity: unknown,
  accessor: GameStateAccessor,
): { transition: Transition; deps: TransitionDeps }[] {
  const out: { transition: Transition; deps: TransitionDeps }[] = [];
  emitForEntity(categoryId, entity as PurchasableEntity, accessor, out);
  return out;
}
