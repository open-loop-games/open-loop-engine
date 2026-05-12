/**
 * Synthetic engine factory for probe/walker profiling.
 *
 * Constructs an engine from primitives sized by `ProbeShape`. No archetype
 * glue, no beats. Auto-purchase is opt-in via `shape.autoPurchase`: when set
 * to `'payback-instant'`, attaches `setupAutoPurchaseProducers` with
 * policy `'payback-period'` and `interval=0` to reproduce b7-class shapes
 * without coupling to Producer's `interval=1` drain-loop cost.
 */

import Decimal, { type DecimalSource } from '@/primitives/decimal';
import {
  createEngine,
  createMemoryStorage,
  createResource,
  createProducerCategory,
  createPurchasableCategory,
  createModifierChain,
  createCostRequirement,
  setupAutoPurchaseProducers,
  CategoriesKey,
  type Engine,
  type EngineCategories,
  type EngineModule,
  type Resource,
  type ProducerCategory,
  type PurchasableCategory,
  type GameStateAccessor,
  type InjectionKey,
} from '@/index';
import type { ProbeShape } from './shape';

interface ProducerDef {
  id: string;
  baseRate: number;
  baseCost: number;
}

interface PurchasableDef {
  id: string;
  baseCost: number;
}

interface Handle {
  resource: Resource<DecimalSource>;
  producers: ProducerCategory<ProducerDef>;
  purchasables: PurchasableCategory<PurchasableDef>;
  predicateThreshold: Decimal;
}

const HandleKey: InjectionKey<Handle> = Symbol('probe-profile-handle');

export interface Fixture {
  engine: Engine;
  accessor: GameStateAccessor;
  predicate: (engine: Engine) => boolean;
  shape: ProbeShape;
}

export async function buildFixture(shape: ProbeShape): Promise<Fixture> {
  const engine = createEngine({
    gameId: `probe-profile-${shape.id}`,
    persistence: false,
    maxDeltaTime: shape.budgetSec,
    storageAdapter: createMemoryStorage(),
    // Isolate persistent-ref registry across fixtures — sweeps build N engines
    // in one process and every module reuses id `probe-synthetic` with
    // resource `r`, so an ambient namespace is the only way to avoid
    // cross-fixture collisions.
    persistenceNamespace: `probe-profile-${shape.id}`,
  });

  engine.use(buildSyntheticModule(shape));
  await engine.start();
  // Stop the tick loop immediately — the probe calls `simulateTick` directly
  // and a running loop would both skew measurements and keep the Node event
  // loop alive forever (blocks process exit across a shape sweep).
  engine.stop();

  const handle = engine.tryInject(HandleKey);
  if (!handle) throw new Error('probe-synthetic module did not provide handle');
  const accessor = buildAccessor(handle);
  const predicate = (): boolean => Decimal.gte(handle.resource.value, handle.predicateThreshold);

  return { engine, accessor, predicate, shape };
}

function buildSyntheticModule(shape: ProbeShape): EngineModule {
  return {
    id: 'probe-synthetic',
    install(ctx) {
      const resource = createResource<DecimalSource>(Decimal.dZero, {
        displayName: 'r',
      });

      const producerDefs: ProducerDef[] = Array.from({ length: shape.producers }, (_, i) => ({
        id: `prod-${i}`,
        baseRate: 0.1 * Math.pow(8, i % 7),
        baseCost: 10 * Math.pow(10, i % 7),
      }));

      const producers = createProducerCategory<ProducerDef>({
        id: 'probe-producers',
        registerTick: ctx.onTick,
        mapProducer: (def) => ({
          resource,
          trigger: 'continuous',
          baseRate: def.baseRate,
          display: def.id,
          purchase: {
            costResource: resource,
            baseCost: def.baseCost,
            costScaling: 1.15,
          },
        }),
      });
      producers.register(producerDefs);

      if (shape.blastRadius === 'wide') {
        const shared = createModifierChain('probe-shared');
        for (const { producer } of producers.getAll()) {
          producer.rateChain.add(shared);
        }
      }

      if (shape.initialRate === 'nonzero') {
        const prior = resource.value;
        resource.value = Decimal.fromNumber(1e60);
        for (const { producer } of producers.getAll()) {
          producer.repeatable?.purchase(1);
        }
        resource.value = prior;
        // Preload cleanliness guard: confirm seed window left no residual
        // resource balance and each producer owns exactly 1. If this trips,
        // the seed-and-rewind trick has been perturbed by a reactive side
        // effect (e.g. a tick handler mutating resource during purchase).
        if (!Decimal.eq(resource.value, prior)) {
          throw new Error('probe fixture: preload did not restore resource.value');
        }
        for (const { producer } of producers.getAll()) {
          if (!Decimal.eq(producer.count.value, 1)) {
            throw new Error(
              `probe fixture: expected producer count=1 after preload, got ${producer.count.value.toString()}`,
            );
          }
        }
      }

      const purchasableDefs: PurchasableDef[] = Array.from(
        { length: shape.purchasables },
        (_, i) => ({
          id: `purch-${i}`,
          baseCost: 10 * Math.pow(10, i % 7),
        }),
      );

      const purchasables = createPurchasableCategory<PurchasableDef>({
        id: 'probe-purchasables',
        mapPurchasable: (def) => ({
          display: { title: def.id, description: def.id },
          requirements: createCostRequirement({ resource, cost: def.baseCost }),
        }),
      });
      purchasables.register(purchasableDefs);

      if (shape.autoPurchase === 'payback-instant') {
        // Policy and interval chosen to isolate probe-layer cost: payback-period
        // matches Producer's bot, interval=0 eliminates the drain-loop cost so
        // wall time is attributable to probe overhead alone.
        setupAutoPurchaseProducers(
          producers,
          { enabled: true, policy: 'payback-period', interval: 0, bulkAmount: 1 },
          ctx.onTick,
        );
      }

      const predicateThreshold = computeThreshold(shape, producerDefs);

      ctx.provide(CategoriesKey, {
        producers: [producers],
        purchasables: [purchasables],
      } as EngineCategories);

      ctx.provide(HandleKey, {
        resource,
        producers,
        purchasables,
        predicateThreshold,
      });
    },
  };
}

function computeThreshold(shape: ProbeShape, defs: ProducerDef[]): Decimal {
  const totalRate = defs.reduce((s, d) => s + d.baseRate, 0);
  const reachable = Math.max(1, totalRate * shape.budgetSec);
  switch (shape.costRegime) {
    case 'always-affordable':
      return Decimal.fromNumber(reachable * 0.1);
    case 'boundary':
      return Decimal.fromNumber(reachable);
    case 'never-affordable':
      return Decimal.fromNumber(reachable * 1000);
  }
}

function buildAccessor(handle: Handle): GameStateAccessor {
  return {
    getResource: (id) =>
      id === handle.resource.id ? Decimal.fromValue(handle.resource.value) : Decimal.dZero,
    getRate: (id) => {
      if (id !== handle.resource.id) return Decimal.dZero;
      let total = Decimal.dZero;
      for (const { producer } of handle.producers.getAll()) {
        if (producer.trigger !== 'continuous') continue;
        total = Decimal.add(total, Decimal.mul(producer.computedRate.value, producer.count.value));
      }
      return total;
    },
    isUnlocked: () => true,
    getState: () => undefined,
  };
}
