import { describe, it, expect } from 'vitest';
import { bn } from '@/primitives/decimal';
import { Decimal } from '@/primitives/decimal';
import { createResource, addResource } from '@/core/resource';
import { persistent, beginPersistentContext, endPersistentContext } from '@/core/persistence';
import { createLoop, LoopType, isLoop } from '@/systems/loop';
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

describe('createLoop', () => {
  it('initializes with zero count and Infinity bestTime', () => {
    const { registerTick } = createTickManager();
    const loop = createLoop({
      thingsToReset: [],
      registerTick,
    });
    expect(loop.count.value).toBe(0);
    expect(loop.bestTime.value).toBe(Infinity);
    expect(loop.elapsed.value).toBe(0);
    expect(loop.running.value).toBe(false);
    expect(loop.type).toBe(LoopType);
  });

  it('tracks elapsed time while running', () => {
    const { registerTick, tick } = createTickManager();
    const loop = createLoop({
      thingsToReset: [],
      registerTick,
    });
    loop.run();
    tick(0.5);
    tick(0.5);
    expect(loop.elapsed.value).toBeCloseTo(1.0);
  });

  it('does not tick while paused', () => {
    const { registerTick, tick } = createTickManager();
    const loop = createLoop({
      thingsToReset: [],
      registerTick,
    });
    loop.run();
    tick(1);
    loop.pause();
    tick(1);
    expect(loop.elapsed.value).toBeCloseTo(1.0);
  });

  it('manual end() increments count and resets elapsed', () => {
    const { registerTick, tick } = createTickManager();
    const loop = createLoop({
      thingsToReset: [],
      registerTick,
    });
    loop.run();
    tick(5);
    const result = loop.end();
    expect(result).toBe(true);
    expect(loop.count.value).toBe(1);
    expect(loop.elapsed.value).toBe(0);
  });

  it('tracks bestTime across loops', () => {
    const { registerTick, tick } = createTickManager();
    const loop = createLoop({
      thingsToReset: [],
      registerTick,
    });
    loop.run();

    // First loop: 10 seconds
    tick(10);
    loop.end();
    expect(loop.bestTime.value).toBeCloseTo(10);

    // Second loop: 3 seconds (new best)
    tick(3);
    loop.end();
    expect(loop.bestTime.value).toBeCloseTo(3);

    // Third loop: 7 seconds (not a new best)
    tick(7);
    loop.end();
    expect(loop.bestTime.value).toBeCloseTo(3);
    expect(loop.count.value).toBe(3);
  });

  it('resets persistent refs on end()', () => {
    const { registerTick } = createTickManager();
    beginPersistentContext('loop-reset-test');
    const gold = createResource(bn(0), { displayName: 'Gold' });
    const level = persistent(1);
    endPersistentContext();

    addResource(gold, 500);
    level.value = 10;

    const loop = createLoop({
      thingsToReset: [gold, level],
      registerTick,
    });
    loop.end();

    expect(gold.value.eq(0)).toBe(true);
    expect(level.value).toBe(1);
  });

  it('calls onBeforeRestart before reset and onRestart after', () => {
    const { registerTick } = createTickManager();
    const order: string[] = [];

    beginPersistentContext('loop-hooks-test');
    const pts = createResource(bn(0), { displayName: 'Points' });
    endPersistentContext();
    addResource(pts, 100);

    const loop = createLoop({
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
    loop.end();
    expect(order).toEqual(['before', 'after']);
  });

  it('cancels end() when onBeforeRestart returns false', () => {
    const { registerTick } = createTickManager();
    beginPersistentContext('loop-cancel-test');
    const pts = createResource(bn(0), { displayName: 'Points' });
    endPersistentContext();
    addResource(pts, 999);

    const loop = createLoop({
      thingsToReset: [pts],
      onBeforeRestart: () => false,
      registerTick,
    });
    const result = loop.end();
    expect(result).toBe(false);
    expect(loop.count.value).toBe(0);
    expect(pts.value.eq(999)).toBe(true);
  });

  it('auto-ends when endCondition becomes true', () => {
    const { registerTick, tick } = createTickManager();
    let health = 100;

    beginPersistentContext('loop-auto-end-test');
    const xp = persistent(0);
    endPersistentContext();
    xp.value = 50;

    const loop = createLoop({
      endCondition: () => health <= 0,
      thingsToReset: [xp],
      registerTick,
    });
    loop.run();

    // Tick without triggering end
    tick(1);
    expect(loop.count.value).toBe(0);

    // Simulate health dropping to zero
    health = 0;
    tick(0.05);
    expect(loop.count.value).toBe(1);
    expect(xp.value).toBe(0);
  });

  it('exposes underlying reset as escape hatch', () => {
    const { registerTick } = createTickManager();
    const loop = createLoop({
      thingsToReset: [],
      registerTick,
    });
    expect(loop.reset).toBeDefined();
    expect(typeof loop.reset.reset).toBe('function');
  });

  it('dispose() unregisters the tick callback', () => {
    const { registerTick, tick } = createTickManager();
    const loop = createLoop({
      thingsToReset: [],
      registerTick,
    });
    loop.run();
    tick(1);
    expect(loop.elapsed.value).toBeCloseTo(1);

    loop.dispose();
    tick(1);
    expect(loop.elapsed.value).toBeCloseTo(1); // unchanged
  });

  it('emits instance loop events', () => {
    const { registerTick } = createTickManager();
    const events: string[] = [];

    const loop = createLoop({
      thingsToReset: [],
      registerTick,
    });

    const unsub1 = loop.on('beforeRestart', () => events.push('before'));
    const unsub2 = loop.on('afterRestart', () => events.push('after'));

    loop.end();
    expect(events).toEqual(['before', 'after']);

    unsub1();
    unsub2();
  });

  it('isLoop type guard works', () => {
    const { registerTick } = createTickManager();
    const loop = createLoop({
      thingsToReset: [],
      registerTick,
    });
    expect(isLoop(loop)).toBe(true);
    expect(isLoop({})).toBe(false);
    expect(isLoop(null)).toBe(false);
  });
});

describe('createLoop with resetModules', () => {
  it('resets module refs on end()', () => {
    const { registerTick, tick } = createTickManager();

    beginPersistentContext('loop-rm-mod');
    const gold = persistent(0);
    const level = persistent(1);
    endPersistentContext();

    gold.value = 500;
    level.value = 10;

    const loop = createLoop({
      resetModules: ['loop-rm-mod'],
      registerTick,
    });

    loop.run();
    tick(1);
    loop.end();

    expect(gold.value).toBe(0);
    expect(level.value).toBe(1);
    expect(loop.count.value).toBe(1);
  });

  it('inline keep preserves specific refs', () => {
    const { registerTick } = createTickManager();

    beginPersistentContext('loop-rm-keep');
    const temp = persistent(0);
    const permanent = persistent(0);
    endPersistentContext();

    temp.value = 100;
    permanent.value = 42;

    const loop = createLoop({
      resetModules: ['loop-rm-keep'],
      keep: [permanent],
      registerTick,
    });

    loop.end();
    expect(temp.value).toBe(0);
    expect(permanent.value).toBe(42);
  });

  it('inline retain applies transforms', () => {
    const { registerTick } = createTickManager();

    beginPersistentContext('loop-rm-retain');
    const skill = createResource(bn(0), { displayName: 'Skill' });
    const xp = persistent(0);
    endPersistentContext();

    addResource(skill, 100);
    xp.value = 5000;

    const loop = createLoop({
      resetModules: ['loop-rm-retain'],
      retain: new Map([[skill, fractional(0.3)]]),
      registerTick,
    });

    loop.end();
    expect(Decimal.eq(skill.value, 30)).toBe(true);
    expect(xp.value).toBe(0);
  });

  it('resolvedScope is accessible for composing into outer loops', () => {
    const { registerTick } = createTickManager();

    beginPersistentContext('loop-rm-scope');
    const r = persistent(0);
    endPersistentContext();

    const loop = createLoop({
      resetModules: ['loop-rm-scope'],
      registerTick,
    });

    expect(loop.resolvedScope.size).toBe(1);
    expect(loop.resolvedScope.has(r)).toBe(true);
  });

  it('composable: outer loop inherits inner loop scope', () => {
    const { registerTick } = createTickManager();

    beginPersistentContext('loop-rm-inner');
    const innerRef = persistent(0);
    endPersistentContext();

    beginPersistentContext('loop-rm-outer');
    const outerRef = persistent(0);
    endPersistentContext();

    innerRef.value = 10;
    outerRef.value = 20;

    const innerLoop = createLoop({
      resetModules: ['loop-rm-inner'],
      registerTick,
    });

    const outerLoop = createLoop({
      resetModules: [innerLoop, 'loop-rm-outer'],
      registerTick,
    });

    outerLoop.end();
    expect(innerRef.value).toBe(0);
    expect(outerRef.value).toBe(0);
  });
});
