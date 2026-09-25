import { describe, it, expect, beforeEach, vi } from 'vitest';
import { computed, ref } from 'vue';
import {
  beginPersistentContext,
  endPersistentContext,
  persistent,
  resetAllPersistentContexts,
  type Persistent,
} from '@/core/persistence';
import { createReset } from '@/systems/reset';
import {
  createActionCategory,
  type ActionCategory,
  type ActionItemState,
} from '@/systems/action-category';
import { Resettable } from '@/systems/resettable';
import { Decimal, type DecimalSource } from '@/primitives/decimal';
import type { RegisterTick } from '@/core/sequencer';

beforeEach(() => {
  resetAllPersistentContexts();
});

// ============================================================================
// Test fixtures
// ============================================================================

interface FakeTickDriver {
  registerTick: RegisterTick;
  tick: (dt: number) => void;
}

function makeTickDriver(): FakeTickDriver {
  const handlers: Array<(dt: number) => void> = [];
  return {
    registerTick: (fn) => {
      handlers.push(fn);
      return () => {
        const i = handlers.indexOf(fn);
        if (i >= 0) handlers.splice(i, 1);
      };
    },
    tick: (dt) => {
      for (const fn of handlers) fn(dt);
    },
  };
}

interface ActionDef {
  id: string;
  baseTicks: number;
}

interface ActionState {
  timesCompleted: Persistent<DecimalSource>;
}

interface ActionPayload {
  count: number;
}

function makeCategory(opts?: { mode?: 'queue' | 'list'; driver?: FakeTickDriver }): {
  category: ActionCategory<ActionDef, ActionState, ActionPayload>;
  driver: FakeTickDriver;
} {
  const driver = opts?.driver ?? makeTickDriver();
  const category = createActionCategory<ActionDef, ActionState, ActionPayload>({
    id: `actions-${Math.random().toString(36).slice(2, 8)}`,
    mode: opts?.mode,
    registerTick: driver.registerTick,
    mapAction: (def) => {
      const entry = () => category.getEntry(def.id)!;
      return {
        signals: {
          unlock: computed(() => Decimal.gt(entry()?.state.timesCompleted.value ?? 0, 0)),
          count: computed(() => entry()?.state.timesCompleted.value ?? 0),
        },
        tick: ({ category: cat, dt }) => {
          cat.tickItemProgress(def.id, dt);
          const cur = cat.currentItem;
          if (!cur) return;
          const progress = typeof cur.progress === 'number' ? cur.progress : 0;
          if (progress >= def.baseTicks) {
            const e = entry();
            e.state.timesCompleted.value = Decimal.add(e.state.timesCompleted.value, 1);
            cat.sequencer.complete();
          }
        },
      };
    },
    mapState: () => ({ timesCompleted: persistent<DecimalSource>(0) }),
  });
  return { category, driver };
}

// ============================================================================
// Registration + per-def state
// ============================================================================

describe('createActionCategory — registration + per-def state', () => {
  it('register / getDef / getEntry / getAll / getState', () => {
    const { category } = makeCategory();
    category.register([
      { id: 'chop', baseTicks: 2 },
      { id: 'mine', baseTicks: 5 },
    ]);
    expect(category.size).toBe(2);
    expect(category.getDef('chop')?.baseTicks).toBe(2);
    expect(category.getEntry('mine')?.def.baseTicks).toBe(5);
    expect(category.getAll().map((e) => e.def.id)).toEqual(['chop', 'mine']);
    expect(Decimal.eq(category.getState('chop')!.timesCompleted.value, 0)).toBe(true);
  });

  it('throws on enqueue of an unregistered defId', () => {
    const { category } = makeCategory();
    expect(() => category.enqueue('ghost', { payload: { count: 1 } })).toThrow(/not registered/);
  });
});

// ============================================================================
// Polymorphic dispatch via per-mapping tick closures
// ============================================================================

describe('createActionCategory — polymorphic dispatch', () => {
  it('each def runs its own tick closure when active', () => {
    const driver = makeTickDriver();
    const tickSpy = vi.fn();

    const category = createActionCategory<ActionDef, void, void>({
      id: 'poly',
      mode: 'queue',
      registerTick: driver.registerTick,
      mapAction: (def) => ({
        signals: {
          unlock: computed(() => true),
          count: computed(() => 0),
        },
        tick: ({ category: cat }) => {
          tickSpy(def.id);
          cat.sequencer.complete();
        },
      }),
    });
    category.register([
      { id: 'first', baseTicks: 1 },
      { id: 'second', baseTicks: 1 },
    ]);
    category.enqueue('first');
    category.enqueue('second');

    driver.tick(0.1);
    driver.tick(0.1);
    expect(tickSpy).toHaveBeenNthCalledWith(1, 'first');
    expect(tickSpy).toHaveBeenNthCalledWith(2, 'second');
  });
});

// ============================================================================
// Lifecycle state machine
// ============================================================================

describe('createActionCategory — lifecycle state machine', () => {
  it('transitions pending → running → completed on dispatch + tick + complete', () => {
    const { category, driver } = makeCategory();
    category.register({ id: 'fast', baseTicks: 1 });

    const transitions: Array<[ActionItemState, ActionItemState]> = [];
    category.on('itemStateChange', (_e, from, to) => {
      transitions.push([from, to]);
    });

    category.enqueue('fast', { payload: { count: 1 } });
    // enqueue auto-starts (startOnEnqueue defaults true), so 'start' has fired
    // already → lifecycle should be 'running'.
    expect(category.currentItem?.lifecycle).toBe('running');
    expect(transitions[transitions.length - 1]).toEqual(['pending', 'running']);

    driver.tick(2);
    // tick added 2 progress → completion handler fires sequencer.complete()
    expect(transitions.some(([_, to]) => to === 'completed')).toBe(true);
  });

  it('emits itemStateChange after the transition commits, so listeners see and keep new state', () => {
    const { category } = makeCategory();
    category.register({ id: 'chop', baseTicks: 10 });

    const seen: Array<ActionItemState | undefined> = [];
    category.on('itemStateChange', (_e, _from, to) => {
      seen.push(category.currentItem?.lifecycle);
      if (to === 'running') category.setItemProgress('chop', 0.5);
    });

    category.enqueue('chop', { payload: { count: 1 } });
    expect(seen).toEqual(['running']);
    expect(category.currentItem?.lifecycle).toBe('running');
    expect(category.currentItem?.progress).toBe(0.5);
  });

  it('emits complete once when setItemState(completed) precedes sequencer.complete()', () => {
    const { category } = makeCategory();
    category.register({ id: 'x', baseTicks: 10 });
    let completes = 0;
    let toCompleted = 0;
    category.on('complete', () => completes++);
    category.on('itemStateChange', (_e, _from, to) => {
      if (to === 'completed') toCompleted++;
    });

    category.enqueue('x', { payload: { count: 1 } });
    category.setItemState('x', 'completed');
    category.sequencer.complete();

    expect(completes).toBe(1);
    expect(toCompleted).toBe(1);
  });

  it('setItemError transitions to failed and increments attempt', () => {
    const { category } = makeCategory();
    category.register({ id: 'fragile', baseTicks: 10 });
    category.enqueue('fragile', { payload: { count: 1 } });

    expect(category.currentItem?.lifecycle).toBe('running');
    expect(category.currentItem?.attempt).toBe(0);

    category.setItemError('fragile', { message: 'broke' });

    expect(category.currentItem?.lifecycle).toBe('failed');
    expect(category.currentItem?.attempt).toBe(1);
    expect(category.currentItem?.error?.message).toBe('broke');
  });

  it('setItemError(null) clears the error without changing lifecycle', () => {
    const { category } = makeCategory();
    category.register({ id: 'recovers', baseTicks: 10 });
    category.enqueue('recovers', { payload: { count: 1 } });
    category.setItemError('recovers', { message: 'oops' });
    expect(category.currentItem?.error?.message).toBe('oops');
    expect(category.currentItem?.lifecycle).toBe('failed');

    category.setItemError('recovers', null);
    expect(category.currentItem?.error).toBeUndefined();
    // Lifecycle stays at 'failed' — clearing the error doesn't auto-revive.
    expect(category.currentItem?.lifecycle).toBe('failed');
  });
});

// ============================================================================
// Multi-bar progress
// ============================================================================

describe('createActionCategory — multi-bar progress', () => {
  it('tickItemProgress with a number accumulates a scalar', () => {
    const { category, driver } = makeCategory();
    category.register({ id: 'walk', baseTicks: 100 });
    category.enqueue('walk', { payload: { count: 1 } });
    driver.tick(3);
    driver.tick(2);
    expect(category.currentItem?.progress).toBe(5);
  });

  it('tickItemProgress with a record accumulates named bars', () => {
    const driver = makeTickDriver();
    const category = createActionCategory<ActionDef, void, void>({
      id: 'multi',
      mode: 'queue',
      registerTick: driver.registerTick,
      mapAction: (def) => ({
        signals: { unlock: computed(() => true), count: computed(() => 0) },
        tick: ({ category: cat, dt }) => {
          cat.tickItemProgress(def.id, { mana: dt * 2, ticks: dt });
        },
      }),
    });
    category.register({ id: 'cast', baseTicks: 100 });
    category.enqueue('cast');
    driver.tick(1);
    driver.tick(2);
    const progress = category.currentItem!.progress as Record<string, number>;
    expect(progress.mana).toBe(6);
    expect(progress.ticks).toBe(3);
  });

  it('setItemProgress overwrites', () => {
    const { category } = makeCategory();
    category.register({ id: 'snap', baseTicks: 100 });
    category.enqueue('snap', { payload: { count: 1 } });
    category.setItemProgress('snap', 42);
    expect(category.currentItem?.progress).toBe(42);
    category.setItemProgress('snap', { phase: 7 });
    expect(category.currentItem?.progress).toEqual({ phase: 7 });
  });
});

// ============================================================================
// Scoped subscriptions
// ============================================================================

describe('createActionCategory — onItemChange', () => {
  it('fires only when the targeted defId is mutated; unsubscribe stops firing', () => {
    const { category } = makeCategory();
    category.register([
      { id: 'a', baseTicks: 100 },
      { id: 'b', baseTicks: 100 },
    ]);
    category.enqueue('a', { payload: { count: 1 } });
    category.enqueue('b', { payload: { count: 1 } });

    // Subscribe after enqueue/start dance so the only mutation that should
    // fire each handler is the explicit per-def progress set below.
    const aSpy = vi.fn();
    const bSpy = vi.fn();
    const unsubA = category.onItemChange('a', aSpy);
    category.onItemChange('b', bSpy);

    category.setItemProgress('a', 5);
    expect(aSpy).toHaveBeenCalledTimes(1);
    expect(bSpy).not.toHaveBeenCalled();

    category.setItemProgress('b', 7);
    expect(bSpy).toHaveBeenCalledTimes(1);

    unsubA();
    category.setItemProgress('a', 9);
    expect(aSpy).toHaveBeenCalledTimes(1);
  });
});

// ============================================================================
// Payload typing + payload patching
// ============================================================================

describe('createActionCategory — payload', () => {
  it('patchItemPayload with partial merges', () => {
    const { category } = makeCategory();
    category.register({ id: 'with-payload', baseTicks: 100 });
    category.enqueue('with-payload', { payload: { count: 3 } });
    category.patchItemPayload('with-payload', { count: 5 });
    expect(category.currentItem?.payload).toEqual({ count: 5 });
  });

  it('patchItemPayload with function transforms', () => {
    const { category } = makeCategory();
    category.register({ id: 'fn-payload', baseTicks: 100 });
    category.enqueue('fn-payload', { payload: { count: 1 } });
    category.patchItemPayload('fn-payload', (p) => ({ count: p.count + 10 }));
    expect(category.currentItem?.payload).toEqual({ count: 11 });
  });
});

// ============================================================================
// Reset participation
// ============================================================================

describe('createActionCategory — Resettable', () => {
  it('exposes [Resettable] forwarding from createCategoryBase', () => {
    const { category } = makeCategory();
    category.register({ id: 'r', baseTicks: 1 });
    // Bump state so reset has something visible to clear.
    category.getState('r')!.timesCompleted.value = 99;

    // Manually iterate Resettable refs and reset them — exercises the protocol
    // without depending on createReset's full wiring.
    const items = Array.from(category[Resettable]() as Iterable<unknown>);
    for (const item of items) {
      if (
        item &&
        typeof item === 'object' &&
        'timesCompleted' in (item as Record<string, unknown>)
      ) {
        const state = item as ActionState;
        state.timesCompleted.value = 0;
      }
    }
    expect(Decimal.eq(category.getState('r')!.timesCompleted.value, 0)).toBe(true);
  });

  it('a reset of the category resets per-def state and leaves the queue and the running item alone', () => {
    const { category } = makeCategory();
    category.register([
      { id: 'a', baseTicks: 10 },
      { id: 'b', baseTicks: 10 },
    ]);
    category.getState('a')!.timesCompleted.value = 5;
    category.enqueue('a', { payload: { count: 1 } });
    category.enqueue('b', { payload: { count: 1 } });
    category.setItemProgress('a', 3);

    createReset({ thingsToReset: [category] }).reset();

    expect(Decimal.eq(category.getState('a')!.timesCompleted.value, 0)).toBe(true);
    expect(category.currentItem?.defId).toBe('a');
    expect(category.currentItem?.progress).toBe(3);
    expect(category.sequencer.items.value.map((i) => i.metadata.defId)).toEqual(['b']);
  });

  it('a module-scoped reset sweeps the queue too, without a cancel event', () => {
    const driver = makeTickDriver();
    beginPersistentContext('act-mod');
    const category = createActionCategory<ActionDef, void, void>({
      id: 'acts',
      registerTick: driver.registerTick,
      mapAction: () => ({ signals: { unlock: computed(() => true), count: computed(() => 0) } }),
    });
    category.register([
      { id: 'a', baseTicks: 1 },
      { id: 'b', baseTicks: 1 },
    ]);
    endPersistentContext();
    const cancelled: string[] = [];
    category.on('cancel', (e) => cancelled.push(e.def.id));
    category.enqueue('a');
    category.enqueue('b');

    createReset({ resetModules: ['act-mod'] }).reset();

    expect(category.currentItem).toBeNull();
    expect(category.sequencer.items.value).toEqual([]);
    expect(cancelled).toEqual([]);
  });
});

// ============================================================================
// canRun composition
// ============================================================================

describe('createActionCategory — per-def canRun', () => {
  it('mapping.canRun gates dispatch', () => {
    const driver = makeTickDriver();
    const allow = ref(false);

    const category = createActionCategory<ActionDef, void, void>({
      id: 'gated',
      mode: 'queue',
      registerTick: driver.registerTick,
      mapAction: () => ({
        signals: { unlock: computed(() => true), count: computed(() => 0) },
        canRun: () => (allow.value ? 'now' : 'never'),
        tick: ({ category: cat }) => {
          cat.sequencer.complete();
        },
      }),
    });
    category.register({ id: 'g', baseTicks: 1 });
    category.enqueue('g');
    expect(category.currentItem).toBeNull(); // skipped because canRun returned 'never'

    allow.value = true;
    category.enqueue('g');
    expect(category.currentItem?.defId).toBe('g');
  });
});

// ============================================================================
// List-mode persistence of current item
// ============================================================================

describe('createActionCategory — list mode', () => {
  it('current item persists in items.value at cursor in list mode', () => {
    const { category } = makeCategory({ mode: 'list' });
    category.register([
      { id: 'first', baseTicks: 100 },
      { id: 'second', baseTicks: 100 },
    ]);
    category.enqueue('first', { payload: { count: 1 } });
    category.enqueue('second', { payload: { count: 1 } });

    // List mode: running item also lives at items.value[cursor].
    expect(category.sequencer.items.value.length).toBe(2);
    expect(category.sequencer.items.value[0].metadata.defId).toBe('first');
    expect(category.sequencer.cursor).toBe(0);

    // Mutating the current item via category verbs mirrors into items.value.
    category.setItemProgress('first', 42);
    expect(category.sequencer.items.value[0].metadata.progress).toBe(42);
  });

  it('replay() re-runs the list from fresh execution slots, duplicate defs included', () => {
    const { category, driver } = makeCategory({ mode: 'list' });
    category.register([
      { id: 'walk', baseTicks: 1 },
      { id: 'dig', baseTicks: 2 },
    ]);
    for (const id of ['walk', 'dig', 'walk']) category.enqueue(id, { payload: { count: 1 } });

    const runTicks = () => {
      let ticks = 0;
      while (category.currentItem && ticks < 100) {
        driver.tick(0.25);
        ticks++;
      }
      return ticks;
    };

    const first = runTicks();
    expect(first).toBe(16);
    expect(category.sequencer.items.value.map((i) => i.metadata.lifecycle)).toEqual([
      'completed',
      'completed',
      'completed',
    ]);

    category.replay();
    expect(category.sequencer.cursor).toBe(0);
    expect(category.currentItem?.lifecycle).toBe('running');
    expect(
      category.sequencer.items.value.map((i) => [i.metadata.progress, i.metadata.lifecycle]),
    ).toEqual([
      [0, 'running'],
      [0, 'pending'],
      [0, 'pending'],
    ]);
    expect(runTicks()).toBe(first);
  });
});
