import { describe, it, expect } from 'vitest';
import { effectScope, watch, watchEffect } from 'vue';
import {
  beginPersistentContext,
  endPersistentContext,
  getAllPersistentRefs,
  settling,
  deserializePersistents,
  serializePersistents,
  withPersistentContext,
} from '@/core/persistence';
import {
  createRunPool,
  type RunPool,
  type RunPoolOptions,
  type RunDeathOutcome,
  type RunHandle,
  type RunStep,
} from '@/core/run-pool';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePool<Id = string>(
  opts: Partial<RunPoolOptions> & { deathDisposition: 'destroy' | 'park' },
): RunPool<Id> {
  const id = opts.id ?? `pool-${Math.random().toString(36).slice(2, 8)}`;
  beginPersistentContext(id);
  const pool = createRunPool<Id>({ ...opts, id });
  endPersistentContext();
  return pool;
}

function aliveStep(): boolean {
  return true;
}

function deadStep(): boolean {
  return false;
}

// ---------------------------------------------------------------------------
// Construction & persistence
// ---------------------------------------------------------------------------

describe('RunPool — construction', () => {
  it('exposes id and deathDisposition', () => {
    const pool = makePool({ deathDisposition: 'destroy' });
    expect(pool.deathDisposition).toBe('destroy');
    expect(typeof pool.id).toBe('string');
  });

  it('starts with no instances and liveCount=0', () => {
    const pool = makePool({ deathDisposition: 'park' });
    expect(pool.runs.value).toEqual([]);
    expect(pool.liveCount.value).toBe(0);
  });

  it('round-trips instance aliveness through save/load', () => {
    const ctxId = `round-trip-${Math.random().toString(36).slice(2, 8)}`;
    beginPersistentContext(ctxId);
    const pool = createRunPool({ id: ctxId, deathDisposition: 'park' });
    endPersistentContext();

    // Three instances — two alive, one parked.
    pool.addRun({ id: 'a', step: aliveStep });
    pool.addRun({ id: 'b', step: aliveStep });
    const c = pool.addRun({ id: 'c', step: deadStep });
    c.step(); // parks (deathDisposition=park, no onDeath)

    expect(pool.liveCount.value).toBe(2);
    expect(c.alive.value).toBe(false);

    // Simulate fresh-session load: seed a new pool, then deserialize a save
    // under `${ctxId2}` that still carries the `instanceIds` key older builds
    // wrote. Instances are added *after* deserialize to exercise the post-load
    // addRun path that motivated the refactor.
    const ctxId2 = `round-trip-2-${Math.random().toString(36).slice(2, 8)}`;
    beginPersistentContext(ctxId2);
    const pool2 = createRunPool({ id: ctxId2, deathDisposition: 'park' });
    endPersistentContext();

    deserializePersistents(getAllPersistentRefs(), {
      [ctxId2]: {
        instanceIds: ['a', 'b', 'c'],
        aliveStates: { a: true, b: true, c: false },
      },
    });

    pool2.addRun({ id: 'a', step: aliveStep });
    pool2.addRun({ id: 'b', step: aliveStep });
    pool2.addRun({ id: 'c', step: deadStep });

    expect(pool2.getRun('a')!.alive.value).toBe(true);
    expect(pool2.getRun('b')!.alive.value).toBe(true);
    expect(pool2.getRun('c')!.alive.value).toBe(false);
    expect(pool2.liveCount.value).toBe(2);
  });

  it('saves only the aliveness of each id; the game re-adds its handles after a load', () => {
    const ctxId = `saved-shape-${Math.random().toString(36).slice(2, 8)}`;
    const pool = withPersistentContext(ctxId, () =>
      createRunPool({ id: ctxId, deathDisposition: 'park' }),
    );
    pool.addRun({ id: 'a', step: aliveStep });
    expect(serializePersistents(getAllPersistentRefs())[ctxId]).toEqual({
      aliveStates: { a: true },
    });
  });

  it('saved alive=false survives a mid-session reload that replaces aliveStates', () => {
    // Mid-session load path: instances are already in the pool, then a
    // deserialize replaces `aliveStates` with a different snapshot. The
    // pool's hydration pass must re-seed each handle's local alive ref from
    // the new map values.
    const ctxId = `mid-session-${Math.random().toString(36).slice(2, 8)}`;
    beginPersistentContext(ctxId);
    const pool = createRunPool({ id: ctxId, deathDisposition: 'park' });
    endPersistentContext();

    pool.addRun({ id: 'a', step: aliveStep });
    pool.addRun({ id: 'b', step: aliveStep });
    expect(pool.getRun('a')!.alive.value).toBe(true);
    expect(pool.getRun('b')!.alive.value).toBe(true);

    deserializePersistents(getAllPersistentRefs(), {
      [ctxId]: {
        instanceIds: ['a', 'b'],
        aliveStates: { a: true, b: false },
      },
    });

    expect(pool.getRun('a')!.alive.value).toBe(true);
    expect(pool.getRun('b')!.alive.value).toBe(false);
  });

  it('a mid-session load flips a handle once the load has settled', () => {
    const ctxId = `settled-${Math.random().toString(36).slice(2, 8)}`;
    const pool = withPersistentContext(ctxId, () =>
      createRunPool({ id: ctxId, deathDisposition: 'park' }),
    );
    const handle = pool.addRun({ id: 'a', step: aliveStep });
    const loadingAtFlip: boolean[] = [];
    watch(handle.alive, () => loadingAtFlip.push(settling.value), { flush: 'sync' });

    deserializePersistents(getAllPersistentRefs(), {
      [ctxId]: { aliveStates: { a: false } },
    });

    expect(handle.alive.value).toBe(false);
    expect(loadingAtFlip).toEqual([false]);
  });

  it('a destroyed handle stays dead through a later load that revives its id', () => {
    const ctxId = `destroyed-load-${Math.random().toString(36).slice(2, 8)}`;
    beginPersistentContext(ctxId);
    const pool = createRunPool({ id: ctxId, deathDisposition: 'destroy' });
    endPersistentContext();

    const clone = pool.addRun({ id: 'clone-1', step: deadStep });
    clone.step();
    expect(pool.getRun('clone-1')).toBeUndefined();

    deserializePersistents(getAllPersistentRefs(), {
      [ctxId]: { instanceIds: ['clone-1'], aliveStates: { 'clone-1': true } },
    });

    expect(clone.alive.value).toBe(false);
  });
});

describe('RunPool — teardown', () => {
  it('dispose() stops the load re-seed and keeps the saved map registered', () => {
    const ctxId = `dispose-${Math.random().toString(36).slice(2, 8)}`;
    const pool = withPersistentContext(ctxId, () =>
      createRunPool({ id: ctxId, deathDisposition: 'park' }),
    );
    const handle = pool.addRun({ id: 'a', step: aliveStep });
    pool.dispose();

    deserializePersistents(getAllPersistentRefs(), {
      [ctxId]: { aliveStates: { a: false } },
    });

    expect(handle.alive.value).toBe(true);
    expect([...getAllPersistentRefs().keys()].some((k) => k.startsWith(ctxId))).toBe(true);
  });

  it('a handle added outside any scope stops with the scope that built its pool', () => {
    const ctxId = `scoped-${Math.random().toString(36).slice(2, 8)}`;
    const scope = effectScope();
    const pool = scope.run(() =>
      withPersistentContext(ctxId, () => createRunPool({ id: ctxId, deathDisposition: 'park' })),
    )!;
    const handle = pool.addRun({ id: 'a', step: aliveStep });
    scope.stop();

    const saved = {
      ...(getAllPersistentRefs().get(`${ctxId}.aliveStates`)!.value as Record<string, boolean>),
    };
    handle.alive.value = false;
    expect(getAllPersistentRefs().get(`${ctxId}.aliveStates`)!.value).toEqual(saved);
  });
});

// ---------------------------------------------------------------------------
// addRun / removeRun
// ---------------------------------------------------------------------------

describe('RunPool — addRun / removeRun', () => {
  it('fires instance:added with the returned handle', () => {
    const pool = makePool({ deathDisposition: 'destroy' });
    let added: RunHandle | null = null;
    pool.on('run:added', (h) => {
      added = h;
    });
    const handle = pool.addRun({ id: 'x', step: aliveStep });
    expect(added).toBe(handle);
    expect(handle.alive.value).toBe(true);
    expect(pool.runs.value).toEqual([handle]);
    expect(pool.liveCount.value).toBe(1);
  });

  it('throws on duplicate id', () => {
    const pool = makePool({ deathDisposition: 'destroy' });
    pool.addRun({ id: 'x', step: aliveStep });
    expect(() => pool.addRun({ id: 'x', step: aliveStep })).toThrow(/duplicate/i);
  });

  it('enforces capacity', () => {
    const pool = makePool({ deathDisposition: 'destroy', capacity: 2 });
    pool.addRun({ id: 'a', step: aliveStep });
    pool.addRun({ id: 'b', step: aliveStep });
    expect(() => pool.addRun({ id: 'c', step: aliveStep })).toThrow(/capacity/i);
  });

  it('treats capacity: 0 as valid-but-empty (always throws)', () => {
    const pool = makePool({ deathDisposition: 'destroy', capacity: 0 });
    expect(() => pool.addRun({ id: 'a', step: aliveStep })).toThrow(/capacity/i);
  });

  it('removeRun fires instance:died then instance:removed', () => {
    const pool = makePool({ deathDisposition: 'destroy' });
    const handle = pool.addRun({ id: 'x', step: aliveStep });
    const events: string[] = [];
    pool.on('run:died', (_h, o) => events.push(`died:${typeof o === 'string' ? o : 'restart'}`));
    pool.on('run:removed', () => events.push('removed'));
    pool.removeRun('x');
    expect(events).toEqual(['died:destroyed', 'removed']);
    expect(pool.runs.value).toEqual([]);
    expect(handle.alive.value).toBe(false);
  });

  it('removeRun on unknown id is a no-op', () => {
    const pool = makePool({ deathDisposition: 'destroy' });
    let fired = 0;
    pool.on('run:removed', () => fired++);
    pool.removeRun('nope');
    expect(fired).toBe(0);
  });

  it('instances.value reference is stable between no-op reads', () => {
    const pool = makePool({ deathDisposition: 'destroy' });
    pool.addRun({ id: 'x', step: aliveStep });
    const view1 = pool.runs.value;
    const view2 = pool.runs.value;
    expect(view1).toBe(view2);
  });

  it('instances.value reference changes on mutation', () => {
    const pool = makePool({ deathDisposition: 'destroy' });
    pool.addRun({ id: 'x', step: aliveStep });
    const view1 = pool.runs.value;
    pool.addRun({ id: 'y', step: aliveStep });
    const view2 = pool.runs.value;
    expect(view1).not.toBe(view2);
    expect(view2.map((h) => h.id)).toEqual(['x', 'y']);
  });
});

// ---------------------------------------------------------------------------
// Step routing — 'destroy' policy
// ---------------------------------------------------------------------------

describe("RunPool — step routing (deathDisposition: 'destroy')", () => {
  it('step returning true fires no events', () => {
    const pool = makePool({ deathDisposition: 'destroy' });
    const handle = pool.addRun({ id: 'x', step: aliveStep });
    let fired = 0;
    pool.on('run:died', () => fired++);
    pool.on('run:removed', () => fired++);
    expect(handle.step()).toBe(true);
    expect(fired).toBe(0);
  });

  it('step returning false fires died then removed, handle gone', () => {
    const pool = makePool({ deathDisposition: 'destroy' });
    const handle = pool.addRun({ id: 'x', step: deadStep });
    const events: string[] = [];
    pool.on('run:died', (_h, o) => events.push(`died:${o as string}`));
    pool.on('run:removed', () => events.push('removed'));
    expect(handle.step()).toBe(false);
    expect(events).toEqual(['died:destroyed', 'removed']);
    expect(pool.runs.value).toEqual([]);
    expect(pool.liveCount.value).toBe(0);
  });

  it('step on already-dead handle is a silent no-op', () => {
    const pool = makePool({ deathDisposition: 'destroy' });
    const handle = pool.addRun({ id: 'x', step: deadStep });
    handle.step();
    let fired = 0;
    pool.on('run:died', () => fired++);
    expect(handle.step()).toBe(false);
    expect(fired).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Step routing — 'park' policy
// ---------------------------------------------------------------------------

describe("RunPool — step routing (deathDisposition: 'park')", () => {
  it('step returning false parks the handle (alive=false, stays in pool)', () => {
    const pool = makePool({ deathDisposition: 'park' });
    const handle = pool.addRun({ id: 'x', step: deadStep });
    const events: string[] = [];
    pool.on('run:died', (_h, o) => events.push(`died:${o as string}`));
    pool.on('run:removed', () => events.push('removed'));
    handle.step();
    expect(events).toEqual(['died:parked']);
    expect(pool.runs.value).toEqual([handle]);
    expect(handle.alive.value).toBe(false);
  });

  it('subsequent step on parked handle returns false without events', () => {
    const pool = makePool({ deathDisposition: 'park' });
    const handle = pool.addRun({ id: 'x', step: deadStep });
    handle.step();
    let fired = 0;
    pool.on('run:died', () => fired++);
    expect(handle.step()).toBe(false);
    expect(fired).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// onDeath override — three outcomes
// ---------------------------------------------------------------------------

describe('RunPool — onDeath outcomes', () => {
  it("'destroyed' outcome from onDeath override (against 'park' pool)", () => {
    const pool = makePool({ deathDisposition: 'park' });
    const handle = pool.addRun({
      id: 'x',
      step: deadStep,
      onDeath: () => 'destroyed',
    });
    handle.step();
    expect(pool.runs.value).toEqual([]);
  });

  it("'parked' outcome from onDeath override (against 'destroy' pool)", () => {
    const pool = makePool({ deathDisposition: 'destroy' });
    const handle = pool.addRun({
      id: 'x',
      step: deadStep,
      onDeath: () => 'parked',
    });
    handle.step();
    expect(pool.runs.value).toEqual([handle]);
    expect(handle.alive.value).toBe(false);
  });

  it("'restartedWith' swaps the step in-place; alive stays true", () => {
    const pool = makePool({ deathDisposition: 'destroy' });
    let calls = 0;
    const firstStep: RunStep = () => {
      calls++;
      return false;
    };
    const replacement: RunStep = () => {
      calls++;
      return true;
    };
    const handle = pool.addRun({
      id: 'x',
      step: firstStep,
      onDeath: () => ({ restartedWith: replacement }),
    });
    const events: string[] = [];
    pool.on('run:died', () => events.push('died'));
    pool.on('run:restarted', () => events.push('restarted'));

    expect(handle.step()).toBe(false); // first step dies → restartedWith installs replacement
    expect(events).toEqual(['died', 'restarted']);
    expect(handle.alive.value).toBe(true);

    // Next invocation runs the replacement (still alive).
    expect(handle.step()).toBe(true);
    expect(calls).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// pool.reset
// ---------------------------------------------------------------------------

describe('RunPool — reset', () => {
  it('fires pool:reset and is synchronous', () => {
    const pool = makePool({ deathDisposition: 'park' });
    let fired = 0;
    pool.on('pool:reset', () => fired++);
    pool.reset();
    expect(fired).toBe(1);
  });

  it('handler can re-arm parked handles via handle.restart()', () => {
    const pool = makePool({ deathDisposition: 'park' });
    const a = pool.addRun({ id: 'a', step: deadStep });
    const b = pool.addRun({ id: 'b', step: deadStep });
    a.step();
    b.step();
    expect(a.alive.value).toBe(false);
    expect(b.alive.value).toBe(false);

    pool.on('pool:reset', () => {
      for (const h of pool.runs.value) h.restart(aliveStep);
    });
    pool.reset();

    expect(a.alive.value).toBe(true);
    expect(b.alive.value).toBe(true);
    expect(pool.liveCount.value).toBe(2);
  });

  it('handle.restart on a live handle is a no-op', () => {
    const pool = makePool({ deathDisposition: 'destroy' });
    const handle = pool.addRun({ id: 'x', step: aliveStep });
    let fired = 0;
    pool.on('run:restarted', () => fired++);
    handle.restart(aliveStep);
    expect(fired).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Firing-order invariants
// ---------------------------------------------------------------------------

describe('RunPool — firing-order invariants', () => {
  it("on instance:died('destroyed'): alive=false, handle still in instances.value", () => {
    const pool = makePool({ deathDisposition: 'destroy' });
    const handle = pool.addRun({ id: 'x', step: deadStep });
    let observedAlive: boolean | null = null;
    let observedPresent: boolean | null = null;
    pool.on('run:died', (h) => {
      observedAlive = h.alive.value;
      observedPresent = pool.runs.value.includes(h);
    });
    handle.step();
    expect(observedAlive).toBe(false);
    expect(observedPresent).toBe(true);
  });

  it("on instance:died('parked'): alive=false, handle still present", () => {
    const pool = makePool({ deathDisposition: 'park' });
    const handle = pool.addRun({ id: 'x', step: deadStep });
    let observedAlive: boolean | null = null;
    let observedPresent: boolean | null = null;
    pool.on('run:died', (h) => {
      observedAlive = h.alive.value;
      observedPresent = pool.runs.value.includes(h);
    });
    handle.step();
    expect(observedAlive).toBe(false);
    expect(observedPresent).toBe(true);
  });

  it('on instance:died(restartedWith): alive=true, handle still present', () => {
    const pool = makePool({ deathDisposition: 'destroy' });
    const handle = pool.addRun({
      id: 'x',
      step: deadStep,
      onDeath: () => ({ restartedWith: aliveStep }),
    });
    let observedAlive: boolean | null = null;
    let observedOutcome: RunDeathOutcome | null = null;
    pool.on('run:died', (h, o) => {
      observedAlive = h.alive.value;
      observedOutcome = o;
    });
    handle.step();
    expect(observedAlive).toBe(true);
    expect(observedOutcome).toEqual({ restartedWith: aliveStep });
  });

  it('on instance:removed: handle no longer in instances.value', () => {
    const pool = makePool({ deathDisposition: 'destroy' });
    const handle = pool.addRun({ id: 'x', step: deadStep });
    let observedPresent: boolean | null = null;
    pool.on('run:removed', (h) => {
      observedPresent = pool.runs.value.includes(h);
    });
    handle.step();
    expect(observedPresent).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Re-entrancy
// ---------------------------------------------------------------------------

describe('RunPool — re-entrancy', () => {
  it('addRun from inside instance:died handler lands before instance:removed', () => {
    const pool = makePool({ deathDisposition: 'destroy' });
    const events: string[] = [];
    pool.on('run:died', (h) => {
      events.push(`died:${h.id}`);
      if (h.id === 'a') {
        pool.addRun({ id: 'b', step: aliveStep });
      }
    });
    pool.on('run:added', (h) => events.push(`added:${h.id}`));
    pool.on('run:removed', (h) => events.push(`removed:${h.id}`));

    const a = pool.addRun({ id: 'a', step: deadStep });
    events.length = 0; // clear the initial added:a
    a.step();

    // Expected: died:a, added:b (from handler), removed:a
    expect(events).toEqual(['died:a', 'added:b', 'removed:a']);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('RunPool — edge cases', () => {
  it('step() throwing propagates, aliveness unchanged', () => {
    const pool = makePool({ deathDisposition: 'destroy' });
    const handle = pool.addRun({
      id: 'x',
      step: () => {
        throw new Error('boom');
      },
    });
    expect(() => handle.step()).toThrow('boom');
    expect(handle.alive.value).toBe(true);
    expect(pool.runs.value).toEqual([handle]);
  });

  it('pool.reset during a step is synchronous and safe', () => {
    const pool = makePool({ deathDisposition: 'park' });
    let resetFired = 0;
    pool.on('pool:reset', () => resetFired++);
    const handle = pool.addRun({
      id: 'x',
      step: () => {
        pool.reset();
        return true;
      },
    });
    expect(handle.step()).toBe(true);
    expect(resetFired).toBe(1);
  });

  it('destroy() is idempotent', () => {
    const pool = makePool({ deathDisposition: 'destroy' });
    const handle = pool.addRun({ id: 'x', step: aliveStep });
    handle.destroy();
    let fired = 0;
    pool.on('run:removed', () => fired++);
    handle.destroy(); // second call
    expect(fired).toBe(0);
  });

  it('a destroyed handle leaves alone the new handle that reuses its id', () => {
    const pool = makePool({ deathDisposition: 'destroy' });
    const old = pool.addRun({ id: 'x', step: aliveStep });
    old.destroy();
    const next = pool.addRun({ id: 'x', step: aliveStep });
    old.destroy();
    old.restart(aliveStep);
    expect(old.alive.value).toBe(false);
    expect(pool.getRun('x')).toBe(next);
    expect(next.alive.value).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Reactivity
// ---------------------------------------------------------------------------

describe('RunPool — dispose', () => {
  it('a run pool built with the id of a disposed one keeps the saved aliveness', () => {
    const first = createRunPool({ id: 'pool-rebuild', deathDisposition: 'park' });
    first.addRun({ id: 'a', step: deadStep }).step();
    first.dispose();

    const second = createRunPool({ id: 'pool-rebuild', deathDisposition: 'park' });
    expect(second.addRun({ id: 'a', step: aliveStep }).alive.value).toBe(false);
  });

  it('the disposed run pool no longer writes the saved map its rebuild took over', () => {
    const first = createRunPool({ id: 'pool-detach', deathDisposition: 'park' });
    first.addRun({ id: 'a', step: deadStep }).step();
    first.dispose();
    const second = createRunPool({ id: 'pool-detach', deathDisposition: 'park' });

    first.removeRun('a');
    expect(second.addRun({ id: 'a', step: aliveStep }).alive.value).toBe(false);
  });
});

describe('RunPool — reactivity', () => {
  it('liveCount reacts to step-death and restart', () => {
    const pool = makePool({ deathDisposition: 'park' });
    const observed: number[] = [];
    const scope = effectScope();
    scope.run(() => {
      watchEffect(
        () => {
          observed.push(pool.liveCount.value);
        },
        { flush: 'sync' },
      );
    });

    const h = pool.addRun({ id: 'x', step: deadStep });
    h.step(); // park
    h.restart(aliveStep);

    // Sequence: initial 0, after add 1, after step 0, after restart 1.
    expect(observed).toEqual([0, 1, 0, 1]);
    scope.stop();
  });

  it('watchEffect on instances.value fires on add/remove', () => {
    const pool = makePool({ deathDisposition: 'destroy' });
    let runs = 0;
    const scope = effectScope();
    scope.run(() => {
      watchEffect(
        () => {
          void pool.runs.value;
          runs++;
        },
        { flush: 'sync' },
      );
    });
    const initial = runs;

    pool.addRun({ id: 'a', step: aliveStep });
    pool.addRun({ id: 'b', step: aliveStep });
    pool.removeRun('a');

    expect(runs - initial).toBeGreaterThanOrEqual(3);
    scope.stop();
  });
});
