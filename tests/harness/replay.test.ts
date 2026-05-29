import { describe, it, expect, vi } from 'vitest';
import { createTickDriver } from '@/core/tick-driver';
import { replayLive, createTickCounter } from '@/harness/replay';

describe('replayLive', () => {
  it('fires floor(seconds * tickRate) interval ticks', async () => {
    const driver = createTickDriver({ tickRate: 20 });
    const fn = vi.fn();
    driver.onTick(fn);
    const ticks = await replayLive(driver, { seconds: 3 });
    expect(ticks).toBe(60);
    expect(fn).toHaveBeenCalledTimes(60);
  });

  it('clamps negative seconds to zero', async () => {
    const driver = createTickDriver({ tickRate: 20 });
    const fn = vi.fn();
    driver.onTick(fn);
    const ticks = await replayLive(driver, { seconds: -5 });
    expect(ticks).toBe(0);
    expect(fn).not.toHaveBeenCalled();
  });

  it('feeds tickInterval * speed per interval tick (variable mode)', async () => {
    const driver = createTickDriver({ tickRate: 20 });
    const dts: number[] = [];
    driver.onTick((dt) => dts.push(dt));
    await replayLive(driver, { seconds: 1, speed: 4 });
    // 20 interval ticks; tickRaw caps the raw interval (1/20 = 0.05 < maxDeltaTime)
    // then scales by speedMultiplier: dt = 0.05 * 4 = 0.2
    expect(dts).toHaveLength(20);
    for (const dt of dts) expect(dt).toBeCloseTo(0.2, 9);
  });

  it('sets driver.speedMultiplier during replay and restores it after', async () => {
    const driver = createTickDriver({ tickRate: 20, speedMultiplier: 3 });
    let observed = 0;
    driver.onTick(() => {
      observed = driver.speedMultiplier;
    });
    await replayLive(driver, { seconds: 0.1, speed: 7 });
    expect(observed).toBe(7); // applied via the live path during replay
    expect(driver.speedMultiplier).toBe(3); // prior value restored on exit
  });

  it('awaits afterTick between ticks', async () => {
    const driver = createTickDriver({ tickRate: 10 });
    const order: string[] = [];
    driver.onTick(() => order.push('tick'));
    await replayLive(driver, {
      seconds: 0.3,
      afterTick: () => {
        order.push('after');
      },
    });
    expect(order).toEqual(['tick', 'after', 'tick', 'after', 'tick', 'after']);
  });

  // The guarantee the helper exists to protect: in fixed mode, equal game-time
  // at different speeds drains the same total sub-tick count through identical
  // per-tick math. Pre-fix variable-dt drift produced ~10× divergence here.
  it('fixed mode: equal game-time at 1x and Nx yields equal sub-tick count', async () => {
    const GAME_SECONDS = 60;
    const SPEED = 20;

    const driver1 = createTickDriver({ tickRate: 50, tickMode: 'fixed', stepSize: 0.02 });
    const counter1 = createTickCounter(driver1);
    await replayLive(driver1, { seconds: GAME_SECONDS, speed: 1 });

    const driverN = createTickDriver({ tickRate: 50, tickMode: 'fixed', stepSize: 0.02 });
    const counterN = createTickCounter(driverN);
    await replayLive(driverN, { seconds: GAME_SECONDS / SPEED, speed: SPEED });

    expect(counterN.get()).toBe(counter1.get());
    // Sanity: 60s of game-time at 0.02s steps = 3000 sub-ticks.
    expect(counter1.get()).toBe(3000);
  });
});

describe('createTickCounter', () => {
  it('counts onTick fires, resets, and disposes', async () => {
    const driver = createTickDriver({ tickRate: 20 });
    const counter = createTickCounter(driver);

    await replayLive(driver, { seconds: 1 });
    expect(counter.get()).toBe(20);

    counter.reset();
    expect(counter.get()).toBe(0);

    counter.dispose();
    await replayLive(driver, { seconds: 1 });
    expect(counter.get()).toBe(0);
  });
});
