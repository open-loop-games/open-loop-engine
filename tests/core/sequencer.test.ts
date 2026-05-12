import { describe, it, expect } from 'vitest';
import { effectScope, watchEffect } from 'vue';
import {
  beginPersistentContext,
  endPersistentContext,
  getAllPersistentRefs,
  deserializePersistents,
} from '@/core/persistence';
import { createSequencer, type SequencerItem, type StartResult } from '@/core/sequencer';

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
    q.on('cancel', (item) => cancelled.push(item.id));

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

  it('emits start and complete events like queue mode', () => {
    const q = makeQueue({ mode: 'list' });
    const started: string[] = [];
    const completed: string[] = [];
    q.on('start', (item) => started.push(item.id));
    q.on('complete', (item) => completed.push(item.id));

    q.enqueue(qi('a'));
    q.enqueue(qi('b'));
    q.complete();
    q.complete();

    expect(started).toEqual(['a', 'b']);
    expect(completed).toEqual(['a', 'b']);
  });

  it('canRun "never" skips items and advances cursor', () => {
    const q = makeQueue({ mode: 'list' });
    q.canRun = (item) => (item.id === 'skip-me' ? 'never' : 'now');
    const skipped: string[] = [];
    q.on('skip', (item) => skipped.push(item.id));

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
// canRun tri-state — 'now' / 'never' / 'notNow' + hold-and-retry
// ============================================================================

/**
 * Minimal tick manager for driving the retry path in tests.
 * Returns both a registerTick function (for SequencerOptions) and a
 * fireTick() helper that invokes all registered callbacks once.
 */
function createTickManager() {
  const callbacks = new Set<(dt: number) => void>();
  return {
    registerTick(cb: (dt: number) => void): () => void {
      callbacks.add(cb);
      return () => callbacks.delete(cb);
    },
    fireTick(dt = 1) {
      for (const cb of Array.from(callbacks)) cb(dt);
    },
    subscriberCount() {
      return callbacks.size;
    },
  };
}

describe('Sequencer — canRun tri-state', () => {
  it('"now" dispatches normally', () => {
    const ctxId = `tri-now-${Math.random().toString(36).slice(2, 8)}`;
    beginPersistentContext(ctxId);
    const q = createSequencer({
      id: ctxId,
      canRun: () => 'now',
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
      canRun: (item) => (item.id === 'bad' ? 'never' : 'now'),
    });
    endPersistentContext();
    q.on('skip', (item) => skipped.push(item.id));

    q.enqueue(qi('bad'));
    q.enqueue(qi('good'));

    expect(q.currentItem?.id).toBe('good');
    expect(skipped).toEqual(['bad']);
    expect(q.holding).toBe(false);
  });

  it('"notNow" with registerTick enters hold state instead of advancing', () => {
    const tm = createTickManager();
    const ctxId = `tri-hold-${Math.random().toString(36).slice(2, 8)}`;
    const events: string[] = [];

    beginPersistentContext(ctxId);
    const q = createSequencer({
      id: ctxId,
      registerTick: tm.registerTick,
      canRun: () => 'notNow',
    });
    endPersistentContext();
    q.on('hold', (item) => events.push(`hold:${item.id}`));
    q.on('start', (item) => events.push(`start:${item.id}`));
    q.on('skip', (item) => events.push(`skip:${item.id}`));

    q.enqueue(qi('wait-me'));

    expect(q.holding).toBe(true);
    expect(q.currentItem).toBeNull();
    // Item remains in the waiting list — peek, don't pop
    expect(q.items.value.map((i) => i.id)).toEqual(['wait-me']);
    expect(events).toEqual(['hold:wait-me']);
    expect(tm.subscriberCount()).toBe(1);
  });

  it('"notNow" without registerTick degrades to "never"', () => {
    const ctxId = `tri-nodeg-${Math.random().toString(36).slice(2, 8)}`;
    const events: string[] = [];

    beginPersistentContext(ctxId);
    const q = createSequencer({
      id: ctxId,
      canRun: (item) => (item.id === 'wait-me' ? 'notNow' : 'now'),
      // No registerTick — 'notNow' should fall back to 'never'
    });
    endPersistentContext();
    q.on('hold', (item) => events.push(`hold:${item.id}`));
    q.on('skip', (item) => events.push(`skip:${item.id}`));

    q.enqueue(qi('wait-me'));
    q.enqueue(qi('run-me'));

    expect(q.holding).toBe(false);
    expect(q.currentItem?.id).toBe('run-me');
    expect(events).toEqual(['skip:wait-me']);
  });

  it('transitions hold → "now" on retry tick, dispatching the held item', () => {
    const tm = createTickManager();
    const ctxId = `tri-hold2now-${Math.random().toString(36).slice(2, 8)}`;
    const events: string[] = [];

    let gate: StartResult = 'notNow';
    beginPersistentContext(ctxId);
    const q = createSequencer({
      id: ctxId,
      registerTick: tm.registerTick,
      canRun: () => gate,
    });
    endPersistentContext();
    q.on('hold', (item) => events.push(`hold:${item.id}`));
    q.on('start', (item) => events.push(`start:${item.id}`));

    q.enqueue(qi('wait-me'));
    expect(q.holding).toBe(true);

    // Tick fires while still 'notNow' — should stay held, not re-emit hold
    tm.fireTick();
    expect(q.holding).toBe(true);
    expect(events).toEqual(['hold:wait-me']);

    // Gate opens — next tick transitions to running
    gate = 'now';
    tm.fireTick();
    expect(q.holding).toBe(false);
    expect(q.currentItem?.id).toBe('wait-me');
    expect(events).toEqual(['hold:wait-me', 'start:wait-me']);
    // The held item is consumed (popped) only when it transitions out of hold
    expect(q.items.value.length).toBe(0);
  });

  it('transitions hold → "never" on retry tick, skipping and advancing', () => {
    const tm = createTickManager();
    const ctxId = `tri-hold2never-${Math.random().toString(36).slice(2, 8)}`;
    const events: string[] = [];

    let gate: StartResult = 'notNow';
    beginPersistentContext(ctxId);
    const q = createSequencer({
      id: ctxId,
      registerTick: tm.registerTick,
      canRun: (item) => (item.id === 'wait-me' ? gate : 'now'),
    });
    endPersistentContext();
    q.on('hold', (item) => events.push(`hold:${item.id}`));
    q.on('skip', (item) => events.push(`skip:${item.id}`));
    q.on('start', (item) => events.push(`start:${item.id}`));

    q.enqueue(qi('wait-me'));
    q.enqueue(qi('run-me'));
    expect(q.holding).toBe(true);

    // Gate becomes impossible — next tick skips and advances to 'run-me'
    gate = 'never';
    tm.fireTick();
    expect(q.holding).toBe(false);
    expect(q.currentItem?.id).toBe('run-me');
    expect(events).toEqual(['hold:wait-me', 'skip:wait-me', 'start:run-me']);
  });

  it('hold state persists across pause; retry resumes on unpause', () => {
    const tm = createTickManager();
    const ctxId = `tri-pause-${Math.random().toString(36).slice(2, 8)}`;

    let gate: StartResult = 'notNow';
    beginPersistentContext(ctxId);
    const q = createSequencer({
      id: ctxId,
      registerTick: tm.registerTick,
      canRun: () => gate,
    });
    endPersistentContext();

    q.enqueue(qi('wait-me'));
    expect(q.holding).toBe(true);

    q.pause();
    // Tick fires while paused — should be a no-op, hold preserved
    tm.fireTick();
    expect(q.holding).toBe(true);
    expect(q.currentItem).toBeNull();

    // Open the gate; resume() should snap out of hold immediately
    gate = 'now';
    q.resume();
    expect(q.holding).toBe(false);
    expect(q.currentItem?.id).toBe('wait-me');
  });

  it('setting canRun = null while holding clears hold and dispatches', () => {
    const tm = createTickManager();
    const ctxId = `tri-gate-off-${Math.random().toString(36).slice(2, 8)}`;

    beginPersistentContext(ctxId);
    const q = createSequencer({
      id: ctxId,
      registerTick: tm.registerTick,
      canRun: () => 'notNow',
    });
    endPersistentContext();

    q.enqueue(qi('wait-me'));
    expect(q.holding).toBe(true);

    q.canRun = null;
    expect(q.holding).toBe(false);
    expect(q.currentItem?.id).toBe('wait-me');
  });

  it('remove() at the held index drops hold and re-drives', () => {
    const tm = createTickManager();
    const ctxId = `tri-remove-${Math.random().toString(36).slice(2, 8)}`;

    beginPersistentContext(ctxId);
    const q = createSequencer({
      id: ctxId,
      registerTick: tm.registerTick,
      canRun: (item) => (item.id === 'wait-me' ? 'notNow' : 'now'),
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
    const tm = createTickManager();
    const ctxId = `tri-clear-${Math.random().toString(36).slice(2, 8)}`;

    beginPersistentContext(ctxId);
    const q = createSequencer({
      id: ctxId,
      registerTick: tm.registerTick,
      canRun: () => 'notNow',
    });
    endPersistentContext();

    q.enqueue(qi('wait-me'));
    expect(q.holding).toBe(true);

    q.clear();
    expect(q.holding).toBe(false);
    expect(q.items.value.length).toBe(0);
    expect(q.currentItem).toBeNull();
  });

  it('list mode: "notNow" holds at cursor position without advancing', () => {
    const tm = createTickManager();
    const ctxId = `tri-list-hold-${Math.random().toString(36).slice(2, 8)}`;

    let gate: StartResult = 'notNow';
    beginPersistentContext(ctxId);
    const q = createSequencer({
      id: ctxId,
      mode: 'list',
      registerTick: tm.registerTick,
      canRun: (item) => (item.id === 'b' ? gate : 'now'),
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
    tm.fireTick();
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

  it('drains a mixed never/now burst in canRun without losing or reordering', () => {
    const allowed = new Set(['a', 'c', 'e']);
    const canRun = (item: SequencerItem<void>): StartResult =>
      allowed.has(item.id) ? 'now' : 'never';

    const ctxId = `q-burst-${Math.random().toString(36).slice(2, 8)}`;
    beginPersistentContext(ctxId);
    const q = createSequencer<void>({ id: ctxId, canRun });
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
    q.on('cancel', (item) => cancelled.push(item.id));

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
    const tm = createTickManager();
    let gate: StartResult = 'notNow';
    beginPersistentContext(ctxId);
    const q = createSequencer({
      id: ctxId,
      registerTick: tm.registerTick,
      canRun: (item) => (item.id === 'blocked' ? gate : 'now'),
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

  it('save/load rehydration clears in-memory hold', () => {
    const ctxId = `hold-hydrate-${Math.random().toString(36).slice(2, 8)}`;
    const tm = createTickManager();
    beginPersistentContext(ctxId);
    const q = createSequencer({
      id: ctxId,
      registerTick: tm.registerTick,
      canRun: () => 'notNow',
    });
    endPersistentContext();

    q.enqueue(qi('wait'));
    expect(q.holding).toBe(true);
    expect(tm.subscriberCount()).toBe(1);

    // Simulate external rehydration (save load) — feed a different rawItems
    // payload through the save-restore path. The watch should drop the hold.
    deserializePersistents(getAllPersistentRefs(), {
      [ctxId]: {
        current: '',
        rawItems: '["replaced"]',
        paused: false,
      },
    });

    expect(q.holding).toBe(false);
    expect(tm.subscriberCount()).toBe(0);
    expect(q.items.value.map((i) => i.id)).toEqual(['replaced']);
  });
});
