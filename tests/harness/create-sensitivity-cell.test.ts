import { describe, it, expect, vi } from 'vitest';
import { createEngine, persistent, type Engine, type EngineModule } from '@/index';
import { bindPersistenceNamespace, getPersistentRefs } from '@/core/persistence';
import type { Analyzer, AnalyzerResult } from '@/primitives/types';
import { createSensitivityCell, runMatrix, runSensitivity, type RunContext } from '@/harness';

// A minimal module that holds a single `gold` persistent ref and ticks it.
// The closure captures the ref so perturbs + analyzers can reach it, but
// each call to `makeGoldModule()` is a fresh instance — required for the
// per-run module factory contract.
function makeGoldModule(initial: number) {
  const refs: { gold?: ReturnType<typeof persistent<number>> } = {};
  const mod: EngineModule = {
    id: 'economy',
    install() {
      refs.gold = persistent(initial, { name: 'gold' });
    },
  };
  return { mod, refs };
}

function createMapStorage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => m.set(k, v),
    removeItem: (k: string) => m.delete(k),
  };
}

function makeLiveSave(gold: number): string {
  const live = createEngine({
    gameId: 'live-game',
    persistenceNamespace: `live-${Math.random().toString(36).slice(2)}`,
    storageAdapter: createMapStorage(),
    persistence: true,
  });
  const { mod, refs } = makeGoldModule(0);
  live.use(mod);
  live.start();
  refs.gold!.value = gold;
  const blob = live.saveManager!.exportSave();
  live.stop();
  return blob;
}

// Analyzer that samples a gold ref resolved lazily via a getter — lets
// the test bind to whichever engine the cell is currently running.
function createGoldPeakAnalyzer(getGold: () => number): Analyzer {
  let peak = 0;
  return {
    name: 'gold-peak',
    onTick: () => {
      const v = getGold();
      if (v > peak) peak = v;
    },
    summarize: (): AnalyzerResult => ({
      name: 'gold-peak',
      metrics: { peak },
    }),
  };
}

describe('createEngineFromSave', () => {
  it("runs modules' onLoad hooks, so derived state rebuilds from the save", async () => {
    const { createEngineFromSave } = await import('@/harness/create-engine');
    let derived = -1;
    const { mod, refs } = makeGoldModule(0);
    const withHook: EngineModule = {
      id: mod.id,
      install(ctx) {
        mod.install(ctx);
        ctx.onLoad(() => {
          derived = refs.gold!.value * 2;
        });
      },
    };
    const engine = createEngineFromSave({
      saveText: makeLiveSave(21),
      modules: [withHook],
      persistenceNamespace: 'from-save-onload',
    });
    expect(derived).toBe(42);
    engine.dispose();
  });

  it('releases the namespace of a failed import, so the next call under it succeeds', async () => {
    const { createEngineFromSave } = await import('@/harness/create-engine');
    const good = makeLiveSave(7);
    const corrupt = JSON.stringify({ ...JSON.parse(good), data: 'not-a-save' });
    expect(() =>
      createEngineFromSave({
        saveText: corrupt,
        modules: [makeGoldModule(0).mod],
        persistenceNamespace: 'from-save-retry',
      }),
    ).toThrow(/failed to import/);

    const { mod, refs } = makeGoldModule(0);
    const engine = createEngineFromSave({
      saveText: good,
      modules: [mod],
      persistenceNamespace: 'from-save-retry',
    });
    expect(refs.gold!.value).toBe(7);
    engine.dispose();
  });

  it('gives each call its own namespace by default', async () => {
    const { createEngineFromSave } = await import('@/harness/create-engine');
    const blob = makeLiveSave(3);
    const first = createEngineFromSave({ saveText: blob, modules: [makeGoldModule(0).mod] });
    const second = createEngineFromSave({ saveText: blob, modules: [makeGoldModule(0).mod] });
    first.dispose();
    second.dispose();
  });
});

describe('createSensitivityCell', () => {
  // Captured per-run via setup so tick + analyzer can read the current engine's gold.
  let currentGold: () => number = () => 0;

  function makeCell(
    name: string,
    saveText: string,
    perturb?: (engine: Engine, ctx: RunContext) => void,
  ) {
    const modFactory = makeGoldModule;
    return createSensitivityCell({
      name,
      saveText,
      modules: () => {
        const { mod, refs } = modFactory(0);
        // Hand the current ref to the outer closure so analyzer + tick see this run's engine.
        currentGold = () => refs.gold?.value ?? 0;
        // Expose refs on the module instance so perturb can mutate them
        // without engine-wide plumbing.
        (mod as EngineModule & { _refs: typeof refs })._refs = refs;
        return [mod];
      },
      perturb,
      buildAnalyzers: () => [createGoldPeakAnalyzer(() => currentGold())],
      tick: (engine) => engine.tickDriver.tickOnce(),
      ticks: 20,
    });
  }

  it('perturb mutates the per-run engine before first tick', () => {
    const blob = makeLiveSave(100);

    const baselineCell = makeCell('baseline', blob);
    const perturbCell = makeCell('perturbed', blob, (engine) => {
      // Find the economy module on this engine and bump its gold ref.
      const economy = engine.registeredModules.find((m) => m.id === 'economy') as
        | (EngineModule & { _refs: { gold?: ReturnType<typeof persistent<number>> } })
        | undefined;
      if (economy?._refs.gold) economy._refs.gold.value = 500;
    });

    const result = runSensitivity({
      baseline: baselineCell,
      variants: [{ name: 'perturbed', patch: () => perturbCell }],
      seeds: [1, 2, 3],
    });

    const baselinePeak = result.baseline.aggregate.metrics['gold-peak.peak']!.avg;
    const variantPeak = result.variants[0]!.cell.aggregate.metrics['gold-peak.peak']!.avg;
    const delta = result.variants[0]!.deltas['gold-peak.peak']!;

    expect(baselinePeak).toBe(100);
    expect(variantPeak).toBe(500);
    expect(delta.absolute).toBe(400);
    expect(delta.relative).toBeCloseTo(4.0);
  });

  it('perturb receives RunContext.seed so stochastic consumers diverge across seeds', () => {
    const blob = makeLiveSave(0);

    const seedsSeen: number[] = [];
    const goldBySeed: number[] = [];

    const cell = createSensitivityCell({
      name: 'seeded',
      saveText: blob,
      modules: () => {
        const { mod, refs } = makeGoldModule(0);
        currentGold = () => refs.gold?.value ?? 0;
        (mod as EngineModule & { _refs: typeof refs })._refs = refs;
        return [mod];
      },
      perturb: (engine, ctx) => {
        seedsSeen.push(ctx.seed);
        const economy = engine.registeredModules.find((m) => m.id === 'economy') as
          | (EngineModule & { _refs: { gold?: ReturnType<typeof persistent<number>> } })
          | undefined;
        if (economy?._refs.gold) economy._refs.gold.value = ctx.seed * 10;
        goldBySeed.push(economy?._refs.gold?.value ?? NaN);
      },
      buildAnalyzers: () => [createGoldPeakAnalyzer(() => currentGold())],
      tick: (engine) => engine.tickDriver.tickOnce(),
      ticks: 1,
    });

    runSensitivity({
      baseline: cell,
      variants: [],
      seeds: [7, 13, 21],
    });

    expect(seedsSeen).toEqual([7, 13, 21]);
    expect(goldBySeed).toEqual([70, 130, 210]);
  });

  it('no-op baseline vs itself produces zero delta', () => {
    const blob = makeLiveSave(100);
    const baseline = makeCell('baseline', blob);
    const shadow = makeCell('shadow', blob);

    const result = runSensitivity({
      baseline,
      variants: [{ name: 'shadow', patch: () => shadow }],
      seeds: [1],
    });

    expect(result.variants[0]!.deltas['gold-peak.peak']!.absolute).toBe(0);
  });

  // Regression for the final-run engine leak: scratch engines are driven
  // tick-by-tick by the harness, so `engine.start()` must not arm a real
  // wall-clock timer. Otherwise the last run's engine — never re-entered by
  // setup and unreachable by the engine-agnostic runner — keeps a live
  // setInterval ticking the imported save after the sweep returns.
  it('scratch engines arm no wall-clock timer, so the sweep leaks none', () => {
    const blob = makeLiveSave(100); // built before the spy — its live engine uses a real timer
    const baseline = makeCell('baseline', blob);
    const variant = makeCell('variant', blob);

    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    try {
      runSensitivity({
        baseline,
        variants: [{ name: 'variant', patch: () => variant }],
        seeds: [1, 2, 3],
      });
      expect(setIntervalSpy).not.toHaveBeenCalled();
    } finally {
      setIntervalSpy.mockRestore();
    }
  });

  it("disposes each run's engine when the next run sets up", () => {
    const blob = makeLiveSave(5);
    // Each counts the refs its run's engine still holds under `economy`.
    const heldRefs: (() => number)[] = [];
    const cell = createSensitivityCell({
      name: 'disposal',
      saveText: blob,
      modules: () => [
        {
          id: 'economy',
          install() {
            heldRefs.push(bindPersistenceNamespace(() => getPersistentRefs('economy')?.size ?? 0));
            persistent(0, { name: 'gold' });
          },
        },
      ],
      tick: (engine) => engine.tickDriver.tickOnce(),
      ticks: 1,
    });
    for (const seed of [1, 2, 3]) cell.setup({ seed });

    expect(heldRefs).toHaveLength(3);
    expect(heldRefs[0]()).toBe(0);
    expect(heldRefs[1]()).toBe(0);
    // The last run's engine stays live until the cell sets up again.
    expect(heldRefs[2]()).toBeGreaterThan(0);
  });

  it('a matrix run leaves no engine live behind it', () => {
    const blob = makeLiveSave(5);
    const heldRefs: (() => number)[] = [];
    const cell = createSensitivityCell({
      name: 'teardown',
      saveText: blob,
      modules: () => [
        {
          id: 'economy',
          install() {
            heldRefs.push(bindPersistenceNamespace(() => getPersistentRefs('economy')?.size ?? 0));
            persistent(0, { name: 'gold' });
          },
        },
      ],
      tick: (engine) => engine.tickDriver.tickOnce(),
      ticks: 1,
    });
    runMatrix({ cells: [cell], seeds: [1, 2] });

    expect(heldRefs).toHaveLength(2);
    for (const held of heldRefs) expect(held()).toBe(0);
  });
});
