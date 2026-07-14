import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { createEngine } from '@/index';
import type { EngineModule, EngineContext } from '@/index';

beforeAll(() => {
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    setTimeout(() => cb(performance.now()), 0);
    return 0;
  });
  vi.stubGlobal('cancelAnimationFrame', (_id: number) => {});
});
afterAll(() => {
  vi.unstubAllGlobals();
});

function createMapStorage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => m.set(k, v),
    removeItem: (k: string) => m.delete(k),
  };
}

describe('engine mod support', () => {
  it('exposes registered mods', () => {
    const engine = createEngine({
      gameId: 'test',
      persistence: false,
      mods: [
        { id: 'vanilla', name: 'Vanilla', modules: [{ id: 'vanilla-mod', install() {} }] },
        {
          id: 'omsi',
          name: 'OMSI',
          recommended: true,
          modules: [{ id: 'omsi-mod', install() {} }],
        },
      ],
    });
    expect(engine.mods).toHaveLength(2);
    expect(engine.mods[0].id).toBe('vanilla');
    expect(engine.mods[1].recommended).toBe(true);
  });

  it('activeModId is null by default', () => {
    const engine = createEngine({ gameId: 'test', persistence: false });
    expect(engine.activeModId).toBeNull();
  });

  it('selectMod sets activeModId', () => {
    const engine = createEngine({
      gameId: 'test',
      persistence: false,
      mods: [{ id: 'omsi', name: 'OMSI', modules: [{ id: 'omsi-mod', install() {} }] }],
    });
    engine.selectMod('omsi');
    expect(engine.activeModId).toBe('omsi');
  });

  it('selectMod throws for unknown mod', () => {
    const engine = createEngine({ gameId: 'test', persistence: false });
    expect(() => engine.selectMod('nope')).toThrow('Unknown mod id: "nope"');
  });

  it('selectMod throws after start()', () => {
    const engine = createEngine({
      gameId: 'test',
      persistence: false,
      mods: [{ id: 'omsi', name: 'OMSI', modules: [{ id: 'omsi-mod', install() {} }] }],
    });
    engine.start();
    expect(() => engine.selectMod('omsi')).toThrow('Cannot select mod after start()');
    engine.stop();
  });

  it('installs every module in the selected mod on start()', () => {
    const installed: string[] = [];
    const baseMod: EngineModule = {
      id: 'base',
      install() {
        installed.push('base');
      },
    };
    const omsiMod: EngineModule = {
      id: 'omsi-mod',
      dependencies: ['base'],
      install() {
        installed.push('omsi-mod');
      },
    };
    const engine = createEngine({
      gameId: 'test',
      persistence: false,
      mods: [{ id: 'omsi', name: 'OMSI', modules: [baseMod, omsiMod] }],
    });
    engine.selectMod('omsi');
    engine.start();

    expect(installed).toEqual(['base', 'omsi-mod']);
    engine.stop();
  });

  it('does not install mod modules when no mod selected', () => {
    const installed: string[] = [];
    const baseMod: EngineModule = {
      id: 'base',
      install() {
        installed.push('base');
      },
    };
    const engine = createEngine({
      gameId: 'test',
      persistence: false,
      mods: [
        {
          id: 'omsi',
          name: 'OMSI',
          modules: [
            {
              id: 'omsi-mod',
              install() {
                installed.push('omsi-mod');
              },
            },
          ],
        },
      ],
    });
    engine.use(baseMod);
    engine.start();

    expect(installed).toEqual(['base']);
    engine.stop();
  });

  it('selectMod pushes modules into the registration list before start()', () => {
    const installed: string[] = [];
    const engine = createEngine({
      gameId: 'test',
      persistence: false,
      mods: [
        {
          id: 'omsi',
          name: 'OMSI',
          modules: [
            {
              id: 'omsi-zones',
              install() {
                installed.push('omsi-zones');
              },
            },
            {
              id: 'omsi-skills',
              dependencies: ['omsi-zones'],
              install() {
                installed.push('omsi-skills');
              },
            },
          ],
        },
      ],
    });
    engine.selectMod('omsi');
    // After selectMod, the engine's registeredModules reflects the pushed list.
    expect(engine.registeredModules.map((m) => m.id)).toEqual(['omsi-zones', 'omsi-skills']);
    engine.start();

    expect(installed).toEqual(['omsi-zones', 'omsi-skills']);
    engine.stop();
  });

  it('selectMod throws if called twice', () => {
    const engine = createEngine({
      gameId: 'test',
      persistence: false,
      mods: [
        { id: 'omsi', name: 'OMSI', modules: [{ id: 'omsi-mod', install() {} }] },
        { id: 'lloyd', name: 'Lloyd', modules: [{ id: 'lloyd-mod', install() {} }] },
      ],
    });
    engine.selectMod('omsi');
    expect(() => engine.selectMod('lloyd')).toThrow('Mod already selected: "omsi"');
  });

  it('mod modules can use provide/inject with consumer-registered modules', () => {
    const TestKey = Symbol('test') as import('@/index').InjectionKey<string>;
    let injected: string | undefined;

    const baseMod: EngineModule = {
      id: 'base',
      install(ctx: EngineContext) {
        ctx.provide(TestKey, 'hello');
      },
    };
    const omsiMod: EngineModule = {
      id: 'omsi-mod',
      dependencies: ['base'],
      install(ctx: EngineContext) {
        injected = ctx.inject(TestKey);
      },
    };

    const engine = createEngine({
      gameId: 'test',
      persistence: false,
      mods: [{ id: 'omsi', name: 'OMSI', modules: [baseMod, omsiMod] }],
    });
    engine.selectMod('omsi');
    engine.start();

    expect(injected).toBe('hello');
    engine.stop();
  });

  it('peekSave returns null when no save exists', () => {
    const engine = createEngine({
      gameId: 'test',
      storageAdapter: createMapStorage(),
    });
    expect(engine.peekSave()).toBeNull();
  });

  it('peekSave returns modId from saved game', () => {
    const storage = createMapStorage();
    const engine = createEngine({
      gameId: 'test',
      storageAdapter: storage,
      mods: [{ id: 'omsi', name: 'OMSI', modules: [{ id: 'omsi-mod', install() {} }] }],
    });
    engine.selectMod('omsi');
    engine.start();
    engine.save();
    engine.stop();
    // Dispose before the second same-namespace instance installs: the stable
    // tick-driver accumulator context would otherwise collide. Save storage is
    // untouched, so engine2's peek still reads this save.
    engine.dispose();

    // New engine instance — peek before start
    const engine2 = createEngine({
      gameId: 'test',
      storageAdapter: storage,
      mods: [{ id: 'omsi', name: 'OMSI', modules: [{ id: 'omsi-mod', install() {} }] }],
    });
    const peek = engine2.peekSave();
    expect(peek).not.toBeNull();
    expect(peek!.modId).toBe('omsi');
  });

  it('peekSave returns null when persistence is disabled', () => {
    const engine = createEngine({ gameId: 'test', persistence: false });
    expect(engine.peekSave()).toBeNull();
  });
});
