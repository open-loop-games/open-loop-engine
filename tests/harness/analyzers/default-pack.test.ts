import { describe, it, expect } from 'vitest';
import { createEngine } from '@/index';
import type { EngineModule, EngineConfig } from '@/index';
import { createResource } from '@/core/resource';
import { createCycle } from '@/systems/cycle';
import { createCycleLog, CycleLogKey } from '@/systems/cycle-log';
import { defaultAnalyzerPack } from '@/harness/analyzers/default-pack';

// Helper: wrap a top-level resource-creation closure in an EngineModule so it
// runs inside the engine's ambient resource registry during install().
function resourceModule(id: string, create: () => void): EngineModule {
  return {
    id,
    install() {
      create();
    },
  };
}

// Each test builds its own engine with a unique persistence namespace so the
// shared persistent-context store doesn't collide across tests when reusing
// module ids.
let nsCounter = 0;
function testEngine(gameId: string, overrides: Partial<EngineConfig> = {}) {
  return createEngine({
    gameId,
    persistence: false,
    persistenceNamespace: `${gameId}-${nsCounter++}`,
    ...overrides,
  });
}

describe('defaultAnalyzerPack', () => {
  it('builds one resource-peak tracker per resource registered on the engine, keyed by id', () => {
    const engine = testEngine('pack-resources');
    engine.use(
      resourceModule('gold-mod', () => createResource(0, { id: 'gold', displayName: 'Coins' })),
    );
    engine.use(
      resourceModule('gems-mod', () => createResource(0, { id: 'gems', displayName: 'Coins' })),
    );
    engine.start();

    const pack = defaultAnalyzerPack(engine);

    const names = pack.map((a) => a.name).sort();
    expect(names).toEqual(['resource-peak:gems', 'resource-peak:gold']);
    engine.stop();
  });

  it('appends a cycle-finalize tracker when a CycleLog is published via CycleLogKey', () => {
    const mod: EngineModule = {
      id: 'game',
      install(ctx) {
        createResource(0, { id: 'gold', displayName: 'gold' });
        const cycle = createCycle({
          endCondition: () => false,
          thingsToReset: [],
          registerTick: () => () => {},
        });
        const log = createCycleLog({ cycle, metrics: {} });
        ctx.provide(CycleLogKey, log);
      },
    };
    const engine = testEngine('pack-looplog');
    engine.use(mod);
    engine.start();

    const pack = defaultAnalyzerPack(engine);
    const names = pack.map((a) => a.name);
    expect(names).toContain('cycle-finalize');
    expect(names).toContain('resource-peak:gold');
    engine.stop();
  });

  it('omits the cycle-finalize tracker when no CycleLog is published', () => {
    const engine = testEngine('pack-no-looplog');
    engine.use(
      resourceModule('gold-mod', () => createResource(0, { id: 'gold', displayName: 'gold' })),
    );
    engine.start();

    const pack = defaultAnalyzerPack(engine);
    expect(pack.map((a) => a.name)).toEqual(['resource-peak:gold']);
    engine.stop();
  });

  it('returns fresh tracker instances per call (no state bleed)', () => {
    const engine = testEngine('pack-fresh');
    engine.use(
      resourceModule('gold-mod', () => createResource(0, { id: 'gold', displayName: 'gold' })),
    );
    engine.start();

    const first = defaultAnalyzerPack(engine);
    const second = defaultAnalyzerPack(engine);

    expect(first[0]).not.toBe(second[0]);
    expect(first.length).toBe(second.length);
    engine.stop();
  });

  it('does not leak registrations across engines', () => {
    const engineA = testEngine('pack-leak-a');
    engineA.use(
      resourceModule('gold-mod', () => createResource(0, { id: 'gold', displayName: 'gold' })),
    );
    engineA.start();

    const engineB = testEngine('pack-leak-b');
    engineB.use(
      resourceModule('gems-mod', () => createResource(0, { id: 'gems', displayName: 'gems' })),
    );
    engineB.start();

    const packA = defaultAnalyzerPack(engineA);
    const packB = defaultAnalyzerPack(engineB);

    expect(packA.map((a) => a.name)).toEqual(['resource-peak:gold']);
    expect(packB.map((a) => a.name)).toEqual(['resource-peak:gems']);

    engineA.stop();
    engineB.stop();
  });
});
