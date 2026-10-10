/**
 * Content walker — enumerate pending challenge transitions.
 *
 * `ChallengeDef` carries `visible`, `canEnter` and `goal` as a Predicate — a
 * boolean, ref, getter or {@link Gate}. A field emits a transition whenever
 * it could still flip the way the transition names:
 *
 * - a Gate predicts its flip through {@link timeUntilGateFlip}, over the
 *   runtime the challenge category evaluates it with and the walker's
 *   accessor — a computed distance for resource and cumulative leaves,
 *   `opaque-predicate` for category, flag and state leaves;
 * - a getter or ref has no mechanical distance and emits `opaque-predicate`,
 *   so stasis detection never mistakes it for a field that can't change;
 * - a constant never flips and emits nothing.
 *
 * Emissions per challenge entity:
 *
 * - `visibility-reveal` — `visible` is currently false.
 * - `becomes-enterable` — the challenge is neither active nor maxed and its
 *   `canEnter` gate is currently false.
 * - `goal-complete` — the challenge is active and its goal doesn't hold yet.
 * - `challenge-maxed` — as `goal-complete`, on the last completion
 *   (`completions === completionLimit - 1`), with the same distance.
 */

import { isRef } from 'vue';
import type { Challenge, ChallengeDef } from '@/systems/challenge-category';
import type { GameStateAccessor } from '@/primitives/types';
import type { TransitionDeps, TransitionDistance } from '@/core/transitions';
import {
  collectGateDeps,
  getBoundGateServices,
  isGate,
  timeUntilGateFlip,
  type GateServices,
} from '@/systems/gate';
import { CategoriesKey } from '@/systems/engine-categories';
import type { Engine } from '@/engine';
import { forEachCategoryEntry } from '../walk';
import type { Transition } from './types';

// ============================================================================
// TYPES (private)
// ============================================================================

/** Shape yielded by `forEachCategoryEntry` for the `challenges` slice. */
interface ChallengeEntity {
  readonly def: ChallengeDef;
  readonly challenge: Challenge;
}

interface FieldFlip {
  distance: TransitionDistance;
  deps: TransitionDeps;
}

// ============================================================================
// PRIVATE BUILDERS
// ============================================================================

/**
 * Predict when a ChallengeDef field flips, or undefined for a constant (or
 * absent) field, which never does.
 */
function predictFieldFlip(value: unknown, services: GateServices): FieldFlip | undefined {
  if (isGate(value)) {
    return { distance: timeUntilGateFlip(value, services), deps: collectGateDeps(value) };
  }
  if (typeof value === 'function' || isRef(value)) {
    return {
      distance: { seconds: null, reason: 'opaque-predicate' },
      deps: { resources: new Set(), rates: new Set(), flags: new Set(), states: new Set() },
    };
  }
  return undefined;
}

function buildTransition(
  categoryId: string,
  defId: string,
  kind: string,
  currentValue: Transition['currentValue'],
  distance: Transition['distance'],
): Transition {
  return {
    walker: 'challenge',
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
  entity: ChallengeEntity,
  accessor: GameStateAccessor,
  out: { transition: Transition; deps: TransitionDeps }[],
): void {
  const { def, challenge } = entity;
  const defId = def.id;
  const runtime: GateServices = { ...getBoundGateServices(challenge), accessor };

  if (!challenge.visible.value) {
    const flip = predictFieldFlip(def.visible, runtime);
    if (flip) {
      out.push({
        transition: buildTransition(categoryId, defId, 'visibility-reveal', false, flip.distance),
        deps: flip.deps,
      });
    }
  }

  // `Challenge.canEnter` is the gate with the active and maxed guards folded
  // in, so outside those two states it reads the gate's own truth.
  if (!challenge.entered.value && !challenge.maxed.value && !challenge.canEnter.value) {
    const flip = predictFieldFlip(def.canEnter, runtime);
    if (flip) {
      out.push({
        transition: buildTransition(categoryId, defId, 'becomes-enterable', false, flip.distance),
        deps: flip.deps,
      });
    }
  }

  // A goal only completes while the challenge is entered; one already met is
  // waiting on a completer, not on a flip.
  if (challenge.entered.value && !challenge.canComplete.value) {
    const flip = predictFieldFlip(def.goal, runtime);
    if (flip) {
      out.push({
        transition: buildTransition(categoryId, defId, 'goal-complete', false, flip.distance),
        deps: flip.deps,
      });

      const limit = def.completionLimit ?? 1;
      if (challenge.completions.value === limit - 1) {
        out.push({
          transition: buildTransition(
            categoryId,
            defId,
            'challenge-maxed',
            challenge.completions.value,
            flip.distance,
          ),
          deps: flip.deps,
        });
      }
    }
  }
}

// ============================================================================
// FACTORIES (public)
// ============================================================================

/**
 * Walk every challenge across every `CategoriesKey.challenges` slice and
 * emit one {@link Transition} per field that could still flip — with a
 * computed distance where its gate has one, `opaque-predicate` where not.
 *
 * @param engine - Engine to introspect. Categories are read via
 *   `engine.tryInject(CategoriesKey)`; missing key degrades to `[]`.
 * @param accessor - Read-side accessor gates read resources, rates, flags
 *   and state through for their flip distances. Explicit rather than
 *   ambient so the walker can be called from non-install contexts (probes,
 *   devtools, tests).
 */
export function walkChallengeTransitions(
  engine: Engine,
  accessor: GameStateAccessor,
): Transition[] {
  return collectChallengeTransitionsWithDeps(engine, accessor).map((entry) => entry.transition);
}

/**
 * Variant of {@link walkChallengeTransitions} that also reports the accessor
 * slots each transition's distance arithmetic reads: the field's gate
 * leaves, with `cumulative-gte` named by its base resource, and nothing for
 * a closure. Consumed by
 * {@link createIncrementalSnapshot} to populate its reverse indices.
 *
 * @internal — harness-internal. Not re-exported from the walker barrel.
 */
export function collectChallengeTransitionsWithDeps(
  engine: Engine,
  accessor: GameStateAccessor,
): { transition: Transition; deps: TransitionDeps }[] {
  const categories = engine.tryInject(CategoriesKey);
  if (!categories) return [];

  const out: { transition: Transition; deps: TransitionDeps }[] = [];
  forEachCategoryEntry(categories, ({ categoryKey, categoryId, entry: entity }) => {
    if (categoryKey !== 'challenges') return;
    collectForEntity(categoryId, entity as unknown as ChallengeEntity, accessor, out);
  });
  return out;
}

/**
 * Re-emit challenge transitions for a single cached entity. Consumed by
 * {@link createIncrementalSnapshot}'s selective-rebuild path: given
 * an entity reference cached at the last full rebuild, produce the same
 * `{ transition, deps }` emissions {@link collectChallengeTransitionsWithDeps}
 * would yield for that one entity — no `forEachCategoryEntry` walk, no
 * engine lookup.
 *
 * @internal — harness-internal. Not re-exported from the walker barrel.
 */
export function collectChallengeTransitionsForEntity(
  categoryId: string,
  entity: unknown,
  accessor: GameStateAccessor,
): { transition: Transition; deps: TransitionDeps }[] {
  const out: { transition: Transition; deps: TransitionDeps }[] = [];
  collectForEntity(categoryId, entity as ChallengeEntity, accessor, out);
  return out;
}
