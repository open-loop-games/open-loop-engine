import { describe, it, expect } from 'vitest';
import { effectScope, watchEffect } from 'vue';
import {
  beginPersistentContext,
  endPersistentContext,
  getAllPersistentRefs,
  deserializePersistents,
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
  opts: Partial<RunPoolOptions> & { deathPolicy: 'destroy' | 'park' },
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
  it('exposes id and deathPolicy', () => {
    const pool = makePool({ deathPolicy: 'destroy' });
    expect(pool.deathPolicy).toBe('destroy');
    expect(typeof pool.id).toBe('string');
  });

  it('starts with no instances and liveCount=0', () => {
    const pool = makePool({ deathPolicy: 'park' });
    expect(pool.instances.value).toEqual([]);
    expect(pool.liveCount.value).toBe(0);
  });

  it('round-trips instance aliveness through save/load', () => {
    const ctxId = `round-trip-${Math.random().toString(36).slice(2, 8)}`;
    beginPersistentContext(ctxId);
    const pool = createRunPool({ id: ctxId, deathPolicy: 'park' });
    endPersistentContext();

    // Three instances — two alive, one parked.
    pool.addInstance({ id: 'a', step: aliveStep });
    pool.addInstance({ id: 'b', step: aliveStep });
    const c = pool.addInstance({ id: 'c', step: deadStep });
    c.step(); // parks (deathPolicy=park, no onDeath)

    expect(pool.liveCount.value).toBe(2);
    expect(c.alive.value).toBe(false);

    // Simulate fresh-session load: seed a new pool, then deserialize a save
    // shaped to match the pool's persisted layout (instanceIds + aliveStates
    // both under `${ctxId2}`). Instances are added *after* deserialize to
    // exercise the post-load addInstance path that motivated the refactor.
    const ctxId2 = `round-trip-2-${Math.random().toString(36).slice(2, 8)}`;
    beginPersistentContext(ctxId2);
    const pool2 = createRunPool({ id: ctxId2, deathPolicy: 'park' });
    endPersistentContext();

    deserializePersistents(getAllPersistentRefs(), {
      [ctxId2]: {
        instanceIds: ['a', 'b', 'c'],
        aliveStates: { a: true, b: true, c: false },
      },
    });

    pool2.addInstance({ id: 'a', step: aliveStep });
    pool2.addInstance({ id: 'b', step: aliveStep });
    pool2.addInstance({ id: 'c', step: deadStep });

    expect(pool2.getInstance('a')!.alive.value).toBe(true);
    expect(pool2.getInstance('b')!.alive.value).toBe(true);
    expect(pool2.getInstance('c')!.alive.value).toBe(false);
    expect(pool2.liveCount.value).toBe(2);
  });

  it('saved alive=false survives a mid-session reload that replaces aliveStates', () => {
    // Mid-session load path: instances are already in the pool, then a
    // deserialize replaces `aliveStates` with a different snapshot. The
    // reverse watcher (gated on loadingSave) must re-seed each handle's
    // local alive ref from the new map values.
    const ctxId = `mid-session-${Math.random().toString(36).slice(2, 8)}`;
    beginPersistentContext(ctxId);
    const pool = createRunPool({ id: ctxId, deathPolicy: 'park' });
    endPersistentContext();

    pool.addInstance({ id: 'a', step: aliveStep });
    pool.addInstance({ id: 'b', step: aliveStep });
    expect(pool.getInstance('a')!.alive.value).toBe(true);
    expect(pool.getInstance('b')!.alive.value).toBe(true);

    deserializePersistents(getAllPersistentRefs(), {
      [ctxId]: {
        instanceIds: ['a', 'b'],
        aliveStates: { a: true, b: false },
      },
    });

    expect(pool.getInstance('a')!.alive.value).toBe(true);
    expect(pool.getInstance('b')!.alive.value).toBe(false);
  });

  it('a destroyed handle stays dead through a later load that revives its id', () => {
    const ctxId = `destroyed-load-${Math.random().toString(36).slice(2, 8)}`;
    beginPersistentContext(ctxId);
    const pool = createRunPool({ id: ctxId, deathPolicy: 'destroy' });
    endPersistentContext();

    const clone = pool.addInstance({ id: 'clone-1', step: deadStep });
    clone.step();
    expect(pool.getInstance('clone-1')).toBeUndefined();

    deserializePersistents(getAllPersistentRefs(), {
      [ctxId]: { instanceIds: ['clone-1'], aliveStates: { 'clone-1': true } },
    });

    expect(clone.alive.value).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// addInstance / removeInstance
// ---------------------------------------------------------------------------

describe('RunPool — addInstance / removeInstance', () => {
  it('fires instance:added with the returned handle', () => {
    const pool = makePool({ deathPolicy: 'destroy' });
    let added: RunHandle | null = null;
    pool.on('instance:added', (h) => {
      added = h;
    });
    const handle = pool.addInstance({ id: 'x', step: aliveStep });
    expect(added).toBe(handle);
    expect(handle.alive.value).toBe(true);
    expect(pool.instances.value).toEqual([handle]);
    expect(pool.liveCount.value).toBe(1);
  });

  it('throws on duplicate id', () => {
    const pool = makePool({ deathPolicy: 'destroy' });
    pool.addInstance({ id: 'x', step: aliveStep });
    expect(() => pool.addInstance({ id: 'x', step: aliveStep })).toThrow(/duplicate/i);
  });

  it('enforces maxInstances cap', () => {
    const pool = makePool({ deathPolicy: 'destroy', maxInstances: 2 });
    pool.addInstance({ id: 'a', step: aliveStep });
    pool.addInstance({ id: 'b', step: aliveStep });
    expect(() => pool.addInstance({ id: 'c', step: aliveStep })).toThrow(/maxInstances/i);
  });

  it('treats maxInstances:0 as valid-but-empty (always throws)', () => {
    const pool = makePool({ deathPolicy: 'destroy', maxInstances: 0 });
    expect(() => pool.addInstance({ id: 'a', step: aliveStep })).toThrow(/maxInstances/i);
  });

  it('removeInstance fires instance:died then instance:removed', () => {
    const pool = makePool({ deathPolicy: 'destroy' });
    const handle = pool.addInstance({ id: 'x', step: aliveStep });
    const events: string[] = [];
    pool.on('instance:died', (_h, o) =>
      events.push(`died:${typeof o === 'string' ? o : 'restart'}`),
    );
    pool.on('instance:removed', () => events.push('removed'));
    pool.removeInstance('x');
    expect(events).toEqual(['died:destroyed', 'removed']);
    expect(pool.instances.value).toEqual([]);
    expect(handle.alive.value).toBe(false);
  });

  it('removeInstance on unknown id is a no-op', () => {
    const pool = makePool({ deathPolicy: 'destroy' });
    let fired = 0;
    pool.on('instance:removed', () => fired++);
    pool.removeInstance('nope');
    expect(fired).toBe(0);
  });

  it('instances.value reference is stable between no-op reads', () => {
    const pool = makePool({ deathPolicy: 'destroy' });
    pool.addInstance({ id: 'x', step: aliveStep });
    const view1 = pool.instances.value;
    const view2 = pool.instances.value;
    expect(view1).toBe(view2);
  });

  it('instances.value reference changes on mutation', () => {
    const pool = makePool({ deathPolicy: 'destroy' });
    pool.addInstance({ id: 'x', step: aliveStep });
    const view1 = pool.instances.value;
    pool.addInstance({ id: 'y', step: aliveStep });
    const view2 = pool.instances.value;
    expect(view1).not.toBe(view2);
    expect(view2.map((h) => h.id)).toEqual(['x', 'y']);
  });
});

// ---------------------------------------------------------------------------
// Step routing — 'destroy' policy
// ---------------------------------------------------------------------------

describe("RunPool — step routing (deathPolicy: 'destroy')", () => {
  it('step returning true fires no events', () => {
    const pool = makePool({ deathPolicy: 'destroy' });
    const handle = pool.addInstance({ id: 'x', step: aliveStep });
    let fired = 0;
    pool.on('instance:died', () => fired++);
    pool.on('instance:removed', () => fired++);
    expect(handle.step()).toBe(true);
    expect(fired).toBe(0);
  });

  it('step returning false fires died then removed, handle gone', () => {
    const pool = makePool({ deathPolicy: 'destroy' });
    const handle = pool.addInstance({ id: 'x', step: deadStep });
    const events: string[] = [];
    pool.on('instance:died', (_h, o) => events.push(`died:${o as string}`));
    pool.on('instance:removed', () => events.push('removed'));
    expect(handle.step()).toBe(false);
    expect(events).toEqual(['died:destroyed', 'removed']);
    expect(pool.instances.value).toEqual([]);
    expect(pool.liveCount.value).toBe(0);
  });

  it('step on already-dead handle is a silent no-op', () => {
    const pool = makePool({ deathPolicy: 'destroy' });
    const handle = pool.addInstance({ id: 'x', step: deadStep });
    handle.step();
    let fired = 0;
    pool.on('instance:died', () => fired++);
    expect(handle.step()).toBe(false);
    expect(fired).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Step routing — 'park' policy
// ---------------------------------------------------------------------------

describe("RunPool — step routing (deathPolicy: 'park')", () => {
  it('step returning false parks the handle (alive=false, stays in pool)', () => {
    const pool = makePool({ deathPolicy: 'park' });
    const handle = pool.addInstance({ id: 'x', step: deadStep });
    const events: string[] = [];
    pool.on('instance:died', (_h, o) => events.push(`died:${o as string}`));
    pool.on('instance:removed', () => events.push('removed'));
    handle.step();
    expect(events).toEqual(['died:parked']);
    expect(pool.instances.value).toEqual([handle]);
    expect(handle.alive.value).toBe(false);
  });

  it('subsequent step on parked handle returns false without events', () => {
    const pool = makePool({ deathPolicy: 'park' });
    const handle = pool.addInstance({ id: 'x', step: deadStep });
    handle.step();
    let fired = 0;
    pool.on('instance:died', () => fired++);
    expect(handle.step()).toBe(false);
    expect(fired).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// onDeath override — three outcomes
// ---------------------------------------------------------------------------

describe('RunPool — onDeath outcomes', () => {
  it("'destroyed' outcome from onDeath override (against 'park' pool)", () => {
    const pool = makePool({ deathPolicy: 'park' });
    const handle = pool.addInstance({
      id: 'x',
      step: deadStep,
      onDeath: () => 'destroyed',
    });
    handle.step();
    expect(pool.instances.value).toEqual([]);
  });

  it("'parked' outcome from onDeath override (against 'destroy' pool)", () => {
    const pool = makePool({ deathPolicy: 'destroy' });
    const handle = pool.addInstance({
      id: 'x',
      step: deadStep,
      onDeath: () => 'parked',
    });
    handle.step();
    expect(pool.instances.value).toEqual([handle]);
    expect(handle.alive.value).toBe(false);
  });

  it("'restartedWith' swaps the step in-place; alive stays true", () => {
    const pool = makePool({ deathPolicy: 'destroy' });
    let calls = 0;
    const firstStep: RunStep = () => {
      calls++;
      return false;
    };
    const replacement: RunStep = () => {
      calls++;
      return true;
    };
    const handle = pool.addInstance({
      id: 'x',
      step: firstStep,
      onDeath: () => ({ restartedWith: replacement }),
    });
    const events: string[] = [];
    pool.on('instance:died', () => events.push('died'));
    pool.on('instance:restarted', () => events.push('restarted'));

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
    const pool = makePool({ deathPolicy: 'park' });
    let fired = 0;
    pool.on('pool:reset', () => fired++);
    pool.reset();
    expect(fired).toBe(1);
  });

  it('handler can re-arm parked handles via handle.restart()', () => {
    const pool = makePool({ deathPolicy: 'park' });
    const a = pool.addInstance({ id: 'a', step: deadStep });
    const b = pool.addInstance({ id: 'b', step: deadStep });
    a.step();
    b.step();
    expect(a.alive.value).toBe(false);
    expect(b.alive.value).toBe(false);

    pool.on('pool:reset', () => {
      for (const h of pool.instances.value) h.restart(aliveStep);
    });
    pool.reset();

    expect(a.alive.value).toBe(true);
    expect(b.alive.value).toBe(true);
    expect(pool.liveCount.value).toBe(2);
  });

  it('handle.restart on a live handle is a no-op', () => {
    const pool = makePool({ deathPolicy: 'destroy' });
    const handle = pool.addInstance({ id: 'x', step: aliveStep });
    let fired = 0;
    pool.on('instance:restarted', () => fired++);
    handle.restart(aliveStep);
    expect(fired).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Firing-order invariants
// ---------------------------------------------------------------------------

describe('RunPool — firing-order invariants', () => {
  it("on instance:died('destroyed'): alive=false, handle still in instances.value", () => {
    const pool = makePool({ deathPolicy: 'destroy' });
    const handle = pool.addInstance({ id: 'x', step: deadStep });
    let observedAlive: boolean | null = null;
    let observedPresent: boolean | null = null;
    pool.on('instance:died', (h) => {
      observedAlive = h.alive.value;
      observedPresent = pool.instances.value.includes(h);
    });
    handle.step();
    expect(observedAlive).toBe(false);
    expect(observedPresent).toBe(true);
  });

  it("on instance:died('parked'): alive=false, handle still present", () => {
    const pool = makePool({ deathPolicy: 'park' });
    const handle = pool.addInstance({ id: 'x', step: deadStep });
    let observedAlive: boolean | null = null;
    let observedPresent: boolean | null = null;
    pool.on('instance:died', (h) => {
      observedAlive = h.alive.value;
      observedPresent = pool.instances.value.includes(h);
    });
    handle.step();
    expect(observedAlive).toBe(false);
    expect(observedPresent).toBe(true);
  });

  it('on instance:died(restartedWith): alive=true, handle still present', () => {
    const pool = makePool({ deathPolicy: 'destroy' });
    const handle = pool.addInstance({
      id: 'x',
      step: deadStep,
      onDeath: () => ({ restartedWith: aliveStep }),
    });
    let observedAlive: boolean | null = null;
    let observedOutcome: RunDeathOutcome | null = null;
    pool.on('instance:died', (h, o) => {
      observedAlive = h.alive.value;
      observedOutcome = o;
    });
    handle.step();
    expect(observedAlive).toBe(true);
    expect(observedOutcome).toEqual({ restartedWith: aliveStep });
  });

  it('on instance:removed: handle no longer in instances.value', () => {
    const pool = makePool({ deathPolicy: 'destroy' });
    const handle = pool.addInstance({ id: 'x', step: deadStep });
    let observedPresent: boolean | null = null;
    pool.on('instance:removed', (h) => {
      observedPresent = pool.instances.value.includes(h);
    });
    handle.step();
    expect(observedPresent).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Re-entrancy
// ---------------------------------------------------------------------------

describe('RunPool — re-entrancy', () => {
  it('addInstance from inside instance:died handler lands before instance:removed', () => {
    const pool = makePool({ deathPolicy: 'destroy' });
    const events: string[] = [];
    pool.on('instance:died', (h) => {
      events.push(`died:${h.id}`);
      if (h.id === 'a') {
        pool.addInstance({ id: 'b', step: aliveStep });
      }
    });
    pool.on('instance:added', (h) => events.push(`added:${h.id}`));
    pool.on('instance:removed', (h) => events.push(`removed:${h.id}`));

    const a = pool.addInstance({ id: 'a', step: deadStep });
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
    const pool = makePool({ deathPolicy: 'destroy' });
    const handle = pool.addInstance({
      id: 'x',
      step: () => {
        throw new Error('boom');
      },
    });
    expect(() => handle.step()).toThrow('boom');
    expect(handle.alive.value).toBe(true);
    expect(pool.instances.value).toEqual([handle]);
  });

  it('pool.reset during a step is synchronous and safe', () => {
    const pool = makePool({ deathPolicy: 'park' });
    let resetFired = 0;
    pool.on('pool:reset', () => resetFired++);
    const handle = pool.addInstance({
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
    const pool = makePool({ deathPolicy: 'destroy' });
    const handle = pool.addInstance({ id: 'x', step: aliveStep });
    handle.destroy();
    let fired = 0;
    pool.on('instance:removed', () => fired++);
    handle.destroy(); // second call
    expect(fired).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Reactivity
// ---------------------------------------------------------------------------

describe('RunPool — reactivity', () => {
  it('liveCount reacts to step-death and restart', () => {
    const pool = makePool({ deathPolicy: 'park' });
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

    const h = pool.addInstance({ id: 'x', step: deadStep });
    h.step(); // park
    h.restart(aliveStep);

    // Sequence: initial 0, after add 1, after step 0, after restart 1.
    expect(observed).toEqual([0, 1, 0, 1]);
    scope.stop();
  });

  it('watchEffect on instances.value fires on add/remove', () => {
    const pool = makePool({ deathPolicy: 'destroy' });
    let runs = 0;
    const scope = effectScope();
    scope.run(() => {
      watchEffect(
        () => {
          void pool.instances.value;
          runs++;
        },
        { flush: 'sync' },
      );
    });
    const initial = runs;

    pool.addInstance({ id: 'a', step: aliveStep });
    pool.addInstance({ id: 'b', step: aliveStep });
    pool.removeInstance('a');

    expect(runs - initial).toBeGreaterThanOrEqual(3);
    scope.stop();
  });
});
