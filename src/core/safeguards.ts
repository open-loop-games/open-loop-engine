/**
 * Engine safeguards — iteration caps, depth limits, and dev diagnostics.
 *
 * Provides runtime protection against infinite recursion and runaway loops
 * in event emission, sequencer advancement, and other engine internals.
 *
 * - Guards are always active (cheap enough for production)
 * - Diagnostics (counters, logging, stack traces) gate behind dev mode
 */

// === DEV MODE ===
let _devMode = false;

/** Enable dev-mode diagnostics (counters, console warnings with stack traces). */
export function enableDevMode(): void {
  _devMode = true;
}

/** Disable dev-mode diagnostics. */
export function disableDevMode(): void {
  _devMode = false;
}

/** Check whether dev mode is active. */
export function isDevMode(): boolean {
  return _devMode;
}

// === DIAGNOSTICS COUNTERS ===
/**
 * Diagnostic counters captured by the runtime safeguards — how often the
 * emit-depth cap and sequencer advance cap have tripped, plus the last
 * offender of each. Read via {@link getDiagnostics}.
 */
export interface SafeguardDiagnostics {
  /** Number of times an emit depth limit was hit */
  emitDepthTrips: number;
  /** Number of times a sequencer advance cap was hit */
  advanceCapTrips: number;
  /** Last event name that tripped the emit depth limit */
  lastEmitDepthEvent: string | null;
  /** Last sequencer ID that tripped the advance cap */
  lastAdvanceCapSequencer: string | null;
}

const _diagnostics: SafeguardDiagnostics = {
  emitDepthTrips: 0,
  advanceCapTrips: 0,
  lastEmitDepthEvent: null,
  lastAdvanceCapSequencer: null,
};

/** Read-only snapshot of safeguard diagnostics counters. */
export function getDiagnostics(): Readonly<SafeguardDiagnostics> {
  return { ..._diagnostics };
}

/** Reset all diagnostics counters to zero. */
export function resetDiagnostics(): void {
  _diagnostics.emitDepthTrips = 0;
  _diagnostics.advanceCapTrips = 0;
  _diagnostics.lastEmitDepthEvent = null;
  _diagnostics.lastAdvanceCapSequencer = null;
}

// === INTERNAL REPORTING (CALLED BY GUARDS IN EVENTS.TS, SEQUENCER.TS, ETC.) ===
/** @internal Called when emit depth limit is exceeded. */
export function reportEmitDepthTrip(eventName: string, depth: number): void {
  _diagnostics.emitDepthTrips++;
  _diagnostics.lastEmitDepthEvent = eventName;
  if (_devMode) {
    console.warn(
      `[safeguard] Emit depth limit hit: event "${eventName}" at depth ${depth}. ` +
        `Recursive emit chain blocked.`,
    );
  }
}

/** @internal Called when sequencer advance cap is exceeded. */
export function reportAdvanceCapTrip(sequencerId: string, count: number): void {
  _diagnostics.advanceCapTrips++;
  _diagnostics.lastAdvanceCapSequencer = sequencerId;
  if (_devMode) {
    console.warn(
      `[safeguard] Advance cap hit: sequencer "${sequencerId}" after ${count} advances. ` +
        `Further advancement paused until next tick.`,
    );
  }
}
