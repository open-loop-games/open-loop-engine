/**
 * Time bank — a store of banked seconds, spent as acceleration or a burst discharge.
 *
 * The genre's fourth offline-progress family (after extrapolation, tick
 * simulation and cap-and-trickle). Offline time, dropped live time or an
 * explicit consumer policy deposits seconds into a time bank. The seconds are
 * spent later as accelerated play. Three factories, each spend shape
 * built on the same core:
 *
 * - {@link createTimeBank} — the spend-agnostic time bank: deposit (with a
 *   deposit efficiency and an optional capacity) and withdraw. A consumer
 *   with a bespoke spend shape (a per-subsystem fast tick, such as stored
 *   cycles) calls `withdraw()` at its own cadence.
 * - {@link createBankedAcceleration} — the most common shape: toggle a raise of
 *   `TickDriver.speedMultiplier`, withdraw from the time bank each tick, and
 *   stop when it is empty. A play session always starts unaccelerated.
 * - {@link burstDischarge} — the "stored time" shape: replay (a fraction of)
 *   the time bank through `processOfflineTime` as one immediate fast-forward,
 *   optionally at an efficiency penalty.
 *
 * Deposit *policy* — which elapsed time counts, log curves over offline
 * excess, borrow-against-future ledgers — stays in the consumer: compute
 * seconds, then call `deposit()`. The one engine-owned deposit is
 * `depositLiveOverflow` on the acceleration wrapper. It banks the dropped
 * seconds `TickDriver` reports through `onDeltaOverflow` when a hidden tab
 * outruns `maxDeltaTime`.
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

/** Options for {@link createTimeBank}. */
export interface TimeBankOptions {
  /**
   * Persistent context id for the time bank. Defaults to `${module}/time-bank`
   * inside a module. Pass one when a module holds several time banks (one per subsystem).
   */
  id?: string;
  /**
   * Fraction of each deposit that goes into the time bank (default 1).
   * Typical values: 1, 0.7, 2/3.
   * Can be a ref or getter, for a value that changes (an upgradeable efficiency).
   */
  depositEfficiency?: Computable<number>;
  /**
   * The most seconds the time bank holds (default unlimited). Deposits beyond
   * it are discarded. Can be a ref or getter, for a value that changes (an
   * upgradeable capacity).
   */
  capacity?: Computable<number>;
}

/** The time bank {@link createTimeBank} returns. */
export interface TimeBank {
  /**
   * Banked seconds (saved). Prefer `deposit`/`withdraw` over direct writes.
   *
   * Not lifetime, unlike most system-owned state: a reset naming the module
   * the time bank was built in empties it. Whether banked time survives a
   * reset is the game's call; pass `keep: [bank.banked]` to keep it.
   */
  banked: Persistent<number>;
  /**
   * Deposit seconds into the time bank, scaled by `depositEfficiency` and
   * clamped at `capacity`. Returns the seconds actually banked. Non-positive
   * input is a no-op.
   */
  deposit(seconds: number): number;
  /**
   * Withdraw up to `seconds` from the time bank. Returns the seconds actually
   * withdrawn (fewer when the time bank runs out). Non-positive input is a
   * no-op.
   */
  withdraw(seconds: number): number;
}

/**
 * Create a time bank: a saved store of seconds that consumer policy deposits.
 * {@link createBankedAcceleration}, {@link burstDischarge} or bespoke consumer
 * code spends them.
 *
 * @param options - Deposit efficiency, capacity and persistent context id.
 * @returns The time bank, with `deposit`/`withdraw` and the persistent
 *   `banked` ref.
 *
 * @example
 * ```ts
 * const bank = createTimeBank({ capacity: () => toNumber(capacityUpgrade.effect.value) });
 * // on load, bank offline time instead of simulating it:
 * bank.deposit(offlineSeconds);
 * ```
 */
export function createTimeBank(options: TimeBankOptions = {}): TimeBank {
  const { depositEfficiency = 1, capacity: cap } = options;
  const bankContextId = resolveSystemPersistentContextId(options.id, 'time-bank');
  const banked = withPersistentContext(bankContextId, () =>
    persistent<number>(0, { id: 'banked' }),
  );

  const bank: TimeBank = {
    banked,
    deposit(seconds) {
      if (!(seconds > 0)) return 0;
      const toDeposit = seconds * resolveComputable(depositEfficiency);
      const before = banked.value;
      const ceiling = cap === undefined ? Infinity : resolveComputable(cap);
      // max(before, …) so a capacity lowered below the banked amount only
      // blocks new deposits — it never removes already-banked time.
      const after = Math.max(before, Math.min(ceiling, before + toDeposit));
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

/** Options for {@link createBankedAcceleration}. */
export interface BankedAccelerationOptions {
  /** The driver whose `speedMultiplier` the spend loop owns while spending. */
  tickDriver: TickDriver;
  /** The time bank the spend loop withdraws from. */
  bank: TimeBank;
  /**
   * Speed factor applied on top of the driver's baseline multiplier while
   * spending (e.g. 10 for 10×). Can be a ref or getter, for a value that
   * changes; a change takes effect on the next tick.
   */
  spendMultiplier: Computable<number>;
  /**
   * How many banked seconds a tick of accelerated play withdraws.
   * - `'excess'` (default) — only the speed beyond baseline, in wall-clock
   *   seconds. A spend at n× withdraws n − 1 banked seconds per wall-clock
   *   second, whatever the driver's baseline multiplier. The most common
   *   shape, and it conserves time: wall-clock time is withdrawn even while a
   *   challenge doubles game speed.
   * - `'full'` — the whole accelerated dt: banked seconds are game seconds
   *   delivered at speed. Deliberately lossier.
   */
  withdrawMode?: 'excess' | 'full';
  /**
   * Predicate evaluated each tick; while false, acceleration and withdrawals
   * pause (driver back at baseline) without ending the spend. For "only
   * while actively playing" tests. A Gate reads the ambient Gate services
   * captured at `createBankedAcceleration` time.
   */
  when?: Predicate;
  /**
   * When true, banks the seconds `TickDriver` drops when a hidden tab or a
   * hitch outruns `maxDeltaTime`, by chaining onto `onDeltaOverflow`. The one
   * engine-owned deposit; everything else deposits explicitly.
   */
  depositLiveOverflow?: boolean;
}

/** Spend-loop handle returned by {@link createBankedAcceleration}. */
export interface BankedAcceleration {
  /**
   * Begin spending: raises the driver to `baseline × spendMultiplier` and
   * withdraws from the time bank each tick until stopped or empty. Returns
   * false (and does nothing) when the time bank is empty or a spend is
   * already running.
   */
  startSpending(): boolean;
  /** End the spend and restore the driver's baseline multiplier. No-op when idle. */
  stopSpending(): void;
  /**
   * Whether a spend is running. Deliberately ephemeral, never saved: a play
   * session always starts unaccelerated, as in every game of the genre.
   */
  isSpending: Ref<boolean>;
  /**
   * End the tick handler and overflow-chain wiring, and stop any running
   * spend. The time bank's `banked` ref stays saved.
   */
  dispose(): void;
}

/**
 * The live game speed spend loop over a {@link TimeBank}. It toggles a game
 * speed raise on the TickDriver and withdraws for it from the time bank each
 * tick. It stops when the time bank is empty. The wrapper owns
 * `tickDriver.speedMultiplier` while a spend is running; the baseline is
 * captured at `startSpending` and restored on stop.
 *
 * @param options - Driver and time bank wiring, spend multiplier, withdraw
 *   mode, an optional predicate and live-overflow banking.
 * @returns Start/stop controls, the ephemeral `isSpending` flag, and
 *   `dispose()`.
 *
 * @example
 * ```ts
 * const bank = createTimeBank();
 * const accel = createBankedAcceleration({
 *   tickDriver: engine.tickDriver,
 *   bank,
 *   spendMultiplier: () => rateLadder[selectedRate.value],
 *   depositLiveOverflow: true,
 * });
 * bank.deposit(offlineSeconds); // on load, instead of simulating
 * accel.startSpending();        // the player turns on acceleration
 * ```
 */
export function createBankedAcceleration(options: BankedAccelerationOptions): BankedAcceleration {
  const { tickDriver, bank, spendMultiplier, withdrawMode = 'excess', when: gate } = options;
  const spendGate = createPredicateResolver().adopt(gate, true, 'createBankedAcceleration gate');

  const isSpending = ref(false);
  let baseline = 1;
  // The bonus factor the driver is currently scaled by beyond baseline —
  // tracked closure-side so withdraw math never re-derives it from the driver.
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
    // A burst replay's chunks reach this handler like live dt, but the
    // burst's withdraw already covered that time; withdrawing again would
    // count it twice. (A consumer's own processOfflineTime call mid-spend has
    // the same hazard; stop the spend around it.)
    if (!isSpending.value || burstInFlight) return;
    // Withdraw for the tick that just ran at appliedBonus. dt arrives already
    // scaled by baseline × appliedBonus, so the wall-clock seconds it covers
    // are dt / (baseline × appliedBonus).
    if (appliedBonus > 1) {
      const excess = baseline > 0 ? (dt * (appliedBonus - 1)) / (baseline * appliedBonus) : 0;
      const toWithdraw = withdrawMode === 'full' ? dt : excess;
      const withdrawn = bank.withdraw(toWithdraw);
      if (withdrawn < toWithdraw) {
        stopSpending();
        return;
      }
    }
    // Arm the factor for the next tick: a predicate that pauses the spend and
    // reactive spendMultiplier changes take effect one tick later.
    const open = spendGate.read();
    applyBonus(open ? resolveComputable(spendMultiplier) : 1);
  });

  let restoreOverflow: (() => void) | undefined;
  if (options.depositLiveOverflow) {
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
// tick handler doesn't withdraw for replayed chunks the burst already
// withdrew. Safe as file state: the replay is synchronous, so the flag spans
// exactly the burst's own ticks.
let burstInFlight = false;

/** Options for {@link burstDischarge}. */
export interface BurstDischargeOptions {
  /**
   * Fraction of the banked seconds to discharge (default 1, the whole time
   * bank). A slow automatic discharge uses `0.01`.
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
   * to the full discharged seconds, so no withdrawn time is silently
   * dropped. Override it with care.
   */
  replay?: OfflineProgressOptions;
}

/**
 * Spend (a fraction of) a {@link TimeBank} as one immediate fast-forward:
 * withdraw, then replay the seconds through {@link processOfflineTime} in a
 * single burst. The "stored time" discharge shape, as opposed to
 * {@link createBankedAcceleration}'s live acceleration.
 *
 * It matches wall-clock time and ignores game speed: the replay path never
 * applies `speedMultiplier`.
 *
 * @param bank - The time bank to discharge.
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
      ...options.replay,
    });
  } finally {
    burstInFlight = false;
  }
}
