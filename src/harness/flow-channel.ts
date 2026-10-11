/**
 * Flow-channel classification — maps beat time to Csikszentmihalyi's
 * Flow Theory engagement classes. An opinionated balance-harness utility: it
 * is in the balance harness because the classes encode player-engagement
 * theory, which the Mechanics API tier avoids on purpose.
 *
 * The thresholds come from automation-pacing analysis across a corpus of
 * incremental games, and match Flow Theory's original engagement
 * classes (Csikszentmihalyi 1990):
 *
 * - **arousal** `[0, 30)` — learning phase, building engagement
 * - **flow** `[30, 120)` — optimal engagement zone (target)
 * - **flow-upper** `[120, 300)` — extended flow, beginning to slow
 * - **boredom** `[300, 900)` — disengagement risk
 * - **frustration** `[900, 3600)` — high disengagement
 * - **breakdown** `[3600, ∞)` — player abandonment likely
 *
 * Used with a beat-time quotient: a cost `Formula` in purchase count over
 * a production rate. The algebra is in the Mechanics API tier; this file
 * adds the theory on top of it.
 */

/**
 * Flow-channel classification based on Csikszentmihalyi's Flow Theory (1990).
 * Maps beat time to a player engagement class.
 */
export type FlowChannel =
  | 'arousal'
  | 'flow'
  | 'flow-upper'
  | 'boredom'
  | 'frustration'
  | 'breakdown';

/**
 * Classify a beat time (in seconds) into its flow channel.
 *
 * Boundaries are half-open `[min, max)`: a beat time of exactly `30s` is
 * `'flow'`, not `'arousal'`. Negative or zero beat times classify as `'arousal'`.
 *
 * @param beatTimeSeconds - Beat time in seconds
 * @returns Flow channel classification
 *
 * @example
 * ```ts
 * classifyFlowChannel(60);   // 'flow'       — optimal
 * classifyFlowChannel(10);   // 'arousal'    — learning
 * classifyFlowChannel(600);  // 'boredom'    — warning
 * classifyFlowChannel(1800); // 'frustration'— critical
 * ```
 */
export function classifyFlowChannel(beatTimeSeconds: number): FlowChannel {
  if (beatTimeSeconds < 30) return 'arousal';
  if (beatTimeSeconds < 120) return 'flow';
  if (beatTimeSeconds < 300) return 'flow-upper';
  if (beatTimeSeconds < 900) return 'boredom';
  if (beatTimeSeconds < 3600) return 'frustration';
  return 'breakdown';
}

/**
 * Get flow-channel threshold boundaries as `[min, max)` pairs in seconds.
 *
 * Useful for drawing boundary markers on a beat-time chart, or for consumer
 * code that quantizes beat times into channels without calling the
 * classifier per value.
 */
export function getFlowChannelBoundaries(): Record<FlowChannel, [number, number]> {
  return {
    // Lower bound 0, not 5: classifyFlowChannel maps every duration < 30
    // (including [0, 5) and, defensively, negatives) to arousal.
    arousal: [0, 30],
    flow: [30, 120],
    'flow-upper': [120, 300],
    boredom: [300, 900],
    frustration: [900, 3600],
    breakdown: [3600, Infinity],
  };
}
