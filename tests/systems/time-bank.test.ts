import { describe, it, expect } from 'vitest';
import { ref } from 'vue';
import { createTimeBank, createBankedAcceleration, burstDischarge } from '@/systems/time-bank';
import { createTickDriver } from '@/core/tick-driver';

function probeDriver() {
  const driver = createTickDriver({ tickRate: 20 });
  let simSeconds = 0;
  driver.onTick((dt) => {
    simSeconds += dt;
  });
  return { driver, sim: () => simSeconds };
}

describe('createTimeBank — deposit / withdraw', () => {
  it('deposits and withdraws seconds, reporting actual amounts', () => {
    const bank = createTimeBank();
    expect(bank.deposit(100)).toBe(100);
    expect(bank.banked.value).toBe(100);
    expect(bank.withdraw(30)).toBe(30);
    expect(bank.banked.value).toBe(70);
  });

  it('withdraw is floored at the reservoir — never goes negative', () => {
    const bank = createTimeBank();
    bank.deposit(10);
    expect(bank.withdraw(25)).toBe(10);
    expect(bank.banked.value).toBe(0);
    expect(bank.withdraw(5)).toBe(0);
  });

  it('ignores non-positive deposits and withdrawals', () => {
    const bank = createTimeBank();
    expect(bank.deposit(-5)).toBe(0);
    expect(bank.withdraw(-5)).toBe(0);
    expect(bank.banked.value).toBe(0);
  });
});

describe('createTimeBank — earn efficiency & cap', () => {
  it('scales deposits by earnEfficiency', () => {
    const bank = createTimeBank({ earnEfficiency: 0.7 });
    expect(bank.deposit(100)).toBeCloseTo(70, 10);
    expect(bank.banked.value).toBeCloseTo(70, 10);
  });

  it('earnEfficiency accepts a getter for dynamic values', () => {
    const eff = ref(0.5);
    const bank = createTimeBank({ earnEfficiency: () => eff.value });
    bank.deposit(10);
    eff.value = 1;
    bank.deposit(10);
    expect(bank.banked.value).toBeCloseTo(15, 10);
  });

  it('hard-clamps at cap, reporting only the accepted amount', () => {
    const bank = createTimeBank({ cap: 60 });
    expect(bank.deposit(50)).toBe(50);
    expect(bank.deposit(50)).toBe(10);
    expect(bank.banked.value).toBe(60);
    // Spending frees headroom for new deposits.
    bank.withdraw(30);
    expect(bank.deposit(100)).toBe(30);
  });

  it('a lowered reactive cap does not confiscate an already-full bank on deposit', () => {
    const cap = ref(100);
    const bank = createTimeBank({ cap });
    bank.deposit(100);
    cap.value = 50;
    expect(bank.deposit(10)).toBe(0);
    expect(bank.banked.value).toBe(100);
  });
});

describe('createBankedAcceleration — spend loop', () => {
  it('startSpending boosts the driver; stopSpending restores the baseline', () => {
    const { driver } = probeDriver();
    const bank = createTimeBank();
    bank.deposit(100);
    const accel = createBankedAcceleration({ tickDriver: driver, bank, spendMultiplier: 10 });
    expect(accel.startSpending()).toBe(true);
    expect(driver.speedMultiplier).toBe(10);
    expect(accel.isSpending.value).toBe(true);
    accel.stopSpending();
    expect(driver.speedMultiplier).toBe(1);
    expect(accel.isSpending.value).toBe(false);
  });

  it('refuses to start on an empty bank or while already spending', () => {
    const { driver } = probeDriver();
    const bank = createTimeBank();
    const accel = createBankedAcceleration({ tickDriver: driver, bank, spendMultiplier: 10 });
    expect(accel.startSpending()).toBe(false);
    bank.deposit(100);
    expect(accel.startSpending()).toBe(true);
    expect(accel.startSpending()).toBe(false);
  });

  it('drains excess-only by default: 1 real second at 10x costs 9 banked seconds', () => {
    const { driver, sim } = probeDriver();
    const bank = createTimeBank();
    bank.deposit(100);
    const accel = createBankedAcceleration({ tickDriver: driver, bank, spendMultiplier: 10 });
    accel.startSpending();
    for (let i = 0; i < 20; i++) driver.tickRaw(0.05); // 1 real second
    expect(sim()).toBeCloseTo(10, 6); // 10 sim-seconds delivered
    expect(bank.banked.value).toBeCloseTo(100 - 9, 6); // paid only the excess
  });

  it('charges excess in real seconds over a non-1 baseline', () => {
    const { driver, sim } = probeDriver();
    driver.speedMultiplier = 2;
    const bank = createTimeBank();
    bank.deposit(100);
    const accel = createBankedAcceleration({ tickDriver: driver, bank, spendMultiplier: 5 });
    accel.startSpending();
    for (let i = 0; i < 20; i++) driver.tickRaw(0.05); // 1 real second
    expect(sim()).toBeCloseTo(10, 6); // 2x baseline × 5x boost
    expect(bank.banked.value).toBeCloseTo(100 - 4, 6); // (5 - 1) real seconds, not 8
  });

  it("drainMode 'full' charges the whole accelerated dt", () => {
    const { driver } = probeDriver();
    const bank = createTimeBank();
    bank.deposit(100);
    const accel = createBankedAcceleration({
      tickDriver: driver,
      bank,
      spendMultiplier: 10,
      drainMode: 'full',
    });
    accel.startSpending();
    for (let i = 0; i < 20; i++) driver.tickRaw(0.05); // 1 real second → 10 sim-seconds
    expect(bank.banked.value).toBeCloseTo(100 - 10, 6);
  });

  it('auto-stops at depletion and restores the baseline multiplier', () => {
    const { driver } = probeDriver();
    const bank = createTimeBank();
    bank.deposit(1); // ~2 ticks of excess at 10x (0.45/tick)
    const accel = createBankedAcceleration({ tickDriver: driver, bank, spendMultiplier: 10 });
    accel.startSpending();
    for (let i = 0; i < 10; i++) driver.tickRaw(0.05);
    expect(accel.isSpending.value).toBe(false);
    expect(driver.speedMultiplier).toBe(1);
    expect(bank.banked.value).toBe(0);
  });

  it('a closed gate suspends acceleration and drain without ending the spend', () => {
    const { driver, sim } = probeDriver();
    const bank = createTimeBank();
    bank.deposit(100);
    const gate = ref(true);
    const accel = createBankedAcceleration({
      tickDriver: driver,
      bank,
      spendMultiplier: 10,
      when: gate,
    });
    accel.startSpending();
    driver.tickRaw(0.05); // accelerated tick: 0.5 sim, drains 0.45
    gate.value = false;
    driver.tickRaw(0.05); // drains for the accelerated tick, then suspends
    const bankedAtSuspend = bank.banked.value;
    driver.tickRaw(0.05); // suspended: 1x, no drain
    driver.tickRaw(0.05);
    expect(bank.banked.value).toBe(bankedAtSuspend);
    expect(driver.speedMultiplier).toBe(1);
    expect(accel.isSpending.value).toBe(true);
    gate.value = true;
    driver.tickRaw(0.05); // re-arms 10x for the next tick
    driver.tickRaw(0.05); // accelerated again
    expect(driver.speedMultiplier).toBe(10);
    expect(bank.banked.value).toBeLessThan(bankedAtSuspend);
    expect(sim()).toBeGreaterThan(0);
  });

  it('composes over a non-1 baseline multiplier and restores it', () => {
    const { driver } = probeDriver();
    driver.speedMultiplier = 2;
    const bank = createTimeBank();
    bank.deposit(100);
    const accel = createBankedAcceleration({ tickDriver: driver, bank, spendMultiplier: 5 });
    accel.startSpending();
    expect(driver.speedMultiplier).toBe(10);
    accel.stopSpending();
    expect(driver.speedMultiplier).toBe(2);
  });

  it('bankLiveOverflow deposits dropped seconds, chaining any prior handler', () => {
    const { driver } = probeDriver();
    let prior = 0;
    driver.onDeltaOverflow = (d) => {
      prior += d;
    };
    const bank = createTimeBank();
    createBankedAcceleration({
      tickDriver: driver,
      bank,
      spendMultiplier: 10,
      bankLiveOverflow: true,
    });
    driver.tickRaw(3.5); // maxDeltaTime 1 → 2.5 dropped
    expect(bank.banked.value).toBeCloseTo(2.5, 6);
    expect(prior).toBeCloseTo(2.5, 6);
  });

  it('spending survives a speed-independent burst mid-spend (verbs compose)', () => {
    const { driver, sim } = probeDriver();
    const bank = createTimeBank();
    bank.deposit(100);
    const accel = createBankedAcceleration({ tickDriver: driver, bank, spendMultiplier: 10 });
    accel.startSpending();
    driver.tickRaw(0.05);
    const simulated = burstDischarge(bank, driver, { fraction: 0.5 });
    // Burst replays wall-clock faithful — no speedMultiplier applied.
    expect(simulated).toBeCloseTo((100 - 0.45) / 2, 6);
    expect(accel.isSpending.value).toBe(true);
    expect(sim()).toBeCloseTo(0.5 + simulated, 6);
    // The replayed chunks must not be drained a second time by the spend loop.
    expect(bank.banked.value).toBeCloseTo((100 - 0.45) / 2, 6);
  });

  it('dispose detaches the tick handler and restores the driver', () => {
    const { driver } = probeDriver();
    const bank = createTimeBank();
    bank.deposit(100);
    const accel = createBankedAcceleration({ tickDriver: driver, bank, spendMultiplier: 10 });
    accel.startSpending();
    accel.dispose();
    expect(driver.speedMultiplier).toBe(1);
    expect(accel.isSpending.value).toBe(false);
    const before = bank.banked.value;
    driver.tickRaw(0.05);
    expect(bank.banked.value).toBe(before);
  });
});

describe('burstDischarge', () => {
  it('replays the whole bank through the driver by default', () => {
    const { driver, sim } = probeDriver();
    const bank = createTimeBank();
    bank.deposit(100);
    expect(burstDischarge(bank, driver)).toBeCloseTo(100, 6);
    expect(sim()).toBeCloseTo(100, 6);
    expect(bank.banked.value).toBe(0);
  });

  it('applies fraction to the withdrawal and efficiency to the replay', () => {
    const { driver, sim } = probeDriver();
    const bank = createTimeBank();
    bank.deposit(200);
    const simulated = burstDischarge(bank, driver, { fraction: 0.25, efficiency: 0.7 });
    expect(simulated).toBeCloseTo(200 * 0.25 * 0.7, 6);
    expect(sim()).toBeCloseTo(35, 6);
    expect(bank.banked.value).toBeCloseTo(150, 6);
  });

  it('is a no-op on an empty bank', () => {
    const { driver, sim } = probeDriver();
    const bank = createTimeBank();
    expect(burstDischarge(bank, driver)).toBe(0);
    expect(sim()).toBe(0);
  });

  it('is not clipped by the default 3-day offline cap', () => {
    const { driver, sim } = probeDriver();
    const bank = createTimeBank();
    bank.deposit(400000); // > 259200s default maxOfflineSeconds
    expect(burstDischarge(bank, driver)).toBeCloseTo(400000, 3);
    expect(sim()).toBeCloseTo(400000, 3);
  });
});
