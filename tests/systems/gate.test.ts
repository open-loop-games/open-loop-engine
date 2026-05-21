import { describe, it, expect, beforeEach } from 'vitest';
import {
  CategoriesKey,
  Decimal,
  Formula,
  ResourceRegistryKey,
  bn,
  createAchievementCategory,
  createChallengeCategory,
  createEngine,
  createProducerCategory,
  createPurchasableCategory,
  createResource,
  createSkillCategory,
  evaluateGate,
  gateToCondition,
  timeUntilGateFlip,
  type EngineCategories,
  type EngineModule,
  type Gate,
  type GameStateAccessor,
  type GateRuntime,
  type ResourceRegistry,
} from '@/index';
import { resetAllPersistentContexts } from '@/core/persistence';
import { evaluateCondition } from '@/core/conditions';

beforeEach(() => {
  resetAllPersistentContexts();
});

interface AchDef {
  id: string;
  name: string;
}
interface UpgDef {
  id: string;
  name: string;
}
interface SkillDef {
  id: string;
  name: string;
}
interface ProdDef {
  id: string;
}
interface ChalDef {
  id: string;
  name: string;
  goal?: () => boolean;
}

// ---------------------------------------------------------------------------
// Test fixture: a five-category engine with one entity per category. Returns
// the runtime bundle plus the entries so tests can mutate state.
// ---------------------------------------------------------------------------

function buildFixture(): {
  runtime: GateRuntime;
  achEntry: ReturnType<ReturnType<typeof createAchievementCategory<AchDef>>['getEntry']>;
  upgEntry: ReturnType<ReturnType<typeof createPurchasableCategory<UpgDef>>['getEntry']>;
  skillEntry: ReturnType<ReturnType<typeof createSkillCategory<SkillDef>>['getEntry']>;
  prodEntry: ReturnType<ReturnType<typeof createProducerCategory<ProdDef>>['getEntry']>;
  chalEntry: ReturnType<ReturnType<typeof createChallengeCategory<ChalDef>>['getEntry']>;
  points: ReturnType<typeof createResource<number>>;
  setRate: (id: string, rate: Decimal) => void;
  setUnlocked: (id: string, value: boolean) => void;
  setState: (path: string, value: unknown) => void;
  stop: () => void;
} {
  let categories: EngineCategories | undefined;
  let registry: ResourceRegistry | undefined;
  let achCat: ReturnType<typeof createAchievementCategory<AchDef>>;
  let upgCat: ReturnType<typeof createPurchasableCategory<UpgDef>>;
  let skillCat: ReturnType<typeof createSkillCategory<SkillDef>>;
  let prodCat: ReturnType<typeof createProducerCategory<ProdDef>>;
  let chalCat: ReturnType<typeof createChallengeCategory<ChalDef>>;
  let points: ReturnType<typeof createResource<number>>;

  // Mutable accessor backing — tests poke rates / unlocks / state through here.
  const rates = new Map<string, Decimal>();
  const unlocks = new Map<string, boolean>();
  const stateMap = new Map<string, unknown>();
  const accessor: GameStateAccessor = {
    getResource: (id) => (id === 'points' ? new Decimal(points.value) : Decimal.dZero),
    getRate: (id) => rates.get(id) ?? Decimal.dZero,
    isUnlocked: (id) => unlocks.get(id) ?? false,
    getState: (path) => stateMap.get(path),
  };

  const game: EngineModule = {
    id: 'game',
    install() {
      points = createResource(0, { id: 'points', displayName: 'points' });

      achCat = createAchievementCategory<AchDef>({
        id: 'achievements',
        mapAchievement: (def) => ({ display: { title: def.name } }),
      });
      achCat.register({ id: 'first', name: 'First' });

      upgCat = createPurchasableCategory<UpgDef>({
        id: 'upgrades',
        mapPurchasable: () => ({ display: {}, requirements: [], effect: 1, limit: 5 }),
      });
      upgCat.register({ id: 'fast', name: 'Fast' });

      skillCat = createSkillCategory<SkillDef>({
        id: 'skills',
        mapSkill: () => ({
          xpToLevel: (xp) => Formula.variable(xp),
          levelToMultiplier: (level) => Formula.variable(level),
        }),
      });
      skillCat.register({ id: 'combat', name: 'Combat' });

      prodCat = createProducerCategory<ProdDef>({
        id: 'producers',
        mapProducer: () => ({ resource: points, baseRate: 1, trigger: 'manual' }),
        registerTick: () => () => {},
      });
      prodCat.register({ id: 'click' });

      chalCat = createChallengeCategory<ChalDef>({ id: 'challenges', mutuallyExclusive: false });
      chalCat.register({ id: 'no-x', name: 'No X', goal: () => true });
    },
  };

  const observer: EngineModule = {
    id: 'observer',
    dependencies: ['game'],
    install(ctx) {
      categories = ctx.tryInject(CategoriesKey);
      registry = ctx.tryInject(ResourceRegistryKey);
    },
  };

  const engine = createEngine({ gameId: 'test', persistence: false, accessor });
  engine.use(game).use(observer);
  engine.start();

  return {
    runtime: { accessor, categories: categories!, registry: registry! },
    achEntry: achCat!.getEntry('first'),
    upgEntry: upgCat!.getEntry('fast'),
    skillEntry: skillCat!.getEntry('combat'),
    prodEntry: prodCat!.getEntry('click'),
    chalEntry: chalCat!.getEntry('no-x'),
    points: points!,
    setRate: (id, rate) => rates.set(id, rate),
    setUnlocked: (id, value) => unlocks.set(id, value),
    setState: (path, value) => stateMap.set(path, value),
    stop: () => engine.stop(),
  };
}

// ============================================================================
// evaluateGate — per-kind dispatch
// ============================================================================

describe('evaluateGate — per-kind dispatch', () => {
  it('resource-gte reads the accessor', () => {
    const f = buildFixture();
    f.points.value = 50;
    expect(evaluateGate({ kind: 'resource-gte', resource: 'points', value: 49 }, f.runtime)).toBe(
      true,
    );
    expect(evaluateGate({ kind: 'resource-gte', resource: 'points', value: 51 }, f.runtime)).toBe(
      false,
    );
    f.stop();
  });

  it('cumulative-gte reads resource.cumulative', () => {
    const f = buildFixture();
    f.points.value = 10;
    f.points.value = 25; // cumulative accumulates: +10 then +15 = 25
    expect(evaluateGate({ kind: 'cumulative-gte', resource: 'points', value: 25 }, f.runtime)).toBe(
      true,
    );
    expect(evaluateGate({ kind: 'cumulative-gte', resource: 'points', value: 26 }, f.runtime)).toBe(
      false,
    );
    f.stop();
  });

  it('count-gte reads CategoryEntrySignals.count', () => {
    const f = buildFixture();
    f.upgEntry!.purchasable.amount.value = 3;
    expect(
      evaluateGate(
        { kind: 'count-gte', category: 'upgrades', entity: 'fast', value: 3 },
        f.runtime,
      ),
    ).toBe(true);
    expect(
      evaluateGate(
        { kind: 'count-gte', category: 'upgrades', entity: 'fast', value: 4 },
        f.runtime,
      ),
    ).toBe(false);
    f.stop();
  });

  it('unlock reads CategoryEntrySignals.unlock', () => {
    const f = buildFixture();
    expect(
      evaluateGate({ kind: 'unlock', category: 'achievements', entity: 'first' }, f.runtime),
    ).toBe(false);
    f.achEntry!.achievement.complete();
    expect(
      evaluateGate({ kind: 'unlock', category: 'achievements', entity: 'first' }, f.runtime),
    ).toBe(true);
    f.stop();
  });

  it('state delegates to compareState via accessor.getState', () => {
    const f = buildFixture();
    f.setState('phase', 'idle');
    expect(
      evaluateGate({ kind: 'state', key: 'phase', operator: 'eq', value: 'idle' }, f.runtime),
    ).toBe(true);
    expect(
      evaluateGate({ kind: 'state', key: 'phase', operator: 'neq', value: 'idle' }, f.runtime),
    ).toBe(false);

    f.setState('progress', 7);
    expect(
      evaluateGate({ kind: 'state', key: 'progress', operator: 'gte', value: 5 }, f.runtime),
    ).toBe(true);
    expect(
      evaluateGate({ kind: 'state', key: 'progress', operator: 'lt', value: 5 }, f.runtime),
    ).toBe(false);
    f.stop();
  });

  it('flag reads accessor.isUnlocked by flat id', () => {
    const f = buildFixture();
    expect(evaluateGate({ kind: 'flag', id: 'knowledge-rask' }, f.runtime)).toBe(false);
    f.setUnlocked('knowledge-rask', true);
    expect(evaluateGate({ kind: 'flag', id: 'knowledge-rask' }, f.runtime)).toBe(true);
    f.stop();
  });

  it('unknown category id evaluates to false (does not throw)', () => {
    const f = buildFixture();
    expect(
      evaluateGate(
        { kind: 'count-gte', category: 'fictional', entity: 'whatever', value: 1 },
        f.runtime,
      ),
    ).toBe(false);
    expect(
      evaluateGate({ kind: 'unlock', category: 'fictional', entity: 'whatever' }, f.runtime),
    ).toBe(false);
    f.stop();
  });

  it('unknown entity id evaluates to false (does not throw)', () => {
    const f = buildFixture();
    expect(
      evaluateGate(
        { kind: 'count-gte', category: 'upgrades', entity: 'ghost', value: 1 },
        f.runtime,
      ),
    ).toBe(false);
    f.stop();
  });

  it('cumulative-gte on unregistered resource throws', () => {
    const f = buildFixture();
    expect(() =>
      evaluateGate({ kind: 'cumulative-gte', resource: 'unknown', value: 1 }, f.runtime),
    ).toThrow(/no resource 'unknown' registered/);
    f.stop();
  });
});

// ============================================================================
// evaluateGate — combinators
// ============================================================================

describe('evaluateGate — combinators', () => {
  it('all is true iff every child is true', () => {
    const f = buildFixture();
    f.points.value = 50;
    f.upgEntry!.purchasable.amount.value = 2;

    const both: Gate = {
      kind: 'all',
      of: [
        { kind: 'resource-gte', resource: 'points', value: 49 },
        { kind: 'count-gte', category: 'upgrades', entity: 'fast', value: 2 },
      ],
    };
    expect(evaluateGate(both, f.runtime)).toBe(true);

    f.upgEntry!.purchasable.amount.value = 1;
    expect(evaluateGate(both, f.runtime)).toBe(false);
    f.stop();
  });

  it('any is true iff some child is true', () => {
    const f = buildFixture();
    const either: Gate = {
      kind: 'any',
      of: [
        { kind: 'resource-gte', resource: 'points', value: 100 },
        { kind: 'unlock', category: 'achievements', entity: 'first' },
      ],
    };
    expect(evaluateGate(either, f.runtime)).toBe(false);
    f.achEntry!.achievement.complete();
    expect(evaluateGate(either, f.runtime)).toBe(true);
    f.stop();
  });

  it('not negates the child', () => {
    const f = buildFixture();
    const negated: Gate = {
      kind: 'not',
      of: { kind: 'unlock', category: 'achievements', entity: 'first' },
    };
    expect(evaluateGate(negated, f.runtime)).toBe(true);
    f.achEntry!.achievement.complete();
    expect(evaluateGate(negated, f.runtime)).toBe(false);
    f.stop();
  });
});

// ============================================================================
// timeUntilGateFlip — dispatch table
// ============================================================================

describe('timeUntilGateFlip — dispatch table', () => {
  it('resource-gte projects to ICondition predictor (computed when rate > 0)', () => {
    const f = buildFixture();
    f.points.value = 0;
    f.setRate('points', new Decimal(10));
    const dist = timeUntilGateFlip(
      { kind: 'resource-gte', resource: 'points', value: 100 },
      f.runtime,
    );
    expect(dist.reason).toBe('computed');
    expect(dist.seconds).toBe(10);
    f.stop();
  });

  it('cumulative-gte projects through the cumulative ref (computed when rate > 0)', () => {
    const f = buildFixture();
    f.points.value = 5;
    f.setRate('points', new Decimal(5));
    const dist = timeUntilGateFlip(
      { kind: 'cumulative-gte', resource: 'points', value: 25 },
      f.runtime,
    );
    expect(dist.reason).toBe('computed');
    // cumulative currently 5 (5 was the increase), needs 25, rate 5 → 20/5 = 4s
    expect(dist.seconds).toBe(4);
    f.stop();
  });

  it('count-gte / unlock / state / flag are opaque-predicate', () => {
    const f = buildFixture();
    expect(
      timeUntilGateFlip(
        { kind: 'count-gte', category: 'upgrades', entity: 'fast', value: 1 },
        f.runtime,
      ).reason,
    ).toBe('opaque-predicate');
    expect(
      timeUntilGateFlip({ kind: 'unlock', category: 'achievements', entity: 'first' }, f.runtime)
        .reason,
    ).toBe('opaque-predicate');
    expect(
      timeUntilGateFlip({ kind: 'state', key: 'phase', operator: 'eq', value: 'idle' }, f.runtime)
        .reason,
    ).toBe('opaque-predicate');
    expect(timeUntilGateFlip({ kind: 'flag', id: 'knowledge-rask' }, f.runtime).reason).toBe(
      'opaque-predicate',
    );
    f.stop();
  });

  it('combinator with mixed rate-aware + category leaves degrades correctly', () => {
    const f = buildFixture();
    f.points.value = 0;
    f.setRate('points', new Decimal(10));

    // AND currently-false (both children false) → max-over-false-children's
    // flip-to-true distances. resource-gte is computed (10s); count-gte is
    // opaque-predicate (null, opaque-predicate). Expect null propagation.
    const mixed: Gate = {
      kind: 'all',
      of: [
        { kind: 'resource-gte', resource: 'points', value: 100 },
        { kind: 'count-gte', category: 'upgrades', entity: 'fast', value: 1 },
      ],
    };
    const dist = timeUntilGateFlip(mixed, f.runtime);
    expect(dist.reason).toBe('opaque-predicate');
    expect(dist.seconds).toBeNull();
    f.stop();
  });

  it('not delegates to the inner Gate distance', () => {
    const f = buildFixture();
    f.points.value = 0;
    f.setRate('points', new Decimal(10));
    const dist = timeUntilGateFlip(
      { kind: 'not', of: { kind: 'resource-gte', resource: 'points', value: 100 } },
      f.runtime,
    );
    expect(dist.reason).toBe('computed');
    expect(dist.seconds).toBe(10);
    f.stop();
  });
});

// ============================================================================
// gateToCondition — partial projection
// ============================================================================

describe('gateToCondition — partial projection', () => {
  it('rate-aware leaf → ResourceCondition', () => {
    expect(gateToCondition({ kind: 'resource-gte', resource: 'gold', value: 50 })).toEqual({
      type: 'resource',
      target: 'gold',
      operator: 'gte',
      value: 50,
    });
  });

  it('cumulative-gte projects to a ResourceCondition over <id>:cumulative', () => {
    expect(gateToCondition({ kind: 'cumulative-gte', resource: 'gold', value: 50 })).toEqual({
      type: 'resource',
      target: 'gold:cumulative',
      operator: 'gte',
      value: 50,
    });
  });

  it('state → StateCondition', () => {
    expect(gateToCondition({ kind: 'state', key: 'phase', operator: 'eq', value: 'idle' })).toEqual(
      { type: 'state', target: 'phase', operator: 'eq', value: 'idle' },
    );
  });

  it('flag → UnlockCondition (1:1, name-preserving projection)', () => {
    expect(gateToCondition({ kind: 'flag', id: 'knowledge-rask' })).toEqual({
      type: 'unlock',
      target: 'knowledge-rask',
    });
  });

  it('rate-aware all/any/not round-trips through evaluateCondition', () => {
    const gate: Gate = {
      kind: 'all',
      of: [
        { kind: 'resource-gte', resource: 'gold', value: 50 },
        {
          kind: 'not',
          of: { kind: 'state', key: 'phase', operator: 'eq', value: 'starting' },
        },
      ],
    };
    const projected = gateToCondition(gate);
    const accessor: GameStateAccessor = {
      getResource: (id) => (id === 'gold' ? bn(75) : bn(0)),
      getRate: () => Decimal.dZero,
      isUnlocked: () => false,
      getState: () => 'mid',
    };
    expect(evaluateCondition(projected, accessor)).toBe(true);
  });

  it('throws on count-gte', () => {
    expect(() =>
      gateToCondition({ kind: 'count-gte', category: 'upgrades', entity: 'fast', value: 1 }),
    ).toThrow(/no ICondition projection/);
  });

  it('throws on unlock (category-aware)', () => {
    expect(() =>
      gateToCondition({ kind: 'unlock', category: 'achievements', entity: 'first' }),
    ).toThrow(/no ICondition projection/);
  });

  it('throws when a category descendant is buried inside a combinator', () => {
    const gate: Gate = {
      kind: 'all',
      of: [
        { kind: 'resource-gte', resource: 'gold', value: 1 },
        { kind: 'count-gte', category: 'upgrades', entity: 'fast', value: 1 },
      ],
    };
    expect(() => gateToCondition(gate)).toThrow(/no ICondition projection/);
  });
});

// ============================================================================
// Lifetime round-trip — γ convention
// ============================================================================

describe('cumulative convention — resource.cumulative slot', () => {
  it('createResource populates resource.cumulative and resource.best automatically', () => {
    let res: ReturnType<typeof createResource<number>>;
    const game: EngineModule = {
      id: 'g',
      install() {
        res = createResource(0, { id: 'r', displayName: 'r' });
        expect(res.cumulative).toBeDefined();
        expect(res.best).toBeDefined();
        expect(res.cumulative!.value).toBe(0);
        expect(res.best!.value).toBe(0);
      },
    };
    const engine = createEngine({ gameId: 't', persistence: false });
    engine.use(game);
    engine.start();
    engine.stop();
  });
});
