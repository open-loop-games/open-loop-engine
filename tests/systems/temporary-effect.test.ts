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
  beginPersistentContext,
  endPersistentContext,
  resetAllPersistentContexts,
} from '@/core/persistence';
import { createMemoryStorage, type StorageAdapter } from '@/core/save-manager';
import { createEngine, type Engine } from '@/engine';
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
): { engine: Engine; system: TemporaryEffectSystem } {
  let system!: TemporaryEffectSystem;
  const engine = createEngine({ gameId: 'temp-effect-rt', storageAdapter: storage });
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
    a.dispose();
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

  it('instance.dispose() removes just that one', () => {
    const { system } = createSystem();
    system.register({ id: 'burn', duration: 10, maxStacks: 2 });
    const a = system.apply('burn')!;
    system.apply('burn');

    a.dispose();
    expect(system.getActive()).toHaveLength(1);
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
  it('restore reconstructs instances from saved data', () => {
    const tm = createTickManager();
    // Create system in a persistent context
    beginPersistentContext('test-persist');
    const system = createTemporaryEffectSystem({ id: 'persist', registerTick: tm.registerTick });
    endPersistentContext();

    system.register({ id: 'burn', duration: 10 });
    system.apply('burn');
    tm.tick(3); // 7s remaining

    // Simulate save/load: restore from current state
    system.restore();
    expect(system.getActive()).toHaveLength(1);
    expect(system.getActive()[0]!.timeRemaining.value).toBeCloseTo(7);
  });

  it('onRestore fires instead of onApply when defined', () => {
    const tm = createTickManager();
    const onApply = vi.fn();
    const onRestore = vi.fn();

    beginPersistentContext('test-persist-2');
    const system = createTemporaryEffectSystem({ id: 'persist2', registerTick: tm.registerTick });
    endPersistentContext();

    system.register({ id: 'burn', duration: 10, onApply, onRestore });
    system.apply('burn');
    expect(onApply).toHaveBeenCalledOnce();

    onApply.mockClear();
    system.restore();
    expect(onRestore).toHaveBeenCalledOnce();
    expect(onApply).not.toHaveBeenCalled();
  });

  it('onApply fires as fallback when onRestore not defined', () => {
    const tm = createTickManager();
    const onApply = vi.fn();

    beginPersistentContext('test-persist-3');
    const system = createTemporaryEffectSystem({ id: 'persist3', registerTick: tm.registerTick });
    endPersistentContext();

    system.register({ id: 'burn', duration: 10, onApply });
    system.apply('burn');
    onApply.mockClear();

    system.restore();
    expect(onApply).toHaveBeenCalledOnce();
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
    second.system.restore();
    expect(second.system.getActive().map((i) => i.timeRemaining.value)).toEqual([18]);
    second.engine.dispose();
  });

  it('restore skips a saved instance whose def no longer registers', () => {
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
    second.engine.load();
    expect(() => second.system.restore()).not.toThrow();
    expect(second.system.getActive().map((i) => i.defId)).toEqual(['haste']);
    second.engine.dispose();
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
