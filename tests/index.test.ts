import { describe, it, expect, vi } from 'vitest';
import {
  createEngine,
  persistent,
  TickDriverKey,
  SaveManagerKey,
  CategoriesKey,
  ChainRegistryKey,
  EffectSystemRegistryKey,
  createModifierChain,
  createTemporaryEffectSystem,
  createPersistentEffectSystem,
  createPurchasableCategory,
  createSkillCategory,
  createCycle,
  createCycleLog,
  CycleLogKey,
} from '@/index';
import { getCurrentContext, getPersistentRefs } from '@/core/persistence';
import type { CycleLog } from '@/index';
import type { EngineModule, InjectionKey, EngineCategories } from '@/index';

describe('createEngine', () => {
  it('creates engine with config', () => {
    const engine = createEngine({ gameId: 'test' });
    expect(engine).toBeDefined();
    expect(engine.start).toBeTypeOf('function');
    expect(engine.stop).toBeTypeOf('function');
    expect(engine.use).toBeTypeOf('function');
  });
  it('use() registers and installs module on start', () => {
    const installed: string[] = [];
    const mod: EngineModule = {
      id: 'test',
      install() {
        installed.push('installed');
      },
    };
    const engine = createEngine({ gameId: 'test' });
    engine.use(mod);
    engine.start();
    expect(installed).toEqual(['installed']);
    engine.stop();
  });
  it('exposes registeredModules for forkable-instance helpers', () => {
    const a: EngineModule = { id: 'a', install() {} };
    const b: EngineModule = { id: 'b', install() {} };
    const engine = createEngine({ gameId: 'test', persistence: false });
    engine.use(a).use(b);
    engine.start();
    expect(engine.registeredModules).toHaveLength(2);
    expect(engine.registeredModules.map((m) => m.id)).toEqual(['a', 'b']);
    engine.stop();
  });
  it('validates module dependencies', () => {
    const mod: EngineModule = { id: 'needs-base', dependencies: ['base'], install() {} };
    const engine = createEngine({ gameId: 'test' });
    engine.use(mod);
    expect(() => engine.start()).toThrow(/base/);
  });
  it('installs in dependency order', () => {
    const order: string[] = [];
    const base: EngineModule = {
      id: 'base',
      install() {
        order.push('base');
      },
    };
    const derived: EngineModule = {
      id: 'derived',
      dependencies: ['base'],
      install() {
        order.push('derived');
      },
    };
    const engine = createEngine({ gameId: 'test' });
    engine.use(derived);
    engine.use(base);
    engine.start();
    expect(order).toEqual(['base', 'derived']);
    engine.stop();
  });
  it('creates engine without save manager when persistence is false', () => {
    const engine = createEngine({ gameId: 'test', persistence: false });
    expect(engine).toBeDefined();
    // Should start and stop without errors
    engine.start();
    engine.stop();
  });
  it('exposes engine context to modules', () => {
    let ctx: any = null;
    const mod: EngineModule = {
      id: 'ctx',
      install(c) {
        ctx = c;
      },
    };
    const engine = createEngine({ gameId: 'test' });
    engine.use(mod);
    engine.start();
    expect(ctx.onTick).toBeTypeOf('function');
    expect(ctx.onSave).toBeTypeOf('function');
    expect(ctx.onLoad).toBeTypeOf('function');
    expect(ctx.onReset).toBeTypeOf('function');
    expect(ctx.provide).toBeTypeOf('function');
    expect(ctx.inject).toBeTypeOf('function');
    expect(ctx.tryInject).toBeTypeOf('function');
    engine.stop();
  });
});

describe('auto-persistence context', () => {
  it('wraps install() in beginPersistentContext(moduleId)', () => {
    let capturedContext: string | undefined;
    const mod: EngineModule = {
      id: 'my-layer',
      install() {
        capturedContext = getCurrentContext();
      },
    };
    const engine = createEngine({ gameId: 'test', persistence: false });
    engine.use(mod);
    engine.start();
    expect(capturedContext).toBe('my-layer');
    engine.stop();
  });

  it('persistent refs created in install() are tracked under module id', () => {
    const mod: EngineModule = {
      id: 'auto-ctx',
      install() {
        persistent(0);
        persistent('hello');
      },
    };
    const engine = createEngine({ gameId: 'test', persistence: false });
    engine.use(mod);
    engine.start();
    const refs = getPersistentRefs('auto-ctx');
    expect(refs).toBeDefined();
    expect(refs!.size).toBe(2);
    engine.stop();
  });

  it('restores persistence context after install() completes', () => {
    const engine = createEngine({ gameId: 'test', persistence: false });
    engine.use({ id: 'a', install() {} });
    engine.start();
    expect(getCurrentContext()).toBeUndefined();
    engine.stop();
  });
});

describe('persistenceNamespace — forkable engine isolation', () => {
  function createMapStorage() {
    const m = new Map<string, string>();
    return {
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => m.set(k, v),
      removeItem: (k: string) => m.delete(k),
      _map: m,
    };
  }

  function makeGoldModule(initial: number) {
    // Each module instance holds its own persistent ref via closure so the
    // two engines don't alias each other's state. The SAME module ID is used
    // intentionally — the namespace is what must keep contexts apart.
    const refs: { gold?: ReturnType<typeof persistent<number>> } = {};
    const mod: EngineModule = {
      id: 'economy',
      install() {
        refs.gold = persistent(initial, { name: 'gold' });
      },
    };
    return { mod, refs };
  }

  it('two engines with different namespaces save/load independently', () => {
    const storageA = createMapStorage();
    const storageB = createMapStorage();
    const a = makeGoldModule(0);
    const b = makeGoldModule(0);

    const engineA = createEngine({
      gameId: 'shared-game',
      persistenceNamespace: 'alpha',
      storageAdapter: storageA,
    });
    const engineB = createEngine({
      gameId: 'shared-game',
      persistenceNamespace: 'beta',
      storageAdapter: storageB,
    });
    engineA.use(a.mod);
    engineB.use(b.mod);
    engineA.start();
    engineB.start();

    a.refs.gold!.value = 111;
    b.refs.gold!.value = 222;

    engineA.save();
    engineB.save();

    // Mutate both so we can verify load restores each side independently
    a.refs.gold!.value = -1;
    b.refs.gold!.value = -1;

    expect(engineA.load().success).toBe(true);
    expect(a.refs.gold!.value).toBe(111);
    // Engine A's load must not touch engine B's state
    expect(b.refs.gold!.value).toBe(-1);

    expect(engineB.load().success).toBe(true);
    expect(b.refs.gold!.value).toBe(222);

    engineA.stop();
    engineB.stop();
  });

  it('namespaced engine shares no storage keys with unnamespaced default', () => {
    const storage = createMapStorage();
    const mod = makeGoldModule(0);
    const engine = createEngine({
      gameId: 'g',
      persistenceNamespace: 'scratch',
      storageAdapter: storage,
    });
    engine.use(mod.mod);
    engine.start();
    mod.refs.gold!.value = 7;
    engine.save();

    // Storage keys must carry the namespace prefix so scratch-vs-live on the
    // same gameId don't alias each other in localStorage.
    for (const key of storage._map.keys()) {
      expect(key).toContain('scratch');
    }
    engine.stop();
  });
});

describe('dispose() — persistent-context teardown', () => {
  function createMapStorage() {
    const m = new Map<string, string>();
    return {
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => m.set(k, v),
      removeItem: (k: string) => m.delete(k),
      _map: m,
    };
  }

  function makeNamedModule() {
    // Two-step closure: each call returns a fresh module with its own
    // persistent ref, but the module id and persistent name are stable so the
    // collision test exercises the realistic gallery-remount path.
    const refs: { score?: ReturnType<typeof persistent<number>> } = {};
    const mod: EngineModule = {
      id: 'scoreboard',
      install() {
        refs.score = persistent(0, { name: 'score' });
      },
    };
    return { mod, refs };
  }

  it('a fresh engine can install the same module ids after dispose', () => {
    const a = makeNamedModule();
    const engineA = createEngine({ gameId: 'g', persistence: false });
    engineA.use(a.mod);
    engineA.start();
    a.refs.score!.value = 42;
    engineA.dispose();

    const b = makeNamedModule();
    const engineB = createEngine({ gameId: 'g', persistence: false });
    engineB.use(b.mod);
    expect(() => engineB.start()).not.toThrow();
    expect(b.refs.score!.value).toBe(0);
    engineB.dispose();
  });

  it('start() throws after dispose', () => {
    const m = makeNamedModule();
    const engine = createEngine({ gameId: 'g', persistence: false });
    engine.use(m.mod);
    engine.start();
    engine.dispose();
    expect(() => engine.start()).toThrow(/disposed/);
  });

  it('dispose is idempotent', () => {
    const m = makeNamedModule();
    const engine = createEngine({ gameId: 'g', persistence: false });
    engine.use(m.mod);
    engine.start();
    expect(() => {
      engine.dispose();
      engine.dispose();
    }).not.toThrow();
  });

  it('save data persists across dispose + new-engine cycle', () => {
    const storage = createMapStorage();
    const a = makeNamedModule();
    const engineA = createEngine({ gameId: 'g', storageAdapter: storage });
    engineA.use(a.mod);
    engineA.start();
    a.refs.score!.value = 99;
    engineA.save();
    engineA.dispose();

    const b = makeNamedModule();
    const engineB = createEngine({ gameId: 'g', storageAdapter: storage });
    engineB.use(b.mod);
    engineB.start();
    expect(engineB.load().success).toBe(true);
    expect(b.refs.score!.value).toBe(99);
    engineB.dispose();
  });

  it('dispose only clears its own namespace; sibling engines untouched', () => {
    const a = makeNamedModule();
    const b = makeNamedModule();
    const engineA = createEngine({
      gameId: 'g',
      persistenceNamespace: 'alpha',
      persistence: false,
    });
    const engineB = createEngine({
      gameId: 'g',
      persistenceNamespace: 'beta',
      persistence: false,
    });
    engineA.use(a.mod);
    engineB.use(b.mod);
    engineA.start();
    engineB.start();
    a.refs.score!.value = 1;
    b.refs.score!.value = 2;

    engineA.dispose();

    // Engine B's ref still works post-A-dispose
    expect(b.refs.score!.value).toBe(2);
    b.refs.score!.value = 3;
    expect(b.refs.score!.value).toBe(3);
    engineB.dispose();
  });
});

describe('provide/inject', () => {
  it('module provides value, dependent module injects it', () => {
    const PointsKey: InjectionKey<{ amount: number }> = Symbol('points');
    let injectedValue: { amount: number } | undefined;

    const provider: EngineModule = {
      id: 'provider',
      install(ctx) {
        ctx.provide(PointsKey, { amount: 42 });
      },
    };

    const consumer: EngineModule = {
      id: 'consumer',
      dependencies: ['provider'],
      install(ctx) {
        injectedValue = ctx.inject(PointsKey);
      },
    };

    const engine = createEngine({ gameId: 'test', persistence: false });
    engine.use(consumer);
    engine.use(provider);
    engine.start();
    expect(injectedValue).toEqual({ amount: 42 });
    engine.stop();
  });

  it('inject throws when key not provided', () => {
    const MissingKey: InjectionKey<string> = Symbol('missing');

    const mod: EngineModule = {
      id: 'throws',
      install(ctx) {
        ctx.inject(MissingKey);
      },
    };

    const engine = createEngine({ gameId: 'test', persistence: false });
    engine.use(mod);
    expect(() => engine.start()).toThrow(/No provider found/);
  });

  it('tryInject returns undefined when key not provided', () => {
    const OptionalKey: InjectionKey<number> = Symbol('optional');
    let result: number | undefined = 999;

    const mod: EngineModule = {
      id: 'optional',
      install(ctx) {
        result = ctx.tryInject(OptionalKey);
      },
    };

    const engine = createEngine({ gameId: 'test', persistence: false });
    engine.use(mod);
    engine.start();
    expect(result).toBeUndefined();
    engine.stop();
  });

  it('dependency order guarantees provider runs before consumer', () => {
    const OrderKey: InjectionKey<string[]> = Symbol('order');
    const log: string[] = [];

    const base: EngineModule = {
      id: 'base',
      install(ctx) {
        log.push('base');
        ctx.provide(OrderKey, log);
      },
    };

    const mid: EngineModule = {
      id: 'mid',
      dependencies: ['base'],
      install(ctx) {
        const arr = ctx.inject(OrderKey);
        arr.push('mid');
      },
    };

    const top: EngineModule = {
      id: 'top',
      dependencies: ['mid'],
      install(ctx) {
        const arr = ctx.inject(OrderKey);
        arr.push('top');
      },
    };

    const engine = createEngine({ gameId: 'test', persistence: false });
    engine.use(top);
    engine.use(mid);
    engine.use(base);
    engine.start();
    expect(log).toEqual(['base', 'mid', 'top']);
    engine.stop();
  });
});

describe('built-in injection keys', () => {
  it('TickDriverKey is pre-provided and injectable', () => {
    let driverRef: unknown;
    const mod: EngineModule = {
      id: 'tick-driver-consumer',
      install(ctx) {
        driverRef = ctx.inject(TickDriverKey);
      },
    };
    const engine = createEngine({ gameId: 'test', persistence: false });
    engine.use(mod);
    engine.start();
    expect(driverRef).toBeDefined();
    expect(driverRef).toBe(engine.tickDriver);
    engine.stop();
  });

  it('SaveManagerKey is pre-provided when persistence is enabled', () => {
    let saveRef: unknown;
    const mod: EngineModule = {
      id: 'save-consumer',
      install(ctx) {
        saveRef = ctx.inject(SaveManagerKey);
      },
    };
    const engine = createEngine({ gameId: 'test' });
    engine.use(mod);
    engine.start();
    expect(saveRef).toBeDefined();
    expect((saveRef as any).save).toBeTypeOf('function');
    engine.stop();
  });

  it('SaveManagerKey is not provided when persistence is false', () => {
    let saveRef: unknown = 'sentinel';
    const mod: EngineModule = {
      id: 'no-save',
      install(ctx) {
        saveRef = ctx.tryInject(SaveManagerKey);
      },
    };
    const engine = createEngine({ gameId: 'test', persistence: false });
    engine.use(mod);
    engine.start();
    expect(saveRef).toBeUndefined();
    engine.stop();
  });
});

describe('CategoriesKey — engine self-publish', () => {
  it('factories called inside install() auto-register into the accumulator', () => {
    interface UpgDef {
      id: string;
      cost: number;
    }
    interface TrainDef {
      id: string;
    }

    const game: EngineModule = {
      id: 'game',
      install() {
        const upgrades = createPurchasableCategory<UpgDef>({
          id: 'upgrades',
          mapPurchasable: () => ({ display: {}, requirements: [], effect: 1 }),
        });
        const training = createSkillCategory<TrainDef>({
          id: 'training',
          mapSkill: () => ({
            xpToLevel: (xp) => xp,
            levelToMultiplier: (level) => level,
          }),
        });
        upgrades.register({ id: 'double-gold', cost: 100 });
        training.register({ id: 'stamina' });
      },
    };

    let discovered: EngineCategories | undefined;
    const introspector: EngineModule = {
      id: 'introspector',
      dependencies: ['game'],
      install(ctx) {
        discovered = ctx.tryInject(CategoriesKey);
      },
    };

    const engine = createEngine({ gameId: 'test', persistence: false });
    engine.use(introspector);
    engine.use(game);
    engine.start();

    expect(discovered).toBeDefined();
    expect(discovered!.purchasables).toHaveLength(1);
    expect(discovered!.skills).toHaveLength(1);
    // Adapter walks a category by its public API.
    const firstUpgrade = discovered!.purchasables![0].getAll()[0];
    expect(firstUpgrade.def.id).toBe('double-gold');
    engine.stop();
  });

  it('back-compat: consumer ctx.provide(CategoriesKey, ...) overwrites the engine pre-provide', () => {
    interface UpgDef {
      id: string;
      cost: number;
    }

    const externalUpgrades = createPurchasableCategory<UpgDef>({
      id: 'external-upgrades',
      mapPurchasable: () => ({ display: {}, requirements: [], effect: 1 }),
    });
    externalUpgrades.register({ id: 'extra-gold', cost: 50 });

    const game: EngineModule = {
      id: 'game',
      install(ctx) {
        ctx.provide(CategoriesKey, { purchasables: [externalUpgrades] });
      },
    };

    let discovered: EngineCategories | undefined;
    const introspector: EngineModule = {
      id: 'introspector',
      dependencies: ['game'],
      install(ctx) {
        discovered = ctx.tryInject(CategoriesKey);
      },
    };

    const engine = createEngine({ gameId: 'test', persistence: false });
    engine.use(introspector);
    engine.use(game);
    engine.start();

    expect(discovered).toBeDefined();
    expect(discovered!.purchasables).toHaveLength(1);
    expect(discovered!.purchasables![0].getAll()[0].def.id).toBe('extra-gold');
    engine.stop();
  });

  it('returns an empty accumulator when no categories are constructed inside install()', () => {
    let discovered: EngineCategories | undefined;
    const mod: EngineModule = {
      id: 'no-categories',
      install(ctx) {
        discovered = ctx.tryInject(CategoriesKey);
      },
    };
    const engine = createEngine({ gameId: 'test', persistence: false });
    engine.use(mod);
    engine.start();
    expect(discovered).toEqual({});
    engine.stop();
  });
});

describe('CycleLogKey — discovery convention', () => {
  it('module publishes a CycleLog; external consumer retrieves it via tryInject', () => {
    let discovered: CycleLog | undefined;

    const game: EngineModule = {
      id: 'game',
      install(ctx) {
        const cycle = createCycle({
          endCondition: () => false,
          thingsToReset: [],
          registerTick: () => () => {},
        });
        const log = createCycleLog({ cycle, metrics: {} });
        ctx.provide(CycleLogKey, log);
      },
    };
    const introspector: EngineModule = {
      id: 'introspector',
      dependencies: ['game'],
      install(ctx) {
        discovered = ctx.tryInject(CycleLogKey);
      },
    };

    const engine = createEngine({ gameId: 'test', persistence: false });
    engine.use(introspector);
    engine.use(game);
    engine.start();

    expect(discovered).toBeDefined();
    expect(discovered!.history.value).toEqual([]);
    engine.stop();
  });

  it('returns undefined when no module publishes a cycle log', () => {
    let discovered: unknown = 'sentinel';
    const mod: EngineModule = {
      id: 'no-publisher',
      install(ctx) {
        discovered = ctx.tryInject(CycleLogKey);
      },
    };
    const engine = createEngine({ gameId: 'test', persistence: false });
    engine.use(mod);
    engine.start();
    expect(discovered).toBeUndefined();
    engine.stop();
  });
});

describe('connect() lifecycle', () => {
  it('all install() calls run before any connect()', () => {
    const order: string[] = [];
    const a: EngineModule = {
      id: 'a',
      install() {
        order.push('install:a');
      },
      connect() {
        order.push('connect:a');
      },
    };
    const b: EngineModule = {
      id: 'b',
      dependencies: ['a'],
      install() {
        order.push('install:b');
      },
      connect() {
        order.push('connect:b');
      },
    };
    const engine = createEngine({ gameId: 'test', persistence: false });
    engine.use(b);
    engine.use(a);
    engine.start();
    expect(order).toEqual(['install:a', 'install:b', 'connect:a', 'connect:b']);
    engine.stop();
  });

  it('connect() sees values provided by any module during install()', () => {
    const Key: InjectionKey<string> = Symbol('val');
    let injected: string | undefined;

    const provider: EngineModule = {
      id: 'provider',
      install(ctx) {
        ctx.provide(Key, 'hello');
      },
    };
    const consumer: EngineModule = {
      id: 'consumer',
      // No dependency on provider — but connect runs after all installs
      connect(ctx) {
        injected = ctx.inject(Key);
      },
      install() {},
    };

    const engine = createEngine({ gameId: 'test', persistence: false });
    engine.use(consumer);
    engine.use(provider);
    engine.start();
    expect(injected).toBe('hello');
    engine.stop();
  });

  it('modules without connect() are skipped without error', () => {
    const order: string[] = [];
    const withConnect: EngineModule = {
      id: 'with',
      install() {
        order.push('install:with');
      },
      connect() {
        order.push('connect:with');
      },
    };
    const without: EngineModule = {
      id: 'without',
      install() {
        order.push('install:without');
      },
    };
    const engine = createEngine({ gameId: 'test', persistence: false });
    engine.use(without);
    engine.use(withConnect);
    engine.start();
    expect(order).toContain('install:without');
    expect(order).toContain('connect:with');
    expect(order).not.toContain('connect:without');
    engine.stop();
  });

  it('connect() runs inside persistent context', () => {
    const mod: EngineModule = {
      id: 'persist-connect',
      install() {},
      connect() {
        persistent(42);
      },
    };
    const engine = createEngine({ gameId: 'test', persistence: false });
    engine.use(mod);
    engine.start();
    const refs = getPersistentRefs('persist-connect');
    expect(refs).toBeDefined();
    expect(refs!.size).toBe(1);
    engine.stop();
  });

  it('event subscriptions during connect() are tracked for cleanup', () => {
    const calls: string[] = [];
    let emitFn: (() => void) | undefined;

    const mod: EngineModule = {
      id: 'event-connect',
      install() {},
      connect(ctx) {
        (ctx as any).on('testConnectEvent', () => {
          calls.push('fired');
        });
      },
    };
    const emitter: EngineModule = {
      id: 'emitter',
      install(ctx) {
        emitFn = () => (ctx as any).emit('testConnectEvent');
      },
    };

    const engine = createEngine({ gameId: 'test', persistence: false });
    engine.use(mod);
    engine.use(emitter);
    engine.start();
    emitFn!();
    expect(calls).toEqual(['fired']);
    engine.stop();
  });
});

describe('ChainRegistryKey — auto-registered modifier chain discovery', () => {
  it('enumerates chains created by any module during install()', () => {
    let capturedIds: string[] = [];

    const modA: EngineModule = {
      id: 'a',
      install() {
        createModifierChain('a/speed');
        createModifierChain('a/damage');
      },
    };
    const modB: EngineModule = {
      id: 'b',
      install() {
        createModifierChain('b/regen');
      },
    };
    const probe: EngineModule = {
      id: 'probe',
      dependencies: ['a', 'b'],
      install(ctx) {
        capturedIds = ctx
          .inject(ChainRegistryKey)
          .all()
          .map((c) => c.id);
      },
    };

    const engine = createEngine({ gameId: 'test', persistence: false });
    engine.use(modA);
    engine.use(modB);
    engine.use(probe);
    engine.start();

    expect(capturedIds.sort()).toEqual(['a/damage', 'a/speed', 'b/regen']);
    engine.stop();
  });

  it('registry is available via tryInject from any module without explicit provide', () => {
    let discoveredSize = -1;
    let alphaFound = false;

    const producer: EngineModule = {
      id: 'producer',
      install() {
        createModifierChain('alpha');
      },
    };
    const inspector: EngineModule = {
      id: 'inspector',
      dependencies: ['producer'],
      install(ctx) {
        const reg = ctx.tryInject(ChainRegistryKey);
        if (reg) {
          discoveredSize = reg.size;
          alphaFound = reg.has('alpha');
        }
      },
    };

    const engine = createEngine({ gameId: 'test', persistence: false });
    engine.use(producer);
    engine.use(inspector);
    engine.start();

    expect(discoveredSize).toBe(1);
    expect(alphaFound).toBe(true);
    engine.stop();
  });

  it('two engines in the same runtime each maintain an isolated registry', () => {
    let idsA: string[] = [];
    let idsB: string[] = [];

    const makeProducer = (chainId: string): EngineModule => ({
      id: 'shared',
      install() {
        createModifierChain(chainId);
      },
    });

    // Concurrent engines in one runtime must carry distinct persistence
    // namespaces — the contract for coexisting instances (shared stable
    // context ids like the tick-driver accumulator collide otherwise).
    const engineA = createEngine({
      gameId: 'test',
      persistence: false,
      persistenceNamespace: 'a',
    });
    engineA.use(makeProducer('only-in-a'));
    engineA.use({
      id: 'probe',
      dependencies: ['shared'],
      install(ctx) {
        idsA = ctx
          .inject(ChainRegistryKey)
          .all()
          .map((c) => c.id);
      },
    });
    engineA.start();

    const engineB = createEngine({
      gameId: 'test',
      persistence: false,
      persistenceNamespace: 'b',
    });
    engineB.use(makeProducer('only-in-b'));
    engineB.use({
      id: 'probe',
      dependencies: ['shared'],
      install(ctx) {
        idsB = ctx
          .inject(ChainRegistryKey)
          .all()
          .map((c) => c.id);
      },
    });
    engineB.start();

    expect(idsA).toEqual(['only-in-a']);
    expect(idsB).toEqual(['only-in-b']);

    engineA.stop();
    engineB.stop();
  });

  it('duplicate chain ids within one engine throw during install()', () => {
    const mod: EngineModule = {
      id: 'dup',
      install() {
        createModifierChain('same-id');
        createModifierChain('same-id');
      },
    };
    const engine = createEngine({ gameId: 'test', persistence: false });
    engine.use(mod);
    expect(() => engine.start()).toThrow(/duplicate chain id "same-id"/);
  });

  it('chains constructed outside any engine do not pollute engine registries', () => {
    // File-scope / test-scope chain, no ambient registry.
    createModifierChain('orphan-chain');

    let size = -1;
    const engine = createEngine({ gameId: 'test', persistence: false });
    engine.use({
      id: 'inspector',
      install(ctx) {
        size = ctx.inject(ChainRegistryKey).size;
      },
    });
    engine.start();
    expect(size).toBe(0);
    engine.stop();
  });
});

describe('EffectSystemRegistryKey — auto-registered effect-system discovery', () => {
  it('enumerates temporary + persistent systems created during install()', () => {
    let capturedIds: string[] = [];
    let kinds: string[] = [];

    const modA: EngineModule = {
      id: 'a',
      install(ctx) {
        createTemporaryEffectSystem({
          id: 'a/buffs',
          registerTick: (cb) => ctx.onTick(cb),
        });
      },
    };
    const modB: EngineModule = {
      id: 'b',
      install() {
        createPersistentEffectSystem({ id: 'b/conditions' });
      },
    };
    const probe: EngineModule = {
      id: 'probe',
      dependencies: ['a', 'b'],
      install(ctx) {
        const reg = ctx.inject(EffectSystemRegistryKey);
        capturedIds = reg.all().map((s) => s.id);
        kinds = reg.all().map((s) => s.kind);
      },
    };

    const engine = createEngine({ gameId: 'test', persistence: false });
    engine.use(modA);
    engine.use(modB);
    engine.use(probe);
    engine.start();

    expect(capturedIds.sort()).toEqual(['a/buffs', 'b/conditions']);
    expect(kinds.sort()).toEqual(['persistent', 'temporary']);
    engine.stop();
  });

  it('two engines each keep their own effect-system registry', () => {
    function makeEngine(name: string) {
      const e = createEngine({ gameId: name, persistence: false });
      let seen: string[] = [];
      e.use({
        id: 'fx',
        install(ctx) {
          createTemporaryEffectSystem({
            id: `${name}-only`,
            registerTick: (cb) => ctx.onTick(cb),
          });
        },
      });
      e.use({
        id: 'inspector',
        dependencies: ['fx'],
        install(ctx) {
          seen = ctx
            .inject(EffectSystemRegistryKey)
            .all()
            .map((s) => s.id);
        },
      });
      e.start();
      e.stop();
      // Dispose so the next engine can reinstall the same stable context ids
      // (the tick-driver accumulator) under the default namespace.
      e.dispose();
      return seen;
    }

    const a = makeEngine('a');
    const b = makeEngine('b');
    expect(a).toEqual(['a-only']);
    expect(b).toEqual(['b-only']);
    expect(a).not.toContain('b-only');
    expect(b).not.toContain('a-only');
  });

  it('throws on duplicate effect-system id within one engine', () => {
    const mod: EngineModule = {
      id: 'm',
      install(ctx) {
        createTemporaryEffectSystem({
          id: 'dup',
          registerTick: (cb) => ctx.onTick(cb),
        });
        createPersistentEffectSystem({ id: 'dup' });
      },
    };
    const engine = createEngine({ gameId: 'test', persistence: false });
    engine.use(mod);
    expect(() => engine.start()).toThrow(/duplicate effect-system id "dup"/);
  });
});

describe('autoSaveInterval — runtime-tunable', () => {
  function mockTimers() {
    let nextId = 1;
    const setInterval = vi.fn(() => nextId++);
    const clearInterval = vi.fn();
    return { setInterval, clearInterval };
  }

  it('exposes the initial config value', () => {
    const engine = createEngine({ gameId: 'test', autoSaveInterval: 5000 });
    expect(engine.autoSaveInterval).toBe(5000);
  });

  it('defaults to 0 when not configured', () => {
    const engine = createEngine({ gameId: 'test' });
    expect(engine.autoSaveInterval).toBe(0);
  });

  it('schedules autosave at the configured interval on start()', () => {
    const timers = mockTimers();
    const engine = createEngine({
      gameId: 'test',
      autoSaveInterval: 5000,
      timerProvider: timers,
    });
    engine.start();
    // Two setInterval calls: one for the game loop, one for autosave.
    const autoSaveCall = timers.setInterval.mock.calls.find((c) => c[1] === 5000);
    expect(autoSaveCall).toBeDefined();
    engine.stop();
  });

  it('setter re-arms the autosave timer while running', () => {
    const timers = mockTimers();
    const engine = createEngine({
      gameId: 'test',
      autoSaveInterval: 5000,
      timerProvider: timers,
    });
    engine.start();
    expect(timers.setInterval.mock.calls.filter((c) => c[1] === 5000)).toHaveLength(1);

    engine.autoSaveInterval = 10000;
    expect(engine.autoSaveInterval).toBe(10000);
    expect(timers.setInterval.mock.calls.filter((c) => c[1] === 10000)).toHaveLength(1);
    // Old timer was cleared (we don't care which id, just that clearInterval ran).
    expect(timers.clearInterval).toHaveBeenCalled();
    engine.stop();
  });

  it('setter to 0 stops the autosave timer without stopping the engine', () => {
    const timers = mockTimers();
    const engine = createEngine({
      gameId: 'test',
      autoSaveInterval: 5000,
      timerProvider: timers,
    });
    engine.start();
    const clearCallsBefore = timers.clearInterval.mock.calls.length;

    engine.autoSaveInterval = 0;
    expect(engine.autoSaveInterval).toBe(0);
    // One additional clearInterval call (the autosave timer).
    expect(timers.clearInterval.mock.calls.length).toBe(clearCallsBefore + 1);
    // No new autosave setInterval call.
    expect(timers.setInterval.mock.calls.filter((c) => c[1] === 0)).toHaveLength(0);
    engine.stop();
  });

  it('setter from 0 to >0 starts the autosave timer when engine is running', () => {
    const timers = mockTimers();
    const engine = createEngine({
      gameId: 'test',
      autoSaveInterval: 0,
      timerProvider: timers,
    });
    engine.start();
    // No autosave timer yet — only the game loop's setInterval.
    expect(timers.setInterval.mock.calls.filter((c) => c[1] === 5000)).toHaveLength(0);

    engine.autoSaveInterval = 5000;
    expect(timers.setInterval.mock.calls.filter((c) => c[1] === 5000)).toHaveLength(1);
    engine.stop();
  });

  it('does not start an autosave timer when persistence is disabled', () => {
    const timers = mockTimers();
    const engine = createEngine({
      gameId: 'test',
      persistence: false,
      autoSaveInterval: 5000,
      timerProvider: timers,
    });
    engine.start();
    // Only the TickDriver setInterval should fire; autosave should be inert.
    expect(timers.setInterval.mock.calls.filter((c) => c[1] === 5000)).toHaveLength(0);

    engine.autoSaveInterval = 10000;
    expect(timers.setInterval.mock.calls.filter((c) => c[1] === 10000)).toHaveLength(0);
    engine.stop();
  });
});

describe('EngineConfig.strictValidation', () => {
  // Hand-build a corrupted uncompressed envelope and feed it through importSave;
  // skips needing the save-manager's compressSave knob plumbed through EngineConfig.
  function corruptedEnvelope(gameId: string, moduleId: string): string {
    return JSON.stringify({
      version: 1,
      gameId,
      timestamp: Date.now(),
      data: { [moduleId]: { count: { not: 'a number' } } },
      _engine: { version: 3 },
    });
  }

  function makeCountModule(id: string): EngineModule {
    return {
      id,
      install() {
        persistent(0, { name: 'count' });
      },
    };
  }

  it('strictValidation: true aborts load on validation failure via createEngine', () => {
    const moduleId = 'strict-true-mod';
    const engine = createEngine({
      gameId: 'strict-true',
      strictValidation: true,
      saveVersion: 1,
    });
    engine.use(makeCountModule(moduleId));
    engine.start();

    const failed = vi.fn();
    engine.saveManager!.on('save:load-failed', failed);
    const result = engine.saveManager!.importSave(corruptedEnvelope('strict-true', moduleId));

    expect(result.success).toBe(false);
    expect(failed).toHaveBeenCalledWith({
      slotId: 0,
      reason: 'validation',
      detail: undefined,
    });
    engine.dispose();
  });

  it('strictValidation: false self-heals on validation failure via createEngine', () => {
    const moduleId = 'strict-false-mod';
    const engine = createEngine({
      gameId: 'strict-false',
      strictValidation: false,
      saveVersion: 1,
    });
    engine.use(makeCountModule(moduleId));
    engine.start();

    const result = engine.saveManager!.importSave(corruptedEnvelope('strict-false', moduleId));

    expect(result.success).toBe(true);
    engine.dispose();
  });
});

describe('reactivity re-exports', () => {
  it('triggerRef and onScopeDispose reach the engine reactivity graph', async () => {
    const { shallowRef, triggerRef, watchEffect, effectScope, onScopeDispose } =
      await import('@/index');
    const list = shallowRef<number[]>([]);
    const seen: number[] = [];
    let disposed = false;
    const scope = effectScope();
    scope.run(() => {
      watchEffect(() => void seen.push(list.value.length), { flush: 'sync' });
      onScopeDispose(() => {
        disposed = true;
      });
    });
    list.value.push(1);
    triggerRef(list);
    expect(seen).toEqual([0, 1]);
    scope.stop();
    expect(disposed).toBe(true);
  });
});

describe('save safety', () => {
  function mapStorage() {
    const m = new Map<string, string>();
    return {
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => void m.set(k, v),
      removeItem: (k: string) => void m.delete(k),
    };
  }
  function capturingTimers() {
    const callbacks = new Map<number, () => void>();
    let nextId = 1;
    return {
      setInterval: vi.fn((cb: () => void, ms: number) => {
        callbacks.set(ms, cb);
        return nextId++;
      }),
      clearInterval: vi.fn(),
      fire: (ms: number) => callbacks.get(ms)!(),
    };
  }

  it('the autosave does not overwrite a save the load refused', () => {
    const storage = mapStorage();
    const newer = JSON.stringify({ version: 2, gameId: 'safe', timestamp: 1, data: {} });
    storage.setItem('safe-slot-0', newer);
    const timers = capturingTimers();
    const engine = createEngine({
      gameId: 'safe',
      saveVersion: 1,
      autoSaveInterval: 30000,
      storageAdapter: storage,
      timerProvider: timers,
    });
    engine.use({ id: 'safe-mod', install: () => void persistent(0, { name: 'gold' }) });
    engine.start();
    expect(engine.load().success).toBe(false);
    timers.fire(30000);
    expect(storage.getItem('safe-slot-0')).toBe(newer);
    engine.dispose();
  });

  it('load() before start() throws instead of reporting a load that hydrated nothing', () => {
    const engine = createEngine({ gameId: 'early', storageAdapter: mapStorage() });
    engine.use({ id: 'early-mod', install: () => void persistent(0, { name: 'gold' }) });
    expect(() => engine.load()).toThrow(/start\(\)/);
  });

  it('load() after dispose() throws', () => {
    const engine = createEngine({ gameId: 'late', storageAdapter: mapStorage() });
    engine.start();
    engine.dispose();
    expect(() => engine.load()).toThrow(/disposed/);
  });
});
