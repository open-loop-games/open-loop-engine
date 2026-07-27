/**
 * Flow-channel classification — maps beat duration to Csikszentmihalyi's
 * Flow Theory engagement bands. Opinionated balance-tooling surface: lives
 * in harness because the bands encode player-engagement theory, which the
 * mechanics-tier kernel deliberately avoids.
 *
 * The thresholds come from automation-pacing analysis across the
 * incremental-games corpus, and match Flow Theory's original engagement
 * bands (Csikszentmihalyi 1990):
 *
 * - **arousal** `[0, 30)` — learning phase, building engagement
 * - **flow** `[30, 120)` — optimal engagement zone (target)
 * - **flow-upper** `[120, 300)` — extended flow, beginning to slow
 * - **boredom** `[300, 900)` — disengagement risk
 * - **frustration** `[900, 3600)` — high disengagement
 * - **breakdown** `[3600, ∞)` — player abandonment likely
 *
 * Consumed alongside a beat-time quotient — a cost `Formula` in level over
 * a production rate. The algebra is the mechanics tier's; this file is the
 * theory layer over it.
 */

/**
 * Flow-channel classification based on Csikszentmihalyi's Flow Theory (1990).
 * Maps beat duration to a player engagement band.
 */
export type FlowChannel =
  | 'arousal'
  | 'flow'
  | 'flow-upper'
  | 'boredom'
  | 'frustration'
  | 'breakdown';

/**
 * Classify a beat duration (in seconds) into its flow channel.
 *
 * Boundaries are half-open `[min, max)`: a beat of exactly `30s` is `'flow'`,
 * not `'arousal'`. Negative or zero durations classify as `'arousal'`.
 *
 * @param beatTimeSeconds - Beat duration in seconds
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
 * Useful for rendering boundary markers on a beat chart, or for consumer
 * code that needs to quantize beats into channels without re-calling the
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
