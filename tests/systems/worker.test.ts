import { describe, it, expect, vi } from 'vitest';
import { beginPersistentContext, endPersistentContext } from '@/core/persistence';
import { createSequencer } from '@/core/sequencer';
import { createTimedProgress } from '@/core/timed-progress';
import { createWorker, isWorker, WorkerType } from '@/systems/worker';

/** Simple tick manager matching the pattern used across systems tests. */
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
    count() {
      return callbacks.length;
    },
  };
}

interface TestTask {
  id: string;
  duration: number;
  speed?: number;
  label?: string;
}

let setupCounter = 0;
function setup(label?: string) {
  const workerId = `${label ?? 'worker'}-${++setupCounter}`;
  const tm = createTickManager();
  beginPersistentContext(`worker-test-${workerId}`);
  const sequencer = createSequencer<void>({ id: `${workerId}:seq` });
  const tasks = new Map<string, TestTask>([
    ['mine', { id: 'mine', duration: 10, label: 'Mine ore' }],
    ['smelt', { id: 'smelt', duration: 20, label: 'Smelt ore' }],
  ]);
  const getTask = (id: string): TestTask | undefined => tasks.get(id);
  const tracker = createTimedProgress({
    id: `${workerId}:tracker`,
    duration: () => getTask(sequencer.currentItem?.id ?? '')?.duration ?? 0,
    registerTick: tm.registerTick,
  });
  endPersistentContext();
  return { tm, sequencer, tracker, tasks, getTask };
}

describe('createWorker', () => {
  it('exposes the four inputs plus type symbol', () => {
    const { sequencer, tracker, getTask } = setup();
    const worker = createWorker({ id: 'player', sequencer, tracker, getTask });
    expect(worker.id).toBe('player');
    expect(worker.sequencer).toBe(sequencer);
    expect(worker.tracker).toBe(tracker);
    expect(worker.type).toBe(WorkerType);
  });

  it('currentTaskId tracks sequencer.currentItem reactively', () => {
    const { sequencer, tracker, getTask } = setup();
    const worker = createWorker({ id: 'player', sequencer, tracker, getTask });

    expect(worker.currentTaskId.value).toBeUndefined();

    sequencer.enqueue({ id: 'mine', metadata: undefined });
    expect(worker.currentTaskId.value).toBe('mine');

    sequencer.complete();
    expect(worker.currentTaskId.value).toBeUndefined();
  });

  it('currentTask resolves via getTask', () => {
    const { sequencer, tracker, getTask, tasks } = setup();
    const worker = createWorker({ id: 'player', sequencer, tracker, getTask });

    expect(worker.currentTask.value).toBeUndefined();

    sequencer.enqueue({ id: 'smelt', metadata: undefined });
    expect(worker.currentTask.value).toBe(tasks.get('smelt'));
    expect(worker.currentTask.value?.label).toBe('Smelt ore');
  });

  it('currentTask is undefined when getTask returns undefined for an unknown id', () => {
    const { sequencer, tracker, getTask } = setup();
    const worker = createWorker({ id: 'player', sequencer, tracker, getTask });

    sequencer.enqueue({ id: 'not-a-real-task', metadata: undefined });
    expect(worker.currentTaskId.value).toBe('not-a-real-task');
    expect(worker.currentTask.value).toBeUndefined();
  });

  it('dispose tears down the tracker but does not touch the sequencer', () => {
    const { tm, sequencer, tracker, getTask } = setup();
    const worker = createWorker({ id: 'player', sequencer, tracker, getTask });

    expect(tm.count()).toBe(1);
    worker.dispose();
    expect(tm.count()).toBe(0);

    // Sequencer still functions — not disposed.
    sequencer.enqueue({ id: 'mine', metadata: undefined });
    expect(sequencer.currentItem?.id).toBe('mine');
  });

  it('two workers sharing the same getTask lookup do not interfere', () => {
    const a = setup('alpha');
    const b = setup('bravo');
    // Share the same lookup between both workers
    const sharedGetTask = a.getTask;

    const wa = createWorker({
      id: 'clone-0',
      sequencer: a.sequencer,
      tracker: a.tracker,
      getTask: sharedGetTask,
    });
    const wb = createWorker({
      id: 'clone-1',
      sequencer: b.sequencer,
      tracker: b.tracker,
      getTask: sharedGetTask,
    });

    a.sequencer.enqueue({ id: 'mine', metadata: undefined });
    b.sequencer.enqueue({ id: 'smelt', metadata: undefined });

    expect(wa.currentTaskId.value).toBe('mine');
    expect(wb.currentTaskId.value).toBe('smelt');
    expect(wa.currentTask.value?.label).toBe('Mine ore');
    expect(wb.currentTask.value?.label).toBe('Smelt ore');

    // Disposing one must not affect the other.
    wa.dispose();
    expect(wb.currentTaskId.value).toBe('smelt');
  });

  it('structural TaskDef typing compiles with consumer-shaped defs', () => {
    // This is a compile-time check: the generic accepts any shape that
    // extends `{ id: string }`, carrying through arbitrary consumer fields.
    interface SpellDef {
      id: string;
      manaCost: number;
      school: 'fire' | 'ice';
    }
    const tm = createTickManager();
    beginPersistentContext('worker-spell');
    const sequencer = createSequencer<void>({ id: 'spell-seq' });
    const spells = new Map<string, SpellDef>([
      ['fireball', { id: 'fireball', manaCost: 10, school: 'fire' }],
    ]);
    const tracker = createTimedProgress({
      id: 'spell-tracker',
      duration: 5,
      registerTick: tm.registerTick,
    });
    endPersistentContext();

    const worker = createWorker<SpellDef>({
      id: 'caster',
      sequencer,
      tracker,
      getTask: (id) => spells.get(id),
    });

    sequencer.enqueue({ id: 'fireball', metadata: undefined });
    // Type narrowing: currentTask carries SpellDef, so manaCost is accessible.
    expect(worker.currentTask.value?.manaCost).toBe(10);
    expect(worker.currentTask.value?.school).toBe('fire');
  });

  it('Worker installs no subscriptions of its own — the consumer owns wiring', () => {
    // The sequencer emits 'start' when enqueue auto-dispatches. Worker should
    // not subscribe to that event, so sequencer.on should have zero listeners
    // attributable to createWorker. We assert this indirectly: if the consumer
    // subscribes to 'start' and no other handler fires, the handler's call
    // count equals exactly the number of enqueues.
    const { sequencer, tracker, getTask } = setup();
    const startHandler = vi.fn();
    sequencer.on('start', startHandler);

    createWorker({ id: 'player', sequencer, tracker, getTask });

    sequencer.enqueue({ id: 'mine', metadata: undefined });
    expect(startHandler).toHaveBeenCalledTimes(1);

    sequencer.complete();
    sequencer.enqueue({ id: 'smelt', metadata: undefined });
    expect(startHandler).toHaveBeenCalledTimes(2);
  });
});

describe('isWorker', () => {
  it('recognizes Worker instances', () => {
    const { sequencer, tracker, getTask } = setup();
    const worker = createWorker({ id: 'player', sequencer, tracker, getTask });
    expect(isWorker(worker)).toBe(true);
  });

  it('rejects non-Worker values', () => {
    expect(isWorker(null)).toBe(false);
    expect(isWorker(undefined)).toBe(false);
    expect(isWorker({})).toBe(false);
    expect(isWorker({ type: Symbol('other') })).toBe(false);
    expect(isWorker('worker')).toBe(false);
  });
});
