/**
 * Time bank — banked-time reservoir with acceleration and burst spend surfaces.
 *
 * The genre's fourth offline-progress family (after extrapolation, tick-sim,
 * and cap-and-trickle): absence — or dropped live time, or an explicit
 * consumer policy — accumulates into a spendable reservoir of seconds, spent
 * later as accelerated play. Three surfaces, layered so each spend shape
 * composes on the same core:
 *
 * - {@link createTimeBank} — the spend-agnostic reservoir: deposit (with an
 *   earn-efficiency factor and optional cap) and withdraw. Consumers with
 *   bespoke spend shapes (per-subsystem fast-tick such as stored
 *   cycles) wire `withdraw()` at their own cadence.
 * - {@link createBankedAcceleration} — the dominant corpus shape: toggle a live
 *   `TickDriver.speedMultiplier` boost, drain the bank per tick, auto-stop
 *   at depletion. Sessions always start unaccelerated.
 * - {@link burstDischarge} — the "stored time" shape:
 *   dump (a fraction of) the reservoir through `processOfflineTime` as one
 *   immediate fast-forward, optionally at an efficiency penalty.
 *
 * Earn *policy* — which elapsed time counts, log curves over offline excess,
 * borrow-against-future ledgers — stays consumer-side: compute seconds, call
 * `deposit()`. The one engine-owned earn source is `bankLiveOverflow` on the
 * acceleration wrapper, which banks the dropped seconds `TickDriver` reports
 * via `onDeltaOverflow` when a tab-hide outruns `maxDeltaTime`.
 *
 * Time is plain `number` seconds throughout, matching `TickDriver` dt,
 * `processOfflineTime`, and `createTimeSystem`.
 */

import { ref } from 'vue';
import type { Ref } from 'vue';
import {
  persistent,
  resolveSystemPersistentContextId,
  withPersistentContext,
} from '@/core/persistence';
import { attachPersistentContextReset } from '@/core/resettable';
import { resolveComputable, type Computable } from '@/core/computed';
import { processOfflineTime, type OfflineProgressOptions } from '@/core/offline';
import type { TickDriver } from '@/core/tick-driver';
import type { Persistent } from '@/core/persistence';
import { createPredicateResolver, type Predicate } from './gate';

// === TIME BANK ===

/** Configuration for {@link createTimeBank}. */
export interface TimeBankConfig {
  /**
   * Save context for the reservoir. Defaults to `${module}/time-bank` inside a
   * module; pass one when a module holds several banks (per-subsystem reserves).
   */
  id?: string;
  /**
   * Fraction of each deposit that lands in the bank (default 1). Corpus
   * range: 1, 0.7, 2/3.
   * Can be a ref or getter for dynamic values (upgradeable efficiency).
   */
  earnEfficiency?: Computable<number>;
  /**
   * Reservoir ceiling in seconds (default unlimited). Hard clamp — deposits
   * beyond it are discarded. Can be a ref or getter for dynamic values
   * (upgradeable caps).
   */
  cap?: Computable<number>;
}

/** Banked-time reservoir returned by {@link createTimeBank}. */
export interface TimeBank {
  /**
   * Banked seconds (persistent). Prefer `deposit`/`withdraw` over direct writes.
   *
   * Run-scoped, unlike most system-owned state: a reset naming the module
   * the bank was built in empties it. Whether banked time survives a
   * prestige is the game's call — pass `keep: [bank.banked]` to carry it.
   */
  banked: Persistent<number>;
  /**
   * Add seconds to the reservoir, scaled by `earnEfficiency` and clamped at
   * `cap`. Returns the seconds actually banked. Non-positive input is a no-op.
   */
  deposit(seconds: number): number;
  /**
   * Remove up to `seconds` from the reservoir. Returns the seconds actually
   * withdrawn (short when the reservoir runs dry). Non-positive input is a
   * no-op.
   */
  withdraw(seconds: number): number;
}

/**
 * Create a banked-time reservoir: a persistent pool of seconds earned by
 * consumer policy and spent through {@link createBankedAcceleration},
 * {@link burstDischarge}, or a bespoke consumer drain.
 *
 * @param config - Earn efficiency, cap, and persistent-context id.
 * @returns The reservoir with `deposit`/`withdraw` and the persistent
 *   `banked` ref.
 *
 * @example
 * ```ts
 * const bank = createTimeBank({ cap: () => toNumber(capUpgrade.effect.value) });
 * // on load, bank offline time instead of simulating it:
 * bank.deposit(offlineSeconds);
 * ```
 */
export function createTimeBank(config: TimeBankConfig = {}): TimeBank {
  const { earnEfficiency = 1, cap } = config;
  const bankContextId = resolveSystemPersistentContextId(config.id, 'time-bank');
  const banked = withPersistentContext(bankContextId, () =>
    persistent<number>(0, { name: 'banked' }),
  );

  const bank: TimeBank = {
    banked,
    deposit(seconds) {
      if (!(seconds > 0)) return 0;
      const earned = seconds * resolveComputable(earnEfficiency);
      const before = banked.value;
      const ceiling = cap === undefined ? Infinity : resolveComputable(cap);
      // max(before, …) so a cap lowered below the current balance only
      // blocks new deposits — it never confiscates already-banked time.
      const after = Math.max(before, Math.min(ceiling, before + earned));
      banked.value = after;
      return after - before;
    },
    withdraw(seconds) {
      if (!(seconds > 0)) return 0;
      const taken = Math.min(banked.value, seconds);
      banked.value -= taken;
      return taken;
    },
  };
  return attachPersistentContextReset(bank, bankContextId);
}

// === BANKED ACCELERATION ===

/** Configuration for {@link createBankedAcceleration}. */
export interface BankedAccelerationConfig {
  /** The driver whose `speedMultiplier` the spend loop owns while spending. */
  tickDriver: TickDriver;
  /** The reservoir the spend loop drains. */
  bank: TimeBank;
  /**
   * Speed factor applied on top of the driver's baseline multiplier while
   * spending (e.g. 10 for 10×). Can be a ref or getter for dynamic values —
   * a rate ladder re-resolves on the next tick.
   */
  spendMultiplier: Computable<number>;
  /**
   * What a tick of accelerated play costs the bank.
   * - `'excess'` (default) — only the boost beyond baseline, charged in real
   *   seconds: a spend at n× costs n − 1 banked seconds per real second,
   *   whatever the driver's baseline multiplier. The corpus-dominant
   *   conservation shape; real time is charged even while a challenge
   *   doubles game speed.
   * - `'full'` — the whole accelerated dt: banked seconds are raw sim-seconds
   *   delivered at speed. Deliberately lossier.
   */
  drainMode?: 'excess' | 'full';
  /**
   * Predicate re-resolved each tick; while false, acceleration and drain
   * suspend (driver back at baseline) without ending the spend. For "only
   * while actively playing" gates. A Gate resolves through the runtime
   * captured at `createBankedAcceleration` time.
   */
  gate?: Predicate;
  /**
   * When true, banks the seconds `TickDriver` drops when a tab-hide or hitch
   * outruns `maxDeltaTime`, by chaining onto `onDeltaOverflow`. The one
   * engine-owned earn source; everything else deposits explicitly.
   */
  bankLiveOverflow?: boolean;
}

/** Spend-loop handle returned by {@link createBankedAcceleration}. */
export interface BankedAcceleration {
  /**
   * Begin spending: boosts the driver to `baseline × spendMultiplier` and
   * drains the bank per tick until stopped or depleted. Returns false (and
   * does nothing) when the bank is empty or a spend is already running.
   */
  startSpending(): boolean;
  /** End the spend and restore the driver's baseline multiplier. No-op when idle. */
  stopSpending(): void;
  /**
   * Whether a spend is running. Deliberately transient, never persisted —
   * sessions always start unaccelerated (corpus-universal invariant).
   */
  isSpending: Ref<boolean>;
  /** Detach the tick handler and overflow chain, ending any running spend. */
  dispose(): void;
}

/**
 * The live-multiplier spend loop over a {@link TimeBank}: toggle a speed
 * boost on the TickDriver, pay for it from the bank each tick, auto-stop at
 * depletion. The wrapper owns `tickDriver.speedMultiplier` while a spend is
 * running; the baseline is captured at `startSpending` and restored on stop.
 *
 * @param config - Driver + bank wiring, spend multiplier, drain accounting,
 *   optional gate and live-overflow banking.
 * @returns Start/stop controls, the transient `isSpending` flag, and
 *   `dispose()`.
 *
 * @example
 * ```ts
 * const bank = createTimeBank();
 * const accel = createBankedAcceleration({
 *   tickDriver: engine.tickDriver,
 *   bank,
 *   spendMultiplier: () => rateLadder[selectedRate.value],
 *   bankLiveOverflow: true,
 * });
 * bank.deposit(offlineSeconds); // on load, instead of simulating
 * accel.startSpending();        // player toggles the boost
 * ```
 */
export function createBankedAcceleration(config: BankedAccelerationConfig): BankedAcceleration {
  const { tickDriver, bank, spendMultiplier, drainMode = 'excess', gate } = config;
  const spendGate = createPredicateResolver().adopt(gate, true, 'createBankedAcceleration gate');

  const isSpending = ref(false);
  let baseline = 1;
  // The bonus factor the driver is currently scaled by beyond baseline —
  // tracked closure-side so drain math never re-derives it from the driver.
  let appliedBonus = 1;

  function applyBonus(bonus: number): void {
    appliedBonus = bonus;
    tickDriver.speedMultiplier = baseline * bonus;
  }

  function stopSpending(): void {
    if (!isSpending.value) return;
    applyBonus(1);
    isSpending.value = false;
  }

  const offTick = tickDriver.onTick((dt) => {
    // A burst replay's simulated chunks reach this handler like live dt, but
    // that time was already paid for by the burst's withdraw — draining it
    // again would double-charge. (A consumer-initiated raw processOfflineTime
    // mid-spend has the same hazard; stop the spend around it.)
    if (!isSpending.value || burstInFlight) return;
    // Pay for the tick that just ran at appliedBonus. dt arrives already
    // scaled by baseline × appliedBonus, so the real seconds it covers are
    // dt / (baseline × appliedBonus).
    if (appliedBonus > 1) {
      const excess = baseline > 0 ? (dt * (appliedBonus - 1)) / (baseline * appliedBonus) : 0;
      const drain = drainMode === 'full' ? dt : excess;
      const paid = bank.withdraw(drain);
      if (paid < drain) {
        stopSpending();
        return;
      }
    }
    // Arm the factor for the next tick: gate suspension and reactive
    // spendMultiplier changes take effect one tick later.
    const open = spendGate.read();
    applyBonus(open ? resolveComputable(spendMultiplier) : 1);
  });

  let restoreOverflow: (() => void) | undefined;
  if (config.bankLiveOverflow) {
    const prior = tickDriver.onDeltaOverflow;
    tickDriver.onDeltaOverflow = (droppedSeconds) => {
      prior?.(droppedSeconds);
      bank.deposit(droppedSeconds);
    };
    restoreOverflow = () => {
      tickDriver.onDeltaOverflow = prior;
    };
  }

  return {
    isSpending,
    startSpending() {
      if (isSpending.value || bank.banked.value <= 0) return false;
      baseline = tickDriver.speedMultiplier;
      isSpending.value = true;
      const open = spendGate.read();
      applyBonus(open ? resolveComputable(spendMultiplier) : 1);
      return true;
    },
    stopSpending,
    dispose() {
      stopSpending();
      offTick();
      restoreOverflow?.();
    },
  };
}

// === BURST DISCHARGE ===

// True while a burst replay is in flight, so a running BankedAcceleration's
// tick handler doesn't drain the bank for simulated chunks the burst already
// paid for. Safe as module state: the replay is synchronous, so the flag
// spans exactly the burst's own tick callbacks.
let burstInFlight = false;

/** Options for {@link burstDischarge}. */
export interface BurstDischargeOptions {
  /**
   * Fraction of the current reservoir to discharge (default 1 — the whole
   * bank). A slow auto-release is `0.01`.
   */
  fraction?: number;
  /**
   * Fraction of the withdrawn seconds actually simulated (default 1).
   * Values below 1 are the conversion penalty for getting the time as an
   * instant burst instead of live acceleration.
   */
  efficiency?: number;
  /**
   * Pass-through to {@link processOfflineTime}. `maxOfflineSeconds` defaults
   * to the full discharge amount so no withdrawn time is silently dropped —
   * override with care.
   */
  offline?: OfflineProgressOptions;
}

/**
 * Spend (a fraction of) a {@link TimeBank} as one immediate fast-forward:
 * withdraw, then replay the seconds through {@link processOfflineTime} in a
 * single burst. The "stored time" discharge shape, as opposed to
 * {@link createBankedAcceleration}'s live boost.
 *
 * Wall-clock faithful and speed-independent — the replay path never applies
 * `speedMultiplier`.
 *
 * @param bank - The reservoir to discharge.
 * @param tickDriver - The driver the burst replays through.
 * @param options - Discharge fraction, conversion efficiency, replay options.
 * @returns Seconds actually simulated.
 *
 * @example
 * ```ts
 * // Discharge the whole bank at a 30% conversion penalty:
 * const simulated = burstDischarge(bank, engine.tickDriver, { efficiency: 0.7 });
 * ```
 */
export function burstDischarge(
  bank: TimeBank,
  tickDriver: TickDriver,
  options: BurstDischargeOptions = {},
): number {
  const fraction = Math.min(1, Math.max(0, options.fraction ?? 1));
  const efficiency = options.efficiency ?? 1;
  const withdrawn = bank.withdraw(bank.banked.value * fraction);
  if (withdrawn <= 0) return 0;
  const seconds = withdrawn * efficiency;
  burstInFlight = true;
  try {
    return processOfflineTime(tickDriver, seconds, {
      maxOfflineSeconds: seconds,
      ...options.offline,
    });
  } finally {
    burstInFlight = false;
  }
}
