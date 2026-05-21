/**
 * Content walker leaf C1 — enumerate pending challenge transitions.
 *
 * Challenges are the best case for precise distances: `ChallengeDef` carries
 * `visible`, `canStart`, and `goal` as `boolean | Gate | (() => boolean)`.
 * Gate fields with rate-aware leaves project to {@link ICondition} via
 * {@link gateToCondition} and feed {@link timeUntilConditionFlip}; the
 * closure / boolean / category-aware-Gate branches degrade to no-emission
 * (they can't express "when").
 *
 * Emissions per challenge entity:
 *
 * - `visibility-reveal` — `visible` projects to a rate-aware ICondition and is currently false.
 * - `start-unlock` — `canStart` projects to a rate-aware ICondition and is currently false.
 * - `goal-complete` — `active === true` and `goal` projects to a rate-aware ICondition.
 * - `challenge-maxed` — `active === true`, `goal` projects, and
 *   `completions === completionLimit - 1`. Second emission with the same
 *   distance as `goal-complete`; drops out of the goal math for free.
 *
 * Closure-form `goal`, boolean-form gates, category-aware Gate descendants,
 * and inactive-challenge goals are all intentionally skipped — "no
 * mechanical distance" is cleaner as a missing emission than as a
 * null-distance sentinel for this walker.
 */

import type { Challenge, ChallengeDef } from '@/systems/challenge-category';
import type { GameStateAccessor, ICondition } from '@/primitives/types';
import {
  collectConditionDeps,
  timeUntilConditionFlip,
  type TransitionDeps,
} from '@/core/transitions';
import { gateToCondition, isGate, type Gate } from '@/systems/gate';
import { CategoriesKey } from '@/index';
import type { Engine } from '@/index';
import { forEachCategoryEntity } from '../walk';
import type { Transition } from './types';

// ============================================================================
// TYPES (private)
// ============================================================================

/** Shape yielded by `forEachCategoryEntity` for the `challenges` slice. */
interface ChallengeEntity {
  readonly def: ChallengeDef;
  readonly challenge: Challenge;
}

// ============================================================================
// PRIVATE BUILDERS
// ============================================================================

/**
 * Project a ChallengeDef field to a rate-aware ICondition for distance/dep
 * extraction, or undefined when the field has no mechanical distance
 * (boolean, closure, category-aware Gate, or undefined).
 */
function toRateAwareCondition(value: unknown): ICondition | undefined {
  if (!isGate(value)) return undefined;
  try {
    return gateToCondition(value as Gate);
  } catch {
    // category-aware Gate (count-gte / unlock) — opaque to this walker.
    return undefined;
  }
}

function buildTransition(
  categoryId: string,
  entityId: string,
  kind: string,
  currentValue: Transition['currentValue'],
  distance: Transition['distance'],
): Transition {
  return {
    source: 'challenge',
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
  entity: ChallengeEntity,
  accessor: GameStateAccessor,
  out: { transition: Transition; deps: TransitionDeps }[],
): void {
  const { def, challenge } = entity;
  const entityId = def.id;

  // visibility-reveal: rate-aware `visible` currently false → emit when it flips true.
  const visibleCond = toRateAwareCondition(def.visible);
  if (visibleCond && !challenge.visible.value) {
    out.push({
      transition: buildTransition(
        categoryId,
        entityId,
        'visibility-reveal',
        challenge.visible.value,
        timeUntilConditionFlip(visibleCond, accessor),
      ),
      deps: collectConditionDeps(visibleCond),
    });
  }

  // start-unlock: rate-aware `canStart` currently false → emit when it flips true.
  // `Challenge.canStart` also folds in maxed/active guards, so read the raw def
  // condition via the accessor to keep the emission purely about the gate.
  const canStartCond = toRateAwareCondition(def.canStart);
  if (canStartCond && !challenge.canStart.value) {
    out.push({
      transition: buildTransition(
        categoryId,
        entityId,
        'start-unlock',
        challenge.canStart.value,
        timeUntilConditionFlip(canStartCond, accessor),
      ),
      deps: collectConditionDeps(canStartCond),
    });
  }

  // goal-complete / challenge-maxed: only meaningful while the challenge is
  // entered AND the goal projects to a rate-aware ICondition. Closure-form
  // goals and category-aware Gates are opaque by construction; inactive-challenge
  // goals have no "next tick" to fire against.
  const goalCond = toRateAwareCondition(def.goal);
  if (challenge.active.value && goalCond) {
    const goalDistance = timeUntilConditionFlip(goalCond, accessor);
    const goalDeps = collectConditionDeps(goalCond);
    out.push({
      transition: buildTransition(
        categoryId,
        entityId,
        'goal-complete',
        challenge.canComplete.value,
        goalDistance,
      ),
      deps: goalDeps,
    });

    const limit = def.completionLimit ?? 1;
    if (challenge.completions.value === limit - 1) {
      out.push({
        transition: buildTransition(
          categoryId,
          entityId,
          'challenge-maxed',
          challenge.completions.value,
          goalDistance,
        ),
        deps: goalDeps,
      });
    }
  }
}

// ============================================================================
// FACTORIES (public)
// ============================================================================

/**
 * Walk every challenge across every `CategoriesKey.challenges` slice and
 * emit one {@link Transition} per declarative gate that currently has a
 * computable flip distance.
 *
 * @param engine - Engine to introspect. Categories are read via
 *   `engine.tryInject(CategoriesKey)`; missing key degrades to `[]`.
 * @param accessor - Read-side accessor used to evaluate conditions and
 *   their flip distances. Explicit rather than ambient so the walker can
 *   be called from non-install contexts (probes, devtools, tests).
 */
export function walkChallengeTransitions(
  engine: Engine,
  accessor: GameStateAccessor,
): Transition[] {
  return emitChallengeTransitionsWithDeps(engine, accessor).map((entry) => entry.transition);
}

/**
 * Variant of {@link walkChallengeTransitions} that also reports the accessor
 * slots each transition's distance arithmetic reads. Each emission's deps
 * come from {@link collectConditionDeps} called on the ICondition branch
 * that produced it (visible / canStart / goal). Consumed by
 * {@link createIncrementalSnapshot} to populate its reverse indices.
 *
 * @internal — harness-internal. Not re-exported from the walker barrel.
 */
export function emitChallengeTransitionsWithDeps(
  engine: Engine,
  accessor: GameStateAccessor,
): { transition: Transition; deps: TransitionDeps }[] {
  const categories = engine.tryInject(CategoriesKey);
  if (!categories) return [];

  const out: { transition: Transition; deps: TransitionDeps }[] = [];
  forEachCategoryEntity(categories, ({ categoryKey, categoryId, entity }) => {
    if (categoryKey !== 'challenges') return;
    emitForEntity(categoryId, entity as unknown as ChallengeEntity, accessor, out);
  });
  return out;
}

/**
 * Re-emit challenge transitions for a single cached entity. Consumed by
 * {@link createIncrementalSnapshot}'s selective-rebuild path: given
 * an entity reference cached at the last full rebuild, produce the same
 * `{ transition, deps }` emissions {@link emitChallengeTransitionsWithDeps}
 * would yield for that one entity — no `forEachCategoryEntity` walk, no
 * engine lookup.
 *
 * @internal — harness-internal. Not re-exported from the walker barrel.
 */
export function emitChallengeTransitionsForEntity(
  categoryId: string,
  entity: unknown,
  accessor: GameStateAccessor,
): { transition: Transition; deps: TransitionDeps }[] {
  const out: { transition: Transition; deps: TransitionDeps }[] = [];
  emitForEntity(categoryId, entity as ChallengeEntity, accessor, out);
  return out;
}
