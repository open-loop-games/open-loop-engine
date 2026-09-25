import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ref } from 'vue';
import { Decimal } from '@/primitives/decimal';
import { createTemporaryEffectSystem } from '@/systems/temporary-effect';
import {
  createModifierChain,
  createMultiplicativeModifier,
  createAdditiveModifier,
} from '@/core/modifier';
import {
  resetAllPersistentContexts,
  withPersistentContext,
  getAllPersistentRefs,
  deserializePersistents,
} from '@/core/persistence';
import { createMemoryStorage, type StorageAdapter } from '@/core/save-manager';
import { createEngine, type Engine } from '@/engine';
import { createReset } from '@/systems/reset';
import type { TemporaryEffectDef, TemporaryEffectSystem } from '@/systems/temporary-effect';

beforeEach(() => {
  resetAllPersistentContexts();
});

/** Creates a simple registerTick that returns the tick function for manual calling */
function createTickManager() {
  const callbacks: ((dt: number) => void)[] = [];
  return {
    registerTick(cb: (dt: number) => void) {
      callbacks.push(cb);
      return () => {
        const idx = callbacks.indexOf(cb);
        if (idx >= 0) callbacks.splice(idx, 1);
      };
    },
    tick(dt: number) {
      for (const cb of callbacks) cb(dt);
    },
  };
}

function createSystem(tm = createTickManager()) {
  const system = createTemporaryEffectSystem({
    id: 'test',
    registerTick: tm.registerTick,
  });
  return { system, ...tm };
}

/**
 * One engine session over `storage`: a module builds the system inside
 * install, registers `defs`, and ticks through the engine's driver. Two
 * sessions over the same storage are a real save → load round trip.
 */
function startSession(
  storage: StorageAdapter,
  defs: TemporaryEffectDef[],
  persistenceNamespace?: string,
): { engine: Engine; system: TemporaryEffectSystem } {
  let system!: TemporaryEffectSystem;
  const engine = createEngine({
    gameId: 'temp-effect-rt',
    storageAdapter: storage,
    persistenceNamespace,
  });
  engine.use({
    id: 'buffs',
    install(ctx) {
      system = createTemporaryEffectSystem({ id: 'buffs', registerTick: (cb) => ctx.onTick(cb) });
      system.register(defs);
    },
  });
  engine.start();
  return { engine, system };
}

// ============================================================================
// Registration
// ============================================================================

describe('registration', () => {
  it('register + getDef round-trip', () => {
    const { system } = createSystem();
    system.register({ id: 'burn', duration: 4 });
    expect(system.getDef('burn')).toBeDefined();
    expect(system.getDef('burn')!.id).toBe('burn');
    expect(system.getDef('unknown')).toBeUndefined();
  });

  it('register accepts array of defs', () => {
    const { system } = createSystem();
    system.register([
      { id: 'burn', duration: 4 },
      { id: 'chill', duration: 6 },
    ]);
    expect(system.getDef('burn')).toBeDefined();
    expect(system.getDef('chill')).toBeDefined();
  });

  it('throws on a duplicate definition id, as persistent-effect does', () => {
    const { system } = createSystem();
    system.register({ id: 'burn', duration: 4 });
    expect(() => system.register({ id: 'burn', duration: 8 })).toThrow(/duplicate/);
    expect(system.getDef('burn')!.duration).toBe(4);
  });

  it('throws if maxStacks > 1 with non-factory modifier', () => {
    const { system } = createSystem();
    const chain = createModifierChain('test');
    const modifier = createMultiplicativeModifier({ multiplier: 2 });

    expect(() =>
      system.register({
        id: 'burn',
        duration: 4,
        maxStacks: 3,
        modifiers: [{ chain, modifier }],
      }),
    ).toThrow(/factories/i);
  });
});

// ============================================================================
// Apply
// ============================================================================

describe('apply', () => {
  it('creates instance with correct fields', () => {
    const { system } = createSystem();
    system.register({ id: 'burn', duration: 4 });
    const inst = system.apply('burn');

    expect(inst).not.toBeNull();
    expect(inst!.defId).toBe('burn');
    expect(inst!.duration).toBe(4);
    expect(inst!.timeRemaining.value).toBe(4);
    expect(inst!.stackIndex).toBe(0);
    expect(inst!.id).toContain('burn:');
  });

  it('returns null at maxStacks', () => {
    const { system } = createSystem();
    system.register({ id: 'burn', duration: 4, maxStacks: 1 });
    const first = system.apply('burn');
    const second = system.apply('burn');

    expect(first).not.toBeNull();
    expect(second).toBeNull();
  });

  it('refresh behavior resets timeRemaining', () => {
    const { system, tick } = createSystem();
    system.register({ id: 'burn', duration: 4, stackBehavior: 'refresh' });
    const first = system.apply('burn')!;
    tick(2); // 2s elapsed, 2s remaining
    expect(first.timeRemaining.value).toBeCloseTo(2);

    const refreshed = system.apply('burn')!;
    expect(refreshed).toBe(first); // same instance
    expect(refreshed.timeRemaining.value).toBe(4); // reset to full
  });

  it('a refresh at a longer duration carries the new duration with it', () => {
    const { system } = createSystem();
    const duration = ref(4);
    system.register({ id: 'burn', duration, stackBehavior: 'refresh' });
    const first = system.apply('burn')!;
    duration.value = 9;
    system.apply('burn');
    expect(first.timeRemaining.value).toBe(9);
    expect(first.duration).toBe(9);
  });

  it('adds modifiers to chains', () => {
    const { system } = createSystem();
    const chain = createModifierChain('damage');
    system.register({
      id: 'buff',
      duration: 5,
      modifiers: [{ chain, modifier: createMultiplicativeModifier({ multiplier: 2 }) }],
    });

    expect(Decimal.eq(chain.apply(10), 10)).toBe(true); // no effect yet
    system.apply('buff');
    expect(Decimal.eq(chain.apply(10), 20)).toBe(true); // x2
  });

  it('factory modifier creates distinct instances per stack', () => {
    const { system } = createSystem();
    const chain = createModifierChain('damage');
    system.register({
      id: 'burn',
      duration: 4,
      maxStacks: 3,
      modifiers: [{ chain, modifier: () => createAdditiveModifier({ addend: 5 }) }],
    });

    system.apply('burn');
    expect(Decimal.eq(chain.apply(0), 5)).toBe(true);
    system.apply('burn');
    expect(Decimal.eq(chain.apply(0), 10)).toBe(true);
    system.apply('burn');
    expect(Decimal.eq(chain.apply(0), 15)).toBe(true);
  });

  it('modifiers factory evaluated at apply time', () => {
    const { system } = createSystem();
    const chainA = createModifierChain('speed');
    const chainB = createModifierChain('potency');
    let targetChain = chainA;

    system.register({
      id: 'charge',
      duration: 4,
      stackBehavior: 'refresh',
      modifiers: () => [
        { chain: targetChain, modifier: () => createMultiplicativeModifier({ multiplier: 1.5 }) },
      ],
    });

    // First apply targets chainA
    system.apply('charge');
    expect(Decimal.eq(chainA.apply(10), 15)).toBe(true);
    expect(Decimal.eq(chainB.apply(10), 10)).toBe(true);

    // Dispel, switch target, re-apply → targets chainB
    system.dispel('charge');
    targetChain = chainB;
    system.apply('charge');
    expect(Decimal.eq(chainA.apply(10), 10)).toBe(true);
    expect(Decimal.eq(chainB.apply(10), 15)).toBe(true);
  });

  it('onApply fires', () => {
    const { system } = createSystem();
    const onApply = vi.fn();
    system.register({ id: 'burn', duration: 4, onApply });
    system.apply('burn');
    expect(onApply).toHaveBeenCalledOnce();
    expect(onApply.mock.calls[0]![0].defId).toBe('burn');
  });

  it('throws on unknown defId', () => {
    const { system } = createSystem();
    expect(() => system.apply('nonexistent')).toThrow(/unknown/i);
  });
});

// ============================================================================
// Tick + Expiry
// ============================================================================

describe('tick and expiry', () => {
  it('timeRemaining decreases by dt', () => {
    const { system, tick } = createSystem();
    system.register({ id: 'burn', duration: 4 });
    const inst = system.apply('burn')!;

    tick(1);
    expect(inst.timeRemaining.value).toBeCloseTo(3);
    tick(0.5);
    expect(inst.timeRemaining.value).toBeCloseTo(2.5);
  });

  it('instance expires at 0', () => {
    const { system, tick } = createSystem();
    system.register({ id: 'burn', duration: 2 });
    system.apply('burn');

    tick(1);
    expect(system.getActive()).toHaveLength(1);
    tick(1);
    expect(system.getActive()).toHaveLength(0);
  });

  it('onTick fires with correct dt', () => {
    const { system, tick } = createSystem();
    const onTick = vi.fn();
    system.register({ id: 'burn', duration: 10, onTick });
    system.apply('burn');

    tick(0.25);
    expect(onTick).toHaveBeenCalledOnce();
    expect(onTick.mock.calls[0]![1]).toBeCloseTo(0.25);
  });

  it('onExpire fires on expiry', () => {
    const { system, tick } = createSystem();
    const onExpire = vi.fn();
    system.register({ id: 'burn', duration: 1, onExpire });
    system.apply('burn');

    tick(1);
    expect(onExpire).toHaveBeenCalledOnce();
  });

  it('modifiers removed from chains on expiry', () => {
    const { system, tick } = createSystem();
    const chain = createModifierChain('damage');
    system.register({
      id: 'buff',
      duration: 2,
      modifiers: [{ chain, modifier: createMultiplicativeModifier({ multiplier: 3 }) }],
    });

    system.apply('buff');
    expect(Decimal.eq(chain.apply(10), 30)).toBe(true);

    tick(2);
    expect(Decimal.eq(chain.apply(10), 10)).toBe(true); // back to base
  });
});

// ============================================================================
// Query
// ============================================================================

describe('query', () => {
  it('isActive returns reactive true/false', () => {
    const { system, tick } = createSystem();
    system.register({ id: 'burn', duration: 1 });
    const active = system.isActive('burn');

    expect(active.value).toBe(false);
    system.apply('burn');
    expect(active.value).toBe(true);
    tick(1);
    expect(active.value).toBe(false);
  });

  it('activeCount returns reactive count', () => {
    const { system } = createSystem();
    system.register({ id: 'burn', duration: 10, maxStacks: 3 });
    const count = system.activeCount('burn');

    expect(count.value).toBe(0);
    system.apply('burn');
    expect(count.value).toBe(1);
    system.apply('burn');
    expect(count.value).toBe(2);
  });

  it('getActive returns snapshot copy', () => {
    const { system } = createSystem();
    system.register({ id: 'burn', duration: 10 });
    system.apply('burn');

    const active = system.getActive();
    expect(active).toHaveLength(1);
    expect(active[0]!.defId).toBe('burn');
  });

  it('getByTag filters correctly', () => {
    const { system } = createSystem();
    system.register([
      { id: 'burn', duration: 4, tags: ['echo', 'flame'] },
      { id: 'chill', duration: 6, tags: ['echo', 'frost'] },
      { id: 'surge', duration: 8, tags: ['surge'] },
    ]);
    system.apply('burn');
    system.apply('chill');
    system.apply('surge');

    expect(system.getByTag('echo')).toHaveLength(2);
    expect(system.getByTag('flame')).toHaveLength(1);
    expect(system.getByTag('surge')).toHaveLength(1);
    expect(system.getByTag('nonexistent')).toHaveLength(0);
  });
});

// ============================================================================
// Stacking
// ============================================================================

describe('stacking', () => {
  it('independent: 2 applies = 2 instances with separate timers', () => {
    const { system, tick } = createSystem();
    system.register({
      id: 'burn',
      duration: 4,
      maxStacks: 2,
      stackBehavior: 'independent',
    });

    const a = system.apply('burn')!;
    tick(1); // a at 3s
    const b = system.apply('burn')!;

    expect(a.id).not.toBe(b.id);
    expect(a.timeRemaining.value).toBeCloseTo(3);
    expect(b.timeRemaining.value).toBe(4);
  });

  it('refresh: 2nd apply resets timer, no new instance', () => {
    const { system, tick } = createSystem();
    system.register({
      id: 'burn',
      duration: 4,
      maxStacks: 1,
      stackBehavior: 'refresh',
    });

    system.apply('burn');
    tick(2);
    system.apply('burn');

    expect(system.getActive()).toHaveLength(1);
    expect(system.getActive()[0]!.timeRemaining.value).toBe(4);
  });

  it('stackIndex is the lowest index no live stack of the def holds', () => {
    const { system } = createSystem();
    system.register({ id: 'burn', duration: 10, maxStacks: 3 });
    const a = system.apply('burn')!;
    const b = system.apply('burn')!;
    a.expire();
    const c = system.apply('burn')!;
    const d = system.apply('burn')!;
    expect([b.stackIndex, c.stackIndex, d.stackIndex]).toEqual([1, 0, 2]);
  });

  it('maxStacks caps independent stacking', () => {
    const { system } = createSystem();
    system.register({ id: 'burn', duration: 10, maxStacks: 2 });

    expect(system.apply('burn')).not.toBeNull();
    expect(system.apply('burn')).not.toBeNull();
    expect(system.apply('burn')).toBeNull();
    expect(system.getActive()).toHaveLength(2);
  });
});

// ============================================================================
// Dispel
// ============================================================================

describe('dispel', () => {
  it('dispel removes all instances of one def', () => {
    const { system } = createSystem();
    system.register([
      { id: 'burn', duration: 10, maxStacks: 2 },
      { id: 'chill', duration: 10 },
    ]);
    system.apply('burn');
    system.apply('burn');
    system.apply('chill');

    system.dispel('burn');
    expect(system.getActive()).toHaveLength(1);
    expect(system.getActive()[0]!.defId).toBe('chill');
  });

  it('dispelAll clears everything', () => {
    const { system } = createSystem();
    system.register([
      { id: 'burn', duration: 10 },
      { id: 'chill', duration: 10 },
    ]);
    system.apply('burn');
    system.apply('chill');

    system.dispelAll();
    expect(system.getActive()).toHaveLength(0);
  });

  it('instance.expire() ends just that stack the way expiry does', () => {
    const onExpire = vi.fn();
    const expired = vi.fn();
    const { system } = createSystem();
    system.register({ id: 'burn', duration: 10, maxStacks: 2, onExpire });
    system.on('expired', expired);
    const a = system.apply('burn')!;
    system.apply('burn');

    a.expire();
    expect(system.getActive()).toHaveLength(1);
    expect(onExpire).toHaveBeenCalledWith(a);
    expect(expired).toHaveBeenCalledWith(a);
  });

  it('dispel cleans up modifiers', () => {
    const { system } = createSystem();
    const chain = createModifierChain('damage');
    system.register({
      id: 'buff',
      duration: 10,
      modifiers: [{ chain, modifier: createMultiplicativeModifier({ multiplier: 2 }) }],
    });

    system.apply('buff');
    expect(Decimal.eq(chain.apply(10), 20)).toBe(true);

    system.dispel('buff');
    expect(Decimal.eq(chain.apply(10), 10)).toBe(true);
  });
});

// ============================================================================
// Persistence
// ============================================================================

describe('persistence', () => {
  it('a load rebuilds instances from the save, firing onRehydrate instead of onApply', () => {
    const onApply = vi.fn();
    const onRehydrate = vi.fn();
    const defs = [{ id: 'burn', duration: 10, onApply, onRehydrate }];
    const storage = createMemoryStorage();
    const first = startSession(storage, defs);
    first.system.apply('burn');
    first.engine.save();
    first.engine.dispose();
    onApply.mockClear();

    const second = startSession(storage, defs);
    second.engine.load();
    expect(second.system.getActive().map((i) => i.defId)).toEqual(['burn']);
    expect(onRehydrate).toHaveBeenCalledOnce();
    expect(onApply).not.toHaveBeenCalled();
    second.engine.dispose();
  });

  it('a load falls back to onApply when the def has no onRehydrate', () => {
    const onApply = vi.fn();
    const storage = createMemoryStorage();
    const first = startSession(storage, [{ id: 'burn', duration: 10, onApply }]);
    first.system.apply('burn');
    first.engine.save();
    first.engine.dispose();
    onApply.mockClear();

    const second = startSession(storage, [{ id: 'burn', duration: 10, onApply }]);
    second.engine.load();
    expect(onApply).toHaveBeenCalledOnce();
    second.engine.dispose();
  });

  it('a mid-session load replaces the live instances and their modifiers', () => {
    const chain = createModifierChain('speed');
    const defs: TemporaryEffectDef[] = [
      {
        id: 'haste',
        duration: 30,
        modifiers: [{ chain, modifier: () => createMultiplicativeModifier({ multiplier: 2 }) }],
      },
      { id: 'burn', duration: 10 },
    ];
    const storage = createMemoryStorage();
    const { engine, system } = startSession(storage, defs);
    system.apply('burn');
    engine.save();
    system.apply('haste');
    expect(Decimal.eq(chain.apply(10), 20)).toBe(true);

    engine.load();
    expect(system.getActive().map((i) => i.defId)).toEqual(['burn']);
    expect(Decimal.eq(chain.apply(10), 10)).toBe(true);
    engine.dispose();
  });

  it("another engine's load leaves this engine's instances alone", () => {
    const onRehydrate = vi.fn();
    const live = startSession(createMemoryStorage(), [{ id: 'haste', duration: 30, onRehydrate }]);
    const haste = live.system.apply('haste')!;

    const scratch = startSession(createMemoryStorage(), [{ id: 'haste', duration: 30 }], 'scratch');
    scratch.engine.save();
    expect(scratch.engine.load().success).toBe(true);

    expect(onRehydrate).not.toHaveBeenCalled();
    expect(live.system.getActive()).toEqual([haste]);
    scratch.engine.dispose();
    live.engine.dispose();
  });

  it('a live instance survives a save round trip with its remaining time', () => {
    const storage = createMemoryStorage();
    const first = startSession(storage, [{ id: 'haste', duration: 30 }]);
    first.system.apply('haste');
    for (let s = 0; s < 12; s++) first.engine.tickDriver.simulateTick(1);
    first.engine.save();
    first.engine.dispose();

    const second = startSession(storage, [{ id: 'haste', duration: 30 }]);
    second.engine.load();
    expect(second.system.getActive().map((i) => i.timeRemaining.value)).toEqual([18]);
    second.engine.dispose();
  });

  it('a rehydrated instance keeps the duration it was applied with', () => {
    const storage = createMemoryStorage();
    const first = startSession(storage, [{ id: 'haste', duration: 30 }]);
    first.system.apply('haste');
    for (let s = 0; s < 12; s++) first.engine.tickDriver.simulateTick(1);
    first.engine.save();
    first.engine.dispose();

    // Rebalanced since the save: the def now lasts 10s.
    const second = startSession(storage, [{ id: 'haste', duration: 10 }]);
    second.engine.load();
    const [instance] = second.system.getActive();
    expect(instance!.duration).toBe(30);
    expect(instance!.timeRemaining.value).toBe(18);
    second.engine.dispose();
  });

  it('a save without durations rehydrates one no shorter than the time remaining', () => {
    const system = withPersistentContext('legacy', () =>
      createTemporaryEffectSystem({ id: 'legacy', registerTick: () => () => {} }),
    );
    system.register({ id: 'haste', duration: 10 });
    deserializePersistents(getAllPersistentRefs(), {
      'temp-effect:legacy': { savedState: [{ defId: 'haste', timeRemaining: 25 }] },
    });
    const [instance] = system.getActive();
    expect(instance!.duration).toBe(25);
    expect(instance!.timeRemaining.value).toBe(25);
  });

  it('a load skips a saved instance whose def no longer registers', () => {
    const storage = createMemoryStorage();
    const first = startSession(storage, [
      { id: 'burn', duration: 10 },
      { id: 'haste', duration: 30 },
    ]);
    first.system.apply('burn');
    first.system.apply('haste');
    first.engine.save();
    first.engine.dispose();

    const second = startSession(storage, [{ id: 'haste', duration: 30 }]);
    expect(() => second.engine.load()).not.toThrow();
    expect(second.system.getActive().map((i) => i.defId)).toEqual(['haste']);
    second.engine.dispose();
  });
});

describe('resets', () => {
  function buildHasted() {
    const chain = createModifierChain('speed');
    const onExpire = vi.fn();
    const system = withPersistentContext('run', () =>
      createTemporaryEffectSystem({ id: 'run-buffs', registerTick: () => () => {} }),
    );
    system.register({
      id: 'haste',
      duration: 30,
      onExpire,
      modifiers: [{ chain, modifier: createMultiplicativeModifier({ multiplier: 2 }) }],
    });
    system.apply('haste');
    return { system, chain, onExpire };
  }

  it('a module reset drops every live instance and its modifiers, without onExpire', () => {
    const { system, chain, onExpire } = buildHasted();

    createReset({ resetModules: ['run'] }).reset();

    expect(system.getActive()).toEqual([]);
    expect(Decimal.eq(chain.apply(10), 10)).toBe(true);
    expect(onExpire).not.toHaveBeenCalled();
  });

  it('a reset naming the system in thingsToReset drops every live instance', () => {
    const { system, chain } = buildHasted();

    createReset({ thingsToReset: [system] }).reset();

    expect(system.getActive()).toEqual([]);
    expect(Decimal.eq(chain.apply(10), 10)).toBe(true);
  });
});

// ============================================================================
// Offline
// ============================================================================

describe('offline', () => {
  it('large dt expires effects correctly', () => {
    const { system, tick } = createSystem();
    const onExpire = vi.fn();
    system.register({ id: 'burn', duration: 5, onExpire });
    system.apply('burn');

    // Simulate 10 seconds offline
    tick(10);
    expect(system.getActive()).toHaveLength(0);
    expect(onExpire).toHaveBeenCalledOnce();
  });
});

// ============================================================================
// Chain order
// ============================================================================

describe('chain order', () => {
  it('the chain value follows registration order, not apply order', () => {
    const { system } = createSystem();
    const chain = createModifierChain('dmg');
    system.register([
      {
        id: 'flat',
        duration: 10,
        modifiers: [{ chain, modifier: () => createAdditiveModifier({ addend: 10 }) }],
      },
      {
        id: 'double',
        duration: 10,
        modifiers: [{ chain, modifier: () => createMultiplicativeModifier({ multiplier: 2 }) }],
      },
    ]);

    system.apply('double');
    system.apply('flat');
    expect(Decimal.eq(chain.apply(1), 22)).toBe(true);

    system.dispel('flat');
    system.apply('flat');
    expect(Decimal.eq(chain.apply(1), 22)).toBe(true);
  });
});

// ============================================================================
// Events
// ============================================================================

describe('events', () => {
  it('applied event fires with instance', () => {
    const { system } = createSystem();
    system.register({ id: 'burn', duration: 4 });

    const handler = vi.fn();
    system.on('applied', handler);
    system.apply('burn');

    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0]![0].defId).toBe('burn');
  });

  it('expired event fires with instance', () => {
    const { system, tick } = createSystem();
    system.register({ id: 'burn', duration: 1 });

    const handler = vi.fn();
    system.on('expired', handler);
    system.apply('burn');
    tick(1);

    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0]![0].defId).toBe('burn');
  });
});

// ============================================================================
// Dispose
// ============================================================================

describe('dispose', () => {
  it('system.dispose() cleans up tick and all instances', () => {
    const { system, tick } = createSystem();
    const chain = createModifierChain('damage');
    system.register({
      id: 'buff',
      duration: 10,
      modifiers: [{ chain, modifier: createMultiplicativeModifier({ multiplier: 2 }) }],
    });

    system.apply('buff');
    expect(Decimal.eq(chain.apply(10), 20)).toBe(true);

    system.dispose();
    expect(system.getActive()).toHaveLength(0);
    expect(Decimal.eq(chain.apply(10), 10)).toBe(true); // modifier removed

    // Tick should be unsubscribed (no error, no effect)
    tick(1);
  });
});

// ============================================================================
// Reactive duration
// ============================================================================

describe('reactive duration', () => {
  it('rejects a non-finite duration, which a save cannot hold', () => {
    const { system } = createSystem();
    expect(() => system.register({ id: 'forever', duration: Infinity })).toThrow(
      /persistent-effect/,
    );
    expect(() => system.register({ id: 'nan', duration: Decimal.dNaN })).toThrow(/finite/);

    const dur = ref<number>(5);
    system.register({ id: 'burn', duration: dur });
    dur.value = Infinity;
    expect(() => system.apply('burn')).toThrow(/finite/);
    expect(system.getActive()).toHaveLength(0);
  });

  it('resolves duration from ref at apply time', () => {
    const { system } = createSystem();
    const dur = ref(5);
    system.register({ id: 'burn', duration: dur });

    const inst = system.apply('burn')!;
    expect(inst.duration).toBe(5);
    expect(inst.timeRemaining.value).toBe(5);
  });
});

// ============================================================================
// Grant vocabulary
// ============================================================================

describe('modifiers take Grants', () => {
  const value = (chain: ReturnType<typeof createModifierChain>) =>
    Decimal.fromValue(chain.apply(1)).toNumber();

  it('a shorthand builds a fresh modifier per stack', () => {
    const { system } = createSystem();
    const chain = createModifierChain('speed');
    system.register({
      id: 'haste',
      duration: 10,
      maxStacks: 2,
      modifiers: [{ chain, mult: 1.5, description: 'Haste' }],
    });

    system.apply('haste');
    system.apply('haste');
    expect(value(chain)).toBeCloseTo(2.25);
  });

  it('a chain array binds on each chain', () => {
    const { system } = createSystem();
    const speed = createModifierChain('speed');
    const power = createModifierChain('power');
    system.register({
      id: 'rage',
      duration: 10,
      modifiers: [{ chain: [speed, power], add: 2, description: 'Rage' }],
    });

    system.apply('rage');
    expect([value(speed), value(power)]).toEqual([3, 3]);
  });

  it('when gates the grant while the effect runs', () => {
    const { system } = createSystem();
    const chain = createModifierChain('speed');
    const night = ref(false);
    system.register({
      id: 'owl',
      duration: 10,
      modifiers: [{ chain, mult: 2, description: 'Owl', when: night }],
    });

    system.apply('owl');
    expect(value(chain)).toBe(1);
    night.value = true;
    expect(value(chain)).toBe(2);
  });

  it("a Gate when whose handles the runtime doesn't carry throws at register", () => {
    const { system } = createSystem();
    const chain = createModifierChain('speed');
    expect(() =>
      system.register({
        id: 'owl',
        duration: 10,
        modifiers: [{ chain, mult: 2, description: 'Owl', when: { kind: 'flag', id: 'night' } }],
      }),
    ).toThrow(/temporary effect 'owl' grant 'Owl' when: /);
  });
});
