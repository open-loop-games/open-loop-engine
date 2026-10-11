import { describe, it, expect } from 'vitest';
import { ref } from 'vue';
import { Decimal, type DecimalSource } from '@/primitives/decimal';
import {
  beginPersistentContext,
  endPersistentContext,
  getAllPersistentRefs,
  isPersistent,
} from '@/core/persistence';
import { createTimedProgress, resourcePaidAt, stepProgressiveCosts } from '@/core/timed-progress';

type TickFn = (dt: number) => void;

function makeTickBus() {
  const subs = new Set<TickFn>();
  const registerTick = (cb: TickFn) => {
    subs.add(cb);
    return () => {
      subs.delete(cb);
    };
  };
  const tick = (dt: number) => {
    for (const cb of subs) cb(dt);
  };
  return { registerTick, tick, size: () => subs.size };
}

describe('createTimedProgress — construction', () => {
  it('builds a tracker with default speed=1 and zeroed progress', () => {
    const bus = makeTickBus();
    const ctxId = 'tp-init';
    beginPersistentContext(ctxId);
    const tp = createTimedProgress({
      id: ctxId,
      needed: 10,
      registerTick: bus.registerTick,
    });
    endPersistentContext();

    expect(tp.id).toBe(ctxId);
    expect(Decimal.eq(tp.progress.value, 0)).toBe(true);
    expect(Decimal.eq(tp.tickProgressDelta.value, 0)).toBe(true);
    expect(tp.percentComplete.value).toBe(0);
  });

  it('auto-generates an id when none provided', () => {
    const bus = makeTickBus();
    const tp = createTimedProgress({
      needed: 10,
      ephemeral: true,
      registerTick: bus.registerTick,
    });
    expect(tp.id).toMatch(/^timedProgress_\d+$/);
    tp.dispose();
  });

  it('N parallel trackers under one ambient context do not collide', () => {
    // The factory's headline use is N parallel trackers built inside a module's
    // install(), which pushes an ambient persistent context. Each tracker's
    // distinct id must produce a distinct persistent context; collapsing them
    // all onto the ambient id makes the second tracker's 'progress' ref collide.
    const bus = makeTickBus();
    beginPersistentContext('module-install');
    const attack = createTimedProgress({
      id: 'attack',
      needed: 10,
      registerTick: bus.registerTick,
    });
    const defend = createTimedProgress({
      id: 'defend',
      needed: 10,
      registerTick: bus.registerTick,
    });
    endPersistentContext();

    expect(attack.id).toBe('attack');
    expect(defend.id).toBe('defend');
    attack.progress.value = 5;
    expect(Decimal.eq(defend.progress.value, 0)).toBe(true);
  });
});

describe('createTimedProgress — tick advancement', () => {
  it('accumulates progress at speed * dt each tick', () => {
    const bus = makeTickBus();
    const tp = createTimedProgress({
      needed: 100,
      rate: 5,
      ephemeral: true,
      registerTick: bus.registerTick,
    });

    bus.tick(1);
    expect(Decimal.eq(tp.progress.value, 5)).toBe(true);
    expect(Decimal.eq(tp.tickProgressDelta.value, 5)).toBe(true);

    bus.tick(2);
    expect(Decimal.eq(tp.progress.value, 15)).toBe(true);
    expect(Decimal.eq(tp.tickProgressDelta.value, 10)).toBe(true);

    tp.dispose();
  });

  it('honors reactive speed via getter', () => {
    const bus = makeTickBus();
    const spd = ref<DecimalSource>(2);
    const tp = createTimedProgress({
      needed: 100,
      rate: () => spd.value,
      ephemeral: true,
      registerTick: bus.registerTick,
    });

    bus.tick(1);
    expect(Decimal.eq(tp.progress.value, 2)).toBe(true);
    spd.value = 10;
    bus.tick(1);
    expect(Decimal.eq(tp.progress.value, 12)).toBe(true);
    tp.dispose();
  });

  it('zeroes tickProgressDelta and skips onProgress when speed <= 0', () => {
    const bus = makeTickBus();
    let calls = 0;
    const tp = createTimedProgress({
      needed: 100,
      rate: 0,
      ephemeral: true,
      registerTick: bus.registerTick,
      onProgress: () => {
        calls++;
      },
    });
    bus.tick(1);
    expect(Decimal.eq(tp.progress.value, 0)).toBe(true);
    expect(Decimal.eq(tp.tickProgressDelta.value, 0)).toBe(true);
    expect(calls).toBe(0);
    tp.dispose();
  });

  it('percentComplete reflects progress / duration clamped to [0,1]', () => {
    const bus = makeTickBus();
    const tp = createTimedProgress({
      needed: 10,
      rate: 1,
      ephemeral: true,
      registerTick: bus.registerTick,
    });
    bus.tick(5);
    expect(tp.percentComplete.value).toBeCloseTo(0.5);
    bus.tick(20); // overshoots
    expect(tp.percentComplete.value).toBe(1);
    tp.dispose();
  });
});

describe('createTimedProgress — onComplete boundary', () => {
  it('fires onComplete exactly once on the crossing tick with overflow', () => {
    const bus = makeTickBus();
    const completions: DecimalSource[] = [];
    const tp = createTimedProgress({
      needed: 10,
      rate: 4,
      ephemeral: true,
      registerTick: bus.registerTick,
      onComplete: (overflow) => completions.push(overflow),
    });

    bus.tick(1); // progress = 4
    bus.tick(1); // progress = 8
    expect(completions.length).toBe(0);
    bus.tick(1); // progress = 12, crosses duration
    expect(completions.length).toBe(1);
    expect(Decimal.eq(completions[0], 2)).toBe(true);
    tp.dispose();
  });

  it('does not re-fire onComplete on subsequent ticks when consumer parks progress past duration', () => {
    const bus = makeTickBus();
    let fires = 0;
    const tp = createTimedProgress({
      needed: 10,
      rate: 20,
      ephemeral: true,
      registerTick: bus.registerTick,
      onComplete: () => {
        fires++;
      },
    });
    bus.tick(1); // cross
    bus.tick(1); // already past duration — no crossing
    bus.tick(1);
    expect(fires).toBe(1);
    tp.dispose();
  });

  it('fires onComplete when the duration drops below progress between ticks', () => {
    const bus = makeTickBus();
    const duration = ref<DecimalSource>(10);
    let fires = 0;
    const tp = createTimedProgress({
      needed: () => duration.value,
      rate: 1,
      ephemeral: true,
      registerTick: bus.registerTick,
      onComplete: () => {
        fires++;
      },
    });
    for (let i = 0; i < 5; i++) bus.tick(1); // progress 5 of 10
    duration.value = 4; // an upgrade shortens the job past where it stands
    bus.tick(1);
    expect(fires).toBe(1);
    bus.tick(1); // parked past duration — no re-fire
    expect(fires).toBe(1);
    tp.dispose();
  });

  it('fires again after the duration grows past a parked progress and is crossed', () => {
    const bus = makeTickBus();
    const duration = ref<DecimalSource>(2);
    let fires = 0;
    const tp = createTimedProgress({
      needed: () => duration.value,
      ephemeral: true,
      registerTick: bus.registerTick,
      onComplete: () => {
        fires++;
      },
    });
    bus.tick(3); // 3 ≥ 2: fires, parks
    duration.value = 5;
    bus.tick(1); // 4 < 5
    bus.tick(1); // 5 ≥ 5: crosses again
    expect(fires).toBe(2);
    tp.dispose();
  });

  it('does not fire for progress written past duration from outside, as a save load does', () => {
    const bus = makeTickBus();
    let fires = 0;
    const tp = createTimedProgress({
      needed: 10,
      ephemeral: true,
      registerTick: bus.registerTick,
      onComplete: () => {
        fires++;
      },
    });
    bus.tick(1);
    tp.progress.value = 12; // a parked tracker restored from a save
    bus.tick(1);
    expect(fires).toBe(0);
    tp.dispose();
  });

  it('reset() clears progress so the next crossing fires again', () => {
    const bus = makeTickBus();
    let fires = 0;
    const tp = createTimedProgress({
      needed: 10,
      rate: 20,
      ephemeral: true,
      registerTick: bus.registerTick,
      onComplete: () => {
        fires++;
        tp.reset();
      },
    });
    bus.tick(1);
    bus.tick(1);
    bus.tick(1);
    expect(fires).toBe(3);
    tp.dispose();
  });

  it('fires onProgress on every advancing tick', () => {
    const bus = makeTickBus();
    const deltas: DecimalSource[] = [];
    const tp = createTimedProgress({
      needed: 100,
      rate: 3,
      ephemeral: true,
      registerTick: bus.registerTick,
      onProgress: (d) => deltas.push(d),
    });
    bus.tick(1);
    bus.tick(2);
    expect(deltas.length).toBe(2);
    expect(Decimal.eq(deltas[0], 3)).toBe(true);
    expect(Decimal.eq(deltas[1], 6)).toBe(true);
    tp.dispose();
  });
});

describe('createTimedProgress — reset and dispose', () => {
  it('reset() clears progress and tickProgressDelta', () => {
    const bus = makeTickBus();
    const tp = createTimedProgress({
      needed: 10,
      rate: 2,
      ephemeral: true,
      registerTick: bus.registerTick,
    });
    bus.tick(2);
    expect(Decimal.eq(tp.progress.value, 4)).toBe(true);
    tp.reset();
    expect(Decimal.eq(tp.progress.value, 0)).toBe(true);
    expect(Decimal.eq(tp.tickProgressDelta.value, 0)).toBe(true);
    tp.dispose();
  });

  it('dispose() unsubscribes from the tick loop', () => {
    const bus = makeTickBus();
    const tp = createTimedProgress({
      needed: 10,
      rate: 1,
      ephemeral: true,
      registerTick: bus.registerTick,
    });
    expect(bus.size()).toBe(1);
    tp.dispose();
    expect(bus.size()).toBe(0);
    bus.tick(5);
    expect(Decimal.eq(tp.progress.value, 0)).toBe(true);
  });

  it('dispose() keeps the saved progress, and a rebuild with the same id resumes it', () => {
    const bus = makeTickBus();
    beginPersistentContext('tp-recreate');
    try {
      const first = createTimedProgress({
        id: 'job',
        needed: 10,
        registerTick: bus.registerTick,
      });
      bus.tick(4);
      first.dispose();
      expect(getAllPersistentRefs().get('tp-recreate/job.progress')).toBe(first.progress);
      const second = createTimedProgress({
        id: 'job',
        needed: 10,
        registerTick: bus.registerTick,
      });
      expect(isPersistent(second.progress)).toBe(true);
      expect(Decimal.eq(second.progress.value, 4)).toBe(true);
      expect(getAllPersistentRefs().get('tp-recreate/job.progress')).toBe(second.progress);
      second.dispose();
    } finally {
      endPersistentContext();
    }
  });
});

describe('createTimedProgress — persistence', () => {
  it('ephemeral: true uses plain refs (not persistent)', () => {
    const bus = makeTickBus();
    const tp = createTimedProgress({
      needed: 10,
      ephemeral: true,
      registerTick: bus.registerTick,
    });
    expect(isPersistent(tp.progress)).toBe(false);
    tp.dispose();
  });

  it('default persists progress inside the ambient context', () => {
    const bus = makeTickBus();
    beginPersistentContext('tp-persist');
    const tp = createTimedProgress({
      id: 'tp-persist',
      needed: 10,
      registerTick: bus.registerTick,
    });
    endPersistentContext();
    expect(isPersistent(tp.progress)).toBe(true);
    tp.dispose();
  });
});

// ============================================================================
// stepProgressiveCosts
// ============================================================================

describe('stepProgressiveCosts — no costs', () => {
  it('advances to proposed with empty costs, never stalled unless proposed <= prev', () => {
    const step = stepProgressiveCosts({
      prevProgress: 3,
      proposedProgress: 7,
      needed: 10,
      costs: [],
    });
    expect(Decimal.eq(step.cappedProgress, 7)).toBe(true);
    expect(step.stalled).toBe(false);
    expect(step.deltas).toEqual([]);
  });

  it('stalls when proposed <= prev', () => {
    const step = stepProgressiveCosts({
      prevProgress: 5,
      proposedProgress: 5,
      needed: 10,
      costs: [],
    });
    expect(Decimal.eq(step.cappedProgress, 5)).toBe(true);
    expect(step.stalled).toBe(true);
  });
});

describe('stepProgressiveCosts — single cost', () => {
  it('advances full proposal when available covers the need', () => {
    const step = stepProgressiveCosts({
      prevProgress: 0,
      proposedProgress: 10,
      needed: 10,
      costs: [{ amount: 10, available: () => 10 }],
    });
    expect(Decimal.eq(step.cappedProgress, 10)).toBe(true);
    expect(step.stalled).toBe(false);
    expect(Decimal.eq(step.deltas[0], 10)).toBe(true);
  });

  it('caps progress when available is short of need', () => {
    // duration 10, cost.amount 10 → interval 1. prev=0, proposed=10 means
    // we wanted all 10 units but only 4 on hand → cap to progress 4.
    const step = stepProgressiveCosts({
      prevProgress: 0,
      proposedProgress: 10,
      needed: 10,
      costs: [{ amount: 10, available: () => 4 }],
    });
    expect(Decimal.eq(step.cappedProgress, 4)).toBe(true);
    expect(step.stalled).toBe(false);
    expect(Decimal.eq(step.deltas[0], 4)).toBe(true);
  });

  it('stalls when zero units affordable', () => {
    const step = stepProgressiveCosts({
      prevProgress: 2,
      proposedProgress: 5,
      needed: 10,
      costs: [{ amount: 10, available: () => 0 }],
    });
    // prevConsumed(2, 10, 10) = ceil(2/1) = 2; available=0 → maxProg=(2+0)*1=2
    expect(Decimal.eq(step.cappedProgress, 2)).toBe(true);
    expect(step.stalled).toBe(true);
    expect(Decimal.eq(step.deltas[0], 0)).toBe(true);
  });

  it('treats zero-amount costs as non-capping and produces zero delta', () => {
    const step = stepProgressiveCosts({
      prevProgress: 0,
      proposedProgress: 8,
      needed: 10,
      costs: [{ amount: 0, available: () => 0 }],
    });
    expect(Decimal.eq(step.cappedProgress, 8)).toBe(true);
    expect(step.stalled).toBe(false);
    expect(Decimal.eq(step.deltas[0], 0)).toBe(true);
  });

  it('does not over-request when available is fractional below 1', () => {
    // duration 10, amount 10, interval 1. Available is 0.7 — caller can spend
    // 0 whole units this tick. Pre-fix, maxUnits = 0 + 0.7 → maxProg = 0.7,
    // and ceil(0.7) bumped the delta to 1 unit (over-requesting by 0.3).
    const step = stepProgressiveCosts({
      prevProgress: 0,
      proposedProgress: 10,
      needed: 10,
      costs: [{ amount: 10, available: () => 0.7 }],
    });
    expect(Decimal.eq(step.cappedProgress, 0)).toBe(true);
    expect(step.stalled).toBe(true);
    expect(Decimal.eq(step.deltas[0], 0)).toBe(true);
  });

  it('writes integer-aligned cappedProgress at the partial-cost boundary', () => {
    // duration=300000, amount=150, available=149 → max units payable is 149,
    // and the integer threshold for 149 units is exactly 149/150 * 300000 =
    // 298000. Naive maxUnits * (duration / amount) computes (duration / amount)
    // as 2000.0000000000002 first, then 149 * 2000.0000000000002 = 298000.00000000006,
    // which lands state.progress just above the threshold. The next call sees
    // ceil(progress / interval) round up by one unit, splitting the
    // primitive's accounting from a re-call that passes raw number args.
    // Multiplying first keeps maxProg on the integer grid.
    const step = stepProgressiveCosts({
      prevProgress: 0,
      proposedProgress: 300000,
      needed: 300000,
      costs: [{ amount: 150, available: () => 149 }],
    });
    expect(Decimal.eq(step.cappedProgress, 298000)).toBe(true);
  });

  it('heals a prevProgress carrying a sub-epsilon float artifact', () => {
    // An already-broken save where state.progress was previously written just
    // above an integer threshold (e.g. 298000.00000000006 instead of 298000).
    // The consumer asks resourcePaidAt(state.progress, dur, amt) with raw
    // number args for dur/amt and gets the full cost as consumed; the
    // primitive must agree internally rather than wrapping dur/amt and
    // splitting its view by a fraction of a unit. The next tick advances
    // through to proposedProgress instead of stalling on a phantom missing
    // unit that no producer can resolve.
    const step = stepProgressiveCosts({
      prevProgress: 298000.00000000006,
      proposedProgress: 300000,
      needed: 300000,
      costs: [{ amount: 150, available: () => 0 }],
    });
    expect(step.stalled).toBe(false);
    expect(Decimal.eq(step.cappedProgress, 300000)).toBe(true);
  });

  it('caps to floor(available) when available is fractional above 1', () => {
    // duration 100, amount 10, interval 10. prev=5 → prevConsumed=1.
    // Available is 1.7; the caller can spend 1 whole unit. Pre-fix, maxUnits
    // = 1 + 1.7 = 2.7, maxProg = 27, and ceil pushed the delta to 2 units
    // (over-requesting by 0.7).
    const step = stepProgressiveCosts({
      prevProgress: 5,
      proposedProgress: 35,
      needed: 100,
      costs: [{ amount: 10, available: () => 1.7 }],
    });
    expect(Decimal.eq(step.cappedProgress, 20)).toBe(true);
    expect(step.stalled).toBe(false);
    expect(Decimal.eq(step.deltas[0], 1)).toBe(true);
  });
});

describe('stepProgressiveCosts — multiple costs', () => {
  it('caps at the tightest constraint', () => {
    // duration=100, proposed=60 from prev=40:
    //   wood amount=10, interval=10, available=5, prevConsumed=4 → maxProg=(4+5)*10=90 — no cap
    //   stone amount=20, interval=5, available=2, prevConsumed=ceil(40/5)=8 → maxProg=(8+2)*5=50 — caps to 50
    const step = stepProgressiveCosts({
      prevProgress: 40,
      proposedProgress: 60,
      needed: 100,
      costs: [
        { amount: 10, available: () => 5 },
        { amount: 20, available: () => 2 },
      ],
    });
    expect(Decimal.eq(step.cappedProgress, 50)).toBe(true);
    expect(step.stalled).toBe(false);
    // wood at 50: consumed(50,100,10)=5, prev=4, delta=1
    // stone at 50: consumed(50,100,20)=10, prev=8, delta=2
    expect(Decimal.eq(step.deltas[0], 1)).toBe(true);
    expect(Decimal.eq(step.deltas[1], 2)).toBe(true);
  });

  it('produces zero delta for a cost whose ceil threshold is not crossed', () => {
    // interval=10 (amount=10, dur=100). prev=51 has already consumed 6 units;
    // advancing to 52 stays within the same [51..60] interval → delta 0.
    const step = stepProgressiveCosts({
      prevProgress: 51,
      proposedProgress: 52,
      needed: 100,
      costs: [
        { amount: 10, available: () => 10 }, // prev consumed 6, would 6 → 0
        { amount: 100, available: () => 100 }, // interval 1 → prev 51, would 52 → 1
      ],
    });
    expect(Decimal.eq(step.cappedProgress, 52)).toBe(true);
    expect(Decimal.eq(step.deltas[0], 0)).toBe(true);
    expect(Decimal.eq(step.deltas[1], 1)).toBe(true);
  });

  it('order-independent capping', () => {
    const costsA = [
      { amount: 10, available: () => 5 },
      { amount: 20, available: () => 2 },
    ];
    const costsB = [
      { amount: 20, available: () => 2 },
      { amount: 10, available: () => 5 },
    ];
    const stepA = stepProgressiveCosts({
      prevProgress: 40,
      proposedProgress: 60,
      needed: 100,
      costs: costsA,
    });
    const stepB = stepProgressiveCosts({
      prevProgress: 40,
      proposedProgress: 60,
      needed: 100,
      costs: costsB,
    });
    expect(Decimal.eq(stepA.cappedProgress, stepB.cappedProgress)).toBe(true);
  });
});

describe('stepProgressiveCosts — invariant parity with resourcePaidAt', () => {
  it('each delta matches the consumedAt difference between prev and capped', () => {
    const costs = [
      { amount: 10, available: () => 5 },
      { amount: 20, available: () => 8 },
      { amount: 4, available: () => 3 },
    ];
    const step = stepProgressiveCosts({
      prevProgress: 12,
      proposedProgress: 45,
      needed: 100,
      costs,
    });
    for (let i = 0; i < costs.length; i++) {
      const before = resourcePaidAt(12, 100, costs[i].amount);
      const after = resourcePaidAt(step.cappedProgress, 100, costs[i].amount);
      const expected = Decimal.sub(after, before);
      expect(Decimal.eq(step.deltas[i], Decimal.max(expected, 0))).toBe(true);
    }
  });
});

describe('stepProgressiveCosts — calls available() lazily only once per entry', () => {
  it('does not invoke available() for zero-amount entries', () => {
    let calls = 0;
    stepProgressiveCosts({
      prevProgress: 0,
      proposedProgress: 5,
      needed: 10,
      costs: [
        {
          amount: 0,
          available: () => {
            calls++;
            return 0;
          },
        },
      ],
    });
    expect(calls).toBe(0);
  });

  it('invokes available() at most once per entry during capping', () => {
    let calls = 0;
    stepProgressiveCosts({
      prevProgress: 0,
      proposedProgress: 10,
      needed: 10,
      costs: [
        {
          amount: 10,
          available: () => {
            calls++;
            return 3; // tight enough to trigger capping
          },
        },
      ],
    });
    expect(calls).toBe(1);
  });
});

describe('stepProgressiveCosts — never requests more than the balance', () => {
  // `maxUnits · duration / amount` and resourcePaidAt's `progress / (duration / amount)`
  // round independently, so the cap can land a few ulps past the threshold where ceil
  // charges one unit more than the caller holds. Swept over the integer grid the
  // over-request showed up on, from a standing start and from a previous cap.
  function sweepCase(d: number, a: number, prev: DecimalSource, avail: number) {
    const step = stepProgressiveCosts({
      prevProgress: prev,
      proposedProgress: d,
      needed: d,
      costs: [{ amount: a, available: () => avail }],
    });
    const before = resourcePaidAt(prev, d, a);
    const after = resourcePaidAt(step.cappedProgress, d, a);
    return { step, before, after };
  }

  it('holds delta ≤ available, and spends every unit it can, across (duration, amount, available)', () => {
    const failures: string[] = [];
    for (let d = 1; d <= 40; d++) {
      for (let a = 1; a <= 40; a++) {
        for (let avail = 0; avail < a; avail++) {
          const first = sweepCase(d, a, 0, avail);
          const delta = first.step.deltas[0];
          if (delta.gt(avail) || !delta.eq(first.after.sub(first.before)) || !delta.eq(avail)) {
            failures.push(`d=${d} a=${a} avail=${avail} delta=${delta.toString()}`);
          }
          // Continue from the capped progress with one more unit on hand.
          const second = sweepCase(d, a, first.step.cappedProgress, 1);
          const delta2 = second.step.deltas[0];
          if (delta2.gt(1) || !delta2.eq(second.after.sub(second.before)) || !delta2.eq(1)) {
            failures.push(`d=${d} a=${a} avail=${avail}+1 delta=${delta2.toString()}`);
          }
        }
      }
    }
    expect(failures.slice(0, 5)).toEqual([]);
  });

  it('holds delta ≤ available tick by tick with Decimal durations and a trickling balance', () => {
    const failures: string[] = [];
    for (const d of [7, 10, 60, 100, 300, 1234.5]) {
      for (let a = 1; a <= 12; a++) {
        const duration = new Decimal(d);
        let stock = 0;
        let prog: DecimalSource = 0;
        for (let t = 0; t < 4000 && Decimal.lt(prog, duration); t++) {
          if (t % 41 === 0) stock += 1;
          const step = stepProgressiveCosts({
            prevProgress: prog,
            proposedProgress: Decimal.min(Decimal.add(prog, duration.div(97)), duration),
            needed: duration,
            costs: [{ amount: a, available: () => stock }],
          });
          if (step.deltas[0].gt(stock)) {
            failures.push(`d=${d} a=${a} t=${t} stock=${stock} delta=${step.deltas[0].toString()}`);
          }
          stock -= step.deltas[0].toNumber();
          if (!step.stalled) prog = step.cappedProgress;
        }
      }
    }
    expect(failures.slice(0, 5)).toEqual([]);
  });

  it('asks nothing of an empty balance when the cap lands on a threshold', () => {
    // incloneution's construction shape: prev 43.8 of 100 has consumed 3 of 6.
    const { step } = sweepCase(100, 6, 43.8, 0);
    expect(Decimal.eq(step.deltas[0], 0)).toBe(true);
  });
});
