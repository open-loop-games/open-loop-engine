import { describe, it, expect, beforeEach } from 'vitest';
import { createEngine, type EngineModule } from '@/index';
import { createChallengeCategory } from '@/systems/challenge-category';
import { createTransitionSnapshot } from '@/harness/walker';
import { createResource } from '@/core/resource';
import { createProducerCategory } from '@/systems/producer-category';
import { resetAllPersistentContexts } from '@/core/persistence';
import { bn } from '@/primitives/decimal';
import { walkProducerTransitions } from '@/harness/walker/walk-producer-transitions';
import { mockAccessor } from './incremental-snapshot-fixture';

beforeEach(() => {
  resetAllPersistentContexts();
});

interface BuildingDef {
  id: string;
  baseRate: number;
  baseCost: number;
  limit?: number;
}

interface ManualDef {
  id: string;
  baseRate: number;
}

/**
 * Build a minimal engine that publishes a single producer category (with a
 * purchase config) under `CategoriesKey.producers`. Returns the engine and
 * the created category so tests can drive rate-chain changes before walking.
 *
 * The cost resource is the same as the produced resource (Cookie Clicker
 * shape): `cookies` pays for `cursor` and `cookies` are produced. Tests
 * drive the accessor's `cookies` rate directly to exercise the walker.
 */
function buildEngineWithProducers(
  gameId: string,
  categoryId: string,
  resourceName: string,
  defs: BuildingDef[],
) {
  const handle: {
    category?: ReturnType<typeof createProducerCategory<BuildingDef>>;
    resource?: ReturnType<typeof createResource>;
  } = {};
  const module: EngineModule = {
    id: 'producers-mod',
    install(ctx) {
      const resource = createResource(0, { id: resourceName, displayName: resourceName });
      handle.resource = resource;
      const category = createProducerCategory<BuildingDef>({
        id: categoryId,
        mapProducer: (def) => ({
          resource,
          baseRate: def.baseRate,
          trigger: 'continuous',
          purchase: {
            costResource: resource,
            baseCost: def.baseCost,
            costScaling: 1.15,
            limit: def.limit,
          },
        }),
        registerTick: ctx.onTick,
      });
      handle.category = category;
      category.register(defs);
    },
  };
  const engine = createEngine({ gameId, persistence: false });
  engine.use(module);
  engine.start();
  return { engine, ...handle } as {
    engine: ReturnType<typeof createEngine>;
    category: ReturnType<typeof createProducerCategory<BuildingDef>>;
    resource: ReturnType<typeof createResource>;
  };
}

/**
 * Build a single manual producer with no purchase config — covers the
 * "no repeatable, no emission" branch.
 */
function buildEngineWithManualProducer(gameId: string, categoryId: string) {
  const handle: { category?: ReturnType<typeof createProducerCategory<ManualDef>> } = {};
  const module: EngineModule = {
    id: 'manual-mod',
    install(ctx) {
      const resource = createResource(0, { id: 'clicks', displayName: 'clicks' });
      const category = createProducerCategory<ManualDef>({
        id: categoryId,
        mapProducer: (def) => ({
          resource,
          baseRate: def.baseRate,
          trigger: 'manual',
        }),
        registerTick: ctx.onTick,
      });
      handle.category = category;
      category.register([{ id: 'click', baseRate: 1 }]);
    },
  };
  const engine = createEngine({ gameId, persistence: false });
  engine.use(module);
  engine.start();
  return { engine, ...handle } as {
    engine: ReturnType<typeof createEngine>;
    category: ReturnType<typeof createProducerCategory<ManualDef>>;
  };
}

// ---------------------------------------------------------------------------
// Empty / degenerate inputs
// ---------------------------------------------------------------------------

describe('walkProducerTransitions — discovery degradation', () => {
  it('returns [] when the engine built no categories', () => {
    const engine = createEngine({ gameId: 'wpd-empty', persistence: false });
    engine.start();
    expect(walkProducerTransitions(engine, mockAccessor())).toEqual([]);
  });

  it('returns [] when the producer category holds no defs', () => {
    const { engine } = buildEngineWithProducers('wpd-empty-slice', 'buildings', 'gold', []);
    expect(walkProducerTransitions(engine, mockAccessor())).toEqual([]);
  });

  it('ignores non-producer category slices', () => {
    const engine = createEngine({ gameId: 'wpd-mixed', persistence: false });
    engine.use({
      id: 'challenge-mod',
      install() {
        createChallengeCategory({ id: 'trials', accessor: mockAccessor() }).register({
          id: 'bronze',
          displayName: 'Bronze',
          canEnter: { kind: 'resource-gte', resource: 'gems', value: 5 },
          goal: () => false,
        });
      },
    });
    engine.start();
    expect(createTransitionSnapshot(engine, mockAccessor()).challenges).not.toEqual([]);
    expect(walkProducerTransitions(engine, mockAccessor())).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// producer-becomes-affordable — computed distance
// ---------------------------------------------------------------------------

describe('walkProducerTransitions — producer-becomes-affordable (computed)', () => {
  it('emits a computed distance derived from the cost resource rate', () => {
    // cost=10, cookies rate=2/s → (10 - 0) / 2 = 5s.
    const { engine } = buildEngineWithProducers('wpd-finite', 'buildings', 'cookies', [
      { id: 'cursor', baseRate: 1, baseCost: 10 },
    ]);
    const accessor = mockAccessor({ resources: { cookies: 0 }, rates: { cookies: 2 } });

    const out = walkProducerTransitions(engine, accessor);
    expect(out).toHaveLength(1);

    const t = out[0];
    expect(t.walker).toBe('producer');
    expect(t.kind).toBe('producer-becomes-affordable');
    expect(t.categoryId).toBe('buildings');
    expect(t.defId).toBe('cursor');
    expect(t.key).toBe('buildings.cursor.producer-becomes-affordable');
    expect(t.distance.reason).toBe('computed');
    expect(t.distance.seconds).toBe(5);
  });

  it('emits seconds: 0 when the player already has enough of the cost resource', () => {
    // cost=10, cookies=20 (already affordable) → timeUntilResource returns 0.
    const { engine } = buildEngineWithProducers('wpd-already', 'buildings', 'cookies', [
      { id: 'cursor', baseRate: 1, baseCost: 10 },
    ]);
    const accessor = mockAccessor({ resources: { cookies: 20 }, rates: { cookies: 2 } });

    const out = walkProducerTransitions(engine, accessor);
    expect(out).toHaveLength(1);
    expect(out[0].distance.reason).toBe('computed');
    expect(out[0].distance.seconds).toBe(0);
    // currentValue is the cost resource's amount, not the owned count.
    expect(out[0].currentValue).toEqual(bn(20));
  });

  it('accessor resource/rate drives the distance, not the producer instance ref', () => {
    // The walker no longer reads `producer.purchaseBeatSeconds` — the
    // distance reflects accessor-reported cost-resource rate. Drive two
    // producers with the same cost from one accessor to verify they report
    // the same distance regardless of their own production rates.
    const { engine } = buildEngineWithProducers('wpd-accessor', 'buildings', 'cookies', [
      { id: 'slow', baseRate: 1, baseCost: 100 },
      { id: 'fast', baseRate: 100, baseCost: 100 },
    ]);
    const accessor = mockAccessor({ resources: { cookies: 0 }, rates: { cookies: 10 } });

    const out = walkProducerTransitions(engine, accessor);
    const bySlow = out.find((t) => t.defId === 'slow')!;
    const byFast = out.find((t) => t.defId === 'fast')!;
    expect(bySlow.distance.seconds).toBe(10);
    expect(byFast.distance.seconds).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// producer-becomes-affordable — no-rate branches
// ---------------------------------------------------------------------------

describe('walkProducerTransitions — producer-becomes-affordable (no-rate)', () => {
  it('emits null / no-rate when the cost resource has rate = 0', () => {
    // Unowned producer on a fresh engine: no income on the cost resource,
    // cost > current → timeUntilResource returns { seconds: null, reason:
    // 'no-rate' }. This is the `count = 0` soundness case: degenerate on
    // the prior walker, null / no-rate here.
    const { engine } = buildEngineWithProducers('wpd-zero', 'buildings', 'cookies', [
      { id: 'grandma', baseRate: 1, baseCost: 100 },
    ]);
    const accessor = mockAccessor({ resources: { cookies: 0 }, rates: { cookies: 0 } });

    const out = walkProducerTransitions(engine, accessor);
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('producer-becomes-affordable');
    expect(out[0].distance.seconds).toBeNull();
    expect(out[0].distance.reason).toBe('no-rate');
  });
});

// ---------------------------------------------------------------------------
// Maxed repeatable — no emission
// ---------------------------------------------------------------------------

describe('walkProducerTransitions — maxed skip', () => {
  it('skips a producer whose repeatable has reached its limit', () => {
    const { engine, category } = buildEngineWithProducers('wpd-maxed', 'buildings', 'cookies', [
      { id: 'mill', baseRate: 1, baseCost: 10, limit: 1 },
    ]);
    const repeatable = category.getProducer('mill')!.repeatable!;
    repeatable.count.value = 1;
    expect(repeatable.maxed.value).toBe(true);

    const accessor = mockAccessor({ resources: { cookies: 1000 }, rates: { cookies: 2 } });
    expect(walkProducerTransitions(engine, accessor)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// No repeatable — no emission
// ---------------------------------------------------------------------------

describe('walkProducerTransitions — no-repeatable skip', () => {
  it('skips manual producers that have no repeatable (no purchase config)', () => {
    const { engine, category } = buildEngineWithManualProducer('wpd-manual', 'clicks');
    // Sanity: the producer exists and has no repeatable, so nothing to emit.
    expect(category.getProducer('click')!.repeatable).toBeUndefined();

    const out = walkProducerTransitions(engine, mockAccessor());
    expect(out).toEqual([]);
  });
});
