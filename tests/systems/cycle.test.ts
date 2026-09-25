import { describe, it, expect } from 'vitest';
import { bn } from '@/primitives/decimal';
import { Decimal } from '@/primitives/decimal';
import { createResource, addResource } from '@/core/resource';
import { persistent, beginPersistentContext, endPersistentContext } from '@/core/persistence';
import { createCycle } from '@/systems/cycle';
import { createReset } from '@/systems/reset';
import { fractional } from '@/systems/retention';

/** Simple tick manager matching the action test pattern */
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

describe('createCycle', () => {
  it('initializes with zero count and Infinity bestTime', () => {
    const { registerTick } = createTickManager();
    const cycle = createCycle({
      thingsToReset: [],
      registerTick,
    });
    expect(cycle.count.value).toBe(0);
    expect(cycle.bestTime.value).toBe(Infinity);
    expect(cycle.elapsed.value).toBe(0);
    expect(cycle.running.value).toBe(false);
  });

  it('tracks elapsed time while running', () => {
    const { registerTick, tick } = createTickManager();
    const cycle = createCycle({
      thingsToReset: [],
      registerTick,
    });
    cycle.run();
    tick(0.5);
    tick(0.5);
    expect(cycle.elapsed.value).toBeCloseTo(1.0);
  });

  it('does not tick while paused', () => {
    const { registerTick, tick } = createTickManager();
    const cycle = createCycle({
      thingsToReset: [],
      registerTick,
    });
    cycle.run();
    tick(1);
    cycle.pause();
    tick(1);
    expect(cycle.elapsed.value).toBeCloseTo(1.0);
  });

  it('manual end() increments count and resets elapsed', () => {
    const { registerTick, tick } = createTickManager();
    const cycle = createCycle({
      thingsToReset: [],
      registerTick,
    });
    cycle.run();
    tick(5);
    const result = cycle.end();
    expect(result).toBe(true);
    expect(cycle.count.value).toBe(1);
    expect(cycle.elapsed.value).toBe(0);
  });

  it('tracks bestTime across cycles', () => {
    const { registerTick, tick } = createTickManager();
    const cycle = createCycle({
      thingsToReset: [],
      registerTick,
    });
    cycle.run();

    // First cycle: 10 seconds
    tick(10);
    cycle.end();
    expect(cycle.bestTime.value).toBeCloseTo(10);

    // Second cycle: 3 seconds (new best)
    tick(3);
    cycle.end();
    expect(cycle.bestTime.value).toBeCloseTo(3);

    // Third cycle: 7 seconds (not a new best)
    tick(7);
    cycle.end();
    expect(cycle.bestTime.value).toBeCloseTo(3);
    expect(cycle.count.value).toBe(3);
  });

  it('resets persistent refs on end()', () => {
    const { registerTick } = createTickManager();
    beginPersistentContext('cycle-reset-test');
    const gold = createResource(bn(0), { id: 'Gold', displayName: 'Gold' });
    const level = persistent(1);
    endPersistentContext();

    addResource(gold, 500);
    level.value = 10;

    const cycle = createCycle({
      thingsToReset: [gold, level],
      registerTick,
    });
    cycle.end();

    expect(gold.value.eq(0)).toBe(true);
    expect(level.value).toBe(1);
  });

  it('calls onBeforeRestart before reset and onRestart after', () => {
    const { registerTick } = createTickManager();
    const order: string[] = [];

    beginPersistentContext('cycle-hooks-test');
    const pts = createResource(bn(0), { id: 'Points', displayName: 'Points' });
    endPersistentContext();
    addResource(pts, 100);

    const cycle = createCycle({
      thingsToReset: [pts],
      onBeforeRestart: () => {
        order.push('before');
        // pts should still have its value here
        expect(pts.value.eq(100)).toBe(true);
      },
      onRestart: () => {
        order.push('after');
        // pts should be reset by now
        expect(pts.value.eq(0)).toBe(true);
      },
      registerTick,
    });
    cycle.end();
    expect(order).toEqual(['before', 'after']);
  });

  it('cancels end() when onBeforeRestart returns false', () => {
    const { registerTick } = createTickManager();
    beginPersistentContext('cycle-cancel-test');
    const pts = createResource(bn(0), { id: 'Points', displayName: 'Points' });
    endPersistentContext();
    addResource(pts, 999);

    const cycle = createCycle({
      thingsToReset: [pts],
      onBeforeRestart: () => false,
      registerTick,
    });
    const result = cycle.end();
    expect(result).toBe(false);
    expect(cycle.count.value).toBe(0);
    expect(pts.value.eq(999)).toBe(true);
  });

  it('auto-ends when endCondition becomes true', () => {
    const { registerTick, tick } = createTickManager();
    let health = 100;

    beginPersistentContext('cycle-auto-end-test');
    const xp = persistent(0);
    endPersistentContext();
    xp.value = 50;

    const cycle = createCycle({
      endCondition: () => health <= 0,
      thingsToReset: [xp],
      registerTick,
    });
    cycle.run();

    // Tick without triggering end
    tick(1);
    expect(cycle.count.value).toBe(0);

    // Simulate health dropping to zero
    health = 0;
    tick(0.05);
    expect(cycle.count.value).toBe(1);
    expect(xp.value).toBe(0);
  });

  it('exposes underlying reset as escape hatch', () => {
    const { registerTick } = createTickManager();
    const cycle = createCycle({
      thingsToReset: [],
      registerTick,
    });
    expect(cycle.reset).toBeDefined();
    expect(typeof cycle.reset.reset).toBe('function');
  });

  it('dispose() unregisters the tick callback', () => {
    const { registerTick, tick } = createTickManager();
    const cycle = createCycle({
      thingsToReset: [],
      registerTick,
    });
    cycle.run();
    tick(1);
    expect(cycle.elapsed.value).toBeCloseTo(1);

    cycle.dispose();
    tick(1);
    expect(cycle.elapsed.value).toBeCloseTo(1); // unchanged
  });

  it('emits instance cycle events', () => {
    const { registerTick } = createTickManager();
    const events: string[] = [];

    const cycle = createCycle({
      thingsToReset: [],
      registerTick,
    });

    const unsub1 = cycle.on('beforeRestart', () => events.push('before'));
    const unsub2 = cycle.on('afterRestart', () => events.push('after'));

    cycle.end();
    expect(events).toEqual(['before', 'after']);

    unsub1();
    unsub2();
  });
});

describe('createCycle with resetModules', () => {
  it('resets module refs on end()', () => {
    const { registerTick, tick } = createTickManager();

    beginPersistentContext('cycle-rm-mod');
    const gold = persistent(0);
    const level = persistent(1);
    endPersistentContext();

    gold.value = 500;
    level.value = 10;

    const cycle = createCycle({
      resetModules: ['cycle-rm-mod'],
      registerTick,
    });

    cycle.run();
    tick(1);
    cycle.end();

    expect(gold.value).toBe(0);
    expect(level.value).toBe(1);
    expect(cycle.count.value).toBe(1);
  });

  it('inline keep preserves specific refs', () => {
    const { registerTick } = createTickManager();

    beginPersistentContext('cycle-rm-keep');
    const temp = persistent(0);
    const permanent = persistent(0);
    endPersistentContext();

    temp.value = 100;
    permanent.value = 42;

    const cycle = createCycle({
      resetModules: ['cycle-rm-keep'],
      keep: [permanent],
      registerTick,
    });

    cycle.end();
    expect(temp.value).toBe(0);
    expect(permanent.value).toBe(42);
  });

  it('inline retain applies transforms', () => {
    const { registerTick } = createTickManager();

    beginPersistentContext('cycle-rm-retain');
    const skill = createResource(bn(0), { id: 'Skill', displayName: 'Skill' });
    const xp = persistent(0);
    endPersistentContext();

    addResource(skill, 100);
    xp.value = 5000;

    const cycle = createCycle({
      resetModules: ['cycle-rm-retain'],
      retain: new Map([[skill, fractional(0.3)]]),
      registerTick,
    });

    cycle.end();
    expect(Decimal.eq(skill.value, 30)).toBe(true);
    expect(xp.value).toBe(0);
  });

  it('resolvedScope is accessible for composing into outer loops', () => {
    const { registerTick } = createTickManager();

    beginPersistentContext('cycle-rm-scope');
    const r = persistent(0);
    endPersistentContext();

    const cycle = createCycle({
      resetModules: ['cycle-rm-scope'],
      registerTick,
    });

    expect(cycle.resolvedScope.size).toBe(1);
    expect(cycle.resolvedScope.has(r)).toBe(true);
  });

  it('composable: outer loop inherits inner loop scope', () => {
    const { registerTick } = createTickManager();

    beginPersistentContext('cycle-rm-inner');
    const innerRef = persistent(0);
    endPersistentContext();

    beginPersistentContext('cycle-rm-outer');
    const outerRef = persistent(0);
    endPersistentContext();

    innerRef.value = 10;
    outerRef.value = 20;

    const innerLoop = createCycle({
      resetModules: ['cycle-rm-inner'],
      registerTick,
    });

    const outerLoop = createCycle({
      resetModules: [innerLoop, 'cycle-rm-outer'],
      registerTick,
    });

    outerLoop.end();
    expect(innerRef.value).toBe(0);
    expect(outerRef.value).toBe(0);
  });
});

describe('createCycle — reset composition', () => {
  it('drives a pre-built Reset passed via `reset`, ignoring the shorthand fields', () => {
    const { registerTick } = createTickManager();

    beginPersistentContext('cycle-provided-reset');
    const driven = persistent(0);
    const shorthand = persistent(0);
    endPersistentContext();

    driven.value = 7;
    shorthand.value = 7;

    const cycle = createCycle({
      reset: createReset({ thingsToReset: [driven] }),
      // Ignored — `reset` wins, so this ref survives.
      thingsToReset: [shorthand],
      registerTick,
    });

    expect(cycle.end()).toBe(true);
    expect(driven.value).toBe(0);
    expect(shorthand.value).toBe(7);
  });

  it('aborts the restart when the underlying Reset declines', () => {
    const { registerTick, tick } = createTickManager();

    beginPersistentContext('cycle-declining-reset');
    const tracked = persistent(0);
    endPersistentContext();
    tracked.value = 5;

    let allowReset = false;
    const cycle = createCycle({
      reset: createReset({
        thingsToReset: [tracked],
        onBeforeReset: () => allowReset,
      }),
      registerTick,
    });

    let restarts = 0;
    cycle.on('afterRestart', () => restarts++);

    cycle.run();
    tick(3);

    // Declined: no count, no bestTime, no afterRestart, elapsed untouched,
    // and the scope is left alone.
    expect(cycle.end()).toBe(false);
    expect(cycle.count.value).toBe(0);
    expect(cycle.bestTime.value).toBe(Infinity);
    expect(cycle.elapsed.value).toBeCloseTo(3);
    expect(tracked.value).toBe(5);
    expect(restarts).toBe(0);

    // Allowed: the same call now commits every part of the sequence.
    allowReset = true;
    expect(cycle.end()).toBe(true);
    expect(cycle.count.value).toBe(1);
    expect(cycle.bestTime.value).toBeCloseTo(3);
    expect(cycle.elapsed.value).toBe(0);
    expect(tracked.value).toBe(0);
    expect(restarts).toBe(1);
  });
});

describe('createCycle — listener re-entrancy', () => {
  it('refuses a restart re-entered from a beforeRestart listener', () => {
    const { registerTick, tick } = createTickManager();
    beginPersistentContext('cycle-reentry');
    const gold = createResource(bn(0), { id: 'Gold', displayName: 'Gold' });
    endPersistentContext();
    const cycle = createCycle({
      id: 'cycle-reentry',
      thingsToReset: [gold],
      registerTick,
    });

    let nested: boolean | undefined;
    let fired = false;
    cycle.on('beforeRestart', () => {
      if (fired) return;
      fired = true;
      nested = cycle.end();
    });
    let afterRestarts = 0;
    cycle.on('afterRestart', () => afterRestarts++);

    cycle.run();
    tick(7);
    expect(cycle.end()).toBe(true);

    // The nested end() zeroes `elapsed` before the outer reads it, so an
    // unrefused re-entry records a best time of 0 into a persistent ref.
    expect(nested).toBe(false);
    expect(cycle.count.value).toBe(1);
    expect(cycle.bestTime.value).toBe(7);
    expect(afterRestarts).toBe(1);
  });

  it('the cycle guard does not block its own inner reset', () => {
    const { registerTick, tick } = createTickManager();
    beginPersistentContext('cycle-reentry-inner');
    const gold = createResource(bn(0), { id: 'Gold', displayName: 'Gold' });
    endPersistentContext();
    const reset = createReset({ thingsToReset: [gold] });
    const cycle = createCycle({ id: 'cycle-reentry-inner', reset, registerTick });

    addResource(gold, 500);
    cycle.run();
    tick(3);

    expect(cycle.end()).toBe(true);
    expect(gold.value.eq(0)).toBe(true);
    expect(cycle.count.value).toBe(1);
  });
});
