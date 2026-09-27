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
  timeUntilGateFlip,
  type EngineCategories,
  type EngineModule,
  type DecimalSource,
  type Gate,
  type GameStateAccessor,
  type GameStateAccessorMutator,
  type GateRuntime,
  type ResourceRegistry,
} from '@/index';
import { resetAllPersistentContexts } from '@/core/persistence';
import { evaluateCondition } from '@/core/conditions';
import { E } from '@/core/effects';
import {
  assertGateHandles,
  gateToCondition,
  getAmbientGateRuntime,
  getRequiredGateHandles,
} from '@/systems/gate';

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
  const accessor: GameStateAccessorMutator = {
    getResource: (id) => (id === 'points' ? new Decimal(points.value) : Decimal.dZero),
    getRate: (id) => rates.get(id) ?? Decimal.dZero,
    isUnlocked: (id) => unlocks.get(id) ?? false,
    getState: (path) => stateMap.get(path),
    applyResourceOp: () => {},
    setUnlocked: (id, value) => unlocks.set(id, value),
    setState: (path, value) => stateMap.set(path, value),
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
        mapPurchasable: () => ({
          display: { description: '' },
          requirements: [],
          effect: 1,
          limit: 5,
        }),
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
// timeUntilGateFlip — cumulative-gte against gross inflow
// ============================================================================

describe('timeUntilGateFlip — cumulative-gte', () => {
  /** The fixture's runtime, with an accessor reporting these rates for points. */
  function withRates(
    f: ReturnType<typeof buildFixture>,
    rates: { net: DecimalSource; inflow?: DecimalSource },
  ): GateRuntime {
    const base = f.runtime.accessor!;
    const accessor: GameStateAccessor = {
      ...base,
      getRate: (id) => (id === 'points' ? new Decimal(rates.net) : base.getRate(id)),
    };
    if (rates.inflow !== undefined) {
      const inflow = rates.inflow;
      accessor.getInflowRate = (id) => (id === 'points' ? new Decimal(inflow) : Decimal.dZero);
    }
    return { ...f.runtime, accessor };
  }

  // Each step writes the gain and the drain separately, as a game's producers
  // and sinks do, so the lifetime total counts only the gain. The total moves
  // in exact binary steps, so the loop's crossing time is exact and the
  // prediction lands within the final step before it.
  it.each([
    { inflow: 10, drain: 0, gap: 100 },
    { inflow: 10, drain: 4, gap: 100 },
    { inflow: 10, drain: 10, gap: 55 },
    { inflow: 3, drain: 7, gap: 20 },
    { inflow: 0.5, drain: 0.25, gap: 7.3 },
    { inflow: 1e6, drain: 3e6, gap: 4.2e7 },
  ])(
    'with an inflow rate, predicts the crossing a tick loop reaches (inflow $inflow, drain $drain)',
    ({ inflow, drain, gap }) => {
      const dt = 0.125;
      const f = buildFixture();
      f.points.value = 1e9;
      const target = Decimal.add(f.points.cumulative!.value, gap);
      const gate: Gate = { kind: 'cumulative-gte', resource: 'points', value: target };

      const predicted = timeUntilGateFlip(gate, withRates(f, { net: inflow - drain, inflow }));

      let steps = 0;
      while (!evaluateGate(gate, f.runtime)) {
        f.points.value = Decimal.add(f.points.value, inflow * dt).toNumber();
        f.points.value = Decimal.sub(f.points.value, drain * dt).toNumber();
        steps++;
      }
      const crossing = steps * dt;
      expect(predicted.reason).toBe('computed');
      expect(predicted.seconds!).toBeLessThanOrEqual(crossing);
      expect(predicted.seconds!).toBeGreaterThan(crossing - dt);
      f.stop();
    },
  );

  it('with an inflow rate, reports no-rate when nothing flows in, whatever the net', () => {
    const f = buildFixture();
    const gate: Gate = { kind: 'cumulative-gte', resource: 'points', value: 10 };
    expect(timeUntilGateFlip(gate, withRates(f, { net: 5, inflow: 0 }))).toEqual({
      seconds: null,
      reason: 'no-rate',
    });
    f.stop();
  });

  it('without an inflow rate, a net rate that is not positive leaves the flip uncomputable', () => {
    // A drain can outpace the gain while the gain still carries the lifetime
    // total over the threshold, so a stalled net rate can't rule the flip out.
    const f = buildFixture();
    const gate: Gate = { kind: 'cumulative-gte', resource: 'points', value: 10 };
    for (const net of [0, -3]) {
      expect(timeUntilGateFlip(gate, withRates(f, { net }))).toEqual({
        seconds: null,
        reason: 'uncomputable',
      });
    }
    f.stop();
  });

  it('an any-gate drops a cumulative branch with no inflow, but not one it cannot bound', () => {
    const f = buildFixture();
    f.setRate('wood', new Decimal(10));
    const gate: Gate = {
      kind: 'any',
      of: [
        { kind: 'resource-gte', resource: 'wood', value: 100 },
        { kind: 'cumulative-gte', resource: 'points', value: 10 },
      ],
    };
    expect(timeUntilGateFlip(gate, withRates(f, { net: -2, inflow: 0 }))).toEqual({
      seconds: 10,
      reason: 'computed',
    });
    // A stalled net rate says nothing about the inflow, so the cumulative
    // branch may still flip first.
    expect(timeUntilGateFlip(gate, withRates(f, { net: -2 }))).toEqual({
      seconds: null,
      reason: 'uncomputable',
    });
    f.stop();
  });

  it('a met gate never flips back under rates, however the balance drains', () => {
    const f = buildFixture();
    f.points.value = 50;
    const gate: Gate = { kind: 'cumulative-gte', resource: 'points', value: 25 };
    for (const rates of [{ net: -5 }, { net: -5, inflow: 1 }]) {
      expect(timeUntilGateFlip(gate, withRates(f, rates))).toEqual({
        seconds: null,
        reason: 'no-rate',
      });
    }
    f.stop();
  });
});

// ============================================================================
// Accessor-less engine — category-only gates owe no GameStateAccessor
// ============================================================================

/**
 * Builds an engine with **no** `accessor` in its config — the shape a consumer
 * whose gates are all category-resolved would naturally write. Resolves the
 * ambient runtime inside `install()`, exactly where an adoption site would.
 */
function buildAccessorlessFixture(): { runtime: GateRuntime; stop: () => void } {
  let runtime: GateRuntime | undefined;

  const game: EngineModule = {
    id: 'game',
    install() {
      createResource(0, { id: 'points', displayName: 'points' });
      const upgCat = createPurchasableCategory<UpgDef>({
        id: 'upgrades',
        mapPurchasable: () => ({
          display: { description: '' },
          requirements: [],
          effect: 1,
          limit: 5,
        }),
      });
      upgCat.register({ id: 'fast', name: 'Fast' });
      upgCat.getEntry('fast')!.purchasable.amount.value = bn(3);
    },
  };

  const observer: EngineModule = {
    id: 'observer',
    dependencies: ['game'],
    install() {
      runtime = getAmbientGateRuntime();
    },
  };

  const engine = createEngine({ gameId: 'test', persistence: false });
  engine.use(game).use(observer);
  engine.start();

  return { runtime: runtime!, stop: () => engine.stop() };
}

describe('evaluateGate — no ambient accessor', () => {
  it('resolves an ambient runtime without throwing', () => {
    const f = buildAccessorlessFixture();
    expect(f.runtime.accessor).toBeUndefined();
    expect(f.runtime.categories).toBeDefined();
    expect(f.runtime.registry).toBeDefined();
    f.stop();
  });

  it('evaluates count-gte and unlock against categories alone', () => {
    const f = buildAccessorlessFixture();
    expect(
      evaluateGate(
        { kind: 'count-gte', category: 'upgrades', entity: 'fast', value: 3 },
        f.runtime,
      ),
    ).toBe(true);
    expect(
      evaluateGate(
        { kind: 'count-gte', category: 'upgrades', entity: 'fast', value: 9 },
        f.runtime,
      ),
    ).toBe(false);
    expect(evaluateGate({ kind: 'unlock', category: 'upgrades', entity: 'fast' }, f.runtime)).toBe(
      true,
    );
    f.stop();
  });

  it('combinators over category-only children evaluate too', () => {
    const f = buildAccessorlessFixture();
    const gate: Gate = {
      kind: 'all',
      of: [
        { kind: 'count-gte', category: 'upgrades', entity: 'fast', value: 1 },
        { kind: 'not', of: { kind: 'count-gte', category: 'upgrades', entity: 'fast', value: 99 } },
      ],
    };
    expect(evaluateGate(gate, f.runtime)).toBe(true);
    f.stop();
  });

  it('accessor-backed kinds throw at evaluation, naming both the handle and the kind', () => {
    const f = buildAccessorlessFixture();
    for (const gate of [
      { kind: 'resource-gte', resource: 'points', value: 1 },
      { kind: 'flag', id: 'some-flag' },
      { kind: 'state', key: 'phase', operator: 'eq', value: 'idle' },
    ] as Gate[]) {
      expect(() => evaluateGate(gate, f.runtime)).toThrow(
        new RegExp(`accessor.*${gate.kind}|${gate.kind}.*accessor`),
      );
    }
    f.stop();
  });

  it('cumulative-gte evaluates without an accessor, and predicting it demands one', () => {
    const f = buildAccessorlessFixture();
    const gate: Gate = { kind: 'cumulative-gte', resource: 'points', value: 1 };
    expect(evaluateGate(gate, f.runtime)).toBe(false);
    expect(() => assertGateHandles(gate, f.runtime, 'site')).not.toThrow();
    expect(() => timeUntilGateFlip(gate, f.runtime)).toThrow(/cumulative-gte.*accessor/);
    f.stop();
  });

  it('a combinator throws only when the accessor-backed branch is actually reached', () => {
    const f = buildAccessorlessFixture();
    // `any` short-circuits on the true category leaf — the flag child never runs.
    expect(
      evaluateGate(
        {
          kind: 'any',
          of: [
            { kind: 'count-gte', category: 'upgrades', entity: 'fast', value: 1 },
            { kind: 'flag', id: 'some-flag' },
          ],
        },
        f.runtime,
      ),
    ).toBe(true);
    // `all` reaches the flag child once the category leaf passes.
    expect(() =>
      evaluateGate(
        {
          kind: 'all',
          of: [
            { kind: 'count-gte', category: 'upgrades', entity: 'fast', value: 1 },
            { kind: 'flag', id: 'some-flag' },
          ],
        },
        f.runtime,
      ),
    ).toThrow(/accessor/);
    f.stop();
  });
});

// ============================================================================
// getRequiredGateHandles — per-kind handle demand
// ============================================================================

describe('getRequiredGateHandles', () => {
  const handles = (gate: Gate) => [...getRequiredGateHandles(gate)].sort();

  it('category-aware leaves demand categories only', () => {
    expect(handles({ kind: 'count-gte', category: 'upgrades', entity: 'fast', value: 1 })).toEqual([
      'categories',
    ]);
    expect(handles({ kind: 'unlock', category: 'achievements', entity: 'first' })).toEqual([
      'categories',
    ]);
  });

  it('accessor-backed leaves demand the accessor only', () => {
    expect(handles({ kind: 'resource-gte', resource: 'gold', value: 50 })).toEqual(['accessor']);
    expect(handles({ kind: 'flag', id: 'knowledge-rask' })).toEqual(['accessor']);
    expect(handles({ kind: 'state', key: 'phase', operator: 'eq', value: 'idle' })).toEqual([
      'accessor',
    ]);
  });

  it('cumulative-gte evaluates through the registry', () => {
    expect(handles({ kind: 'cumulative-gte', resource: 'gold', value: 50 })).toEqual(['registry']);
  });

  it('combinators union their children, recursing through nesting', () => {
    const gate: Gate = {
      kind: 'all',
      of: [
        { kind: 'count-gte', category: 'upgrades', entity: 'fast', value: 1 },
        {
          kind: 'not',
          of: {
            kind: 'any',
            of: [
              { kind: 'unlock', category: 'achievements', entity: 'first' },
              { kind: 'flag', id: 'knowledge-rask' },
            ],
          },
        },
      ],
    };
    expect(handles(gate)).toEqual(['accessor', 'categories']);
  });

  it('a category-only tree demands nothing else — the accessor-free consumer case', () => {
    const gate: Gate = {
      kind: 'any',
      of: [
        { kind: 'count-gte', category: 'producers', entity: 'farm', value: 5 },
        { kind: 'unlock', category: 'upgrades', entity: 'fast' },
      ],
    };
    expect(handles(gate)).toEqual(['categories']);
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

  it('throws on cumulative-gte (the cumulative slot is read through the registry)', () => {
    expect(() => gateToCondition({ kind: 'cumulative-gte', resource: 'gold', value: 50 })).toThrow(
      /no ICondition projection/,
    );
  });

  it('E.conditional over a cumulative-gte gate fails when the effect is built', () => {
    expect(() =>
      E.conditional({ kind: 'cumulative-gte', resource: 'gold', value: 50 }, E.unlock('x')),
    ).toThrow(/no ICondition projection/);
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
