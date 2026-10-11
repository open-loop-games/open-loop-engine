/**
 * Selection policies — score-and-pick over a candidate list.
 *
 * One of three sibling "choose one from a list" primitives. The axis is
 * shape, not lifecycle:
 *
 * - {@link FillStrategy} — *stateful chooser*. The sequencer asks it for
 *   `next()` when its queue is empty; the round-robin strategy keeps a
 *   persistent cursor.
 * - `SelectionPolicy` (this file) — *stateless selector*. Given a
 *   pre-filtered candidate list, scores and returns the winner. No
 *   internal state; pure function-shape consumed as configuration.
 * - {@link Recommender} — *scored candidate*. IS one of many
 *   candidates the recommendation system arbitrates between; the system
 *   filters via `canApply`, scores via `score`, runs `recommend()` on the
 *   winner.
 *
 * Built-in factories follow the constructor-as-data carve-out (see
 * `AGENTS.md` § Code Rules, Naming, noun-form helpers): call sites
 * look like configuration, not actions — `policy: selectionHybridPayback({ ... })`.
 * `FillStrategy` factories keep the verb form (`create*Strategy`) because
 * the round-robin strategy keeps persistent cursor state. The rest of that
 * family follows for symmetry. See `core/sequencer-strategies.ts` for the
 * mirrored cross-reference.
 *
 * Filtering is the driver's job, not the policy's. Each utility that drives
 * a policy (e.g. `setupPolicyAutoPurchase`) filters candidates by
 * visibility, unlocks and limits before it calls `pick`. It also filters by
 * affordability and reserve, unless the driver waits for cost. Then
 * unaffordable candidates reach the policy, and a pick the amount can't pay
 * for purchases nothing this attempt. Policies may still skip candidates
 * whose *scoring meaning* fails. For example, zero-rate producers under
 * `selectionHybridPayback` have no finite payback period and no defined
 * score. But policies should not re-implement any of those filters.
 */

import { Decimal, type DecimalSource } from '@/primitives/decimal';

// === TYPES ===
/**
 * Pick one item from a list of pre-filtered candidates, or `undefined` when
 * none of the candidates are an acceptable choice under this policy.
 *
 * @typeParam T - Candidate type. Policies are parametric — built-in factories
 *   take per-T getters, so the same policy code drives `Producer`,
 *   `Purchasable`, or any consumer-defined shape.
 */
export interface SelectionPolicy<T> {
  /**
   * Score each candidate and return the winner.
   *
   * @param candidates - Pre-filtered candidate list. The caller has already
   *   filtered by visibility, unlock and limit. It has also filtered by
   *   affordability and reserve, unless it waits for cost; then a pick the
   *   amount can't pay for purchases nothing this attempt.
   * @param ctx - Untyped pass-through for consumer-defined policies that
   *   want per-call state without re-currying the factory.
   *   `selectionHybridPayback` reads a {@link HybridPaybackContext} from it,
   *   and `selectionComposite` passes it to its children. The other built-in
   *   policies ignore it. Cast it to your own context
   *   type in a custom policy.
   * @returns The chosen candidate, or `undefined` if no candidate scored.
   */
  pick(candidates: T[], ctx?: unknown): T | undefined;
}

/** Options for {@link selectionHybridPayback} */
export interface HybridPaybackOptions<T> {
  /** Cost of the next unit of `t` */
  getCost: (t: T) => DecimalSource;
  /**
   * Marginal rate `t` would add if purchased. Candidates with `rate ≤ 0`
   * are skipped — they have no payback term.
   */
  getRate: (t: T) => DecimalSource;
  /** Amount of `t`'s cost resource held now */
  getAmount: (t: T) => DecimalSource;
  /**
   * Amount to leave unspent; `effectiveAmount = amount − reserve`. Read once
   * per `pick` call. Pass `() => 0` when no reserve is configured.
   */
  getReserve: () => DecimalSource;
  /**
   * Total production rate of `t`'s cost resource across the whole economy.
   * The wait term divides the unaffordable gap by this value to estimate
   * "seconds until I can afford it". It is only read for a candidate with
   * a gap.
   *
   * Drivers (e.g. `setupPolicyAutoPurchase`) may pass a cached version as
   * {@link HybridPaybackContext.getTotalRate} on the `ctx` argument, and
   * `pick` prefers it. The cache is at the call site, not on the stateless
   * policy.
   */
  getTotalRate: (t: T) => DecimalSource;
}

/**
 * Per-call context that {@link selectionHybridPayback} understands. Drivers
 * pass this to `pick(candidates, ctx)` to replace the policy's own
 * `getTotalRate` with a cached one. That helps when one resource's total
 * rate is read for many candidates per pick.
 */
export interface HybridPaybackContext<T> {
  /**
   * Cached total-rate getter. When present, it replaces
   * `HybridPaybackOptions.getTotalRate` for that pick.
   */
  getTotalRate?: (t: T) => DecimalSource;
}

// === FACTORIES ===
/**
 * Pick the candidate with the smallest cost.
 *
 * The "purchase whatever I can" baseline policy. Pairs naturally with a
 * pre-filtered affordable-only candidate list.
 *
 * @param getCost - Cost extractor. Typically `(p) => p.repeatable.getCost(1)`.
 *
 * @example
 * ```ts
 * const policy = selectionCheapest<Producer>(
 *   (p) => p.repeatable!.getCost(1),
 * );
 * ```
 */
export function selectionCheapest<T>(getCost: (t: T) => DecimalSource): SelectionPolicy<T> {
  return {
    pick(candidates) {
      let best: T | undefined;
      let bestCost: Decimal | undefined;
      for (const c of candidates) {
        const cost = Decimal.fromValue(getCost(c));
        if (bestCost === undefined || cost.lt(bestCost)) {
          best = c;
          bestCost = cost;
        }
      }
      return best;
    },
  };
}

/**
 * Pick the candidate with the smallest seconds figure, which the caller
 * supplies per candidate; lower wins.
 *
 * Candidates with a non-finite figure are skipped — the policy treats them
 * as having no defined payback. Treats each candidate in isolation; doesn't
 * read the rest of the economy. Prone to a cold-start pathology when no
 * candidate has a finite figure. Surveyed auto-purchase userscripts all add
 * a wait term to handle that case
 * (see {@link selectionHybridPayback}).
 *
 * @param getSeconds - Seconds extractor. `(p) => p.purchaseBeatSeconds.value` is
 *   the usual source: the beat time, which is the seconds the producer's
 *   whole stack takes to produce its next unit's cost. It favours tall
 *   stacks. For the marginal payback
 *   period the surveyed userscripts rank by, pass cost over the rate one more
 *   unit adds (`getCost(1) / computedRate` for a producer).
 */
export function selectionPaybackPeriod<T>(getSeconds: (t: T) => number): SelectionPolicy<T> {
  return {
    pick(candidates) {
      let best: T | undefined;
      let bestBeat: number | undefined;
      for (const c of candidates) {
        const beat = getSeconds(c);
        if (!Number.isFinite(beat)) continue;
        if (bestBeat === undefined || beat < bestBeat) {
          best = c;
          bestBeat = beat;
        }
      }
      return best;
    },
  };
}

/**
 * Pick the candidate with the smallest blended payback score:
 * `max(cost − effectiveAmount, 0) / totalRate + cost / Δrate`,
 * where `effectiveAmount = amount − reserve`.
 *
 * The first term dominates while the player saves toward an expensive
 * candidate. It is zero once the candidate is affordable, so the payback
 * term alone decides. Auto-purchase userscripts commonly use this formula.
 *
 * The wait term only scores candidates the driver offers before they're
 * affordable: under `setupPolicyAutoPurchase` that takes `waitForCost`.
 * Without it every candidate is already affordable and this ranks by payback
 * alone.
 *
 * Both terms are seconds, so any mix of candidates ranks on one scale. With
 * no production yet (total rate ≤ 0) an affordable candidate still waits
 * zero and ranks by payback alone. An unaffordable one would wait forever
 * and is skipped. Candidates with `Δrate ≤ 0` are skipped too — they have
 * no payback term.
 *
 * @param opts - Per-candidate getters for cost, rate and amount, plus the
 *   reserve and the total rate. See {@link HybridPaybackOptions}.
 *
 * @example
 * ```ts
 * const policy = selectionHybridPayback<Producer>({
 *   getCost: (p) => p.repeatable!.getCost(1),
 *   getRate: (p) => p.computedRate.value,
 *   getAmount: (p) => p.resource.value,
 *   getReserve: () => 0,
 *   getTotalRate: (p) => buildings.getTotalRate(p.resource),
 * });
 * ```
 */
export function selectionHybridPayback<T>(opts: HybridPaybackOptions<T>): SelectionPolicy<T> {
  return {
    pick(candidates, ctx) {
      const ctxObj = ctx as HybridPaybackContext<T> | undefined;
      const getTotalRate = ctxObj?.getTotalRate ?? opts.getTotalRate;
      const reserve = Decimal.fromValue(opts.getReserve());
      let best: T | undefined;
      let bestScore: Decimal | undefined;
      for (const c of candidates) {
        const deltaRate = Decimal.fromValue(opts.getRate(c));
        if (!deltaRate.gt(0)) continue;
        const cost = Decimal.fromValue(opts.getCost(c));
        const effectiveAmount = Decimal.sub(opts.getAmount(c), reserve);
        const gap = cost.sub(effectiveAmount);
        let waitTerm: Decimal = Decimal.dZero;
        if (gap.gt(0)) {
          const totalRate = Decimal.fromValue(getTotalRate(c));
          // No production means the gap never closes: no finite wait to score.
          if (!totalRate.gt(0)) continue;
          waitTerm = gap.div(totalRate);
        }
        const score = waitTerm.add(cost.div(deltaRate));
        if (bestScore === undefined || score.lt(bestScore)) {
          best = c;
          bestScore = score;
        }
      }
      return best;
    },
  };
}

/**
 * Chain policies with first-non-empty-pick semantics. Tries each policy in
 * order against the same candidate list; returns the first non-`undefined`
 * pick. Mirrors {@link createCompositeStrategy}'s composition shape.
 *
 * Composition is policy-fallback, not candidate-filter — every policy sees
 * the same input list. Use it for "primary policy with a backup if the
 * primary returns nothing" (e.g. `selectionPaybackPeriod` falling back to
 * `selectionCheapest` when no candidate has a finite beat time).
 *
 * @example
 * ```ts
 * const policy = selectionComposite(
 *   selectionPaybackPeriod<Producer>((p) => p.purchaseBeatSeconds.value),
 *   selectionCheapest<Producer>((p) => p.repeatable!.getCost(1)),
 * );
 * ```
 */
export function selectionComposite<T>(...policies: SelectionPolicy<T>[]): SelectionPolicy<T> {
  return {
    pick(candidates, ctx) {
      for (const p of policies) {
        const item = p.pick(candidates, ctx);
        if (item != null) return item;
      }
      return undefined;
    },
  };
}
