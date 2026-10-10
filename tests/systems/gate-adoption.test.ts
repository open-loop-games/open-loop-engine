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
import { ref, unref } from 'vue';
import {
  Decimal,
  createChallengeCategory,
  createEngine,
  createGateRequirement,
  createPredicateResolver,
  createPurchasableCategory,
  createReset,
  createResource,
  createCostRequirement,
  evaluatePredicate,
  requirementsMet,
  type EngineModule,
  type GameStateAccessor,
  type GameStateAccessorMutator,
  type Resource,
} from '@/index';
import { createAchievement } from '@/systems/achievement';
import { createAchievementCategory } from '@/systems/achievement-category';
import { createSubjectCategory } from '@/systems/subject-category';
import { resetAllPersistentContexts } from '@/core/persistence';
import { createModifierChain } from '@/core/modifier';
import { createTickDriver } from '@/core/tick-driver';
import { createAutomationTiers } from '@/systems/automation';
import { createCycle } from '@/systems/cycle';
import { createNativeDialogRuntime } from '@/systems/dialog';
import { createProducerCategory } from '@/systems/producer-category';
import { createBankedAcceleration, createTimeBank } from '@/systems/time-bank';
import type { ChallengeDef } from '@/systems/challenge-category';
import { createManualTicks } from '../helpers/manual-ticks';

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
  const accessor: GameStateAccessorMutator = {
    getAmount: (id) => (id === 'points' ? new Decimal(points.value) : Decimal.dZero),
    getRate: (id) => rates.get(id) ?? Decimal.dZero,
    getFlag: () => false,
    getStateAt: (path) => stateMap.get(path),
    applyResourceOp: () => {},
    setFlag: () => {},
    setStateAt: (path, value) => stateMap.set(path, value),
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
        setStateAt: (path, value) => stateMap.set(path, value),
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
  setStateAt: (path: string, value: unknown) => void;
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
        goal: {
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
        goal: {
          kind: 'resource-gte',
          resource: 'points',
          value: 50,
        },
      });
      const closureAch = createAchievement({
        id: 'closure',
        display: { title: 'Closure', description: 'always' },
        goal: () => false,
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
        goal: flag,
      }),
    );

    expect(result.earned.value).toBe(false);
    flag.value = true;
    expect(result.earned.value).toBe(true);
    stop();
  });
});

// ============================================================================
// ChallengeCategory.{visible, canEnter, goal} accept Gate
// ============================================================================

describe('ChallengeCategory adoption — visible / canEnter / goal accept Gate', () => {
  it('Gate-typed goal flips canComplete reactively', () => {
    const { result, stop } = bootstrap(() => {
      const cat = createChallengeCategory<{ id: string; displayName: string; goal?: any }>({
        id: 'challenges',
        mutuallyExclusive: false,
      });
      cat.register({
        id: 'reach-50',
        displayName: 'Reach 50',
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
      const cat = createChallengeCategory<{ id: string; displayName: string; goal?: any }>({
        id: 'challenges',
        mutuallyExclusive: false,
      });
      cat.register({
        id: 'reach-25',
        displayName: 'Reach 25',
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

  it('Gate-typed visible / canEnter fields control entry', () => {
    const { result, stop } = bootstrap((api) => {
      api.points.value = 5;
      const cat = createChallengeCategory<{
        id: string;
        displayName: string;
        visible?: any;
        canEnter?: any;
        goal?: () => boolean;
      }>({
        id: 'challenges',
        mutuallyExclusive: false,
      });
      cat.register({
        id: 'locked',
        displayName: 'Locked',
        visible: { kind: 'resource-gte', resource: 'points', value: 10 },
        canEnter: { kind: 'resource-gte', resource: 'points', value: 10 },
      });
      const before = {
        visible: cat.getChallenge('locked')!.visible.value,
        canEnter: cat.getChallenge('locked')!.canEnter.value,
      };
      api.points.value = 10;
      const after = {
        visible: cat.getChallenge('locked')!.visible.value,
        canEnter: cat.getChallenge('locked')!.canEnter.value,
      };
      return { before, after };
    });

    expect(result.before).toEqual({ visible: false, canEnter: false });
    expect(result.after).toEqual({ visible: true, canEnter: true });
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

// ============================================================================
// Accessor-less engine — the cold-consumer path (studio/open-loop-engine#23)
// ============================================================================

/**
 * Bootstrap without an `accessor` in the engine config — a consumer whose gates
 * are all category-resolved has no reason to author one, and the type says it's
 * optional. `install` runs inside the engine's install ambient.
 */
function bootstrapAccessorless<T>(install: () => T): { result: T; stop: () => void } {
  let captured: T;
  let upgrades: ReturnType<typeof createPurchasableCategory<{ id: string }>>;

  const content: EngineModule = {
    id: 'content',
    install() {
      upgrades = createPurchasableCategory<{ id: string }>({
        id: 'producers',
        mapPurchasable: () => ({
          display: { description: '' },
          requirements: [],
          effect: 1,
          limit: 10,
        }),
      });
      upgrades.register({ id: 'farm' });
      upgrades.getEntry('farm')!.purchasable.count.value = new Decimal(5);
    },
  };

  const game: EngineModule = {
    id: 'game',
    dependencies: ['content'],
    install() {
      captured = install();
    },
  };

  const engine = createEngine({ gameId: 'test', persistence: false });
  engine.use(content).use(game);
  engine.start();

  return { result: captured!, stop: () => engine.stop() };
}

describe('createGateRequirement — no ambient accessor', () => {
  it('constructs and satisfies a category-only gate', () => {
    const { result, stop } = bootstrapAccessorless(() =>
      createGateRequirement({
        gate: { kind: 'count-gte', category: 'producers', entry: 'farm', value: 5 },
        description: '5 farms owned',
      }),
    );

    expect(requirementsMet([result])).toBe(true);
    stop();
  });

  it('constructs and evaluates a cumulative-gte gate through the registry alone', () => {
    const { result, stop } = bootstrapAccessorless(() => {
      const gold = createResource(0, { id: 'gold', displayName: 'gold' });
      const req = createGateRequirement({
        gate: { kind: 'cumulative-gte', resource: 'gold', value: 10 },
      });
      return { gold, req };
    });

    expect(requirementsMet([result.req])).toBe(false);
    result.gold.value = 10;
    expect(requirementsMet([result.req])).toBe(true);
    stop();
  });

  it('throws at construction for an accessor-backed gate, naming the handle', () => {
    expect(() =>
      bootstrapAccessorless(() =>
        createGateRequirement({ gate: { kind: 'flag', id: 'some-flag' } }),
      ),
    ).toThrow(/accessor/);
  });

  it('names the offending kind, not just the missing handle', () => {
    expect(() =>
      bootstrapAccessorless(() =>
        createGateRequirement({
          gate: {
            kind: 'all',
            of: [
              { kind: 'count-gte', category: 'producers', entry: 'farm', value: 1 },
              { kind: 'state', path: 'phase', operator: 'eq', value: 'idle' },
            ],
          },
        }),
      ),
    ).toThrow(/state/);
  });
});

// ============================================================================
// Registration after start() — the runtime is the category's, not the register call's
// ============================================================================

describe('Gate-accepting categories — content registered after start()', () => {
  it('an achievement registered after start() evaluates its gate', () => {
    const { result, stop } = bootstrap(() =>
      createAchievementCategory<{ id: string }>({
        id: 'milestones',
        mapAchievement: () => ({
          display: { title: 'Rich' },
          goal: { kind: 'resource-gte', resource: 'points', value: 10 },
        }),
      }),
    );

    expect(() => result.register({ id: 'late' })).not.toThrow();
    expect(result.getAchievement('late')!.canComplete.value).toBe(false);
    stop();
  });

  it('a subject registered after start() advances through its tier gate', () => {
    const { result, stop } = bootstrap((api) => {
      api.points.value = 10;
      return createSubjectCategory({
        id: 'npcs',
        fields: { trust: { kind: 'ladder', rungs: ['stranger', 'friend'] } },
      });
    });

    result.register({
      id: 'late',
      fields: { trust: { advanceWhen: [{ kind: 'resource-gte', resource: 'points', value: 10 }] } },
    });
    expect(result.get('late')!.fields.trust.tryAdvance()).toBe('friend');
    stop();
  });

  it('an explicit accessor overrides the ambient one on both categories', () => {
    const override: GameStateAccessor = {
      getAmount: () => new Decimal(1000),
      getRate: () => Decimal.dZero,
      getFlag: () => true,
      getStateAt: () => undefined,
    };
    const { result, stop } = bootstrap(() => {
      const achievements = createAchievementCategory<{ id: string }>({
        id: 'milestones',
        accessor: override,
        mapAchievement: () => ({
          display: { title: 'Flagged' },
          goal: { kind: 'flag', id: 'anything' },
        }),
      });
      achievements.register({ id: 'flagged' });
      const subjects = createSubjectCategory({
        id: 'npcs',
        accessor: override,
        fields: { trust: { kind: 'ladder', rungs: ['stranger', 'friend'] } },
      });
      subjects.register({
        id: 'rask',
        fields: {
          trust: { advanceWhen: [{ kind: 'resource-gte', resource: 'points', value: 500 }] },
        },
      });
      return { achievements, subjects };
    });

    expect(result.achievements.getAchievement('flagged')!.earned.value).toBe(true);
    expect(result.subjects.get('rask')!.fields.trust.tryAdvance()).toBe('friend');
    stop();
  });
});

// ============================================================================
// Predicate resolver — the one adoption path every predicate field goes through
// ============================================================================

describe('createPredicateResolver', () => {
  const categoryOnly = {
    kind: 'count-gte',
    category: 'producers',
    entry: 'farm',
    value: 1,
  } as const;

  it('adopts every arm to the same reactive holds', () => {
    const { result, stop } = bootstrap((api) => {
      const predicates = createPredicateResolver();
      const flag = ref(false);
      return {
        api,
        flag,
        constant: predicates.adopt(true, false, 'constant'),
        viaRef: predicates.adopt(flag, true, 'ref'),
        viaGetter: predicates.adopt(() => flag.value, true, 'getter'),
        viaGate: predicates.adopt(
          { kind: 'resource-gte', resource: 'points', value: 5 },
          true,
          'gate',
        ),
        absent: predicates.adopt(undefined, true, 'absent'),
      };
    });

    expect(result.constant.holds.value).toBe(true);
    expect(result.viaRef.holds.value).toBe(false);
    expect(result.viaGetter.holds.value).toBe(false);
    expect(result.viaGate.holds.value).toBe(false);
    expect(result.absent.holds.value).toBe(true);

    result.flag.value = true;
    result.api.points.value = 5;
    expect(result.viaRef.holds.value).toBe(true);
    expect(result.viaGetter.holds.value).toBe(true);
    expect(result.viaGate.holds.value).toBe(true);
    stop();
  });

  it('keeps the Gate for predictors and drops closures', () => {
    const gate = { kind: 'resource-gte', resource: 'points', value: 5 } as const;
    const { result, stop } = bootstrap(() => {
      const predicates = createPredicateResolver();
      return {
        gate: predicates.adopt(gate, false, 'gate'),
        getter: predicates.adopt(() => true, false, 'getter'),
      };
    });

    expect(result.gate.gate).toBe(gate);
    expect(result.getter.gate).toBeUndefined();
    stop();
  });

  it('read() evaluates a closure afresh on every call', () => {
    let open = false;
    const predicates = createPredicateResolver({});
    const adopted = predicates.adopt(() => open, false, 'polled');

    expect(adopted.read()).toBe(false);
    open = true;
    expect(adopted.read()).toBe(true);
  });

  it("throws at adopt for a Gate whose handles the runtime doesn't carry", () => {
    const predicates = createPredicateResolver({});
    expect(() => predicates.adopt({ kind: 'flag', id: 'seen' }, false, 'cutscene')).toThrow(
      /^cutscene: .*accessor/,
    );
  });

  it('resolves the runtime once, so adoption after start() still reads the handles', () => {
    const { result, stop } = bootstrapAccessorless(() => createPredicateResolver());
    expect(() => result.adopt(categoryOnly, false, 'late')).not.toThrow();
    expect(result.adopt(categoryOnly, false, 'late').holds.value).toBe(true);
    stop();
  });

  it('assert checks a Gate held elsewhere without adopting it', () => {
    const predicates = createPredicateResolver({});
    expect(() =>
      predicates.assert({ kind: 'state', path: 'k', operator: 'eq', value: 1 }, 'node'),
    ).toThrow(/^node: .*state/);
    expect(() =>
      predicates.assert({ kind: 'not', of: { kind: 'all', of: [] } }, 'node'),
    ).not.toThrow();
  });
});

describe('evaluatePredicate', () => {
  it('evaluates each arm against a runtime', () => {
    const accessor: GameStateAccessor = {
      getAmount: () => new Decimal(10),
      getRate: () => Decimal.dZero,
      getFlag: (id) => id === 'seen',
      getStateAt: () => undefined,
    };
    expect(evaluatePredicate(true, {})).toBe(true);
    expect(evaluatePredicate(ref(false), {})).toBe(false);
    expect(evaluatePredicate(() => true, {})).toBe(true);
    expect(evaluatePredicate({ kind: 'flag', id: 'seen' }, { accessor })).toBe(true);
    expect(
      evaluatePredicate({ kind: 'resource-gte', resource: 'x', value: 11 }, { accessor }),
    ).toBe(false);
  });
});

// ============================================================================
// Systems predicate fields — every field takes a Predicate, asserted at register
// ============================================================================

const pointsGte = (value: number) => ({ kind: 'resource-gte', resource: 'points', value }) as const;
const unwiredFlag = { kind: 'flag', id: 'unwired' } as const;

describe('Predicate fields — every arm reaches the system', () => {
  it('achievement visible and hidden take a Gate', () => {
    const { result, stop } = bootstrap((api) => {
      const cat = createAchievementCategory<{ id: string }>({
        id: 'milestones',
        mapAchievement: () => ({
          display: { title: 'Secret' },
          visible: pointsGte(5),
          hidden: { kind: 'not', of: pointsGte(10) },
        }),
      });
      cat.register({ id: 'secret' });
      return { api, ach: cat.getAchievement('secret')! };
    });

    expect(result.ach.visible.value).toBe(false);
    expect(result.ach.hidden.value).toBe(true);
    result.api.points.value = 10;
    expect(result.ach.visible.value).toBe(true);
    expect(result.ach.hidden.value).toBe(false);
    stop();
  });

  it('challenge visible, canEnter and goal take refs and getters', () => {
    const shown = ref(false);
    const { result, stop } = bootstrap(() => {
      const cat = createChallengeCategory<ChallengeDef>({ id: 'trials', mutuallyExclusive: false });
      cat.register({
        id: 't',
        displayName: 'T',
        visible: shown,
        canEnter: () => shown.value,
        goal: shown,
      });
      return cat.getChallenge('t')!;
    });

    expect(result.visible.value).toBe(false);
    expect(result.canEnter.value).toBe(false);
    shown.value = true;
    expect(result.visible.value).toBe(true);
    expect(result.enter()).toBe(true);
    expect(result.canComplete.value).toBe(true);
    stop();
  });

  it('reset canReset takes a getter', () => {
    let allowed = false;
    const reset = createReset({ thingsToReset: [], canReset: () => allowed });
    expect(reset.reset()).toBe(false);
    allowed = true;
    expect(reset.reset()).toBe(true);
  });

  it('cycle endCondition takes a Gate', () => {
    const ticks = createManualTicks();
    const { result, stop } = bootstrap((api) => {
      const cycle = createCycle({
        id: 'loop',
        thingsToReset: [],
        endCondition: pointsGte(3),
        registerTick: ticks.registerTick,
      });
      cycle.resume();
      return { api, cycle };
    });

    ticks.tick();
    expect(result.cycle.count.value).toBe(0);
    result.api.points.value = 3;
    ticks.tick();
    expect(result.cycle.count.value).toBe(1);
    stop();
  });

  it('automation tier requirement takes a Gate', () => {
    const { result, stop } = bootstrap((api) => ({
      api,
      tiers: createAutomationTiers({
        id: 'auto',
        tiers: [
          { id: 'manual', displayName: 'Manual', order: 0 },
          { id: 'basic', displayName: 'Basic', order: 1, unlockWhen: pointsGte(7) },
        ],
      }),
    }));

    expect(result.tiers.isUnlocked('basic')).toBe(false);
    result.api.points.value = 7;
    expect(result.tiers.isUnlocked('basic')).toBe(true);
    stop();
  });

  it('time-bank spend gate takes a Gate', () => {
    const driver = createTickDriver({ intervalRate: 20 });
    const { result, stop } = bootstrap((api) => {
      const bank = createTimeBank();
      bank.deposit(100);
      const accel = createBankedAcceleration({
        tickDriver: driver,
        bank,
        spendMultiplier: 10,
        when: pointsGte(1),
      });
      return { api, accel };
    });

    result.accel.startSpending();
    expect(driver.speedMultiplier).toBe(1);
    result.api.points.value = 1;
    driver.processInterval(0.05);
    expect(driver.speedMultiplier).toBe(10);
    result.accel.dispose();
    stop();
  });

  it('purchasable and producer visible take a Gate', () => {
    const { result, stop } = bootstrap((api) => {
      const upgrades = createPurchasableCategory<{ id: string }>({
        id: 'upgrades',
        mapPurchasable: () => ({
          display: { description: '' },
          requirements: [],
          visible: pointsGte(2),
        }),
      });
      upgrades.register({ id: 'u' });
      const producers = createProducerCategory<{ id: string }>({
        id: 'buildings',
        mapProducer: () => ({
          resource: api.points,
          baseRate: 0,
          trigger: 'continuous',
          purchase: {
            costResource: api.points,
            baseCost: 0,
            costScaling: 1,
            visible: pointsGte(2),
          },
        }),
        registerTick: () => () => {},
      });
      producers.register({ id: 'farm' });
      return {
        api,
        upgrade: upgrades.getPurchasable('u')!,
        farm: producers.getProducer('farm')!.repeatable!,
      };
    });

    expect(unref(result.upgrade.visible)).toBe(false);
    expect(unref(result.farm.visible)).toBe(false);
    result.api.points.value = 2;
    expect(unref(result.upgrade.visible)).toBe(true);
    expect(unref(result.farm.visible)).toBe(true);
    stop();
  });

  it('subject tier gates take a getter', () => {
    const open = ref(false);
    const npcs = createSubjectCategory({
      id: 'npcs',
      fields: {
        trust: { kind: 'ladder', rungs: ['stranger', 'friend'], advanceWhen: [() => open.value] },
      },
    });
    npcs.register({ id: 'rask' });
    const trust = npcs.get('rask')!.fields.trust;

    expect(trust.tryAdvance()).toBeNull();
    open.value = true;
    expect(trust.tryAdvance()).toBe('friend');
  });

  it('a grant when takes a Gate', () => {
    const chain = createModifierChain('gold-rate');
    const { result, stop } = bootstrap((api) => {
      const upgrades = createPurchasableCategory<{ id: string }>({
        id: 'upgrades',
        mapPurchasable: () => ({
          display: { description: '' },
          requirements: [],
          limit: 1,
          initialCount: 1,
          grants: [{ chain, mult: 2, description: 'Doubler', when: pointsGte(4) }],
        }),
      });
      upgrades.register({ id: 'doubler' });
      return api;
    });

    expect(Decimal.fromValue(chain.apply(1)).toNumber()).toBe(1);
    result.points.value = 4;
    expect(Decimal.fromValue(chain.apply(1)).toNumber()).toBe(2);
    stop();
  });
});

describe('Predicate fields — a Gate missing a handle throws at register, labelled', () => {
  it('achievement goal, visible and hidden', () => {
    for (const field of ['goal', 'visible', 'hidden'] as const) {
      const cat = createAchievementCategory<{ id: string }>({
        id: `a-${field}`,
        mapAchievement: () => ({ display: { title: 'A' }, [field]: unwiredFlag }),
      });
      expect(() => cat.register({ id: 'a' })).toThrow(new RegExp(`achievement 'a' ${field}: `));
    }
  });

  it('challenge visible, canEnter and goal', () => {
    for (const field of ['visible', 'canEnter', 'goal'] as const) {
      const cat = createChallengeCategory<ChallengeDef>({ id: `c-${field}` });
      expect(() => cat.register({ id: 'c', displayName: 'C', [field]: unwiredFlag })).toThrow(
        new RegExp(`challenge 'c' ${field}: `),
      );
    }
  });

  it('reset canReset, cycle endCondition, automation requirement, time-bank gate', () => {
    const ticks = createManualTicks();
    expect(() => createReset({ thingsToReset: [], canReset: unwiredFlag })).toThrow(/canReset: /);
    expect(() =>
      createCycle({
        thingsToReset: [],
        endCondition: unwiredFlag,
        registerTick: ticks.registerTick,
      }),
    ).toThrow(/endCondition: /);
    expect(() =>
      createAutomationTiers({
        tiers: [{ id: 'basic', displayName: 'Basic', order: 0, unlockWhen: unwiredFlag }],
      }),
    ).toThrow(/automation tier 'basic' unlockWhen: /);
    expect(() =>
      createBankedAcceleration({
        tickDriver: createTickDriver({ intervalRate: 20 }),
        bank: createTimeBank(),
        spendMultiplier: 2,
        when: unwiredFlag,
      }),
    ).toThrow(/gate: /);
  });

  it('purchasable visible and grant when', () => {
    const chain = createModifierChain('rate');
    const hidden = createPurchasableCategory<{ id: string }>({
      id: 'hidden',
      mapPurchasable: () => ({
        display: { description: '' },
        requirements: [],
        visible: unwiredFlag,
      }),
    });
    expect(() => hidden.register({ id: 'u' })).toThrow(/purchasable 'u' visible: /);

    const granted = createPurchasableCategory<{ id: string }>({
      id: 'granted',
      mapPurchasable: () => ({
        display: { description: '' },
        requirements: [],
        grants: [{ chain, mult: 2, description: 'Doubler', when: unwiredFlag }],
      }),
    });
    expect(() => granted.register({ id: 'u' })).toThrow(/purchasable 'u' grant 'Doubler' when: /);
  });

  it('subject tier gates', () => {
    const npcs = createSubjectCategory({
      id: 'npcs',
      fields: {
        trust: { kind: 'ladder', rungs: ['stranger', 'friend'], advanceWhen: [unwiredFlag] },
      },
    });
    expect(() => npcs.register({ id: 'rask' })).toThrow(/tier 'trust' advanceWhen\[0\]: /);
  });

  it('dialog conditions, when the runtime is built', () => {
    const noAccessor = {} as GameStateAccessor;
    expect(() =>
      createNativeDialogRuntime({
        graphs: [
          {
            id: 'g',
            entry: 'a',
            nodes: [
              {
                id: 'a',
                text: 'hi',
                when: { kind: 'count-gte', category: 'x', entry: 'y', value: 1 },
              },
            ],
          },
        ],
        accessor: noAccessor,
        mutator: { applyResourceOp: () => {}, setFlag: () => {}, setStateAt: () => {} },
      }),
    ).toThrow(/dialog 'g' node 'a' condition: /);
  });
});
