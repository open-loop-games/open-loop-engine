import { bn, Decimal } from '@/primitives/decimal';
import type { GameStateAccessorMutator } from '@/core/game-state-accessor';
import { createRecommendationSystem, type RecommendationSystem } from '@/systems/recommendation';
import type { Cycle } from '@/systems/cycle';
import type { CycleLog } from '@/systems/cycle-log';
import type { BestOf } from '@/systems/best-of';

/** A registerTick that never fires, for a system whose ticking isn't under test. */
export const noopRegisterTick = () => () => {};

/** The two-tier `manual` / `basic` ladder reset.test.ts and system-resettable.test.ts both build. */
export const AUTOMATION_TIER_DEFS = [
  { id: 'manual', name: 'Manual', order: 0 },
  { id: 'basic', name: 'Basic', order: 1 },
];

/** A stateless GameStateAccessorMutator stub for a DialogSession under test. */
export const dialogAccessorStub: GameStateAccessorMutator = {
  getAmount: () => bn(0),
  getFlag: () => false,
  getStateAt: () => undefined,
  getRate: () => Decimal.dZero,
  applyResourceOp: () => {},
  setFlag: () => {},
  setStateAt: () => {},
};

/** The minimal RecommendationSystem wiring over an existing Cycle + CycleLog + BestOf. */
export function buildRecommendationStack(
  cycle: Cycle,
  cycleLog: CycleLog,
  bestOf: BestOf,
): RecommendationSystem {
  return createRecommendationSystem({
    cycle,
    cycleLog,
    bestOf,
    getCurrentSnapshot: () => ({}),
    applySnapshot: () => {},
  });
}
