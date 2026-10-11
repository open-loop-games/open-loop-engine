/**
 * Engine safeguards — iteration caps, depth limits, and safeguard diagnostics.
 *
 * Provides runtime protection against infinite recursion and runaway loops
 * in event emission, sequencer advancement, and other engine internals.
 *
 * - Guards are always active (cheap enough for production)
 * - Safeguard diagnostics always count; dev mode adds a console warning each time a cap is hit
 */

// === DEV MODE ===
let _devMode = false;

/**
 * Enable dev mode: a console warning each time a safeguard cap is hit.
 * The safeguard diagnostics {@link getSafeguardDiagnostics} reads count whether or not dev mode is on.
 */
export function enableDevMode(): void {
  _devMode = true;
}

/** Disable dev mode. */
export function disableDevMode(): void {
  _devMode = false;
}

/** Check whether dev mode is active. */
export function isDevMode(): boolean {
  return _devMode;
}

// === SAFEGUARD DIAGNOSTICS ===
/**
 * Safeguard diagnostics — how often the emit-depth cap and the sequencer
 * advance cap were hit, plus the last offender of each. Read through
 * {@link getSafeguardDiagnostics}.
 */
export interface SafeguardDiagnostics {
  /** Number of times an emit depth limit was hit */
  emitDepthTrips: number;
  /** Number of times a sequencer advance cap was hit */
  advanceCapTrips: number;
  /** Last event name that hit the emit depth limit */
  lastEmitDepthEvent: string | null;
  /** Last sequencer id that hit the advance cap */
  lastAdvanceCapSequencer: string | null;
}

const _diagnostics: SafeguardDiagnostics = {
  emitDepthTrips: 0,
  advanceCapTrips: 0,
  lastEmitDepthEvent: null,
  lastAdvanceCapSequencer: null,
};

/** Read-only snapshot of the safeguard diagnostics. */
export function getSafeguardDiagnostics(): Readonly<SafeguardDiagnostics> {
  return { ..._diagnostics };
}

/** Reset every safeguard diagnostic to zero. */
export function resetSafeguardDiagnostics(): void {
  _diagnostics.emitDepthTrips = 0;
  _diagnostics.advanceCapTrips = 0;
  _diagnostics.lastEmitDepthEvent = null;
  _diagnostics.lastAdvanceCapSequencer = null;
}

// === INTERNAL RECORDING (CALLED BY GUARDS IN EVENTS.TS, SEQUENCER.TS, ETC.) ===
/** @internal Called when emit depth limit is exceeded. */
export function reportEmitDepthTrip(eventName: string, depth: number): void {
  _diagnostics.emitDepthTrips++;
  _diagnostics.lastEmitDepthEvent = eventName;
  if (_devMode) {
    console.warn(
      `[safeguard] Emit depth limit hit: event "${eventName}" at depth ${depth}. ` +
        `Recursive emit blocked.`,
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
        `Further advances wait for the next tick.`,
    );
  }
}
