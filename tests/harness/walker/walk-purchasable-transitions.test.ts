import { describe, it, expect, beforeEach } from 'vitest';
import { CategoriesKey, createEngine, type EngineCategories, type EngineModule } from '@/index';
import { createResource } from '@/core/resource';
import { createCostRequirement, createBooleanRequirement } from '@/core/requirements';
import { createPurchasableCategory } from '@/systems/purchasable-category';
import { resetAllPersistentContexts } from '@/core/persistence';
import { bn } from '@/primitives/decimal';
import { ref } from 'vue';
import type { GameStateAccessor } from '@/primitives/types';
import { walkPurchasableTransitions } from '@/harness/walker/walk-purchasable-transitions';

beforeEach(() => {
  resetAllPersistentContexts();
});

function mockAccessor(
  config: {
    resources?: Record<string, number>;
    rates?: Record<string, number>;
    unlocks?: Record<string, boolean>;
    state?: Record<string, unknown>;
  } = {},
): GameStateAccessor {
  const resources = config.resources ?? {};
  const rates = config.rates ?? {};
  const unlocks = config.unlocks ?? {};
  const state = config.state ?? {};
  return {
    getResource: (id) => bn(resources[id] ?? 0),
    isUnlocked: (id) => unlocks[id] ?? false,
    getState: (path) => state[path],
    getRate: (id) => bn(rates[id] ?? 0),
  };
}

interface UpgradeDef {
  id: string;
  cost: number;
  limit?: number;
}

/**
 * Build a minimal engine that publishes a single purchasable category under
 * `CategoriesKey.purchasables`. Returns the engine and the created category
 * so tests can drive purchases and registry changes before walking.
 */
function buildEngineWithPurchasables(
  gameId: string,
  categoryId: string,
  resourceName: string,
  resourceInitial: number,
  defs: UpgradeDef[],
  extra?: {
    visibility?: (def: UpgradeDef) => boolean;
    extraRequirements?: (
      def: UpgradeDef,
      resource: ReturnType<typeof createResource>,
    ) => ReturnType<typeof createCostRequirement>[];
  },
) {
  const handle: {
    category?: ReturnType<typeof createPurchasableCategory<UpgradeDef>>;
    resource?: ReturnType<typeof createResource>;
  } = {};
  const module: EngineModule = {
    id: 'purchasables-mod',
    install(ctx) {
      const resource = createResource(resourceInitial, {
        id: resourceName,
        displayName: resourceName,
      });
      handle.resource = resource;
      const category = createPurchasableCategory<UpgradeDef>({
        id: categoryId,
        mapPurchasable: (def) => ({
          display: { description: def.id },
          requirements: [
            createCostRequirement({ resource, cost: def.cost }),
            ...(extra?.extraRequirements?.(def, resource) ?? []),
          ],
          limit: def.limit ?? 1,
          visibility: extra?.visibility?.(def) ?? true,
        }),
      });
      handle.category = category;
      category.register(defs);
      ctx.provide(CategoriesKey, { purchasables: [category] } as EngineCategories);
    },
  };
  const engine = createEngine({ gameId, persistence: false });
  engine.use(module);
  engine.start();
  return { engine, ...handle } as {
    engine: ReturnType<typeof createEngine>;
    category: ReturnType<typeof createPurchasableCategory<UpgradeDef>>;
    resource: ReturnType<typeof createResource>;
  };
}

// ---------------------------------------------------------------------------
// Empty / degenerate inputs
// ---------------------------------------------------------------------------

describe('walkPurchasableTransitions — discovery degradation', () => {
  it('returns [] when CategoriesKey is not provided', () => {
    const engine = createEngine({ gameId: 'wpt-empty', persistence: false });
    engine.start();
    expect(walkPurchasableTransitions(engine, mockAccessor())).toEqual([]);
  });

  it('returns [] when purchasables slice is empty', () => {
    const module: EngineModule = {
      id: 'empty-mod',
      install(ctx) {
        ctx.provide(CategoriesKey, { purchasables: [] } as EngineCategories);
      },
    };
    const engine = createEngine({ gameId: 'wpt-empty-slice', persistence: false });
    engine.use(module);
    engine.start();
    expect(walkPurchasableTransitions(engine, mockAccessor())).toEqual([]);
  });

  it('ignores non-purchasable category slices', () => {
    const module: EngineModule = {
      id: 'mixed-mod',
      install(ctx) {
        ctx.provide(CategoriesKey, {
          purchasables: [],
          resources: [], // irrelevant slice, should be ignored
        } as EngineCategories);
      },
    };
    const engine = createEngine({ gameId: 'wpt-mixed', persistence: false });
    engine.use(module);
    engine.start();
    expect(walkPurchasableTransitions(engine, mockAccessor())).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// becomes-affordable — computed distance
// ---------------------------------------------------------------------------

describe('walkPurchasableTransitions — becomes-affordable', () => {
  it('emits computed distance when a rate source is feeding the cost resource', () => {
    // gold at 40, rate +2/s, cost 100 → (100-40)/2 = 30s.
    const accessor = mockAccessor({ resources: { gold: 40 }, rates: { gold: 2 } });
    const { engine } = buildEngineWithPurchasables('wpt-afford', 'upgrades', 'gold', 40, [
      { id: 'double', cost: 100 },
    ]);

    const out = walkPurchasableTransitions(engine, accessor);
    const affordable = out.filter((t) => t.kind === 'becomes-affordable');
    expect(affordable).toHaveLength(1);
    expect(affordable[0].source).toBe('purchasable');
    expect(affordable[0].categoryId).toBe('upgrades');
    expect(affordable[0].entityId).toBe('double');
    expect(affordable[0].label).toBe('upgrades.double.becomes-affordable');
    expect(affordable[0].currentValue).toEqual(bn(40));
    expect(affordable[0].distance.reason).toBe('computed');
    expect(affordable[0].distance.seconds).toBe(30);
  });

  it('emits no-rate when current < cost and there is no rate source', () => {
    const accessor = mockAccessor({ resources: { gold: 40 }, rates: { gold: 0 } });
    const { engine } = buildEngineWithPurchasables('wpt-no-rate', 'upgrades', 'gold', 40, [
      { id: 'double', cost: 100 },
    ]);

    const out = walkPurchasableTransitions(engine, accessor);
    const affordable = out.filter((t) => t.kind === 'becomes-affordable');
    expect(affordable).toHaveLength(1);
    expect(affordable[0].distance.reason).toBe('no-rate');
    expect(affordable[0].distance.seconds).toBeNull();
  });

  it('emits zero-distance when already affordable (current >= cost)', () => {
    const accessor = mockAccessor({ resources: { gold: 200 }, rates: { gold: 5 } });
    const { engine } = buildEngineWithPurchasables('wpt-already', 'upgrades', 'gold', 200, [
      { id: 'double', cost: 100 },
    ]);

    const out = walkPurchasableTransitions(engine, accessor);
    const affordable = out.filter((t) => t.kind === 'becomes-affordable');
    expect(affordable).toHaveLength(1);
    expect(affordable[0].distance.reason).toBe('computed');
    expect(affordable[0].distance.seconds).toBe(0);
    // currentValue is the cost resource's amount as the accessor reports it.
    expect(affordable[0].currentValue).toEqual(bn(200));
  });

  // Regression: when a resource has distinct `id` and `displayName` (the
  // realistic case — stable id, human-readable label), the walker must key
  // the accessor by `id`. Before the fix it passed `displayName` and the
  // accessor returned zero for the unknown key, collapsing every distance to
  // `null` / 'no-rate'.
  it('keys accessor by resource.id when id and displayName diverge', () => {
    const accessor = mockAccessor({ resources: { cookies: 40 }, rates: { cookies: 2 } });
    const module: EngineModule = {
      id: 'divergent-id-mod',
      install(ctx) {
        const resource = createResource(40, { id: 'cookies', displayName: 'Cookies' });
        const category = createPurchasableCategory<UpgradeDef>({
          id: 'upgrades',
          mapPurchasable: (def) => ({
            display: { description: def.id },
            requirements: [createCostRequirement({ resource, cost: def.cost })],
            limit: def.limit ?? 1,
            visibility: true,
          }),
        });
        category.register([{ id: 'double', cost: 100 }]);
        ctx.provide(CategoriesKey, { purchasables: [category] } as EngineCategories);
      },
    };
    const engine = createEngine({ gameId: 'wpt-divergent-id', persistence: false });
    engine.use(module);
    engine.start();

    const out = walkPurchasableTransitions(engine, accessor);
    const affordable = out.filter((t) => t.kind === 'becomes-affordable');
    expect(affordable).toHaveLength(1);
    expect(affordable[0].distance.reason).toBe('computed');
    expect(affordable[0].distance.seconds).toBe(30); // (100 - 40) / 2
  });
});

// ---------------------------------------------------------------------------
// Skips: maxed, already bought (one-shot), missing cost requirement
// ---------------------------------------------------------------------------

describe('walkPurchasableTransitions — skip conditions', () => {
  it('skips a one-shot purchasable that has already been bought', () => {
    const accessor = mockAccessor({ resources: { gold: 500 }, rates: { gold: 2 } });
    const { engine, category } = buildEngineWithPurchasables(
      'wpt-bought',
      'upgrades',
      'gold',
      500,
      [{ id: 'double', cost: 100, limit: 1 }],
    );
    category.getPurchasable('double')!.purchase();

    const out = walkPurchasableTransitions(engine, accessor);
    expect(out.filter((t) => t.kind === 'becomes-affordable')).toHaveLength(0);
    expect(out.filter((t) => t.kind === 'purchasable-maxed')).toHaveLength(0);
  });

  it('skips a leveled purchasable that has reached its limit', () => {
    const accessor = mockAccessor({ resources: { gold: 10_000 }, rates: { gold: 10 } });
    const { engine, category } = buildEngineWithPurchasables(
      'wpt-maxed',
      'upgrades',
      'gold',
      10_000,
      [{ id: 'lvls', cost: 100, limit: 3 }],
    );
    // Purchase enough to hit the limit.
    const p = category.getPurchasable('lvls')!;
    p.purchase(1);
    p.purchase(1);
    p.purchase(1);

    const out = walkPurchasableTransitions(engine, accessor);
    expect(out).toHaveLength(0);
  });

  it('skips purchasables that have no cost requirement (boolean-only gate)', () => {
    const accessor = mockAccessor();
    // Category whose purchasables cost nothing — opaque to the walker by design.
    const flag = ref(false);
    const module: EngineModule = {
      id: 'bool-only-mod',
      install(ctx) {
        const category = createPurchasableCategory<{ id: string }>({
          id: 'flags',
          mapPurchasable: () => ({
            display: { description: 'flag' },
            requirements: createBooleanRequirement(flag, 'must flip'),
            limit: 1,
          }),
        });
        category.register([{ id: 'flip-me' }]);
        ctx.provide(CategoriesKey, { purchasables: [category] } as EngineCategories);
      },
    };
    const engine = createEngine({ gameId: 'wpt-bool', persistence: false });
    engine.use(module);
    engine.start();

    const out = walkPurchasableTransitions(engine, accessor);
    expect(out).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// purchasable-maxed (edge case, falls out of the affordability math)
// ---------------------------------------------------------------------------

describe('walkPurchasableTransitions — purchasable-maxed', () => {
  it('emits purchasable-maxed alongside becomes-affordable on the last buyable level', () => {
    const accessor = mockAccessor({ resources: { gold: 40 }, rates: { gold: 2 } });
    const { engine, category } = buildEngineWithPurchasables(
      'wpt-last',
      'upgrades',
      'gold',
      1_000, // real resource high enough that the two pre-purchases succeed
      [{ id: 'lvls', cost: 100, limit: 3 }],
    );
    const p = category.getPurchasable('lvls')!;
    // Bring amount to limit - 1 (== 2). Next purchase would cap at 3.
    p.purchase(1);
    p.purchase(1);

    const out = walkPurchasableTransitions(engine, accessor);
    const affordable = out.find((t) => t.kind === 'becomes-affordable')!;
    const maxed = out.find((t) => t.kind === 'purchasable-maxed')!;
    expect(affordable).toBeDefined();
    expect(maxed).toBeDefined();
    expect(maxed.distance).toEqual(affordable.distance);
    expect(maxed.currentValue).toEqual(bn(2));
    expect(maxed.label).toBe('upgrades.lvls.purchasable-maxed');
  });

  it('does not emit purchasable-maxed for uncapped purchasables (limit: Infinity)', () => {
    // Omitting `limit` defaults to 1 in our helper, so wire an explicit Infinity.
    const accessor = mockAccessor({ resources: { gold: 40 }, rates: { gold: 2 } });
    const module: EngineModule = {
      id: 'inf-mod',
      install(ctx) {
        const gold = createResource(40, { id: 'gold', displayName: 'gold' });
        const category = createPurchasableCategory<{ id: string; cost: number }>({
          id: 'upgrades',
          mapPurchasable: (def) => ({
            display: { description: def.id },
            requirements: createCostRequirement({ resource: gold, cost: def.cost }),
            limit: Infinity,
          }),
        });
        category.register([{ id: 'forever', cost: 100 }]);
        ctx.provide(CategoriesKey, { purchasables: [category] } as EngineCategories);
      },
    };
    const engine = createEngine({ gameId: 'wpt-inf', persistence: false });
    engine.use(module);
    engine.start();

    const out = walkPurchasableTransitions(engine, accessor);
    expect(out.filter((t) => t.kind === 'becomes-affordable')).toHaveLength(1);
    expect(out.filter((t) => t.kind === 'purchasable-maxed')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Visibility — task default: skip-when-opaque (no emission at all)
// ---------------------------------------------------------------------------

describe('walkPurchasableTransitions — visibility is opaque', () => {
  it('emits becomes-affordable even when the purchasable is currently hidden', () => {
    // visibility: Computable<boolean> has no mechanical flip distance, so the
    // walker neither blocks nor annotates on it — hidden purchasables still
    // surface via their cost transition.
    const accessor = mockAccessor({ resources: { gold: 40 }, rates: { gold: 2 } });
    const { engine } = buildEngineWithPurchasables(
      'wpt-hidden',
      'upgrades',
      'gold',
      40,
      [{ id: 'double', cost: 100 }],
      { visibility: () => false },
    );

    const out = walkPurchasableTransitions(engine, accessor);
    expect(out.filter((t) => t.kind === 'becomes-affordable')).toHaveLength(1);
    expect(out.filter((t) => t.kind === 'visibility-reveal')).toHaveLength(0);
  });
});
