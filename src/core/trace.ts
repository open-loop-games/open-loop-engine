/**
 * Resource mutation tracing system
 *
 * Automatically records resource value changes via the persistent() setter.
 * The graph view and other observers read the trace to visualize flows.
 *
 * - Zero module code changes for basic tracing (setter intercept)
 * - Opt-in withTraceChain() for modifier chain attribution
 * - Per-tick grouping via beginTraceTick()/endTraceTick(), which the game loop calls
 */

import type { Modifier } from './modifier';
import type { Resource } from './resource';
import type { DecimalSource } from '@/primitives/decimal';

/** A single resource mutation recorded by the trace system */
export interface TraceEntry {
  /** The resource that was mutated */
  resource: Resource;
  /** The delta (positive = gained, negative = lost) */
  delta: DecimalSource;
  /** The tick number when this mutation occurred */
  tick: number;
  /** The modifier chain that computed the amount (opt-in via withTraceChain) */
  chain?: Modifier;
}

// === TRACE STATE ===
let currentTick = 0;
let currentTickEntries: TraceEntry[] = [];
let previousTickEntries: TraceEntry[] = [];
let tracing = false;
let enableRefcount = 0;

/**
 * Enable the trace system for the length of a subscription. Returns a
 * cleanup that decrements the refcount; tracing stays on while at least one
 * caller holds a subscription. When the refcount is zero, `beginTraceTick`
 * and `recordTrace` short-circuit, so the hot path allocates nothing — the
 * common case, where no observer is subscribed.
 *
 * Intended for observers like a graph view or a balance-harness runner: call
 * it on subscribe, and call the returned cleanup on unsubscribe.
 */
export function enableTracing(): () => void {
  enableRefcount++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    enableRefcount--;
    if (enableRefcount === 0) {
      tracing = false;
      currentTickEntries = [];
      previousTickEntries = [];
    }
  };
}

/** Whether any caller currently holds a trace subscription. @internal */
export function isTracingEnabled(): boolean {
  return enableRefcount > 0;
}

// === CHAIN ATTRIBUTION CONTEXT ===
let activeChain: Modifier | undefined;

/**
 * Run `fn` with modifier chain attribution.
 * Each resource mutation inside `fn` records the chain on its trace entry.
 *
 * @param chain - The modifier chain that computed the mutation amount
 * @param fn - The function that performs the mutation
 * @returns The return value of fn
 *
 * @example
 * ```ts
 * withTraceChain(decayChain, () => {
 *   health.value = Decimal.sub(health.value, decay)
 * })
 * ```
 */
export function withTraceChain<T>(chain: Modifier, fn: () => T): T {
  const prev = activeChain;
  activeChain = chain;
  try {
    return fn();
  } finally {
    activeChain = prev;
  }
}

/**
 * Get the currently active modifier chain, if any.
 * Called by the persistent() setter to attach attribution.
 * @internal
 */
export function getActiveChain(): Modifier | undefined {
  return activeChain;
}

// === TICK LIFECYCLE ===
/**
 * Begin a new tick. Clears current entries and starts recording.
 * Called by the game loop at the start of each processTick.
 * @internal
 */
export function beginTraceTick(): void {
  if (enableRefcount === 0) return;
  currentTickEntries = [];
  currentTick++;
  tracing = true;
}

/**
 * End the current tick. Rotates current entries to previous for reading.
 * Called by the game loop after processTick.
 * @internal
 */
export function endTraceTick(): void {
  if (enableRefcount === 0) return;
  tracing = false;
  previousTickEntries = currentTickEntries;
}

// === RECORDING ===
/**
 * Record a trace entry. Called by the persistent() setter.
 * @internal
 */
export function recordTrace(resource: Resource, delta: DecimalSource): void {
  currentTickEntries.push({
    resource,
    delta,
    tick: currentTick,
    chain: activeChain,
  });
}

/**
 * Whether tracing is currently active (inside a tick).
 * @internal
 */
export function isTracing(): boolean {
  return tracing;
}

// === READING ===
/** Get the current tick number */
export function getTraceTick(): number {
  return currentTick;
}

/** Get trace entries for the current (in-progress) tick */
export function getCurrentTraceEntries(): readonly TraceEntry[] {
  return currentTickEntries;
}

/** Get trace entries for the previous (completed) tick */
export function getPreviousTraceEntries(): readonly TraceEntry[] {
  return previousTickEntries;
}

// === RESET (FOR TESTING) ===
/** @internal */
export function resetTrace(): void {
  currentTick = 0;
  currentTickEntries = [];
  previousTickEntries = [];
  tracing = false;
  activeChain = undefined;
  enableRefcount = 0;
}
