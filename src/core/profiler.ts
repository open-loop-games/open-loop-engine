/**
 * Hot-path profiler — labeled wall-clock attribution for the tick loop.
 *
 * Sibling to {@link trace} with an identical refcount gate: no subscriber,
 * no cost. When a consumer calls {@link enableProfiling}, the game loop's
 * `processTick` drives per-tick capture via {@link beginProfileTick} /
 * {@link endProfileTick}, and wrap points in hot code record labeled
 * sub-tick time through {@link profile} or {@link profileStart}/
 * {@link profileEnd}.
 *
 * Unlike the borglike profiler this is modelled on, per-label per-tick
 * self-times are retained in a ring buffer so {@link getProfileReport}
 * yields p50/p95/p99 per label — matching borglike's "profile max times,
 * not just averages" learning against cf-auto-steady's multi-thousand
 * tick runs.
 *
 * @internal
 */

interface Timing {
  total: number;
  calls: number;
  min: number;
  max: number;
  /** Per-tick accumulated self-time for this label. One entry per tick the label fired. */
  perTick: number[];
}

const timings: Map<string, Timing> = new Map();
let refcount = 0;
let tickStart = 0;
/** Per-tick accumulator. Allocated in beginProfileTick, flushed in endProfileTick. */
let tickDeltas: Map<string, number> | null = null;

/**
 * Subscribe to the profiler. Returns a disposer that decrements the refcount.
 * When the refcount hits zero, {@link profile}, {@link profileStart}, and the
 * tick-lifecycle hooks short-circuit — zero allocation, one branch.
 *
 * Intended for benchmark runners and perf consumers: call once before the
 * measurement window, dispose after.
 */
export function enableProfiling(): () => void {
  refcount++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--refcount === 0) {
      timings.clear();
      tickDeltas = null;
    }
  };
}

/** Whether any caller currently holds a profile subscription. */
export function isProfilingEnabled(): boolean {
  return refcount > 0;
}

/**
 * Wrap a function call with profiling. Returns the function's result
 * untouched. No-op (returns `fn()` directly) when profiling is disabled.
 */
export function profile<T>(name: string, fn: () => T): T {
  if (refcount === 0) return fn();
  const t0 = performance.now();
  try {
    return fn();
  } finally {
    record(name, performance.now() - t0);
  }
}

/**
 * Start a manual timer. Returns an opaque token to pass to {@link profileEnd}.
 * Use when the timed block isn't naturally a closure (loops, early returns).
 * Returns `0` when profiling is disabled; pair with `profileEnd` which
 * short-circuits on zero.
 */
export function profileStart(): number {
  return refcount === 0 ? 0 : performance.now();
}

/**
 * End a manual timer started with {@link profileStart}.
 * No-op when the token is `0`.
 */
export function profileEnd(name: string, start: number): void {
  if (refcount === 0 || start === 0) return;
  record(name, performance.now() - start);
}

function record(name: string, elapsed: number): void {
  let t = timings.get(name);
  if (!t) {
    t = { total: 0, calls: 0, min: Infinity, max: 0, perTick: [] };
    timings.set(name, t);
  }
  t.total += elapsed;
  t.calls++;
  if (elapsed < t.min) t.min = elapsed;
  if (elapsed > t.max) t.max = elapsed;
  if (tickDeltas !== null) {
    const prev = tickDeltas.get(name);
    tickDeltas.set(name, (prev ?? 0) + elapsed);
  }
}

// === TICK LIFECYCLE (CALLED BY GAME-LOOP) ===
/**
 * Begin a new tick's capture window. Called by the game loop at the start of
 * `processTick`. Short-circuits when no subscriber is active.
 * @internal
 */
export function beginProfileTick(): void {
  if (refcount === 0) return;
  tickStart = performance.now();
  tickDeltas = new Map();
}

/**
 * End the current tick's capture window. Flushes per-label tick totals into
 * each label's `perTick` ring buffer, and records a synthetic `tick.total`
 * label carrying the whole-tick wall clock. Called by the game loop after
 * `processTick` finishes.
 * @internal
 */
export function endProfileTick(): void {
  if (refcount === 0 || tickDeltas === null) return;
  const tickTotal = performance.now() - tickStart;
  for (const [name, delta] of tickDeltas) {
    const t = timings.get(name);
    if (t) t.perTick.push(delta);
  }
  // Synthetic denominator label so %-of-total math lives in the same table.
  record('tick.total', tickTotal);
  const t = timings.get('tick.total');
  if (t) t.perTick.push(tickTotal);
  tickDeltas = null;
}

// === REPORTING ===
/** A single row in a {@link ProfileReport}. */
export interface ProfileEntry {
  /** Label passed to {@link profile} or {@link profileEnd}. */
  name: string;
  /** Percentage of aggregate `tick.total` time (or of summed totals if tick.total missing). */
  pct: number;
  /** Aggregate self-time in milliseconds across all calls. */
  totalMs: number;
  /** Number of {@link profile} / {@link profileEnd} calls contributing to this label. */
  calls: number;
  /** Mean self-time per call, in microseconds. */
  avgUs: number;
  /** Fastest single call, in milliseconds. */
  minMs: number;
  /** Slowest single call, in milliseconds. */
  maxMs: number;
  /** p50 per-tick self-time in microseconds (over ticks where the label fired). */
  p50Us: number;
  /** p95 per-tick self-time in microseconds. */
  p95Us: number;
  /** p99 per-tick self-time in microseconds. */
  p99Us: number;
  /** Number of ticks the label was touched. */
  ticks: number;
}

/** Structured profiling report produced by {@link getProfileReport}. */
export interface ProfileReport {
  /** Aggregate `tick.total` wall clock across captured ticks, in ms. */
  totalMs: number;
  /** Number of ticks captured in `tick.total`'s perTick buffer. */
  ticks: number;
  /** Rows sorted by `totalMs` descending. */
  entries: ProfileEntry[];
}

function percentile(sorted: number[], p: number): number {
  const n = sorted.length;
  if (n === 0) return 0;
  return sorted[Math.min(n - 1, Math.floor(n * p))] ?? 0;
}

/**
 * Build a structured report of accumulated timings. The `tick.total` row is
 * the denominator for %-of-total math; if it's absent (no ticks captured),
 * %'s fall back to the summed label totals.
 */
export function getProfileReport(): ProfileReport {
  const tickTotalEntry = timings.get('tick.total');
  const denominatorMs =
    tickTotalEntry?.total ?? [...timings.values()].reduce((sum, t) => sum + t.total, 0);
  const ticks = tickTotalEntry?.perTick.length ?? 0;

  const entries: ProfileEntry[] = [];
  for (const [name, t] of timings) {
    // perTick deltas are in ms; percentile output is in µs.
    const sortedPerTick = [...t.perTick].sort((a, b) => a - b);
    entries.push({
      name,
      pct: denominatorMs > 0 ? (t.total / denominatorMs) * 100 : 0,
      totalMs: t.total,
      calls: t.calls,
      avgUs: t.calls > 0 ? (t.total / t.calls) * 1000 : 0,
      minMs: t.min === Infinity ? 0 : t.min,
      maxMs: t.max,
      p50Us: percentile(sortedPerTick, 0.5) * 1000,
      p95Us: percentile(sortedPerTick, 0.95) * 1000,
      p99Us: percentile(sortedPerTick, 0.99) * 1000,
      ticks: t.perTick.length,
    });
  }
  entries.sort((a, b) => b.totalMs - a.totalMs);

  return { totalMs: denominatorMs, ticks, entries };
}

/**
 * Format a {@link ProfileReport} as a borglike-style console table.
 * Useful for headless runs; BenchmarkLayout renders the structured report directly.
 */
export function formatProfileReport(report: ProfileReport): string {
  const lines: string[] = [];
  lines.push(`=== PROFILE ===`);
  lines.push(`Total: ${report.totalMs.toFixed(1)}ms across ${report.ticks} ticks`);
  lines.push('');
  for (const e of report.entries) {
    lines.push(
      `${e.pct.toFixed(1).padStart(5)}%  ` +
        `${e.totalMs.toFixed(1).padStart(8)}ms  ` +
        `${e.calls.toString().padStart(7)} calls  ` +
        `${e.avgUs.toFixed(1).padStart(8)}µs avg  ` +
        `[p50 ${e.p50Us.toFixed(0).padStart(5)}µs  ` +
        `p95 ${e.p95Us.toFixed(0).padStart(5)}µs  ` +
        `p99 ${e.p99Us.toFixed(0).padStart(5)}µs]  ` +
        `${e.name}`,
    );
  }
  return lines.join('\n');
}

/** Clear all accumulated timings. Does not affect refcount. */
export function resetProfile(): void {
  timings.clear();
  tickDeltas = null;
}
