/**
 * Proves the in-install pattern composes with `createSensitivityCell` +
 * `defaultAnalyzerPack` + `runSensitivity` end-to-end.
 *
 * The toy module creates its `gold` resource inside `install()` — the exact
 * shape every real game uses. Per-run engines get their own fresh refs via
 * the engine-owned resource registry; `defaultAnalyzerPack` walks that
 * registry inside each `setup()`, and the variant perturbs the per-run chain
 * so the baseline vs. variant delta is observable on the `resource-peak:gold`
 * metric.
 */

import { describe, it, expect } from 'vitest';
import {
  addResource,
  applyPerturbation,
  createCycle,
  createCycleLog,
  createPickerSnapshot,
  createSensitivityCell,
  ChainRegistryKey,
  createEngine,
  createModifierChain,
  createMultiplicativeModifier,
  createResource,
  defaultAnalyzerPack,
  CycleLogKey,
  runMatrix,
  runSensitivity,
  type Engine,
  type EngineModule,
} from '@/index';

const GOLD_NAME = 'gold';
const CHAIN_ID = 'toy/rate';

function stripTimestamp(blob: string): string {
  const parsed = JSON.parse(blob) as Record<string, unknown>;
  delete parsed.timestamp;
  return JSON.stringify(parsed);
}

function createMapStorage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => m.set(k, v),
    removeItem: (k: string) => m.delete(k),
  };
}

function createToyModule(): EngineModule {
  return {
    id: 'toy',
    install(ctx) {
      const gold = createResource(0, { id: GOLD_NAME, displayName: GOLD_NAME });
      const chain = createModifierChain(CHAIN_ID);
      chain.add(createMultiplicativeModifier({ multiplier: 1 }));
      ctx.onTick(() => {
        addResource(gold, chain.apply(1));
      });
    },
  };
}

function buildSourceEngine(): Engine {
  const engine = createEngine({
    gameId: 'in-install-source',
    persistenceNamespace: `in-install-${Math.random().toString(36).slice(2)}`,
    storageAdapter: createMapStorage(),
    persistence: true,
  });
  engine.use(createToyModule());
  engine.start();
  return engine;
}

describe('in-install sensitivity integration', () => {
  it('delivers positive resource-peak deltas for a scalar-multiply variant built from in-install resources', () => {
    const source = buildSourceEngine();
    const blob = source.saveManager!.exportSave();
    const blobBefore = stripTimestamp(blob);

    const baseline = createSensitivityCell({
      name: 'baseline',
      saveBlob: blob,
      modules: () => [createToyModule()],
      buildAnalyzers: (engine) => defaultAnalyzerPack(engine),
      tick: (engine) => engine.tickDriver.stepOnce(),
      ticks: 20,
    });

    const variant = createSensitivityCell({
      name: 'variant',
      saveBlob: blob,
      modules: () => [createToyModule()],
      perturb: (engine) => {
        const registry = engine.tryInject(ChainRegistryKey);
        const chain = registry?.get(CHAIN_ID);
        expect(chain).toBeDefined();
        chain!.add(createMultiplicativeModifier({ multiplier: 3 }));
      },
      buildAnalyzers: (engine) => defaultAnalyzerPack(engine),
      tick: (engine) => engine.tickDriver.stepOnce(),
      ticks: 20,
    });

    const result = runSensitivity({
      baseline,
      variants: [{ name: 'variant', patch: () => variant }],
      seeds: [1, 2],
    });

    const metricPeak = `resource-peak:${GOLD_NAME}.peak`;
    const metricFinal = `resource-peak:${GOLD_NAME}.final`;

    const baselinePeak = result.baseline.aggregate.metrics[metricPeak];
    const variantPeak = result.variants[0]!.cell.aggregate.metrics[metricPeak];
    const peakDelta = result.variants[0]!.deltas[metricPeak];
    const finalDelta = result.variants[0]!.deltas[metricFinal];

    expect(baselinePeak).toBeDefined();
    expect(variantPeak).toBeDefined();
    expect(baselinePeak!.avg).toBeGreaterThan(0);
    expect(variantPeak!.avg).toBeGreaterThan(baselinePeak!.avg);
    expect(peakDelta!.absolute).toBeGreaterThan(0);
    expect(peakDelta!.relative).toBeGreaterThan(0);
    expect(finalDelta!.absolute).toBeGreaterThan(0);

    expect(stripTimestamp(source.saveManager!.exportSave())).toBe(blobBefore);

    source.stop();
  });

  it('chain-apply perturbation against an initially-empty chain yields a measurable sensitivity delta', () => {
    // Mirrors the creep-vs-creep shape: a chain registered empty at install
    // time and populated later. The workbench picker lists the chain via its
    // chain-apply entry, and `applyPerturbation` appends a scalar wrapper so
    // the variant diverges from baseline without requiring a sentinel
    // modifier on the consumer side.
    const EMPTY_CHAIN_ID = 'toy/empty-rate';

    function makeEmptyChainModule(): EngineModule {
      return {
        id: 'toy-empty',
        install(ctx) {
          const gold = createResource(0, { id: GOLD_NAME, displayName: GOLD_NAME });
          createModifierChain(EMPTY_CHAIN_ID);
          ctx.onTick(() => {
            const chain = ctx.tryInject(ChainRegistryKey)?.get(EMPTY_CHAIN_ID);
            addResource(gold, chain ? chain.apply(1) : 1);
          });
        },
      };
    }

    const source = createEngine({
      gameId: 'empty-chain-source',
      persistenceNamespace: `empty-chain-${Math.random().toString(36).slice(2)}`,
      storageAdapter: createMapStorage(),
      persistence: true,
    });
    source.use(makeEmptyChainModule());
    source.start();

    // Walk the source engine for the chain-apply entry — identical to how
    // BalanceWorkbench surfaces the picker to users.
    const snapshot = createPickerSnapshot(source);
    const entry = snapshot.all.find((e) => e.label === `${EMPTY_CHAIN_ID}[*]`)!;
    expect(entry).toBeDefined();

    const blob = source.saveManager!.exportSave();

    const baseline = createSensitivityCell({
      name: 'baseline',
      saveBlob: blob,
      modules: () => [makeEmptyChainModule()],
      buildAnalyzers: (engine) => defaultAnalyzerPack(engine),
      tick: (engine) => engine.tickDriver.stepOnce(),
      ticks: 20,
    });

    const variant = createSensitivityCell({
      name: 'variant',
      saveBlob: blob,
      modules: () => [makeEmptyChainModule()],
      perturb: (engine) => {
        applyPerturbation(engine, entry, { kind: 'scalar-multiply', factor: 5 });
      },
      buildAnalyzers: (engine) => defaultAnalyzerPack(engine),
      tick: (engine) => engine.tickDriver.stepOnce(),
      ticks: 20,
    });

    const result = runSensitivity({
      baseline,
      variants: [{ name: 'variant', patch: () => variant }],
      seeds: [1, 2],
    });

    const metric = `resource-peak:${GOLD_NAME}.final`;
    const baselineFinal = result.baseline.aggregate.metrics[metric]!.avg;
    const variantFinal = result.variants[0]!.cell.aggregate.metrics[metric]!.avg;
    const delta = result.variants[0]!.deltas[metric]!;

    // Baseline chain is empty → identity → 1 per tick → 20 after 20 ticks.
    // Variant wraps chain-apply with ×5 → 5 per tick → 100 after 20 ticks.
    expect(baselineFinal).toBe(20);
    expect(variantFinal).toBe(100);
    expect(delta.absolute).toBe(80);
    expect(delta.relative).toBeCloseTo(4.0);

    source.stop();
  });

  it('createSensitivityCell auto-binds onCycleFinalize when the engine publishes a CycleLog', () => {
    // Receipt for the workbench dead-wire fix: defaultAnalyzerPack ships
    // createCycleFinalizeTracker when CycleLogKey is published, and the cell
    // setup auto-subscribes any onCycleFinalize hook via log.on('finalize', ...).
    // Before the auto-bind, this metric was silently zero in every workbench run.
    const TICKS_PER_LOOP = 5;
    const LOOPS = 3;
    const TOTAL_TICKS = TICKS_PER_LOOP * LOOPS;

    function createLoopGoldModule(): EngineModule {
      return {
        id: 'cycle-gold',
        install(ctx) {
          const gold = createResource(0, { id: GOLD_NAME, displayName: GOLD_NAME });
          let tickIndex = 0;
          let loopTickHandler: ((dt: number) => void) | null = null;
          const cycle = createCycle({
            endCondition: () => tickIndex > 0 && tickIndex % TICKS_PER_LOOP === 0,
            thingsToReset: [gold],
            registerTick: (cb) => {
              loopTickHandler = cb;
              return () => {
                loopTickHandler = null;
              };
            },
          });
          const log = createCycleLog({ cycle, metrics: { gold } });
          ctx.provide(CycleLogKey, log);
          ctx.onTick((dt) => {
            tickIndex += 1;
            addResource(gold, 1);
            loopTickHandler?.(dt);
          });
          cycle.run();
        },
      };
    }

    const source = createEngine({
      gameId: 'cycle-receipt-source',
      persistenceNamespace: `cycle-receipt-${Math.random().toString(36).slice(2)}`,
      storageAdapter: createMapStorage(),
      persistence: true,
    });
    source.use(createLoopGoldModule());
    source.start();

    const blob = source.saveManager!.exportSave();

    const cell = createSensitivityCell({
      name: 'cycle',
      saveBlob: blob,
      modules: () => [createLoopGoldModule()],
      buildAnalyzers: (engine) => defaultAnalyzerPack(engine),
      tick: (engine) => engine.tickDriver.stepOnce(),
      ticks: TOTAL_TICKS,
    });

    const result = runMatrix({ cells: [cell], seeds: [1] });

    const loopsMetric = result.cells[0]!.aggregate.metrics['cycle-finalize.cycles'];
    expect(loopsMetric).toBeDefined();
    expect(loopsMetric!.avg).toBe(LOOPS);

    source.stop();
  });
});
