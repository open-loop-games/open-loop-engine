import { describe, it, expect } from 'vitest';
import { computed, effectScope, watchEffect } from 'vue';
import {
  beginPersistentContext,
  endPersistentContext,
  getAllPersistentRefs,
  deserializePersistents,
} from '@/core/persistence';
import {
  createSequencer,
  type Sequencer,
  type SequencerItem,
  type StartResult,
} from '@/core/sequencer';
import { createManualTicks } from '../helpers/manual-ticks';

const qi = (id: string): SequencerItem<void> => ({ id, metadata: undefined as void });

function makeQueue(opts: { mode?: 'queue' | 'list'; id?: string; maxSize?: number } = {}) {
  const ctxId = opts.id ?? `q-${Math.random().toString(36).slice(2, 8)}`;
  beginPersistentContext(ctxId);
  const q = createSequencer({ id: ctxId, ...opts });
  endPersistentContext();
  return q;
}

describe('Sequencer — queue mode (default)', () => {
  it('defaults to queue mode', () => {
    const q = makeQueue();
    expect(q.mode).toBe('queue');
  });

  it('consumes items on complete', () => {
    const q = makeQueue();
    q.enqueue(qi('a'));
    q.enqueue(qi('b'));
    expect(q.currentItem?.id).toBe('a');
    expect(q.items.value.length).toBe(1); // b waiting

    q.complete();
    expect(q.currentItem?.id).toBe('b');
    expect(q.items.value.length).toBe(0); // consumed

    q.complete();
    expect(q.currentItem).toBeNull();
  });

  it('cursor is always 0 in queue mode', () => {
    const q = makeQueue();
    q.enqueue(qi('a'));
    expect(q.cursor).toBe(0);
    q.complete();
    expect(q.cursor).toBe(0);
  });

  it('resetCursor is a no-op in queue mode', () => {
    const q = makeQueue();
    q.enqueue(qi('a'));
    q.resetCursor(); // should not throw or change anything
    expect(q.currentItem?.id).toBe('a');
  });
});

describe('Sequencer — list mode', () => {
  it('creates in list mode', () => {
    const q = makeQueue({ mode: 'list' });
    expect(q.mode).toBe('list');
    expect(q.cursor).toBe(0);
  });

  it('does not consume items on complete', () => {
    const q = makeQueue({ mode: 'list' });
    q.enqueue(qi('a'));
    q.enqueue(qi('b'));
    expect(q.currentItem?.id).toBe('a');

    q.complete();
    expect(q.currentItem?.id).toBe('b');
    // Items still in list
    expect(q.items.value.length).toBe(2);
    expect(q.items.value.map((i) => i.id)).toEqual(['a', 'b']);
  });

  it('advances cursor on complete', () => {
    const q = makeQueue({ mode: 'list' });
    q.enqueue(qi('a'));
    q.enqueue(qi('b'));
    q.enqueue(qi('c'));
    // After enqueue, 'a' is auto-started, cursor points AT 'a'
    expect(q.cursor).toBe(0);

    q.complete(); // complete 'a', start 'b'
    expect(q.cursor).toBe(1);
    expect(q.currentItem?.id).toBe('b');

    q.complete(); // complete 'b', start 'c'
    expect(q.cursor).toBe(2);
    expect(q.currentItem?.id).toBe('c');

    q.complete(); // complete 'c', nothing left
    expect(q.cursor).toBe(3); // done sentinel
    expect(q.currentItem).toBeNull();
  });

  it('stops at end of list when no fill strategy', () => {
    const q = makeQueue({ mode: 'list' });
    q.enqueue(qi('a'));
    q.complete();
    expect(q.currentItem).toBeNull();
    expect(q.cursor).toBe(1);
  });

  it('resetCursor replays from the beginning', () => {
    const q = makeQueue({ mode: 'list' });
    q.enqueue(qi('a'));
    q.enqueue(qi('b'));
    q.complete(); // a done, b running
    expect(q.cursor).toBe(1);

    q.resetCursor();
    expect(q.cursor).toBe(0); // points AT first item
    expect(q.currentItem?.id).toBe('a');
    // Items still intact
    expect(q.items.value.length).toBe(2);
  });

  it('resetCursor cancels current item', () => {
    const q = makeQueue({ mode: 'list' });
    const cancelled: string[] = [];
    q.on('cancelled', (item) => cancelled.push(item.id));

    q.enqueue(qi('a'));
    q.enqueue(qi('b'));
    q.complete(); // now b is current
    q.resetCursor();

    expect(cancelled).toEqual(['b']);
  });

  it('resetCursor while paused does not auto-start', () => {
    const q = makeQueue({ mode: 'list' });
    q.enqueue(qi('a'));
    q.pause();
    q.resetCursor();
    expect(q.cursor).toBe(0);
    expect(q.currentItem).toBeNull();
  });

  it('emits started and completed events like queue mode', () => {
    const q = makeQueue({ mode: 'list' });
    const started: string[] = [];
    const completed: string[] = [];
    q.on('started', (item) => started.push(item.id));
    q.on('completed', (item) => completed.push(item.id));

    q.enqueue(qi('a'));
    q.enqueue(qi('b'));
    q.complete();
    q.complete();

    expect(started).toEqual(['a', 'b']);
    expect(completed).toEqual(['a', 'b']);
  });

  it('canStart "never" skips items and advances cursor', () => {
    const q = makeQueue({ mode: 'list' });
    q.canStart = (item) => (item.id === 'skip-me' ? 'never' : 'now');
    const skipped: string[] = [];
    q.on('skipped', (item) => skipped.push(item.id));

    q.enqueue(qi('skip-me'));
    q.enqueue(qi('run-me'));

    // skip-me is skipped, run-me starts — cursor points AT run-me
    expect(q.currentItem?.id).toBe('run-me');
    expect(skipped).toEqual(['skip-me']);
    expect(q.cursor).toBe(1);
  });

  it('remove adjusts cursor when removing before cursor', () => {
    const q = makeQueue({ mode: 'list' });
    q.pause(); // prevent auto-start so we can set up list
    q.enqueue(qi('a'));
    q.enqueue(qi('b'));
    q.enqueue(qi('c'));
    q.resume(); // starts 'a', cursor = 0

    q.complete(); // starts 'b', cursor = 1

    // Remove 'a' (index 0, before cursor)
    q.remove(0);
    expect(q.cursor).toBe(0); // adjusted
    expect(q.items.value.map((i) => i.id)).toEqual(['b', 'c']);
  });

  it('remove does not adjust cursor when removing after cursor', () => {
    const q = makeQueue({ mode: 'list' });
    q.enqueue(qi('a'));
    q.enqueue(qi('b'));
    q.enqueue(qi('c'));
    // cursor = 0 (pointing AT 'a')

    // Remove 'c' (index 2, after cursor)
    q.remove(2);
    expect(q.cursor).toBe(0);
    expect(q.items.value.map((i) => i.id)).toEqual(['a', 'b']);
  });

  it('clear resets cursor', () => {
    const q = makeQueue({ mode: 'list' });
    q.enqueue(qi('a'));
    q.enqueue(qi('b'));
    q.complete();
    expect(q.cursor).toBe(1);

    q.clear();
    expect(q.cursor).toBe(0);
    expect(q.items.value.length).toBe(0);
  });

  it('reorder adjusts cursor when moving item from before to after', () => {
    const q = makeQueue({ mode: 'list' });
    q.pause();
    q.enqueue(qi('a'));
    q.enqueue(qi('b'));
    q.enqueue(qi('c'));
    q.enqueue(qi('d'));
    q.resume(); // starts 'a', cursor = 0

    q.complete(); // starts 'b', cursor = 1

    // Move 'a' (index 0, before cursor=1) to index 3 (after cursor)
    q.reorder(0, 3);
    expect(q.cursor).toBe(0); // adjusted down
    expect(q.items.value.map((i) => i.id)).toEqual(['b', 'c', 'd', 'a']);
  });

  it('reorder adjusts cursor when moving item from after to before', () => {
    const q = makeQueue({ mode: 'list' });
    q.pause();
    q.enqueue(qi('a'));
    q.enqueue(qi('b'));
    q.enqueue(qi('c'));
    q.enqueue(qi('d'));
    q.resume(); // starts 'a', cursor = 0

    q.complete(); // starts 'b', cursor = 1

    // Move 'd' (index 3, after cursor=1) to index 0 (before cursor)
    q.reorder(3, 0);
    expect(q.cursor).toBe(2); // adjusted up
    expect(q.items.value.map((i) => i.id)).toEqual(['d', 'a', 'b', 'c']);
  });
});

// ============================================================================
// Referential identity
// ============================================================================

describe('Sequencer — referential identity', () => {
  it('items.value returns the same array on repeated reads', () => {
    const q = makeQueue();
    q.enqueue(qi('a'));
    q.enqueue(qi('b'));

    const first = q.items.value;
    const second = q.items.value;
    expect(first).toBe(second);
  });

  it('items.value elements are referentially stable across reads', () => {
    const q = makeQueue();
    q.enqueue(qi('a'));

    const item1 = q.items.value[0];
    const item2 = q.items.value[0];
    expect(item1).toBe(item2);
  });

  it('items.value returns a new reference after mutation', () => {
    const q = makeQueue();
    q.enqueue(qi('a'));
    const before = q.items.value;

    q.enqueue(qi('b'));
    const after = q.items.value;
    expect(before).not.toBe(after);
  });

  it('currentItem returns the same object on repeated reads', () => {
    const q = makeQueue();
    q.enqueue(qi('a'));

    const first = q.currentItem;
    const second = q.currentItem;
    expect(first).toBe(second);
  });

  it('currentItem invalidates when current changes', () => {
    const q = makeQueue();
    q.enqueue(qi('a'));
    q.enqueue(qi('b'));

    const first = q.currentItem;
    expect(first?.id).toBe('a');

    q.complete();
    const second = q.currentItem;
    expect(second?.id).toBe('b');
    expect(first).not.toBe(second);
  });
});

// ============================================================================
// Vue reactivity — watchers over items.value retrigger on mutation
// ============================================================================

describe('Sequencer — Vue reactivity', () => {
  it('watchEffect over items.value reruns on every mutation', () => {
    const q = makeQueue();

    let runs = 0;
    const scope = effectScope();
    scope.run(() => {
      watchEffect(
        () => {
          // Read drives the dependency. The content is irrelevant.
          void q.items.value.length;
          runs++;
        },
        { flush: 'sync' },
      );
    });
    const initial = runs; // 1 after initial run

    q.enqueue(qi('a')); // auto-starts, items becomes [] → still []? Actually 'a' becomes current, items = []
    q.enqueue(qi('b')); // items = ['b']
    q.enqueue(qi('c')); // items = ['b', 'c']
    q.complete(); // 'b' becomes current, items = ['c']
    q.enqueue(qi('d')); // items = ['c', 'd']
    q.remove(0); // items = ['d']
    q.enqueue(qi('e')); // items = ['d', 'e']
    q.reorder(0, 1); // items = ['e', 'd']
    q.clear(); // items = []

    // Nine mutations, each should invalidate the effect at least once.
    // >= is used (not ===) because some mutations may flush multiple internal
    // changes (e.g. complete may sync items twice: advance + dequeueNext).
    expect(runs - initial).toBeGreaterThanOrEqual(9);
    scope.stop();
  });

  it('save/load rehydrate also retriggers watchers', () => {
    const ctxId = `rehydrate-${Math.random().toString(36).slice(2, 8)}`;
    beginPersistentContext(ctxId);
    const q = createSequencer({ id: ctxId });
    endPersistentContext();

    let runs = 0;
    let lastIds: string[] = [];
    const scope = effectScope();
    scope.run(() => {
      watchEffect(
        () => {
          lastIds = q.items.value.map((i) => i.id);
          runs++;
        },
        { flush: 'sync' },
      );
    });
    const initial = runs;

    // Use the same save/load path as the save-compat tests: seed a fixture
    // with a serialized rawItems and let deserializePersistents write it in.
    deserializePersistents(getAllPersistentRefs(), {
      [ctxId]: {
        current: '',
        rawItems: JSON.stringify(['x', 'y', 'z']),
        paused: false,
      },
    });

    expect(lastIds).toEqual(['x', 'y', 'z']);
    expect(runs - initial).toBeGreaterThanOrEqual(1);
    scope.stop();
  });
});

// ============================================================================
// startOnEnqueue
// ============================================================================

describe('Sequencer — startOnEnqueue', () => {
  it('defaults to true (existing auto-start behavior)', () => {
    const q = makeQueue();
    q.enqueue(qi('a'));
    expect(q.currentItem?.id).toBe('a');
  });

  it('does not auto-start when startOnEnqueue is false', () => {
    const ctxId = `q-noenqueue-${Math.random().toString(36).slice(2, 8)}`;
    beginPersistentContext(ctxId);
    const q = createSequencer({ id: ctxId, startOnEnqueue: false });
    endPersistentContext();

    q.enqueue(qi('a'));
    expect(q.currentItem).toBeNull();
    expect(q.items.value.length).toBe(1);
  });

  it('start() begins execution after planning', () => {
    const ctxId = `q-start-${Math.random().toString(36).slice(2, 8)}`;
    beginPersistentContext(ctxId);
    const q = createSequencer({ id: ctxId, startOnEnqueue: false });
    endPersistentContext();

    q.enqueue(qi('a'));
    q.enqueue(qi('b'));
    expect(q.currentItem).toBeNull();

    q.start();
    expect(q.currentItem?.id).toBe('a');
  });

  it('start() is a no-op when paused', () => {
    const ctxId = `q-start-paused-${Math.random().toString(36).slice(2, 8)}`;
    beginPersistentContext(ctxId);
    const q = createSequencer({ id: ctxId, startOnEnqueue: false });
    endPersistentContext();

    q.enqueue(qi('a'));
    q.pause();
    q.start();
    expect(q.currentItem).toBeNull();
  });

  it('start() is a no-op when something is already running', () => {
    const ctxId = `q-start-running-${Math.random().toString(36).slice(2, 8)}`;
    beginPersistentContext(ctxId);
    const q = createSequencer({ id: ctxId });
    endPersistentContext();

    q.enqueue(qi('a'));
    q.enqueue(qi('b'));
    expect(q.currentItem?.id).toBe('a');

    q.start(); // should be no-op since 'a' is already running
    expect(q.currentItem?.id).toBe('a');
  });
});

// ============================================================================
// canStart tri-state — 'now' / 'never' / 'notNow' + hold-and-retry
// ============================================================================

describe('Sequencer — canStart tri-state', () => {
  it('"now" dispatches normally', () => {
    const ctxId = `tri-now-${Math.random().toString(36).slice(2, 8)}`;
    beginPersistentContext(ctxId);
    const q = createSequencer({
      id: ctxId,
      canStart: () => 'now',
    });
    endPersistentContext();

    q.enqueue(qi('a'));
    expect(q.currentItem?.id).toBe('a');
    expect(q.holding).toBe(false);
  });

  it('"never" skips and advances without entering hold', () => {
    const ctxId = `tri-never-${Math.random().toString(36).slice(2, 8)}`;
    const skipped: string[] = [];
    beginPersistentContext(ctxId);
    const q = createSequencer({
      id: ctxId,
      canStart: (item) => (item.id === 'bad' ? 'never' : 'now'),
    });
    endPersistentContext();
    q.on('skipped', (item) => skipped.push(item.id));

    q.enqueue(qi('bad'));
    q.enqueue(qi('good'));

    expect(q.currentItem?.id).toBe('good');
    expect(skipped).toEqual(['bad']);
    expect(q.holding).toBe(false);
  });

  it('"notNow" with registerTick enters hold state instead of advancing', () => {
    const tm = createManualTicks();
    const ctxId = `tri-hold-${Math.random().toString(36).slice(2, 8)}`;
    const events: string[] = [];

    beginPersistentContext(ctxId);
    const q = createSequencer({
      id: ctxId,
      registerTick: tm.registerTick,
      canStart: () => 'notNow',
    });
    endPersistentContext();
    q.on('held', (item) => events.push(`hold:${item.id}`));
    q.on('started', (item) => events.push(`start:${item.id}`));
    q.on('skipped', (item) => events.push(`skip:${item.id}`));

    q.enqueue(qi('wait-me'));

    expect(q.holding).toBe(true);
    expect(q.currentItem).toBeNull();
    // Item remains in the waiting list — peek, don't pop
    expect(q.items.value.map((i) => i.id)).toEqual(['wait-me']);
    expect(events).toEqual(['hold:wait-me']);
    // Two ticks: the always-on advance-cap reset (registered at construction
    // whenever registerTick is supplied) plus the hold's retry tick.
    expect(tm.subscriberCount()).toBe(2);
  });

  it('"notNow" without registerTick degrades to "never"', () => {
    const ctxId = `tri-nodeg-${Math.random().toString(36).slice(2, 8)}`;
    const events: string[] = [];

    beginPersistentContext(ctxId);
    const q = createSequencer({
      id: ctxId,
      canStart: (item) => (item.id === 'wait-me' ? 'notNow' : 'now'),
      // No registerTick — 'notNow' should fall back to 'never'
    });
    endPersistentContext();
    q.on('held', (item) => events.push(`hold:${item.id}`));
    q.on('skipped', (item) => events.push(`skip:${item.id}`));

    q.enqueue(qi('wait-me'));
    q.enqueue(qi('run-me'));

    expect(q.holding).toBe(false);
    expect(q.currentItem?.id).toBe('run-me');
    expect(events).toEqual(['skip:wait-me']);
  });

  it('holding is live: a computed over it follows hold entry and release', () => {
    const tm = createManualTicks();
    const ctxId = `tri-holdlive-${Math.random().toString(36).slice(2, 8)}`;
    let gate: StartResult = 'notNow';
    beginPersistentContext(ctxId);
    const q = createSequencer({
      id: ctxId,
      registerTick: tm.registerTick,
      canStart: () => gate,
    });
    endPersistentContext();
    const isHolding = computed(() => q.holding);
    expect(isHolding.value).toBe(false);

    q.enqueue(qi('wait-me'));
    expect(isHolding.value).toBe(true);

    gate = 'now';
    tm.tick();
    expect(isHolding.value).toBe(false);
  });

  it('transitions hold → "now" on retry tick, dispatching the held item', () => {
    const tm = createManualTicks();
    const ctxId = `tri-hold2now-${Math.random().toString(36).slice(2, 8)}`;
    const events: string[] = [];

    let gate: StartResult = 'notNow';
    beginPersistentContext(ctxId);
    const q = createSequencer({
      id: ctxId,
      registerTick: tm.registerTick,
      canStart: () => gate,
    });
    endPersistentContext();
    q.on('held', (item) => events.push(`hold:${item.id}`));
    q.on('started', (item) => events.push(`start:${item.id}`));

    q.enqueue(qi('wait-me'));
    expect(q.holding).toBe(true);

    // Tick fires while still 'notNow' — should stay held, not re-emit held
    tm.tick();
    expect(q.holding).toBe(true);
    expect(events).toEqual(['hold:wait-me']);

    // Gate opens — next tick transitions to running
    gate = 'now';
    tm.tick();
    expect(q.holding).toBe(false);
    expect(q.currentItem?.id).toBe('wait-me');
    expect(events).toEqual(['hold:wait-me', 'start:wait-me']);
    // The held item is consumed (popped) only when it transitions out of hold
    expect(q.items.value.length).toBe(0);
  });

  it('transitions hold → "never" on retry tick, skipping and advancing', () => {
    const tm = createManualTicks();
    const ctxId = `tri-hold2never-${Math.random().toString(36).slice(2, 8)}`;
    const events: string[] = [];

    let gate: StartResult = 'notNow';
    beginPersistentContext(ctxId);
    const q = createSequencer({
      id: ctxId,
      registerTick: tm.registerTick,
      canStart: (item) => (item.id === 'wait-me' ? gate : 'now'),
    });
    endPersistentContext();
    q.on('held', (item) => events.push(`hold:${item.id}`));
    q.on('skipped', (item) => events.push(`skip:${item.id}`));
    q.on('started', (item) => events.push(`start:${item.id}`));

    q.enqueue(qi('wait-me'));
    q.enqueue(qi('run-me'));
    expect(q.holding).toBe(true);

    // Gate becomes impossible — next tick skips and advances to 'run-me'
    gate = 'never';
    tm.tick();
    expect(q.holding).toBe(false);
    expect(q.currentItem?.id).toBe('run-me');
    expect(events).toEqual(['hold:wait-me', 'skip:wait-me', 'start:run-me']);
  });

  it('hold state persists across pause; retry resumes on unpause', () => {
    const tm = createManualTicks();
    const ctxId = `tri-pause-${Math.random().toString(36).slice(2, 8)}`;

    let gate: StartResult = 'notNow';
    beginPersistentContext(ctxId);
    const q = createSequencer({
      id: ctxId,
      registerTick: tm.registerTick,
      canStart: () => gate,
    });
    endPersistentContext();

    q.enqueue(qi('wait-me'));
    expect(q.holding).toBe(true);

    q.pause();
    // Tick fires while paused — should be a no-op, hold preserved
    tm.tick();
    expect(q.holding).toBe(true);
    expect(q.currentItem).toBeNull();

    // Open the gate; resume() should snap out of hold immediately
    gate = 'now';
    q.resume();
    expect(q.holding).toBe(false);
    expect(q.currentItem?.id).toBe('wait-me');
  });

  it('setting canStart = null while holding clears hold and dispatches', () => {
    const tm = createManualTicks();
    const ctxId = `tri-gate-off-${Math.random().toString(36).slice(2, 8)}`;

    beginPersistentContext(ctxId);
    const q = createSequencer({
      id: ctxId,
      registerTick: tm.registerTick,
      canStart: () => 'notNow',
    });
    endPersistentContext();

    q.enqueue(qi('wait-me'));
    expect(q.holding).toBe(true);

    q.canStart = null;
    expect(q.holding).toBe(false);
    expect(q.currentItem?.id).toBe('wait-me');
  });

  it('remove() at the held index drops hold and re-drives', () => {
    const tm = createManualTicks();
    const ctxId = `tri-remove-${Math.random().toString(36).slice(2, 8)}`;

    beginPersistentContext(ctxId);
    const q = createSequencer({
      id: ctxId,
      registerTick: tm.registerTick,
      canStart: (item) => (item.id === 'wait-me' ? 'notNow' : 'now'),
    });
    endPersistentContext();

    q.enqueue(qi('wait-me'));
    q.enqueue(qi('run-me'));
    expect(q.holding).toBe(true);

    // Remove the held item (index 0 in queue mode)
    q.remove(0);
    expect(q.holding).toBe(false);
    expect(q.currentItem?.id).toBe('run-me');
  });

  it('clear() while holding exits hold cleanly', () => {
    const tm = createManualTicks();
    const ctxId = `tri-clear-${Math.random().toString(36).slice(2, 8)}`;

    beginPersistentContext(ctxId);
    const q = createSequencer({
      id: ctxId,
      registerTick: tm.registerTick,
      canStart: () => 'notNow',
    });
    endPersistentContext();

    q.enqueue(qi('wait-me'));
    expect(q.holding).toBe(true);

    q.clear();
    expect(q.holding).toBe(false);
    expect(q.items.value.length).toBe(0);
    expect(q.currentItem).toBeNull();
  });

  it('cancel() while holding cancels the held item, as it would a running one', () => {
    const tm = createManualTicks();
    const ctxId = `tri-cancel-${Math.random().toString(36).slice(2, 8)}`;

    let gate: StartResult = 'notNow';
    beginPersistentContext(ctxId);
    const q = createSequencer({
      id: ctxId,
      registerTick: tm.registerTick,
      canStart: () => gate,
    });
    endPersistentContext();
    const cancelled: string[] = [];
    q.on('cancelled', (item) => cancelled.push(item.id));

    q.enqueue(qi('wait-me'));
    q.enqueue(qi('next'));
    expect(q.holding).toBe(true);

    q.cancel();
    expect(cancelled).toEqual(['wait-me']);
    expect(q.holding).toBe(false);
    expect(q.items.value.map((i) => i.id)).toEqual(['next']);

    // Stopped, as after cancelling a running item: start() resumes.
    gate = 'now';
    tm.tick();
    expect(q.currentItem).toBeNull();
    q.start();
    expect(q.currentItem?.id).toBe('next');
  });

  it('list mode: cancel() while holding cancels the held item and leaves the cursor on it', () => {
    const tm = createManualTicks();
    const ctxId = `tri-list-cancel-${Math.random().toString(36).slice(2, 8)}`;

    let gate: StartResult = 'notNow';
    beginPersistentContext(ctxId);
    const q = createSequencer({
      id: ctxId,
      mode: 'list',
      registerTick: tm.registerTick,
      canStart: () => gate,
    });
    endPersistentContext();
    const cancelled: string[] = [];
    q.on('cancelled', (item) => cancelled.push(item.id));

    q.enqueue(qi('a'));
    expect(q.holding).toBe(true);
    q.cancel();
    expect(cancelled).toEqual(['a']);
    expect(q.holding).toBe(false);
    expect(q.cursor).toBe(0);
    gate = 'now';
    q.start();
    expect(q.currentItem?.id).toBe('a');
  });

  it('list mode: resetCursor() while holding cancels the held item, then replays', () => {
    const tm = createManualTicks();
    const ctxId = `tri-list-reset-${Math.random().toString(36).slice(2, 8)}`;

    beginPersistentContext(ctxId);
    const q = createSequencer({
      id: ctxId,
      mode: 'list',
      registerTick: tm.registerTick,
      canStart: (item) => (item.id === 'b' ? 'notNow' : 'now'),
    });
    endPersistentContext();
    const cancelled: Array<[string, number]> = [];
    q.on('cancelled', (item) => cancelled.push([item.id, q.cursor]));

    q.enqueue(qi('a'));
    q.enqueue(qi('b'));
    q.complete(); // a done, b held at cursor 1
    expect(q.holding).toBe(true);

    q.resetCursor();
    expect(cancelled).toEqual([['b', 1]]);
    expect(q.holding).toBe(false);
    expect(q.cursor).toBe(0);
    expect(q.currentItem?.id).toBe('a');
  });

  it('list mode: "notNow" holds at cursor position without advancing', () => {
    const tm = createManualTicks();
    const ctxId = `tri-list-hold-${Math.random().toString(36).slice(2, 8)}`;

    let gate: StartResult = 'notNow';
    beginPersistentContext(ctxId);
    const q = createSequencer({
      id: ctxId,
      mode: 'list',
      registerTick: tm.registerTick,
      canStart: (item) => (item.id === 'b' ? gate : 'now'),
    });
    endPersistentContext();

    q.enqueue(qi('a'));
    q.enqueue(qi('b'));
    q.enqueue(qi('c'));

    // 'a' runs first
    expect(q.currentItem?.id).toBe('a');
    expect(q.cursor).toBe(0);

    // Complete 'a' — should hit 'b' which holds
    q.complete();
    expect(q.holding).toBe(true);
    expect(q.cursor).toBe(1);
    expect(q.currentItem).toBeNull();

    // Items are still intact in list mode
    expect(q.items.value.map((i) => i.id)).toEqual(['a', 'b', 'c']);

    // Open the gate — retry dispatches 'b'
    gate = 'now';
    tm.tick();
    expect(q.holding).toBe(false);
    expect(q.currentItem?.id).toBe('b');
    expect(q.cursor).toBe(1);
  });
});

// ============================================================================
// Save-format compatibility — ActionQueue→Sequencer rename must not churn persistent state
// ============================================================================
//
// Hand-authored fixtures representing save data as it would have been written
// by the pre-rename `ActionQueue` code. The persistent-ref names (`current`,
// `rawItems`, `paused`, `rawCursor`) and the caller-provided context id must
// load unchanged into a post-rename `createSequencer`. Do NOT replace these
// fixtures with round-trip generators — round-tripping would be tautological
// and could not catch a regression in the serialization format.

describe('Sequencer — save-compat (ActionQueue rename)', () => {
  it('loads a queue-mode save with JSON-object metadata items', () => {
    // Pre-rename save shape: context id `ol375-queue-json`, queue mode with
    // two waiting items carrying `{ loops: number }` metadata, one current
    // item also with metadata, not paused.
    const fixture = {
      'ol375-queue-json': {
        current: '{"id":"running","m":{"loops":3}}',
        rawItems: '[{"id":"next-a","m":{"loops":1}},{"id":"next-b","m":{"loops":2}}]',
        paused: false,
      },
    };

    const ctxId = 'ol375-queue-json';
    beginPersistentContext(ctxId);
    const q = createSequencer<{ loops: number }>({ id: ctxId });
    endPersistentContext();

    deserializePersistents(getAllPersistentRefs(), fixture);

    expect(q.mode).toBe('queue');
    expect(q.paused.value).toBe(false);
    expect(q.currentItem).toEqual({ id: 'running', metadata: { loops: 3 } });
    expect(q.items.value).toEqual([
      { id: 'next-a', metadata: { loops: 1 } },
      { id: 'next-b', metadata: { loops: 2 } },
    ]);
  });

  it('loads a list-mode save with cursor and mid-execution state', () => {
    // Pre-rename save shape: context id `ol375-list-cursor`, list mode with
    // three items, cursor pointing AT item index 1, item 1 is the current.
    const fixture = {
      'ol375-list-cursor': {
        current: '{"id":"step-b","m":{"tag":"mid"}}',
        rawItems:
          '[{"id":"step-a","m":{"tag":"first"}},{"id":"step-b","m":{"tag":"mid"}},{"id":"step-c","m":{"tag":"last"}}]',
        paused: false,
        rawCursor: 1,
      },
    };

    const ctxId = 'ol375-list-cursor';
    beginPersistentContext(ctxId);
    const q = createSequencer<{ tag: string }>({ id: ctxId, mode: 'list' });
    endPersistentContext();

    deserializePersistents(getAllPersistentRefs(), fixture);

    expect(q.mode).toBe('list');
    expect(q.paused.value).toBe(false);
    expect(q.cursor).toBe(1);
    expect(q.currentItem).toEqual({ id: 'step-b', metadata: { tag: 'mid' } });
    expect(q.items.value).toEqual([
      { id: 'step-a', metadata: { tag: 'first' } },
      { id: 'step-b', metadata: { tag: 'mid' } },
      { id: 'step-c', metadata: { tag: 'last' } },
    ]);
  });

  it('loads a void-metadata save where items serialize as plain strings', () => {
    // Pre-rename save shape: metadata === undefined, so serializeItem()
    // emits bare `id` strings inside the JSON array rather than `{id, m}`
    // objects. `current` is the bare id for the same reason.
    const fixture = {
      'ol375-void': {
        current: 'alpha',
        rawItems: '["beta","gamma"]',
        paused: true,
      },
    };

    const ctxId = 'ol375-void';
    beginPersistentContext(ctxId);
    const q = createSequencer({ id: ctxId });
    endPersistentContext();

    deserializePersistents(getAllPersistentRefs(), fixture);

    expect(q.paused.value).toBe(true);
    expect(q.currentItem).toEqual({ id: 'alpha', metadata: undefined });
    expect(q.items.value).toEqual([
      { id: 'beta', metadata: undefined },
      { id: 'gamma', metadata: undefined },
    ]);
  });

  it('loads a legacy comma-delimited rawItems string', () => {
    // Legacy format from before the JSON array migration: rawItems is a
    // comma-separated list of ids, falling through the JSON.parse catch
    // branch in deserializeItems(). Pin this path so the rename can't
    // regress it.
    const fixture = {
      'ol375-legacy': {
        current: '',
        rawItems: 'x,y,z',
        paused: false,
      },
    };

    const ctxId = 'ol375-legacy';
    beginPersistentContext(ctxId);
    const q = createSequencer({ id: ctxId });
    endPersistentContext();

    deserializePersistents(getAllPersistentRefs(), fixture);

    expect(q.currentItem).toBeNull();
    expect(q.items.value).toEqual([
      { id: 'x', metadata: undefined },
      { id: 'y', metadata: undefined },
      { id: 'z', metadata: undefined },
    ]);
  });

  it('loads an empty save (fresh queue)', () => {
    // Pre-rename defaults: current='', rawItems='', paused=false. This is
    // what a never-touched queue or a cleared queue looks like on disk.
    const fixture = {
      'ol375-empty': {
        current: '',
        rawItems: '',
        paused: false,
      },
    };

    const ctxId = 'ol375-empty';
    beginPersistentContext(ctxId);
    const q = createSequencer({ id: ctxId });
    endPersistentContext();

    deserializePersistents(getAllPersistentRefs(), fixture);

    expect(q.currentItem).toBeNull();
    expect(q.items.value).toEqual([]);
    expect(q.paused.value).toBe(false);
  });
});

describe('Sequencer — burst pop ordering', () => {
  it('preserves FIFO order across many instant completions in queue mode', () => {
    const q = makeQueue();
    const ids = Array.from({ length: 100 }, (_, i) => `n${i}`);
    for (const id of ids) q.enqueue(qi(id));

    // First item auto-starts on enqueue. Drain via complete().
    const seen: string[] = [q.currentItem!.id];
    while (q.currentItem) {
      q.complete();
      if (q.currentItem) seen.push(q.currentItem.id);
    }
    expect(seen).toEqual(ids);
    expect(q.items.value).toEqual([]);
  });

  it('drains a mixed never/now burst in canStart without losing or reordering', () => {
    const allowed = new Set(['a', 'c', 'e']);
    const canStart = (item: SequencerItem<void>): StartResult =>
      allowed.has(item.id) ? 'now' : 'never';

    const ctxId = `q-burst-${Math.random().toString(36).slice(2, 8)}`;
    beginPersistentContext(ctxId);
    const q = createSequencer<void>({ id: ctxId, canStart });
    endPersistentContext();

    q.enqueue(qi('a'));
    q.enqueue(qi('b')); // skip
    q.enqueue(qi('c'));
    q.enqueue(qi('d')); // skip
    q.enqueue(qi('e'));

    const seen: string[] = [];
    while (q.currentItem) {
      seen.push(q.currentItem.id);
      q.complete();
    }
    expect(seen).toEqual(['a', 'c', 'e']);
    expect(q.items.value).toEqual([]);
  });
});

describe('Sequencer — list-mode cursor & hold invariants', () => {
  function makeList(id?: string) {
    const ctxId = id ?? `list-${Math.random().toString(36).slice(2, 8)}`;
    beginPersistentContext(ctxId);
    const q = createSequencer({ id: ctxId, mode: 'list' });
    endPersistentContext();
    return q;
  }

  it('reorder: cursor follows the active item moved forward', () => {
    const q = makeList();
    ['a', 'b', 'c', 'd', 'e'].forEach((id) => q.enqueue(qi(id)));
    q.complete(); // cursor → 1 (b running)
    q.complete(); // cursor → 2 (c running)
    expect(q.currentItem?.id).toBe('c');
    expect(q.cursor).toBe(2);

    q.reorder(2, 4); // move c to end
    expect(q.cursor).toBe(4);
    expect(q.items.value.map((i) => i.id)).toEqual(['a', 'b', 'd', 'e', 'c']);

    q.complete();
    expect(q.currentItem).toBeNull();
  });

  it('reorder: cursor follows the active item moved backward', () => {
    const q = makeList();
    ['a', 'b', 'c', 'd'].forEach((id) => q.enqueue(qi(id)));
    q.complete();
    q.complete(); // c running at cursor 2

    q.reorder(2, 0); // c to front
    expect(q.cursor).toBe(0);
    expect(q.items.value.map((i) => i.id)).toEqual(['c', 'a', 'b', 'd']);
  });

  it('reorder: moving an item from before cursor past it shifts cursor', () => {
    const q = makeList();
    ['a', 'b', 'c', 'd'].forEach((id) => q.enqueue(qi(id)));
    q.complete();
    q.complete(); // c running at cursor 2

    // Pull a out of position 0 and slot it in at 2 → [b, c, a, d]
    // c's new index is 1, so cursor must decrement.
    q.reorder(0, 2);
    expect(q.items.value.map((i) => i.id)).toEqual(['b', 'c', 'a', 'd']);
    expect(q.cursor).toBe(1);
    expect(q.currentItem?.id).toBe('c');
  });

  it('reorder: moving an item from after cursor into its slot shifts cursor', () => {
    const q = makeList();
    ['a', 'b', 'c', 'd'].forEach((id) => q.enqueue(qi(id)));
    q.complete(); // b running at cursor 1

    // Move d (index 3) to position 1 → [a, d, b, c]
    // b's new index is 2, cursor must increment.
    q.reorder(3, 1);
    expect(q.items.value.map((i) => i.id)).toEqual(['a', 'd', 'b', 'c']);
    expect(q.cursor).toBe(2);
    expect(q.currentItem?.id).toBe('b');
  });

  it('remove: deleting the running item advances to its replacement', () => {
    const q = makeList();
    ['a', 'b', 'c', 'd', 'e'].forEach((id) => q.enqueue(qi(id)));
    q.complete();
    q.complete(); // c running at cursor 2
    expect(q.currentItem?.id).toBe('c');

    q.remove(2); // remove c while it's running
    expect(q.items.value.map((i) => i.id)).toEqual(['a', 'b', 'd', 'e']);

    q.complete(); // cursor advances — should land on d, not e
    expect(q.currentItem?.id).toBe('d');
  });

  it('clear: running item is cancelled so subsequent enqueue dispatches from 0', () => {
    const q = makeList();
    q.enqueue(qi('a'));
    q.enqueue(qi('b'));
    expect(q.currentItem?.id).toBe('a');

    const cancelled: string[] = [];
    q.on('cancelled', (item) => cancelled.push(item.id));

    q.clear();
    expect(cancelled).toEqual(['a']);
    expect(q.currentItem).toBeNull();
    expect(q.cursor).toBe(0);

    q.enqueue(qi('fresh'));
    expect(q.currentItem?.id).toBe('fresh');
    expect(q.cursor).toBe(0);
  });
});

describe('Sequencer — hold state invariants', () => {
  it('queue reorder clears hold when index 0 is disturbed', () => {
    const ctxId = `hold-reorder-${Math.random().toString(36).slice(2, 8)}`;
    const tm = createManualTicks();
    let gate: StartResult = 'notNow';
    beginPersistentContext(ctxId);
    const q = createSequencer({
      id: ctxId,
      registerTick: tm.registerTick,
      canStart: (item) => (item.id === 'blocked' ? gate : 'now'),
    });
    endPersistentContext();

    q.enqueue(qi('blocked'));
    q.enqueue(qi('free'));
    expect(q.holding).toBe(true);
    expect(q.currentItem).toBeNull();

    // Unblock the gated item first, so reorder's re-drive can dispatch it.
    gate = 'now';
    q.reorder(0, 1);
    expect(q.holding).toBe(false);
    // Re-drive dispatched whichever item landed at head 0.
    expect(q.currentItem).not.toBeNull();
  });

  it('save/load rehydration drops the stale hold and re-drives', () => {
    const ctxId = `hold-hydrate-${Math.random().toString(36).slice(2, 8)}`;
    const tm = createManualTicks();
    beginPersistentContext(ctxId);
    const q = createSequencer({
      id: ctxId,
      registerTick: tm.registerTick,
      canStart: () => 'notNow',
    });
    endPersistentContext();

    q.enqueue(qi('wait'));
    expect(q.holding).toBe(true);
    // Always-on advance-cap reset tick + the stale hold's retry tick.
    expect(tm.subscriberCount()).toBe(2);

    // Simulate external rehydration (save load) — feed a different rawItems
    // payload through the save-restore path. The watch drops the stale hold
    // (and its retry tick) and arms a one-shot re-drive.
    deserializePersistents(getAllPersistentRefs(), {
      [ctxId]: {
        current: '',
        rawItems: '["replaced"]',
        paused: false,
      },
    });

    expect(q.holding).toBe(false);
    expect(q.items.value.map((i) => i.id)).toEqual(['replaced']);

    // Post-load tick re-drives rather than stalling: canStart is still 'notNow',
    // so the reloaded item re-enters hold instead of being silently stranded.
    tm.tick();
    expect(q.holding).toBe(true);
    expect(q.currentItem).toBeNull();
    expect(q.items.value.map((i) => i.id)).toEqual(['replaced']);
  });
});

describe('Sequencer — enqueue positional `at`', () => {
  it('omitted `at` appends (existing behavior unchanged)', () => {
    const q = makeQueue();
    q.enqueue(qi('a'));
    q.enqueue(qi('b'));
    q.enqueue(qi('c'));
    // a is current, b and c waiting in that order
    expect(q.currentItem?.id).toBe('a');
    expect(q.items.value.map((i) => i.id)).toEqual(['b', 'c']);
  });

  it('`at: 0` prepends ahead of waiting items', () => {
    const q = makeQueue();
    q.enqueue(qi('a'));
    q.enqueue(qi('b'));
    q.enqueue(qi('c'));
    q.enqueue(qi('jump'), { at: 0 });
    expect(q.currentItem?.id).toBe('a');
    expect(q.items.value.map((i) => i.id)).toEqual(['jump', 'b', 'c']);
  });

  it('`at: 0` into an empty sequencer auto-starts the inserted item', () => {
    const q = makeQueue();
    const started: string[] = [];
    q.on('started', (i) => started.push(i.id));
    expect(q.enqueue(qi('first'), { at: 0 })).toBe(true);
    expect(q.currentItem?.id).toBe('first');
    expect(started).toEqual(['first']);
  });

  it('arbitrary-position insert splices into the waiting list', () => {
    const q = makeQueue();
    q.enqueue(qi('a'));
    q.enqueue(qi('b'));
    q.enqueue(qi('c'));
    q.enqueue(qi('d'));
    // current=a; waiting=[b, c, d]
    q.enqueue(qi('mid'), { at: 1 });
    expect(q.items.value.map((i) => i.id)).toEqual(['b', 'mid', 'c', 'd']);
  });

  it('`at >= length` falls through to append', () => {
    const q = makeQueue();
    q.enqueue(qi('a'));
    q.enqueue(qi('b'));
    q.enqueue(qi('tail'), { at: 99 });
    expect(q.items.value.map((i) => i.id)).toEqual(['b', 'tail']);
  });

  it('emits `enqueued` event regardless of position', () => {
    const q = makeQueue();
    const events: string[] = [];
    q.on('enqueued', (i) => events.push(i.id));
    q.enqueue(qi('a'));
    q.enqueue(qi('b'), { at: 0 });
    q.enqueue(qi('c'), { at: 1 });
    expect(events).toEqual(['a', 'b', 'c']);
  });

  it('rejects when `maxSize` would be exceeded, no event fires', () => {
    const q = makeQueue({ maxSize: 2 });
    const events: string[] = [];
    q.on('enqueued', (i) => events.push(i.id));
    q.enqueue(qi('a')); // current
    q.enqueue(qi('b')); // waiting (size 1)
    q.enqueue(qi('c')); // waiting (size 2 = max)
    expect(q.enqueue(qi('reject'), { at: 0 })).toBe(false);
    expect(q.items.value.map((i) => i.id)).toEqual(['b', 'c']);
    expect(events).toEqual(['a', 'b', 'c']);
  });

  it('throws RangeError on negative `at`', () => {
    const q = makeQueue();
    q.enqueue(qi('a'));
    expect(() => q.enqueue(qi('bad'), { at: -1 })).toThrow(RangeError);
  });

  it('list mode: `at: 0` while running shifts cursor forward to track current', () => {
    const q = makeQueue({ mode: 'list' });
    q.enqueue(qi('a'));
    q.enqueue(qi('b'));
    q.enqueue(qi('c'));
    // a is current, cursor=0
    expect(q.currentItem?.id).toBe('a');
    expect(q.cursor).toBe(0);

    q.enqueue(qi('jump'), { at: 0 });
    // items now [jump, a, b, c]; current still 'a' which is at index 1
    expect(q.items.value.map((i) => i.id)).toEqual(['jump', 'a', 'b', 'c']);
    expect(q.currentItem?.id).toBe('a');
    expect(q.cursor).toBe(1);
  });

  it('list mode: insert at cursor position with no running item makes it next dispatch', () => {
    const q = makeQueue({ mode: 'list' });
    q.enqueue(qi('a'));
    q.cancel(); // empty current, cursor=0
    expect(q.currentItem).toBeNull();
    expect(q.cursor).toBe(0);

    // edit-mode insert: prepend with no running item should not skip past
    q.enqueue(qi('first'), { at: 0 });
    // currentItem auto-started because current was empty
    expect(q.currentItem?.id).toBe('first');
    expect(q.cursor).toBe(0);
  });
});

describe('Sequencer — enqueue positional `at` × hold state', () => {
  it('queue mode: `at: 0` while holding drops the hold and dispatches the new item', () => {
    const tm = createManualTicks();
    const ctxId = `pos-hold-q-${Math.random().toString(36).slice(2, 8)}`;

    beginPersistentContext(ctxId);
    const gate: StartResult = 'notNow';
    const q = createSequencer({
      id: ctxId,
      registerTick: tm.registerTick,
      canStart: (item) => (item.id === 'wait-me' ? gate : 'now'),
    });
    endPersistentContext();

    q.enqueue(qi('wait-me'));
    expect(q.holding).toBe(true);
    expect(q.currentItem).toBeNull();

    // New item jumps the queue; dispatch decision must re-run on it.
    q.enqueue(qi('jump'), { at: 0 });
    expect(q.holding).toBe(false);
    expect(q.currentItem?.id).toBe('jump');
    // wait-me still in the waiting list behind the dispatched jump
    // (jump was dequeued for current, wait-me remains)
    expect(q.items.value.map((i) => i.id)).toEqual(['wait-me']);

    // Unrelated: gate stays 'notNow', so future dequeue still respects canStart.
    void gate;
  });

  it('queue mode: positional insert AFTER the held item leaves the hold intact', () => {
    const tm = createManualTicks();
    const ctxId = `pos-hold-q-after-${Math.random().toString(36).slice(2, 8)}`;

    beginPersistentContext(ctxId);
    const q = createSequencer({
      id: ctxId,
      registerTick: tm.registerTick,
      canStart: (item) => (item.id === 'wait-me' ? 'notNow' : 'now'),
    });
    endPersistentContext();

    q.enqueue(qi('wait-me'));
    q.enqueue(qi('a'));
    q.enqueue(qi('b'));
    expect(q.holding).toBe(true);

    // Insert between a and b — does not touch index 0 (held position).
    q.enqueue(qi('mid'), { at: 2 });
    expect(q.holding).toBe(true);
    expect(q.items.value.map((i) => i.id)).toEqual(['wait-me', 'a', 'mid', 'b']);
  });

  it('list mode: insert AT the held cursor drops the hold and re-drives', () => {
    const tm = createManualTicks();
    const ctxId = `pos-hold-list-${Math.random().toString(36).slice(2, 8)}`;

    beginPersistentContext(ctxId);
    const q = createSequencer({
      id: ctxId,
      mode: 'list',
      registerTick: tm.registerTick,
      canStart: (item) => (item.id === 'wait-me' ? 'notNow' : 'now'),
    });
    endPersistentContext();

    q.enqueue(qi('wait-me')); // cursor=0, held
    expect(q.holding).toBe(true);
    expect(q.cursor).toBe(0);

    q.enqueue(qi('jump'), { at: 0 });
    expect(q.holding).toBe(false);
    expect(q.currentItem?.id).toBe('jump');
    // cursor points at the newly-dispatched 'jump' at index 0
    expect(q.cursor).toBe(0);
    // wait-me is now at index 1 (behind jump)
    expect(q.items.value.map((i) => i.id)).toEqual(['jump', 'wait-me']);
  });
});

describe('Sequencer — repeat()', () => {
  it('queue mode: re-dispatches the same item and emits repeated, not completed', () => {
    const q = makeQueue();
    const starts: string[] = [];
    const repeats: string[] = [];
    const completes: string[] = [];
    const enqueues: string[] = [];
    q.on('started', (i) => starts.push(i.id));
    q.on('repeated', (i) => repeats.push(i.id));
    q.on('completed', (i) => completes.push(i.id));
    q.on('enqueued', (i) => enqueues.push(i.id));

    q.enqueue(qi('a'));
    q.enqueue(qi('b'));
    expect(q.currentItem?.id).toBe('a');

    q.repeat();
    expect(q.currentItem?.id).toBe('a');
    expect(q.items.value.map((i) => i.id)).toEqual(['b']);
    expect(starts).toEqual(['a', 'a']);
    expect(repeats).toEqual(['a']);
    expect(completes).toEqual([]);
    // Initial enqueued events fire for the two seed items, but repeated must NOT
    // re-fire enqueue for the re-dispatched item.
    expect(enqueues).toEqual(['a', 'b']);
  });

  it('queue mode: no-op when no current item', () => {
    const q = makeQueue();
    const repeats: string[] = [];
    q.on('repeated', (i) => repeats.push(i.id));
    expect(() => q.repeat()).not.toThrow();
    expect(repeats).toEqual([]);
    expect(q.currentItem).toBeNull();
  });

  it('queue mode: repeat with canStart "never" on re-entry skips and advances', () => {
    let blockA = false;
    const ctxId = `repeat-never-${Math.random().toString(36).slice(2, 8)}`;
    beginPersistentContext(ctxId);
    const q = createSequencer({
      id: ctxId,
      canStart: (item) => (item.id === 'a' && blockA ? 'never' : 'now'),
    });
    endPersistentContext();

    const events: string[] = [];
    q.on('repeated', (i) => events.push(`repeat:${i.id}`));
    q.on('skipped', (i) => events.push(`skip:${i.id}`));
    q.on('started', (i) => events.push(`start:${i.id}`));

    q.enqueue(qi('a'));
    q.enqueue(qi('b'));
    expect(q.currentItem?.id).toBe('a');

    blockA = true;
    q.repeat();
    expect(events).toEqual(['start:a', 'repeat:a', 'skip:a', 'start:b']);
    expect(q.currentItem?.id).toBe('b');
  });

  it('queue mode: repeat with canStart "notNow" on re-entry enters hold', () => {
    const tm = createManualTicks();
    let blockA = false;
    const ctxId = `repeat-hold-${Math.random().toString(36).slice(2, 8)}`;
    beginPersistentContext(ctxId);
    const q = createSequencer({
      id: ctxId,
      registerTick: tm.registerTick,
      canStart: (item) => (item.id === 'a' && blockA ? 'notNow' : 'now'),
    });
    endPersistentContext();

    const events: string[] = [];
    q.on('repeated', (i) => events.push(`repeat:${i.id}`));
    q.on('held', (i) => events.push(`hold:${i.id}`));
    q.on('started', (i) => events.push(`start:${i.id}`));

    q.enqueue(qi('a'));
    expect(q.currentItem?.id).toBe('a');

    blockA = true;
    q.repeat();
    expect(events).toEqual(['start:a', 'repeat:a', 'hold:a']);
    expect(q.holding).toBe(true);
    expect(q.currentItem).toBeNull();

    blockA = false;
    tm.tick();
    expect(q.holding).toBe(false);
    expect(q.currentItem?.id).toBe('a');
  });

  it('queue mode: repeat counts toward maxAdvancesPerTick', async () => {
    const { resetSafeguardDiagnostics, getSafeguardDiagnostics } =
      await import('@/core/safeguards');
    resetSafeguardDiagnostics();

    const ctxId = `repeat-cap-${Math.random().toString(36).slice(2, 8)}`;
    beginPersistentContext(ctxId);
    const q = createSequencer({
      id: ctxId,
      maxAdvancesPerTick: 3,
    });
    endPersistentContext();

    q.enqueue(qi('a'));
    // Initial dispatch consumed 1 advance. Three repeats trip the cap.
    for (let i = 0; i < 5; i++) q.repeat();

    expect(getSafeguardDiagnostics().advanceCapTrips).toBe(1);
    expect(getSafeguardDiagnostics().lastAdvanceCapSequencer).toBe(ctxId);
  });

  it('list mode: cursor does not advance on repeat', () => {
    const q = makeQueue({ mode: 'list' });
    q.enqueue(qi('a'));
    q.enqueue(qi('b'));
    expect(q.currentItem?.id).toBe('a');
    expect(q.cursor).toBe(0);

    const cursorBefore = q.cursor;
    q.repeat();
    expect(q.cursor).toBe(cursorBefore);
    expect(q.currentItem?.id).toBe('a');
    // items unchanged in list mode
    expect(q.items.value.map((i) => i.id)).toEqual(['a', 'b']);
  });

  it('list mode: emits repeated not completed; complete still advances after a repeat', () => {
    const q = makeQueue({ mode: 'list' });
    const events: string[] = [];
    q.on('repeated', (i) => events.push(`repeat:${i.id}`));
    q.on('completed', (i) => events.push(`complete:${i.id}`));
    q.on('started', (i) => events.push(`start:${i.id}`));

    q.enqueue(qi('a'));
    q.enqueue(qi('b'));

    q.repeat();
    q.repeat();
    q.complete();

    expect(events).toEqual([
      'start:a',
      'repeat:a',
      'start:a',
      'repeat:a',
      'start:a',
      'complete:a',
      'start:b',
    ]);
    expect(q.cursor).toBe(1);
    expect(q.currentItem?.id).toBe('b');
  });

  it('list mode: repeat with canStart "notNow" on re-entry holds at the same cursor', () => {
    const tm = createManualTicks();
    let blockA = false;
    const ctxId = `repeat-list-hold-${Math.random().toString(36).slice(2, 8)}`;
    beginPersistentContext(ctxId);
    const q = createSequencer({
      id: ctxId,
      mode: 'list',
      registerTick: tm.registerTick,
      canStart: (item) => (item.id === 'a' && blockA ? 'notNow' : 'now'),
    });
    endPersistentContext();

    q.enqueue(qi('a'));
    q.enqueue(qi('b'));
    expect(q.currentItem?.id).toBe('a');
    expect(q.cursor).toBe(0);

    blockA = true;
    q.repeat();
    expect(q.holding).toBe(true);
    expect(q.cursor).toBe(0);
    expect(q.currentItem).toBeNull();

    blockA = false;
    tm.tick();
    expect(q.holding).toBe(false);
    expect(q.cursor).toBe(0);
    expect(q.currentItem?.id).toBe('a');
  });

  it('list mode: no-op when no current item', () => {
    const q = makeQueue({ mode: 'list' });
    const repeats: string[] = [];
    q.on('repeated', (i) => repeats.push(i.id));
    expect(() => q.repeat()).not.toThrow();
    expect(repeats).toEqual([]);
  });

  it('items.value identity stays referentially stable across a queue-mode repeat', () => {
    const q = makeQueue();
    q.enqueue(qi('a'));
    q.enqueue(qi('b'));

    const view1 = q.items.value;
    q.repeat();
    const view2 = q.items.value;
    // repeat mutates _liveItems (splice), so the cached view rebuilds — new
    // identity is expected. Content asserts the splice put 'a' back ahead of 'b'.
    expect(view1).not.toBe(view2);
    expect(view2.map((i) => i.id)).toEqual(['b']);
  });
});

describe('Sequencer — updateCurrentItem / updateItem', () => {
  type Meta = { ticks: number; err?: string };
  const mi = (id: string, ticks = 0): SequencerItem<Meta> => ({ id, metadata: { ticks } });

  function makeTypedQueue(opts: { mode?: 'queue' | 'list'; id?: string } = {}) {
    const ctxId = opts.id ?? `q-${Math.random().toString(36).slice(2, 8)}`;
    beginPersistentContext(ctxId);
    const q = createSequencer<Meta>({ id: ctxId, ...opts });
    endPersistentContext();
    return q;
  }

  it('updateCurrentItem updates queue-mode current via persistent ref', () => {
    const q = makeTypedQueue();
    q.enqueue(mi('a', 5));
    q.updateCurrentItem((m) => ({ ...m, ticks: m.ticks + 1 }));
    expect(q.currentMetadata).toEqual({ ticks: 6 });
    expect(q.currentItem?.id).toBe('a');
  });

  it('updateCurrentItem is a no-op in queue mode when nothing is running', () => {
    const q = makeTypedQueue();
    // No enqueue → no current. Should not throw, should not affect state.
    expect(() => q.updateCurrentItem((m) => ({ ...m, ticks: 99 }))).not.toThrow();
    expect(q.currentItem).toBeNull();
  });

  it('updateCurrentItem updates list-mode current and mirrors into items.value at cursor', () => {
    const q = makeTypedQueue({ mode: 'list' });
    q.enqueue(mi('a', 0));
    q.enqueue(mi('b', 0));
    // 'a' is running at cursor 0.
    q.updateCurrentItem((m) => ({ ...m, ticks: 42 }));
    expect(q.currentMetadata).toEqual({ ticks: 42 });
    expect(q.items.value[0].metadata).toEqual({ ticks: 42 });
    // Sibling untouched.
    expect(q.items.value[1].metadata).toEqual({ ticks: 0 });
  });

  it('updateCurrentItem is a no-op in list mode when no running item', () => {
    const q = makeTypedQueue({ mode: 'list' });
    q.enqueue(mi('a', 0));
    q.pause();
    q.cancel();
    // List mode with paused + cancel → no running item, cursor still at 0.
    expect(q.currentItem).toBeNull();
    expect(() => q.updateCurrentItem((m) => ({ ...m, ticks: 99 }))).not.toThrow();
    expect(q.items.value[0].metadata).toEqual({ ticks: 0 });
  });

  it('updateItem updates items.value at index and preserves other identities', () => {
    const q = makeTypedQueue({ mode: 'list' });
    q.enqueue(mi('a', 1));
    q.enqueue(mi('b', 2));
    q.enqueue(mi('c', 3));
    const before = q.items.value;
    q.updateItem(1, (m) => ({ ...m, ticks: 99 }));
    const after = q.items.value;

    expect(after[1].metadata).toEqual({ ticks: 99 });
    expect(after[1]).not.toBe(before[1]);
    // Unpatched siblings keep their object identity.
    expect(after[0]).toBe(before[0]);
    expect(after[2]).toBe(before[2]);
  });

  it('updateItem with out-of-range index is a no-op', () => {
    const q = makeTypedQueue({ mode: 'list' });
    q.enqueue(mi('a', 1));
    const before = q.items.value;
    expect(() => q.updateItem(-1, (m) => ({ ...m, ticks: 99 }))).not.toThrow();
    expect(() => q.updateItem(5, (m) => ({ ...m, ticks: 99 }))).not.toThrow();
    // No mutation → version stable → same view reference.
    expect(q.items.value).toBe(before);
    expect(q.items.value[0].metadata).toEqual({ ticks: 1 });
  });

  it('updateItem fires reactive watchers on items.value', () => {
    const q = makeTypedQueue({ mode: 'list' });
    q.enqueue(mi('a', 0));
    q.enqueue(mi('b', 0));

    const seen: number[][] = [];
    const scope = effectScope();
    scope.run(() => {
      watchEffect(
        () => {
          seen.push(q.items.value.map((i) => i.metadata.ticks));
        },
        { flush: 'sync' },
      );
    });
    // initial effect run captures [0, 0].
    expect(seen[seen.length - 1]).toEqual([0, 0]);
    q.updateItem(1, (m) => ({ ...m, ticks: 7 }));
    expect(seen[seen.length - 1]).toEqual([0, 7]);
    scope.stop();
  });

  it('queue-mode updateCurrentItem persists into the current persistent ref', () => {
    // Queue-mode current item is stored serialized in current.value. Verify
    // patch reaches that surface (the save manager picks up the change as
    // part of standard persistent-ref serialization).
    const ctxId = `patch-save-${Math.random().toString(36).slice(2, 8)}`;
    beginPersistentContext(ctxId);
    const q = createSequencer<Meta>({ id: ctxId });
    endPersistentContext();
    q.enqueue(mi('a', 0));
    q.updateCurrentItem((m) => ({ ...m, ticks: 9 }));

    const refs = getAllPersistentRefs();
    const currentRef = refs.get(`${ctxId}.current`);
    expect(currentRef).toBeDefined();
    const serialized = JSON.parse(currentRef!.value as string) as { id: string; m: Meta };
    expect(serialized.id).toBe('a');
    expect(serialized.m).toEqual({ ticks: 9 });
  });
});

// ============================================================================
// save/load re-drive — a save taken mid-hold must not reload into a stall
// ============================================================================

describe('Sequencer — save/load re-drive', () => {
  it('resumes after a save taken mid-hold reloads into a fresh sequencer', () => {
    const tm = createManualTicks();
    const ctxId = `hold-reload-${Math.random().toString(36).slice(2, 8)}`;
    beginPersistentContext(ctxId);
    const q = createSequencer({
      id: ctxId,
      registerTick: tm.registerTick,
      canStart: () => 'now',
    });
    endPersistentContext();

    // Simulate loading a save captured while the sequencer was holding on a
    // 'notNow' item: current empty, the held item still queued, not paused.
    // Hold state is runtime-only, so it is absent from the save.
    deserializePersistents(getAllPersistentRefs(), {
      [ctxId]: {
        current: '',
        rawItems: JSON.stringify(['wait-me']),
        paused: false,
      },
    });

    // Nothing dispatches synchronously on load — the re-drive is deferred to
    // the next tick so paused/cursor finish rehydrating first.
    expect(q.currentItem).toBeNull();

    // The blocking condition has since cleared; the post-load tick re-drives.
    tm.tick();
    expect(q.currentItem?.id).toBe('wait-me');
    expect(q.holding).toBe(false);
    // The one-shot re-drive tick unregistered itself — no live watcher leaks.
    // The always-on advance-cap reset tick remains (it lives for the
    // sequencer's lifetime whenever registerTick is supplied).
    expect(tm.subscriberCount()).toBe(1);
  });

  it('re-enters hold on load when the item is still notNow', () => {
    const tm = createManualTicks();
    const ctxId = `hold-reload-stillblocked-${Math.random().toString(36).slice(2, 8)}`;
    let gate: StartResult = 'notNow';
    beginPersistentContext(ctxId);
    const q = createSequencer({
      id: ctxId,
      registerTick: tm.registerTick,
      canStart: () => gate,
    });
    endPersistentContext();

    deserializePersistents(getAllPersistentRefs(), {
      [ctxId]: { current: '', rawItems: JSON.stringify(['wait-me']), paused: false },
    });

    tm.tick();
    // Still blocked → the sequencer re-enters the hold path rather than stalling.
    expect(q.holding).toBe(true);
    expect(q.currentItem).toBeNull();

    // Condition clears → the retry tick dispatches.
    gate = 'now';
    tm.tick();
    expect(q.currentItem?.id).toBe('wait-me');
    expect(q.holding).toBe(false);
  });

  it('resumes list-mode hold from the saved cursor after reload', () => {
    const tm = createManualTicks();
    const ctxId = `list-hold-reload-${Math.random().toString(36).slice(2, 8)}`;
    beginPersistentContext(ctxId);
    const q = createSequencer({
      id: ctxId,
      mode: 'list',
      registerTick: tm.registerTick,
      canStart: () => 'now',
    });
    endPersistentContext();

    // List-mode save mid-hold: 'a' already completed, holding on 'b' at cursor 1.
    deserializePersistents(getAllPersistentRefs(), {
      [ctxId]: {
        current: '',
        rawItems: JSON.stringify(['a', 'b', 'c']),
        paused: false,
        rawCursor: 1,
      },
    });

    expect(q.currentItem).toBeNull();
    tm.tick();
    // Re-drives from the loaded cursor (1), dispatching 'b' — proving the
    // deferral let rawCursor rehydrate before the re-drive read it. A
    // synchronous re-drive in the rawItems watch would have seen cursor 0
    // and wrongly dispatched 'a'.
    expect(q.currentItem?.id).toBe('b');
    expect(q.cursor).toBe(1);
  });

  it('does not auto-start on load when startOnEnqueue is false (planning mode)', () => {
    const tm = createManualTicks();
    const ctxId = `plan-reload-${Math.random().toString(36).slice(2, 8)}`;
    beginPersistentContext(ctxId);
    const q = createSequencer({
      id: ctxId,
      startOnEnqueue: false,
      registerTick: tm.registerTick,
      canStart: () => 'now',
    });
    endPersistentContext();

    deserializePersistents(getAllPersistentRefs(), {
      [ctxId]: { current: '', rawItems: JSON.stringify(['planned']), paused: false },
    });

    tm.tick();
    // Explicit-control sequencer stays put until the consumer calls start().
    expect(q.currentItem).toBeNull();
    expect(q.items.value.map((i) => i.id)).toEqual(['planned']);

    q.start();
    expect(q.currentItem?.id).toBe('planned');
  });

  it('stays paused on load and does not dispatch until resumed', () => {
    const tm = createManualTicks();
    const ctxId = `paused-reload-${Math.random().toString(36).slice(2, 8)}`;
    beginPersistentContext(ctxId);
    const q = createSequencer({
      id: ctxId,
      registerTick: tm.registerTick,
      canStart: () => 'now',
    });
    endPersistentContext();

    deserializePersistents(getAllPersistentRefs(), {
      [ctxId]: { current: '', rawItems: JSON.stringify(['wait-me']), paused: true },
    });

    tm.tick();
    // paused rehydrated true — the deferred re-drive must respect it.
    expect(q.currentItem).toBeNull();

    q.resume();
    expect(q.currentItem?.id).toBe('wait-me');
  });
});

// The skip contract: by the time `skipped` fires, the skip is already committed —
// popped in queue mode, cursor past it in list mode. These are the only tests in
// the file that observe sequencer state from inside a listener.
describe('Sequencer — skip ordering', () => {
  interface SkipMeta {
    error: string | null;
  }
  const smi = (id: string): SequencerItem<SkipMeta> => ({ id, metadata: { error: null } });

  it('list mode: cursor has advanced past the skipped item when skipped fires', () => {
    const q = makeQueue({ mode: 'list' });
    q.canStart = (item) => (item.id === 'skip-me' ? 'never' : 'now');
    const seen: number[] = [];
    q.on('skipped', () => seen.push(q.cursor));

    q.enqueue(qi('skip-me'));
    q.enqueue(qi('run-me'));

    expect(seen).toEqual([1]);
    expect(q.currentItem?.id).toBe('run-me');
  });

  it('list mode: cursor has advanced when "notNow" degrades to skip without registerTick', () => {
    const q = makeQueue({ mode: 'list' });
    q.canStart = (item) => (item.id === 'wait-me' ? 'notNow' : 'now');
    const seen: number[] = [];
    q.on('skipped', () => seen.push(q.cursor));

    q.enqueue(qi('wait-me'));
    q.enqueue(qi('run-me'));

    expect(seen).toEqual([1]);
    expect(q.currentItem?.id).toBe('run-me');
  });

  it('list mode: cursor has advanced when a held item transitions to skip on retry', () => {
    const tm = createManualTicks();
    const ctxId = `skip-order-retry-${Math.random().toString(36).slice(2, 8)}`;
    let gate: StartResult = 'notNow';
    beginPersistentContext(ctxId);
    const q = createSequencer({
      id: ctxId,
      mode: 'list',
      registerTick: tm.registerTick,
      canStart: (item) => (item.id === 'wait-me' ? gate : 'now'),
    });
    endPersistentContext();
    const seen: number[] = [];
    q.on('skipped', () => seen.push(q.cursor));

    q.enqueue(qi('wait-me'));
    q.enqueue(qi('run-me'));
    expect(q.holding).toBe(true);

    gate = 'never';
    tm.tick();

    expect(seen).toEqual([1]);
    expect(q.currentItem?.id).toBe('run-me');
  });

  it('queue mode: the skipped item is already gone from items when skipped fires', () => {
    const q = makeQueue();
    q.canStart = (item) => (item.id === 'skip-me' ? 'never' : 'now');
    const seen: string[][] = [];
    q.on('skipped', () => seen.push(q.items.value.map((i) => i.id)));

    q.enqueue(qi('skip-me'));
    q.enqueue(qi('run-me'));

    expect(seen).toEqual([[]]);
  });

  // The shape idle-loops-ng's action-runner uses to tag a skipped entry.
  it('list mode: a listener tagging cursor - 1 marks the item that was skipped', () => {
    const ctxId = `skip-order-tag-${Math.random().toString(36).slice(2, 8)}`;
    beginPersistentContext(ctxId);
    const q = createSequencer<SkipMeta>({
      id: ctxId,
      mode: 'list',
      canStart: (item) => (item.id === 'b' ? 'never' : 'now'),
    });
    endPersistentContext();

    q.on('skipped', () => {
      const priorIdx = q.cursor - 1;
      if (priorIdx < 0) return;
      q.updateItem(priorIdx, (m) => ({ ...m, error: 'Cannot run here' }));
    });

    q.enqueue(smi('a'));
    q.enqueue(smi('b'));
    q.enqueue(smi('c'));
    expect(q.currentItem?.id).toBe('a');

    q.complete();

    expect(q.currentItem?.id).toBe('c');
    expect(q.items.value.map((i) => i.metadata.error)).toEqual([null, 'Cannot run here', null]);
  });

  // The cursor advance is a read-modify-write across the emit; committing it first
  // is what keeps a mutating listener from being overwritten on the way out.
  it('list mode: clearing from a skipped listener leaves the done sentinel intact', () => {
    const q = makeQueue({ mode: 'list' });
    q.canStart = (item) => (item.id === 'skip-me' ? 'never' : 'now');
    let cleared = false;
    q.on('skipped', () => {
      if (cleared) return;
      cleared = true;
      q.clear();
    });

    q.enqueue(qi('skip-me'));

    expect(q.items.value).toHaveLength(0);
    expect(q.cursor).toBe(0);
  });
});

describe('Sequencer — listener re-entrancy', () => {
  /**
   * Track dispatches against their terminal events. `dequeueNext` emits
   * synchronously, so a listener can dispatch underneath the walk; the symptom
   * is either a second `start` for the running item or — worse — a `start` that
   * never gets a terminal event at all, because the walk overwrote `current`
   * without cancelling what was there.
   */
  function trackLifecycle(q: {
    on: Sequencer<void>['on'];
    currentItem: SequencerItem<void> | null;
  }) {
    const starts: string[] = [];
    const ended = new Set<string>();
    q.on('started', (item) => starts.push(item.id));
    q.on('completed', (item) => ended.add(item.id));
    q.on('cancelled', (item) => ended.add(item.id));
    q.on('skipped', (item) => ended.add(item.id));
    return {
      starts,
      /** Started but never terminated, excluding whatever is running now. */
      orphaned(): string[] {
        const live = q.currentItem?.id;
        return starts.filter((id) => id !== live && !ended.has(id));
      },
    };
  }

  /** Run `fn` on the first emit of `event` only — re-entrancy, not recursion. */
  function once<E extends 'skipped' | 'held' | 'completed' | 'cancelled' | 'repeated' | 'started'>(
    q: Sequencer<void>,
    event: E,
    fn: () => void,
  ) {
    let fired = false;
    q.on(event, () => {
      if (fired) return;
      fired = true;
      fn();
    });
  }

  it('queue mode: enqueueing from a completed listener does not orphan the next item', () => {
    const q = makeQueue();
    const seen = trackLifecycle(q);
    once(q, 'completed', () => q.enqueue(qi('c')));

    q.enqueue(qi('a'));
    q.enqueue(qi('b'));
    q.complete();

    expect(seen.starts).toEqual(['a', 'b']);
    expect(seen.orphaned()).toEqual([]);
    expect(q.currentItem?.id).toBe('b');
    expect(q.items.value.map((i) => i.id)).toEqual(['c']);
  });

  it('list mode: enqueueing from a completed listener does not re-start the running item', () => {
    const q = makeQueue({ mode: 'list' });
    const seen = trackLifecycle(q);
    once(q, 'completed', () => q.enqueue(qi('c')));

    q.enqueue(qi('a'));
    q.enqueue(qi('b'));
    q.complete();

    expect(seen.starts).toEqual(['a', 'b']);
    expect(q.currentItem?.id).toBe('b');
    expect(q.cursor).toBe(1);
  });

  it('queue mode: enqueueing from a skipped listener does not orphan the next item', () => {
    const q = makeQueue();
    q.canStart = (item) => (item.id === 'skip-me' ? 'never' : 'now');
    const seen = trackLifecycle(q);
    q.pause();
    q.enqueue(qi('skip-me'));
    q.enqueue(qi('b'));
    once(q, 'skipped', () => q.enqueue(qi('c')));
    q.resume();

    expect(seen.starts).toEqual(['b']);
    expect(seen.orphaned()).toEqual([]);
    expect(q.currentItem?.id).toBe('b');
    expect(q.items.value.map((i) => i.id)).toEqual(['c']);
  });

  it('list mode: enqueueing from a skipped listener does not re-start the dispatched item', () => {
    const q = makeQueue({ mode: 'list' });
    q.canStart = (item) => (item.id === 'skip-me' ? 'never' : 'now');
    const seen = trackLifecycle(q);
    once(q, 'skipped', () => q.enqueue(qi('c')));

    q.enqueue(qi('skip-me'));

    expect(seen.starts).toEqual(['c']);
    expect(q.currentItem?.id).toBe('c');
  });

  it('list mode: breaking the hold from a held listener dispatches once', () => {
    const tm = createManualTicks();
    const ctxId = `reentry-hold-${Math.random().toString(36).slice(2, 8)}`;
    beginPersistentContext(ctxId);
    const q = createSequencer({
      id: ctxId,
      mode: 'list',
      registerTick: tm.registerTick,
      canStart: (item) => (item.id === 'wait-me' ? 'notNow' : 'now'),
    });
    endPersistentContext();
    const seen = trackLifecycle(q);
    // Inserting AT the cursor with nothing running breaks the hold, which
    // re-drives from inside the `held` emit still on the stack.
    once(q, 'held', () => q.enqueue(qi('jump-in'), { at: 0 }));

    q.enqueue(qi('wait-me'));

    expect(seen.starts).toEqual(['jump-in']);
    expect(seen.orphaned()).toEqual([]);
    expect(q.currentItem?.id).toBe('jump-in');
  });

  it('list mode: enqueueing from resetCursor’s cancelled listener does not orphan', () => {
    const q = makeQueue({ mode: 'list' });
    const seen = trackLifecycle(q);
    q.enqueue(qi('a'));
    q.enqueue(qi('b'));
    once(q, 'cancelled', () => q.enqueue(qi('c')));

    q.resetCursor();

    expect(seen.starts).toEqual(['a', 'a']);
    expect(seen.orphaned()).toEqual([]);
    expect(q.currentItem?.id).toBe('a');
    expect(q.cursor).toBe(0);
  });

  it('queue mode: enqueueing from a repeated listener does not orphan the repeated item', () => {
    const q = makeQueue();
    const seen = trackLifecycle(q);
    q.enqueue(qi('a'));
    once(q, 'repeated', () => q.enqueue(qi('c')));

    q.repeat();

    expect(seen.orphaned()).toEqual([]);
    expect(q.currentItem?.id).toBe('a');
    expect(q.items.value.map((i) => i.id)).toEqual(['c']);
  });

  // The guard refuses a dispatch over a *live* current. `complete()` clears
  // `current` before it emits, so completing from a started listener is a
  // legitimate nested call and must still advance.
  it('queue mode: completing from a started listener still dispatches the next item', () => {
    const q = makeQueue();
    const seen = trackLifecycle(q);
    once(q, 'started', () => q.complete());

    q.enqueue(qi('a'));
    q.enqueue(qi('b'));

    expect(seen.starts).toEqual(['a', 'b']);
    expect(seen.orphaned()).toEqual([]);
    expect(q.currentItem?.id).toBe('b');
  });
});
