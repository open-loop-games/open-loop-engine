import { describe, it, expect } from 'vitest';
import { bn } from '@/primitives/decimal';
import { Decimal } from '@/primitives/decimal';
import { createResource, addResource } from '@/core/resource';
import {
  persistent,
  beginPersistentContext,
  endPersistentContext,
  withPersistentContext,
  getAllPersistentRefs,
  serializePersistents,
  deserializePersistents,
} from '@/core/persistence';
import { createCycle } from '@/systems/cycle';
import { createReset } from '@/systems/reset';
import { fractional } from '@/systems/retention';
import { createManualTicks } from '../helpers/manual-ticks';

describe('createCycle', () => {
  it('initializes with zero count and Infinity bestTime', () => {
    const { registerTick } = createManualTicks();
    const cycle = createCycle({
      thingsToReset: [],
      registerTick,
    });
    expect(cycle.count.value).toBe(0);
    expect(cycle.bestTime.value).toBe(Infinity);
    expect(cycle.elapsed.value).toBe(0);
    expect(cycle.running.value).toBe(false);
  });

  it('a grant in an afterEnd listener counts toward cumulative; one in onEnd does not', () => {
    const { registerTick } = createManualTicks();
    beginPersistentContext('cycle-grant');
    const pp = createResource(bn(0), { id: 'Prestige', displayName: 'Prestige' });
    endPersistentContext();
    const cycle = createCycle({
      thingsToReset: [],
      onEnd: () => addResource(pp, 5),
      registerTick,
    });
    cycle.on('afterEnd', () => addResource(pp, 10));

    cycle.end();

    expect(Decimal.eq(pp.value, 15)).toBe(true);
    expect(Decimal.eq(pp.cumulative!.value, 10)).toBe(true);
  });

  it('pausing in an afterEnd listener dwells until run() is called', () => {
    const { registerTick, tick } = createManualTicks();
    const cycle = createCycle({
      thingsToReset: [],
      registerTick,
      endCondition: () => cycle.elapsed.value >= 3,
    });
    cycle.on('afterEnd', () => cycle.pause());

    cycle.resume();
    tick(3);

    expect(cycle.count.value).toBe(1);
    expect(cycle.running.value).toBe(false);
    expect(cycle.elapsed.value).toBe(0);

    tick(5);
    tick(5);
    expect(cycle.running.value).toBe(false);
    expect(cycle.elapsed.value).toBe(0);
    expect(cycle.count.value).toBe(1);

    cycle.resume();
    tick(1);
    expect(cycle.elapsed.value).toBeCloseTo(1);
  });

  it('a zero-length cycle does not record a best time', () => {
    const { registerTick, tick } = createManualTicks();
    const cycle = createCycle({ thingsToReset: [], registerTick });
    cycle.resume();
    tick(3);
    cycle.end();
    cycle.end(); // a double-clicked restart, no tick in between

    expect(cycle.count.value).toBe(2);
    expect(cycle.bestTime.value).toBe(3);
  });

  it('pauses when a restart its endCondition triggered is declined', () => {
    const { registerTick, tick } = createManualTicks();
    const reset = createReset({ thingsToReset: [], onBeforeReset: () => false });
    const cycle = createCycle({ reset, endCondition: () => true, registerTick });
    let beforeRestarts = 0;
    cycle.on('beforeEnd', () => beforeRestarts++);

    cycle.resume();
    for (let i = 0; i < 5; i++) tick(1);

    expect(beforeRestarts).toBe(1);
    expect(cycle.running.value).toBe(false);
    expect(cycle.count.value).toBe(0);
  });

  it('a declined manual end() leaves the cycle running', () => {
    const { registerTick } = createManualTicks();
    const reset = createReset({ thingsToReset: [], onBeforeReset: () => false });
    const cycle = createCycle({ reset, registerTick });
    cycle.resume();

    expect(cycle.end()).toBe(false);
    expect(cycle.running.value).toBe(true);
  });

  it('tracks elapsed time while running', () => {
    const { registerTick, tick } = createManualTicks();
    const cycle = createCycle({
      thingsToReset: [],
      registerTick,
    });
    cycle.resume();
    tick(0.5);
    tick(0.5);
    expect(cycle.elapsed.value).toBeCloseTo(1.0);
  });

  it('elapsed survives a save round trip, so a reloaded run keeps timing from where it was', () => {
    const { registerTick, tick } = createManualTicks();
    const cycle = createCycle({ id: 'cycle-elapsed-save', thingsToReset: [], registerTick });
    cycle.resume();
    tick(5);

    const refs = getAllPersistentRefs();
    const save = serializePersistents(refs);
    cycle.elapsed.value = 0;
    deserializePersistents(refs, save);
    expect(cycle.elapsed.value).toBe(5);

    tick(2);
    cycle.end();
    expect(cycle.bestTime.value).toBe(7);
  });

  it('a reset from another Reset naming the cycle module zeroes the run clock', () => {
    const { registerTick, tick } = createManualTicks();
    const cycle = withPersistentContext('cycle-run-clock', () =>
      createCycle({ thingsToReset: [], registerTick }),
    );
    cycle.resume();
    tick(3);
    cycle.end();
    tick(2);

    createReset({ resetPersistentContexts: ['cycle-run-clock'] }).reset();

    expect(cycle.elapsed.value).toBe(0);
    expect(cycle.count.value).toBe(1);
    expect(cycle.bestTime.value).toBe(3);
  });

  it('a reset covering the cycle context still records the best time', () => {
    const { registerTick, tick } = createManualTicks();
    const cycle = withPersistentContext('cycle-self-reset', () =>
      createCycle({ resetPersistentContexts: ['cycle-self-reset'], registerTick }),
    );
    cycle.resume();
    tick(3);
    cycle.end();
    expect(cycle.bestTime.value).toBe(3);
    expect(cycle.elapsed.value).toBe(0);
  });

  it('does not tick while paused', () => {
    const { registerTick, tick } = createManualTicks();
    const cycle = createCycle({
      thingsToReset: [],
      registerTick,
    });
    cycle.resume();
    tick(1);
    cycle.pause();
    tick(1);
    expect(cycle.elapsed.value).toBeCloseTo(1.0);
  });

  it('manual end() increments count and resets elapsed', () => {
    const { registerTick, tick } = createManualTicks();
    const cycle = createCycle({
      thingsToReset: [],
      registerTick,
    });
    cycle.resume();
    tick(5);
    const result = cycle.end();
    expect(result).toBe(true);
    expect(cycle.count.value).toBe(1);
    expect(cycle.elapsed.value).toBe(0);
  });

  it('tracks bestTime across cycles', () => {
    const { registerTick, tick } = createManualTicks();
    const cycle = createCycle({
      thingsToReset: [],
      registerTick,
    });
    cycle.resume();

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
    const { registerTick } = createManualTicks();
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

  it('calls onBeforeEnd before reset and onEnd after', () => {
    const { registerTick } = createManualTicks();
    const order: string[] = [];

    beginPersistentContext('cycle-hooks-test');
    const pts = createResource(bn(0), { id: 'Points', displayName: 'Points' });
    endPersistentContext();
    addResource(pts, 100);

    const cycle = createCycle({
      thingsToReset: [pts],
      onBeforeEnd: () => {
        order.push('before');
        // pts should still have its value here
        expect(pts.value.eq(100)).toBe(true);
      },
      onEnd: () => {
        order.push('after');
        // pts should be reset by now
        expect(pts.value.eq(0)).toBe(true);
      },
      registerTick,
    });
    cycle.end();
    expect(order).toEqual(['before', 'after']);
  });

  it('cancels end() when onBeforeEnd returns false', () => {
    const { registerTick } = createManualTicks();
    beginPersistentContext('cycle-cancel-test');
    const pts = createResource(bn(0), { id: 'Points', displayName: 'Points' });
    endPersistentContext();
    addResource(pts, 999);

    const cycle = createCycle({
      thingsToReset: [pts],
      onBeforeEnd: () => false,
      registerTick,
    });
    const result = cycle.end();
    expect(result).toBe(false);
    expect(cycle.count.value).toBe(0);
    expect(pts.value.eq(999)).toBe(true);
  });

  it('auto-ends when endCondition becomes true', () => {
    const { registerTick, tick } = createManualTicks();
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
    cycle.resume();

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
    const { registerTick } = createManualTicks();
    const cycle = createCycle({
      thingsToReset: [],
      registerTick,
    });
    expect(cycle.reset).toBeDefined();
    expect(typeof cycle.reset.reset).toBe('function');
  });

  it('dispose() unregisters the tick callback', () => {
    const { registerTick, tick } = createManualTicks();
    const cycle = createCycle({
      thingsToReset: [],
      registerTick,
    });
    cycle.resume();
    tick(1);
    expect(cycle.elapsed.value).toBeCloseTo(1);

    cycle.dispose();
    tick(1);
    expect(cycle.elapsed.value).toBeCloseTo(1); // unchanged
  });

  it('a cycle built with the id of a disposed one resumes its saved state', () => {
    const { registerTick, tick } = createManualTicks();
    const first = createCycle({ id: 'cycle-rebuild', thingsToReset: [], registerTick });
    first.resume();
    tick(2);
    first.end();
    tick(1);
    first.dispose();

    const second = createCycle({ id: 'cycle-rebuild', thingsToReset: [], registerTick });
    expect(second.count.value).toBe(1);
    expect(second.elapsed.value).toBeCloseTo(1);
  });

  it('emits instance cycle events', () => {
    const { registerTick } = createManualTicks();
    const events: string[] = [];

    const cycle = createCycle({
      thingsToReset: [],
      registerTick,
    });

    const unsub1 = cycle.on('beforeEnd', () => events.push('before'));
    const unsub2 = cycle.on('afterEnd', () => events.push('after'));

    cycle.end();
    expect(events).toEqual(['before', 'after']);

    unsub1();
    unsub2();
  });
});

describe('createCycle with resetPersistentContexts', () => {
  it('resets module refs on end()', () => {
    const { registerTick, tick } = createManualTicks();

    beginPersistentContext('cycle-rm-mod');
    const gold = persistent(0);
    const level = persistent(1);
    endPersistentContext();

    gold.value = 500;
    level.value = 10;

    const cycle = createCycle({
      resetPersistentContexts: ['cycle-rm-mod'],
      registerTick,
    });

    cycle.resume();
    tick(1);
    cycle.end();

    expect(gold.value).toBe(0);
    expect(level.value).toBe(1);
    expect(cycle.count.value).toBe(1);
  });

  it('inline keep preserves specific refs', () => {
    const { registerTick } = createManualTicks();

    beginPersistentContext('cycle-rm-keep');
    const temp = persistent(0);
    const permanent = persistent(0);
    endPersistentContext();

    temp.value = 100;
    permanent.value = 42;

    const cycle = createCycle({
      resetPersistentContexts: ['cycle-rm-keep'],
      keep: [permanent],
      registerTick,
    });

    cycle.end();
    expect(temp.value).toBe(0);
    expect(permanent.value).toBe(42);
  });

  it('inline retain applies transforms', () => {
    const { registerTick } = createManualTicks();

    beginPersistentContext('cycle-rm-retain');
    const skill = createResource(bn(0), { id: 'Skill', displayName: 'Skill' });
    const xp = persistent(0);
    endPersistentContext();

    addResource(skill, 100);
    xp.value = 5000;

    const cycle = createCycle({
      resetPersistentContexts: ['cycle-rm-retain'],
      retain: new Map([[skill, fractional(0.3)]]),
      registerTick,
    });

    cycle.end();
    expect(Decimal.eq(skill.value, 30)).toBe(true);
    expect(xp.value).toBe(0);
  });

  it('resolvedScope is accessible for composing into outer loops', () => {
    const { registerTick } = createManualTicks();

    beginPersistentContext('cycle-rm-scope');
    const r = persistent(0);
    endPersistentContext();

    const cycle = createCycle({
      resetPersistentContexts: ['cycle-rm-scope'],
      registerTick,
    });

    expect(cycle.resolvedScope.size).toBe(1);
    expect(cycle.resolvedScope.has(r)).toBe(true);
  });

  it('composable: outer loop inherits inner loop scope', () => {
    const { registerTick } = createManualTicks();

    beginPersistentContext('cycle-rm-inner');
    const innerRef = persistent(0);
    endPersistentContext();

    beginPersistentContext('cycle-rm-outer');
    const outerRef = persistent(0);
    endPersistentContext();

    innerRef.value = 10;
    outerRef.value = 20;

    const innerLoop = createCycle({
      resetPersistentContexts: ['cycle-rm-inner'],
      registerTick,
    });

    const outerLoop = createCycle({
      resetPersistentContexts: [innerLoop, 'cycle-rm-outer'],
      registerTick,
    });

    outerLoop.end();
    expect(innerRef.value).toBe(0);
    expect(outerRef.value).toBe(0);
  });
});

describe('createCycle — reset composition', () => {
  it('drives a pre-built Reset passed via `reset`, ignoring the shorthand fields', () => {
    const { registerTick } = createManualTicks();

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
    const { registerTick, tick } = createManualTicks();

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
    cycle.on('afterEnd', () => restarts++);

    cycle.resume();
    tick(3);

    // Declined: no count, no bestTime, no afterEnd, elapsed untouched,
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
  it('refuses a restart re-entered from a beforeEnd listener', () => {
    const { registerTick, tick } = createManualTicks();
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
    cycle.on('beforeEnd', () => {
      if (fired) return;
      fired = true;
      nested = cycle.end();
    });
    let afterRestarts = 0;
    cycle.on('afterEnd', () => afterRestarts++);

    cycle.resume();
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
    const { registerTick, tick } = createManualTicks();
    beginPersistentContext('cycle-reentry-inner');
    const gold = createResource(bn(0), { id: 'Gold', displayName: 'Gold' });
    endPersistentContext();
    const reset = createReset({ thingsToReset: [gold] });
    const cycle = createCycle({ id: 'cycle-reentry-inner', reset, registerTick });

    addResource(gold, 500);
    cycle.resume();
    tick(3);

    expect(cycle.end()).toBe(true);
    expect(gold.value.eq(0)).toBe(true);
    expect(cycle.count.value).toBe(1);
  });
});
