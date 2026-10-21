import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { createEngine, persistent } from '@/index';
import type { EngineModule, EngineContext, ModDef } from '@/index';
import { createEngineFromSave } from '@/harness/create-engine';

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
        { id: 'vanilla', displayName: 'Vanilla', modules: [{ id: 'vanilla-mod', install() {} }] },
        {
          id: 'omsi',
          displayName: 'OMSI',
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
      mods: [{ id: 'omsi', displayName: 'OMSI', modules: [{ id: 'omsi-mod', install() {} }] }],
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
      mods: [{ id: 'omsi', displayName: 'OMSI', modules: [{ id: 'omsi-mod', install() {} }] }],
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
      mods: [{ id: 'omsi', displayName: 'OMSI', modules: [baseMod, omsiMod] }],
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
          displayName: 'OMSI',
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

  describe('start() with registered mods', () => {
    const mods: ModDef[] = [
      { id: 'omsi', displayName: 'OMSI', modules: [{ id: 'omsi-mod', install() {} }] },
    ];

    it('warns once when no mod is selected and no module is registered', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const engine = createEngine({ gameId: 'unmodded', persistence: false, mods });
      engine.start();
      engine.stop();
      engine.start();
      expect(warn).toHaveBeenCalledOnce();
      expect(warn.mock.calls[0][0]).toMatch(/"unmodded".*selectMod\(\)/s);
      engine.dispose();
      warn.mockRestore();
    });

    it('does not warn when a mod is selected', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const engine = createEngine({ gameId: 'modded', persistence: false, mods });
      engine.selectMod('omsi');
      engine.start();
      expect(warn).not.toHaveBeenCalled();
      engine.dispose();
      warn.mockRestore();
    });

    it('does not warn when use() registered a module', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const engine = createEngine({ gameId: 'picker', persistence: false, mods });
      engine.use({ id: 'base', install() {} });
      engine.start();
      expect(warn).not.toHaveBeenCalled();
      engine.dispose();
      warn.mockRestore();
    });

    it('does not warn when no mod is registered', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const engine = createEngine({ gameId: 'plain', persistence: false });
      engine.start();
      expect(warn).not.toHaveBeenCalled();
      engine.dispose();
      warn.mockRestore();
    });
  });

  it('selectMod pushes modules into the registration list before start()', () => {
    const installed: string[] = [];
    const engine = createEngine({
      gameId: 'test',
      persistence: false,
      mods: [
        {
          id: 'omsi',
          displayName: 'OMSI',
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
        { id: 'omsi', displayName: 'OMSI', modules: [{ id: 'omsi-mod', install() {} }] },
        { id: 'lloyd', displayName: 'Lloyd', modules: [{ id: 'lloyd-mod', install() {} }] },
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
      mods: [{ id: 'omsi', displayName: 'OMSI', modules: [baseMod, omsiMod] }],
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
      mods: [{ id: 'omsi', displayName: 'OMSI', modules: [{ id: 'omsi-mod', install() {} }] }],
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
      mods: [{ id: 'omsi', displayName: 'OMSI', modules: [{ id: 'omsi-mod', install() {} }] }],
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

describe("a save's mod", () => {
  // Each mod keeps a counter; a fresh set per engine, so refs don't alias.
  const counters = new Map<string, { value: number }>();
  const modsFor = (): ModDef[] =>
    ['lloyd', 'omsi'].map((id) => ({
      id,
      displayName: id,
      modules: [
        {
          id: `${id}-mod`,
          install() {
            counters.set(id, persistent(0, { id: 'counter' }));
          },
        },
      ],
    }));
  const build = (modId: string | undefined, storage = createMapStorage()) => {
    const engine = createEngine({ gameId: 'test', storageAdapter: storage, mods: modsFor() });
    if (modId) engine.selectMod(modId);
    else engine.use({ id: 'base', install() {} });
    engine.start();
    return engine;
  };
  const exportFrom = (modId: string | undefined, value: number) => {
    const engine = build(modId);
    if (modId) counters.get(modId)!.value = value;
    const text = engine.saveManager!.exportSave();
    engine.dispose();
    return text;
  };

  it('refuses an import from another mod, and leaves the state as it was', () => {
    const text = exportFrom('lloyd', 7);
    const engine = build('omsi');
    counters.get('omsi')!.value = 3;
    const failed = vi.fn();
    engine.saveManager!.on('save:load-failed', failed);

    // The save's mod, so the game can reopen the slot under it
    expect(engine.saveManager!.importSave(text)).toEqual({
      success: false,
      reason: 'wrong-mod',
      modId: 'lloyd',
    });
    expect(failed).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'wrong-mod', modId: 'lloyd' }),
    );
    expect(counters.get('omsi')!.value).toBe(3);
    engine.dispose();
  });

  it('refuses a modded save in an engine with no mod selected', () => {
    const text = exportFrom('lloyd', 7);
    const engine = build(undefined);
    expect(engine.saveManager!.importSave(text).success).toBe(false);
    engine.dispose();
  });

  it('loads a save that names no mod under any mod', () => {
    const text = exportFrom(undefined, 0);
    const engine = build('omsi');
    expect(engine.saveManager!.importSave(text).success).toBe(true);
    engine.dispose();
  });

  it("protects a slot another mod wrote, so this mod's autosave can't overwrite it", () => {
    const storage = createMapStorage();
    const first = build('lloyd', storage);
    counters.get('lloyd')!.value = 7;
    first.save();
    const slot = first.saveManager!.activeSlotId;
    const before = first.saveManager!.exportSlot(slot);
    first.dispose();

    const second = build('omsi', storage);
    expect(second.saveManager!.load().success).toBe(false);
    second.save();

    expect(second.saveManager!.exportSlot(slot)).toBe(before);
    second.dispose();
  });

  it('createEngineFromSave selects the mod the save names', () => {
    const text = exportFrom('lloyd', 7);
    const engine = createEngineFromSave({ saveText: text, mods: modsFor() });
    expect(engine.activeModId).toBe('lloyd');
    expect(counters.get('lloyd')!.value).toBe(7);
    engine.dispose();
  });

  it("createEngineFromSave throws when mods doesn't hold the save's mod", () => {
    const text = exportFrom('lloyd', 7);
    expect(() => createEngineFromSave({ saveText: text, modules: [] })).toThrow(/mod "lloyd"/);
  });
});
