import { describe, it, expect, vi } from 'vitest';
import { createTickDriver } from '@/core/tick-driver';
import { createSaveManager, createMemoryStorage } from '@/core/save-manager';

describe('TickDriver', () => {
  it('onTick registers callback', () => {
    const tickDriver = createTickDriver({ tickRate: 20 });
    const fn = vi.fn();
    tickDriver.onTick(fn);
    tickDriver.simulateTick(0.05);
    expect(fn).toHaveBeenCalledWith(0.05);
  });
  it('unsubscribe removes callback', () => {
    const tickDriver = createTickDriver({ tickRate: 20 });
    const fn = vi.fn();
    const unsub = tickDriver.onTick(fn);
    unsub();
    tickDriver.simulateTick(0.05);
    expect(fn).not.toHaveBeenCalled();
  });
  it('multiple callbacks called in order', () => {
    const tickDriver = createTickDriver({ tickRate: 20 });
    const order: number[] = [];
    tickDriver.onTick(() => order.push(1));
    tickDriver.onTick(() => order.push(2));
    tickDriver.simulateTick(0.05);
    expect(order).toEqual([1, 2]);
  });
  it('simulateTick clamps delta to maxDeltaTime', () => {
    const tickDriver = createTickDriver({ tickRate: 20, maxDeltaTime: 1 });
    const fn = vi.fn();
    tickDriver.onTick(fn);
    tickDriver.simulateTick(5);
    // Variable dt: single call with capped dt, not multiple fixed-step calls
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith(1);
  });
  it('simulateTick passes raw dt when under maxDeltaTime', () => {
    const tickDriver = createTickDriver({ tickRate: 20, maxDeltaTime: 1 });
    const fn = vi.fn();
    tickDriver.onTick(fn);
    tickDriver.simulateTick(0.3);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith(0.3);
  });
  it('stepOnce processes exactly one tick at tickInterval', () => {
    const tickDriver = createTickDriver({ tickRate: 10 });
    const fn = vi.fn();
    tickDriver.onTick(fn);
    tickDriver.stepOnce();
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith(0.1);
  });
  it('tickRate is mutable and updates tick interval', () => {
    const tickDriver = createTickDriver({ tickRate: 10 });
    const fn = vi.fn();
    tickDriver.onTick(fn);
    expect(tickDriver.tickRate).toBe(10);

    tickDriver.tickRate = 20;
    expect(tickDriver.tickRate).toBe(20);

    tickDriver.stepOnce();
    expect(fn).toHaveBeenCalledWith(0.05);
  });
  it('simulateTick does not apply speedMultiplier', () => {
    const tickDriver = createTickDriver({ tickRate: 20 });
    const fn = vi.fn();
    tickDriver.onTick(fn);
    tickDriver.speedMultiplier = 3;
    tickDriver.simulateTick(0.05);
    // dt should NOT be scaled by speedMultiplier
    expect(fn).toHaveBeenCalledWith(0.05);
  });
  it('stepOnce does not apply speedMultiplier', () => {
    const tickDriver = createTickDriver({ tickRate: 20 });
    const fn = vi.fn();
    tickDriver.onTick(fn);
    tickDriver.speedMultiplier = 2;
    tickDriver.stepOnce();
    expect(fn).toHaveBeenCalledWith(0.05);
  });
  it('speedMultiplier getter/setter', () => {
    const tickDriver = createTickDriver({ tickRate: 20 });
    expect(tickDriver.speedMultiplier).toBe(1);
    tickDriver.speedMultiplier = 5;
    expect(tickDriver.speedMultiplier).toBe(5);
  });
  it('speedMultiplier from config', () => {
    const tickDriver = createTickDriver({ tickRate: 20, speedMultiplier: 3 });
    expect(tickDriver.speedMultiplier).toBe(3);
  });
  it('deltaMean initializes to 0', () => {
    const tickDriver = createTickDriver({ tickRate: 20 });
    expect(tickDriver.deltaMean).toBe(0);
  });
  it('registerPhase tracks phase state', () => {
    const tickDriver = createTickDriver({ tickRate: 20 });
    let active = false;
    tickDriver.registerPhase('combat', {
      onEnter: () => {
        active = true;
      },
      onExit: () => {
        active = false;
      },
    });
    tickDriver.enterPhase('combat');
    expect(active).toBe(true);
    tickDriver.exitPhase('combat');
    expect(active).toBe(false);
  });
  it('timerProvider is used for scheduling', () => {
    const mockSetInterval = vi.fn().mockReturnValue(42);
    const mockClearInterval = vi.fn();
    const tickDriver = createTickDriver({
      tickRate: 20,
      timerProvider: {
        setInterval: mockSetInterval,
        clearInterval: mockClearInterval,
      },
    });
    tickDriver.start();
    expect(mockSetInterval).toHaveBeenCalledTimes(1);
    expect(mockSetInterval).toHaveBeenCalledWith(expect.any(Function), 50);
    tickDriver.stop();
    expect(mockClearInterval).toHaveBeenCalledWith(42);
  });
  it('changing tickRate restarts interval when running', () => {
    const mockSetInterval = vi.fn().mockReturnValue(1);
    const mockClearInterval = vi.fn();
    const tickDriver = createTickDriver({
      tickRate: 20,
      timerProvider: {
        setInterval: mockSetInterval,
        clearInterval: mockClearInterval,
      },
    });
    tickDriver.start();
    expect(mockSetInterval).toHaveBeenCalledTimes(1);

    tickDriver.tickRate = 10;
    // Should have cleared old interval and started new one
    expect(mockClearInterval).toHaveBeenCalledTimes(1);
    expect(mockSetInterval).toHaveBeenCalledTimes(2);
    expect(mockSetInterval).toHaveBeenLastCalledWith(expect.any(Function), 100);

    tickDriver.stop();
  });

  it('intervalTick fires onDeltaOverflow with dropped seconds when rawDt exceeds maxDeltaTime', () => {
    let scheduledCallback: (() => void) | null = null;
    const mockSetInterval = vi.fn((cb: () => void) => {
      scheduledCallback = cb;
      return 1;
    });
    const onOverflow = vi.fn();
    const tickDriver = createTickDriver({
      tickRate: 20,
      maxDeltaTime: 1,
      onDeltaOverflow: onOverflow,
      timerProvider: { setInterval: mockSetInterval, clearInterval: vi.fn() },
    });
    tickDriver.onTick(() => {});

    const nowSpy = vi.spyOn(performance, 'now');
    nowSpy.mockReturnValue(0);
    tickDriver.start();
    nowSpy.mockReturnValue(5000); // 5 s real elapsed, 1 s cap → 4 s dropped.
    scheduledCallback!();

    expect(onOverflow).toHaveBeenCalledTimes(1);
    expect(onOverflow).toHaveBeenCalledWith(4);

    tickDriver.stop();
    nowSpy.mockRestore();
  });

  it('intervalTick does not fire onDeltaOverflow when rawDt is within maxDeltaTime', () => {
    let scheduledCallback: (() => void) | null = null;
    const mockSetInterval = vi.fn((cb: () => void) => {
      scheduledCallback = cb;
      return 1;
    });
    const onOverflow = vi.fn();
    const tickDriver = createTickDriver({
      tickRate: 20,
      maxDeltaTime: 1,
      onDeltaOverflow: onOverflow,
      timerProvider: { setInterval: mockSetInterval, clearInterval: vi.fn() },
    });
    tickDriver.onTick(() => {});

    const nowSpy = vi.spyOn(performance, 'now');
    nowSpy.mockReturnValue(0);
    tickDriver.start();
    nowSpy.mockReturnValue(100); // 0.1 s, well under the 1 s cap.
    scheduledCallback!();

    expect(onOverflow).not.toHaveBeenCalled();

    tickDriver.stop();
    nowSpy.mockRestore();
  });

  it('onDeltaOverflow is live-settable after tickDriver creation', () => {
    let scheduledCallback: (() => void) | null = null;
    const mockSetInterval = vi.fn((cb: () => void) => {
      scheduledCallback = cb;
      return 1;
    });
    const tickDriver = createTickDriver({
      tickRate: 20,
      maxDeltaTime: 1,
      timerProvider: { setInterval: mockSetInterval, clearInterval: vi.fn() },
    });
    tickDriver.onTick(() => {});
    const fn = vi.fn();
    tickDriver.onDeltaOverflow = fn;

    const nowSpy = vi.spyOn(performance, 'now');
    nowSpy.mockReturnValue(0);
    tickDriver.start();
    nowSpy.mockReturnValue(3000);
    scheduledCallback!();

    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith(2);

    tickDriver.stop();
    nowSpy.mockRestore();
  });
});

describe('TickDriver — fixed mode (accumulator)', () => {
  it('simulateTick drains the accumulator at stepSize', () => {
    const tickDriver = createTickDriver({
      tickRate: 50,
      tickMode: 'fixed',
      stepSize: 0.02,
    });
    const fn = vi.fn();
    tickDriver.onTick(fn);

    // 0.1 s of simulation at 0.02 stepSize = 5 sub-ticks.
    tickDriver.simulateTick(0.1);
    expect(fn).toHaveBeenCalledTimes(5);
    expect(fn).toHaveBeenNthCalledWith(1, 0.02);
    expect(fn).toHaveBeenNthCalledWith(5, 0.02);
  });

  it('simulateTick banks sub-stepSize residual across calls', () => {
    const tickDriver = createTickDriver({
      tickMode: 'fixed',
      stepSize: 0.02,
    });
    const fn = vi.fn();
    tickDriver.onTick(fn);

    // 0.015 + 0.015 = 0.030 → 1 full sub-tick, 0.010 left banked.
    tickDriver.simulateTick(0.015);
    expect(fn).toHaveBeenCalledTimes(0);
    tickDriver.simulateTick(0.015);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith(0.02);
  });

  it('simulateTick is NOT bounded by maxStepsPerTick (offline is upstream-bounded)', () => {
    const tickDriver = createTickDriver({
      tickMode: 'fixed',
      stepSize: 0.02,
      maxStepsPerTick: 10, // Deliberately low to prove simulateTick ignores it.
    });
    const fn = vi.fn();
    tickDriver.onTick(fn);

    // 1 second / 0.02 stepSize = 50 sub-ticks — far more than maxStepsPerTick.
    tickDriver.simulateTick(1);
    expect(fn).toHaveBeenCalledTimes(50);
  });

  it('simulateTick does not apply speedMultiplier in fixed mode', () => {
    const tickDriver = createTickDriver({
      tickMode: 'fixed',
      stepSize: 0.02,
      speedMultiplier: 5,
    });
    const fn = vi.fn();
    tickDriver.onTick(fn);

    tickDriver.simulateTick(0.1);
    // Wall-clock faithful: 0.1 / 0.02 = 5 sub-ticks, NOT 25.
    expect(fn).toHaveBeenCalledTimes(5);
  });

  it('stepOnce uses stepSize in fixed mode', () => {
    const tickDriver = createTickDriver({
      tickRate: 50,
      tickMode: 'fixed',
      stepSize: 0.02,
    });
    const fn = vi.fn();
    tickDriver.onTick(fn);
    tickDriver.stepOnce();
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith(0.02);
  });

  it('stepOnce defaults stepSize to 1/tickRate in fixed mode without explicit stepSize', () => {
    const tickDriver = createTickDriver({ tickRate: 50, tickMode: 'fixed' });
    const fn = vi.fn();
    tickDriver.onTick(fn);
    tickDriver.stepOnce();
    expect(fn).toHaveBeenCalledWith(0.02);
  });

  it('intervalTick drains the accumulator and scales by speedMultiplier', () => {
    let scheduledCallback: (() => void) | null = null;
    const mockSetInterval = vi.fn((cb: () => void) => {
      scheduledCallback = cb;
      return 1;
    });
    const tickDriver = createTickDriver({
      tickMode: 'fixed',
      stepSize: 0.02,
      speedMultiplier: 10,
      timerProvider: {
        setInterval: mockSetInterval,
        clearInterval: vi.fn(),
      },
    });
    const fn = vi.fn();
    tickDriver.onTick(fn);

    const nowSpy = vi.spyOn(performance, 'now');
    nowSpy.mockReturnValue(0);
    tickDriver.start();
    // 50 ms real elapsed, 10× speed = 0.5 s effective → 25 sub-ticks at 0.02 each.
    nowSpy.mockReturnValue(50);
    scheduledCallback!();
    expect(fn).toHaveBeenCalledTimes(25);
    expect(fn).toHaveBeenCalledWith(0.02);

    tickDriver.stop();
    nowSpy.mockRestore();
  });

  it('intervalTick drops residual above maxStepsPerTick and fires onStepsOverflow', () => {
    let scheduledCallback: (() => void) | null = null;
    const mockSetInterval = vi.fn((cb: () => void) => {
      scheduledCallback = cb;
      return 1;
    });
    const onOverflow = vi.fn();
    const tickDriver = createTickDriver({
      tickMode: 'fixed',
      stepSize: 0.02,
      maxStepsPerTick: 10,
      speedMultiplier: 100, // 50 ms real × 100 = 5 s effective → 250 sub-ticks uncapped.
      maxDeltaTime: 10, // Keep raw-dt cap out of the way.
      onStepsOverflow: onOverflow,
      timerProvider: {
        setInterval: mockSetInterval,
        clearInterval: vi.fn(),
      },
    });
    const fn = vi.fn();
    tickDriver.onTick(fn);

    const nowSpy = vi.spyOn(performance, 'now');
    nowSpy.mockReturnValue(0);
    tickDriver.start();
    nowSpy.mockReturnValue(50);
    scheduledCallback!();

    // Capped at 10 sub-ticks, 240 dropped.
    expect(fn).toHaveBeenCalledTimes(10);
    expect(onOverflow).toHaveBeenCalledTimes(1);
    expect(onOverflow).toHaveBeenCalledWith(240);

    tickDriver.stop();
    nowSpy.mockRestore();
  });

  it('onStepsOverflow is live-settable after tickDriver creation', () => {
    let scheduledCallback: (() => void) | null = null;
    const mockSetInterval = vi.fn((cb: () => void) => {
      scheduledCallback = cb;
      return 1;
    });
    const tickDriver = createTickDriver({
      tickMode: 'fixed',
      stepSize: 0.02,
      maxStepsPerTick: 10,
      speedMultiplier: 100,
      maxDeltaTime: 10,
      timerProvider: { setInterval: mockSetInterval, clearInterval: vi.fn() },
    });
    tickDriver.onTick(() => {});
    const fn = vi.fn();
    tickDriver.onStepsOverflow = fn;

    const nowSpy = vi.spyOn(performance, 'now');
    nowSpy.mockReturnValue(0);
    tickDriver.start();
    nowSpy.mockReturnValue(50);
    scheduledCallback!();

    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith(240);

    tickDriver.stop();
    nowSpy.mockRestore();
  });

  it('intervalTick does not fire onStepsOverflow when accumulator drains naturally', () => {
    let scheduledCallback: (() => void) | null = null;
    const mockSetInterval = vi.fn((cb: () => void) => {
      scheduledCallback = cb;
      return 1;
    });
    const onOverflow = vi.fn();
    const tickDriver = createTickDriver({
      tickMode: 'fixed',
      stepSize: 0.02,
      maxStepsPerTick: 100,
      onStepsOverflow: onOverflow,
      timerProvider: {
        setInterval: mockSetInterval,
        clearInterval: vi.fn(),
      },
    });
    tickDriver.onTick(() => {});

    const nowSpy = vi.spyOn(performance, 'now');
    nowSpy.mockReturnValue(0);
    tickDriver.start();
    nowSpy.mockReturnValue(50);
    scheduledCallback!();
    expect(onOverflow).not.toHaveBeenCalled();

    tickDriver.stop();
    nowSpy.mockRestore();
  });

  it('phase hooks do not interleave with sub-steps within a single drain', () => {
    const order: string[] = [];
    const tickDriver = createTickDriver({
      tickMode: 'fixed',
      stepSize: 0.02,
    });
    tickDriver.registerPhase('combat', {
      onEnter: () => order.push('enter'),
      onExit: () => order.push('exit'),
      onTick: () => order.push('phase-tick'),
    });
    tickDriver.onTick(() => order.push('tick'));

    tickDriver.enterPhase('combat');
    // 3 sub-ticks in a single drain.
    tickDriver.simulateTick(0.06);
    tickDriver.exitPhase('combat');

    expect(order).toEqual([
      'enter',
      'tick',
      'phase-tick',
      'tick',
      'phase-tick',
      'tick',
      'phase-tick',
      'exit',
    ]);
  });

  it('variable mode remains the default when tickMode is omitted', () => {
    const tickDriver = createTickDriver({ tickRate: 20, maxDeltaTime: 1 });
    const fn = vi.fn();
    tickDriver.onTick(fn);
    tickDriver.simulateTick(5);
    // Variable behavior: single capped call, not multiple sub-ticks.
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith(1);
  });

  it('fixed-mode accumulator round-trips through exportSave/importSave', () => {
    // Regression: the fixed-mode sub-step accumulator must be persistent so
    // `importSave` restores it. Observed via behavior — after
    // restoring a snapshot whose accumulator sits just below `stepSize`, a
    // follow-up `simulateTick(dt)` with `dt` that crosses the threshold must
    // still fire one sub-tick. A closure-local accumulator would instead
    // carry the post-snapshot remainder, shifting the threshold crossing.
    const tickDriver = createTickDriver({ tickMode: 'fixed', stepSize: 0.02, tickRate: 50 });
    const fn = vi.fn();
    tickDriver.onTick(fn);
    const mgr = createSaveManager({
      gameId: 'ol-672-tickDriver',
      storageAdapter: createMemoryStorage(),
    });

    // Accumulator 0.015 — below stepSize, no sub-tick yet.
    tickDriver.simulateTick(0.015);
    expect(fn).toHaveBeenCalledTimes(0);

    const snapshot = mgr.exportSave();

    // Forward path: 0.015 + 0.01 = 0.025 ≥ stepSize → one sub-tick, leave 0.005.
    tickDriver.simulateTick(0.01);
    expect(fn).toHaveBeenCalledTimes(1);

    // Restore. If the accumulator round-tripped, it's 0.015 again and the next
    // 0.01 tick fires another sub-tick (total 2). Without restore, it would be
    // 0.005 and the same 0.01 tick would leave 0.015 without firing (total 1).
    expect(mgr.importSave(snapshot).success).toBe(true);
    tickDriver.simulateTick(0.01);
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
