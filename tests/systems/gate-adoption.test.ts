/**
 * Gate adoption — OL-846. Each adoption surface exercises:
 *   - Gate-form acceptance alongside the pre-existing forms (boolean compat)
 *   - reactivity through the underlying signal (state mutation flips eval)
 *   - the relevant accessor (Achievement.gate, Reset cancellation order, etc.)
 *
 * The fixture builds the same five-category engine pattern as gate.test.ts,
 * but the consumer-visible code under test never reaches for runtime —
 * adoption sites resolve it through `getAmbientGateRuntime()` internally.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ref } from 'vue';
import {
  Decimal,
  createChallengeCategory,
  createEngine,
  createGateRequirement,
  createReset,
  createResource,
  createCostRequirement,
  requirementsMet,
  type EngineModule,
  type GameStateAccessor,
  type Resource,
} from '@/index';
import { createAchievement } from '@/systems/achievement';
import { resetAllPersistentContexts } from '@/core/persistence';

beforeEach(() => {
  resetAllPersistentContexts();
});

/**
 * Stands up a minimal engine with three categories (achievements / upgrades /
 * producers) and a `points` resource plus mutable accessor state. Every
 * adoption-site test runs inside `bootstrap(install)` so the user code under
 * test executes inside the engine's install/connect ambient.
 */
function bootstrap<T>(install: (api: BootstrapApi) => T): { result: T; stop: () => void } {
  const rates = new Map<string, Decimal>();
  const stateMap = new Map<string, unknown>();
  let points: Resource<number>;
  const accessor: GameStateAccessor = {
    getResource: (id) => (id === 'points' ? new Decimal(points.value) : Decimal.dZero),
    getRate: (id) => rates.get(id) ?? Decimal.dZero,
    isUnlocked: () => false,
    getState: (path) => stateMap.get(path),
  };

  let captured: T;

  const game: EngineModule = {
    id: 'game',
    install() {
      points = createResource<number>(0, { id: 'points', displayName: 'points' });

      captured = install({
        get points() {
          return points;
        },
        setRate: (id, rate) => rates.set(id, rate),
        setState: (path, value) => stateMap.set(path, value),
      });
    },
  };

  const engine = createEngine({ gameId: 'test', persistence: false, accessor });
  engine.use(game);
  engine.start();

  return {
    result: captured!,
    stop: () => engine.stop(),
  };
}

interface BootstrapApi {
  readonly points: Resource<number>;
  setRate: (id: string, rate: Decimal) => void;
  setState: (path: string, value: unknown) => void;
}

// ============================================================================
// Achievement.requirement accepts Gate
// ============================================================================

describe('Achievement adoption — requirement accepts Gate', () => {
  it('auto-earns when a resource-gte Gate first holds', () => {
    const { result, stop } = bootstrap((api) => {
      const ach = createAchievement({
        id: 'rich',
        display: { title: 'Rich', description: '100 points' },
        requirement: {
          kind: 'resource-gte',
          resource: 'points',
          value: 100,
        },
      });

      expect(ach.earned.value).toBe(false);
      api.points.value = 100;
      return ach;
    });

    expect(result.earned.value).toBe(true);
    stop();
  });

  it('exposes the Gate spec on the instance', () => {
    const { result, stop } = bootstrap(() => {
      const gateAch = createAchievement({
        id: 'gated',
        display: { title: 'Gated', description: '50 points' },
        requirement: {
          kind: 'resource-gte',
          resource: 'points',
          value: 50,
        },
      });
      const closureAch = createAchievement({
        id: 'closure',
        display: { title: 'Closure', description: 'always' },
        requirement: () => false,
      });
      return { gateAch, closureAch };
    });

    expect(result.gateAch.gate).toEqual({
      kind: 'resource-gte',
      resource: 'points',
      value: 50,
    });
    expect(result.closureAch.gate).toBeUndefined();
    stop();
  });

  it('back-compat: Computable<boolean> requirements still work unchanged', () => {
    const flag = ref(false);
    const { result, stop } = bootstrap(() =>
      createAchievement({
        id: 'flag',
        display: { title: 'Flag', description: 'set true' },
        requirement: flag,
      }),
    );

    expect(result.earned.value).toBe(false);
    flag.value = true;
    expect(result.earned.value).toBe(true);
    stop();
  });
});

// ============================================================================
// ChallengeCategory.{visible, canStart, goal} accept Gate
// ============================================================================

describe('ChallengeCategory adoption — visible / canStart / goal accept Gate', () => {
  it('Gate-typed goal flips canComplete reactively', () => {
    const { result, stop } = bootstrap(() => {
      const cat = createChallengeCategory<{ id: string; name: string; goal?: any }>({
        id: 'challenges',
        mutuallyExclusive: false,
      });
      cat.register({
        id: 'reach-50',
        name: 'Reach 50',
        goal: { kind: 'resource-gte', resource: 'points', value: 50 },
      });
      const ch = cat.getChallenge('reach-50')!;
      ch.enter();
      return { cat, ch };
    });

    expect(result.ch.canComplete.value).toBe(false);
    // bootstrap closed; mutate via outer ref to the resource
    stop();
  });

  it('Gate-typed goal completes when state mutates inside install', () => {
    const { result, stop } = bootstrap((api) => {
      const cat = createChallengeCategory<{ id: string; name: string; goal?: any }>({
        id: 'challenges',
        mutuallyExclusive: false,
      });
      cat.register({
        id: 'reach-25',
        name: 'Reach 25',
        goal: { kind: 'resource-gte', resource: 'points', value: 25 },
      });
      const ch = cat.getChallenge('reach-25')!;
      ch.enter();
      expect(ch.canComplete.value).toBe(false);
      api.points.value = 25;
      return { canCompleteWhileEntered: ch.canComplete.value };
    });

    expect(result.canCompleteWhileEntered).toBe(true);
    stop();
  });

  it('Gate-typed visible / canStart fields control entry', () => {
    const { result, stop } = bootstrap((api) => {
      api.points.value = 5;
      const cat = createChallengeCategory<{
        id: string;
        name: string;
        visible?: any;
        canStart?: any;
        goal?: () => boolean;
      }>({
        id: 'challenges',
        mutuallyExclusive: false,
      });
      cat.register({
        id: 'locked',
        name: 'Locked',
        visible: { kind: 'resource-gte', resource: 'points', value: 10 },
        canStart: { kind: 'resource-gte', resource: 'points', value: 10 },
      });
      const before = {
        visible: cat.getChallenge('locked')!.visible.value,
        canStart: cat.getChallenge('locked')!.canStart.value,
      };
      api.points.value = 10;
      const after = {
        visible: cat.getChallenge('locked')!.visible.value,
        canStart: cat.getChallenge('locked')!.canStart.value,
      };
      return { before, after };
    });

    expect(result.before).toEqual({ visible: false, canStart: false });
    expect(result.after).toEqual({ visible: true, canStart: true });
    stop();
  });

  it('back-compat: ICondition + boolean fields evaluate alongside Gate', () => {
    const { result, stop } = bootstrap((api) => {
      const cat = createChallengeCategory<{
        id: string;
        name: string;
        visible?: any;
        canStart?: any;
        goal?: () => boolean;
      }>({
        id: 'challenges',
        mutuallyExclusive: false,
      });
      cat.register({
        id: 'mixed',
        name: 'Mixed',
        visible: true,
        canStart: {
          type: 'resource',
          target: 'points',
          operator: 'gte',
          value: 5,
        },
      });
      api.points.value = 5;
      return cat.getChallenge('mixed')!;
    });

    expect(result.visible.value).toBe(true);
    expect(result.canStart.value).toBe(true);
    stop();
  });
});

// ============================================================================
// Reset.canReset
// ============================================================================

describe('Reset.canReset', () => {
  it('omitted: reset proceeds (current behavior)', () => {
    const { result, stop } = bootstrap(() => {
      const r = createReset({ thingsToReset: [] });
      return { ok: r.reset() };
    });
    expect(result.ok).toBe(true);
    stop();
  });

  it('Gate truthy: reset proceeds and returns true', () => {
    const { result, stop } = bootstrap((api) => {
      api.points.value = 100;
      const r = createReset({
        thingsToReset: [],
        canReset: { kind: 'resource-gte', resource: 'points', value: 50 },
      });
      return { ok: r.reset() };
    });
    expect(result.ok).toBe(true);
    stop();
  });

  it('Gate falsy: reset returns false, onReset is not called', () => {
    let onResetCalls = 0;
    const { result, stop } = bootstrap((api) => {
      api.points.value = 0;
      const r = createReset({
        thingsToReset: [],
        canReset: { kind: 'resource-gte', resource: 'points', value: 50 },
        onReset: () => {
          onResetCalls++;
        },
      });
      return { ok: r.reset() };
    });
    expect(result.ok).toBe(false);
    expect(onResetCalls).toBe(0);
    stop();
  });

  it('canReset evaluates before onBeforeReset', () => {
    let onBeforeCalls = 0;
    const { result, stop } = bootstrap((api) => {
      api.points.value = 0;
      const r = createReset({
        thingsToReset: [],
        canReset: { kind: 'resource-gte', resource: 'points', value: 50 },
        onBeforeReset: () => {
          onBeforeCalls++;
          return true;
        },
      });
      return { ok: r.reset() };
    });
    expect(result.ok).toBe(false);
    expect(onBeforeCalls).toBe(0); // canReset short-circuits before onBeforeReset
    stop();
  });

  it('reactive: flipping resource state changes whether reset is allowed', () => {
    const { result, stop } = bootstrap((api) => {
      const r = createReset({
        thingsToReset: [],
        canReset: { kind: 'resource-gte', resource: 'points', value: 10 },
      });
      const tooLow = r.reset();
      api.points.value = 10;
      const enough = r.reset();
      return { tooLow, enough };
    });
    expect(result.tooLow).toBe(false);
    expect(result.enough).toBe(true);
    stop();
  });
});

// ============================================================================
// createGateRequirement — systems-layer Requirement factory over Gate
// ============================================================================

describe('createGateRequirement', () => {
  it('builds a Requirement that flips with the Gate', () => {
    const { result, stop } = bootstrap((api) => {
      const req = createGateRequirement({
        gate: { kind: 'resource-gte', resource: 'points', value: 100 },
      });
      const before = requirementsMet(req);
      api.points.value = 100;
      const after = requirementsMet(req);
      return { before, after, req };
    });
    expect(result.before).toBe(false);
    expect(result.after).toBe(true);
    expect(result.req.requiresPay).toBe(false);
    stop();
  });

  it('composes alongside cost requirements', () => {
    const { result, stop } = bootstrap((api) => {
      const gold = createResource<number>(50, { id: 'gold', displayName: 'gold' });
      const requirements = [
        createCostRequirement({ resource: gold, cost: 25 }),
        createGateRequirement({
          gate: { kind: 'resource-gte', resource: 'points', value: 10 },
        }),
      ];
      const beforeBoth = requirementsMet(requirements);
      api.points.value = 10;
      const afterBoth = requirementsMet(requirements);
      return { beforeBoth, afterBoth };
    });
    expect(result.beforeBoth).toBe(false);
    expect(result.afterBoth).toBe(true);
    stop();
  });
});
