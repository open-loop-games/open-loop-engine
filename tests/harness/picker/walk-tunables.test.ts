import { describe, it, expect } from 'vitest';
import {
  createEngine,
  createTuningRegistry,
  tunable,
  TuningRegistriesKey,
  type EngineModule,
} from '@/index';
import { walkTunables } from '@/harness/picker';

describe('walkTunables', () => {
  it('emits one entry per base-map key across every registered tuning registry', () => {
    const mod: EngineModule = {
      id: 'tuning-host',
      install() {
        const a = createTuningRegistry('archetype-a');
        tunable(a, 'foo/cost', () => 10);
        tunable(a, 'foo/multiplier', () => 1.25);

        const b = createTuningRegistry('archetype-b');
        tunable(b, 'bar/threshold', () => 100);
      },
    };
    const engine = createEngine({
      gameId: 'wt-1',
      persistence: false,
      persistenceNamespace: `wt-1-${Math.random().toString(36).slice(2)}`,
    });
    engine.use(mod);
    engine.start();

    const entries = walkTunables(engine);
    expect(entries).toHaveLength(3);

    const labels = entries.map((e) => e.label).sort();
    expect(labels).toEqual([
      'archetype-a/foo/cost',
      'archetype-a/foo/multiplier',
      'archetype-b/bar/threshold',
    ]);

    for (const e of entries) {
      expect(e.kind).toBe('tunable');
      expect(e.address.source).toBe('tunable');
    }

    const fooCost = entries.find((e) => e.key === 'foo/cost')!;
    expect(fooCost.registryName).toBe('archetype-a');
    expect(fooCost.address.registryName).toBe('archetype-a');

    engine.stop();
  });

  it('excludes scope-only keys — only base-map keys surface', () => {
    const mod: EngineModule = {
      id: 'tuning-scopes',
      install(ctx) {
        const reg = createTuningRegistry('scoped');
        tunable(reg, 'base/key', () => 1);
        // Stash for the test to push scopes against.
        ctx.provide(Symbol.for('test:registry') as never, reg as never);
      },
    };
    const engine = createEngine({
      gameId: 'wt-scopes',
      persistence: false,
      persistenceNamespace: `wt-scopes-${Math.random().toString(36).slice(2)}`,
    });
    engine.use(mod);
    engine.start();

    const registries = engine.tryInject(TuningRegistriesKey)!;
    const reg = [...registries].find((r) => r.name === 'scoped')!;
    const cleanup = reg.pushOverrides('challenge', {
      'scope-only/key': () => 999,
    });

    const entries = walkTunables(engine);
    expect(entries.map((e) => e.key)).toEqual(['base/key']);

    cleanup();
    engine.stop();
  });

  it('engine without TuningRegistriesKey degrades to empty array', () => {
    const engine = createEngine({
      gameId: 'wt-none',
      persistence: false,
      persistenceNamespace: `wt-none-${Math.random().toString(36).slice(2)}`,
    });
    // No modules → no tuning registries created. The key is still
    // pre-provided by createEngine; the set is just empty.
    engine.use({ id: 'noop', install() {} });
    engine.start();

    expect(walkTunables(engine)).toEqual([]);

    engine.stop();
  });
});
