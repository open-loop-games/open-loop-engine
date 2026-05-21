/**
 * Selection policies — score-and-pick over a candidate list.
 *
 * Sibling axis to {@link FillStrategy} (sequencer-driven, closure-bound `next()`)
 * and {@link RecommendationStrategyDef} (BestOf-coupled, between-loop arbitration).
 * Where those primitives drive their own invocation, a `SelectionPolicy` is
 * passive: a consumer hands it a pre-filtered candidate list and asks "which
 * one wins?". This is the shape automation auto-buy actually wants — bridging
 * the player-facing automation surface with the sim/recommendation/balance
 * machinery without forcing either side to adopt the other's lifecycle.
 *
 * Built-in factories follow the constructor-as-data carve-out (see
 * `open-loop-engine/CLAUDE.md` § Naming, noun-form helpers): call sites
 * read as configuration, not as actions — `policy: selectionHybridPayback({ ... })`.
 * `FillStrategy` factories keep the verb form (`create*Strategy`) because
 * round-robin binds persistent cursor state; the convention extends across
 * that family for symmetry. See `core/sequencer-strategies.ts` for the
 * mirrored cross-reference.
 *
 * Affordability filtering is the consumer's responsibility, not the policy's.
 * Each helper that drives a policy (e.g. `setupPolicyAutoPurchase`) filters
 * candidates by `canPurchase` / reserve before invoking `pick`. Policies may
 * still skip candidates whose *scoring meaning* fails (e.g. zero-rate
 * producers under `selectionHybridPayback` cannot be paid back at all and
 * have no defined score), but they should not re-implement the affordability
 * gate.
 */

import { Decimal, type DecimalSource } from '@/primitives/decimal';

// === TYPES ===
/**
 * Pick one item from a list of pre-filtered candidates, or `undefined` when
 * none of the candidates are an acceptable choice under this policy.
 *
 * @typeParam T - Candidate type. Policies are parametric — built-in factories
 *   take per-T getter callbacks so the same policy code drives `Producer`,
 *   `Purchasable`, or any consumer-defined shape.
 */
export interface SelectionPolicy<T> {
  /**
   * Score each candidate and return the winner.
   *
   * @param candidates - Pre-filtered candidate list. Caller has already
   *   applied any affordability/visibility/reserve gates.
   * @param ctx - Untyped pass-through for consumer-defined policies that
   *   want per-call state without re-currying the factory. Built-in
   *   policies ignore it; cast to your own context type in custom policies.
   * @returns The chosen candidate, or `undefined` if no candidate scored.
   */
  pick(candidates: T[], ctx?: unknown): T | undefined;
}

/** Options for {@link selectionHybridPayback} */
export interface HybridPaybackOptions<T> {
  /** Cost to acquire the next unit of `t` */
  getCost: (t: T) => DecimalSource;
  /**
   * Marginal rate `t` would add if purchased. Candidates with `rate ≤ 0`
   * are skipped — they have no payback term.
   */
  getRate: (t: T) => DecimalSource;
  /** Resource currently held against `t`'s cost-resource */
  getResource: (t: T) => DecimalSource;
  /**
   * Spending floor; `effectiveResource = resource − reserve`. Read once per
   * `pick` call. Pass `() => 0` when no reserve is configured.
   */
  getReserve: () => DecimalSource;
  /**
   * Aggregate production rate of `t`'s cost-resource across the whole
   * economy. The wait term divides the unaffordable gap by this value to
   * estimate "seconds until I can afford it."
   *
   * Driver helpers (e.g. `setupPolicyAutoPurchase`) may pass their own
   * cached version via {@link HybridPaybackContext.getHeadlineRate} on the
   * `ctx` argument, in which case `pick` prefers that — caching lives at
   * the call site, not on the stateless policy.
   */
  getHeadlineRate: (t: T) => DecimalSource;
}

/**
 * Per-call context that {@link selectionHybridPayback} understands. Drivers
 * pass this to `pick(candidates, ctx)` to override the policy's own
 * `getHeadlineRate` with a cached one — useful when the same resource's
 * headline rate is queried for many candidates per pick.
 */
export interface HybridPaybackContext<T> {
  /**
   * Cached headline-rate getter. When present, supersedes
   * `HybridPaybackOptions.getHeadlineRate` for the duration of the pick.
   */
  getHeadlineRate?: (t: T) => DecimalSource;
}

// === FACTORIES ===
/**
 * Pick the candidate with the smallest cost.
 *
 * The "buy whatever I can" baseline policy. Pairs naturally with a
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
 * Pick the candidate with the shortest payback period (smallest beat).
 *
 * Candidates whose beat is non-finite are skipped — the policy treats them
 * as having no defined payback. Treats each candidate in isolation; doesn't
 * read the rest of the economy. Prone to a cold-start pathology when no
 * candidate has finite beat — surveyed userscripts (Frozen Cookies, Cookie
 * Monster, AutoTrimps) all blend in a wait term to handle that case
 * (see {@link selectionHybridPayback}).
 *
 * @param getBeat - Payback-period extractor in seconds. Typically
 *   `(p) => p.purchaseBeatSeconds.value`.
 */
export function selectionPaybackPeriod<T>(getBeat: (t: T) => number): SelectionPolicy<T> {
  return {
    pick(candidates) {
      let best: T | undefined;
      let bestBeat: number | undefined;
      for (const c of candidates) {
        const beat = getBeat(c);
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
 * `max(cost − effectiveResource, 0) / headlineRate + cost / Δrate`,
 * where `effectiveResource = resource − reserve`.
 *
 * The first term dominates while the player is saving toward something
 * expensive — it collapses to zero the moment the candidate is affordable,
 * handing the decision to the pure payback term. Sourced from Cookie
 * Monster's `pp` formula and Frozen Cookies' `purchaseEfficiency`.
 *
 * Cold-start fallback: when `headlineRate = 0` (no passive production yet)
 * the wait term would blow up, so the score degenerates to `cost`
 * (cheapest-affordable) and relies on the caller's affordability filter to
 * gate "wait until first purchase becomes possible." Candidates with
 * `Δrate ≤ 0` are skipped — they have no payback term.
 *
 * @param opts - Per-candidate getters for cost / rate / resource +
 *   reserve floor + headline-rate aggregator. See {@link HybridPaybackOptions}.
 *
 * @example
 * ```ts
 * const policy = selectionHybridPayback<Producer>({
 *   getCost: (p) => p.repeatable!.getCost(1),
 *   getRate: (p) => p.computedRate.value,
 *   getResource: (p) => p.resource.value,
 *   getReserve: () => 0,
 *   getHeadlineRate: (p) => buildings.getTotalRate(p.resource),
 * });
 * ```
 */
export function selectionHybridPayback<T>(opts: HybridPaybackOptions<T>): SelectionPolicy<T> {
  return {
    pick(candidates, ctx) {
      const ctxObj = ctx as HybridPaybackContext<T> | undefined;
      const getHeadlineRate = ctxObj?.getHeadlineRate ?? opts.getHeadlineRate;
      const reserve = Decimal.fromValue(opts.getReserve());
      let best: T | undefined;
      let bestScore: Decimal | undefined;
      for (const c of candidates) {
        const deltaRate = Decimal.fromValue(opts.getRate(c));
        if (!deltaRate.gt(0)) continue;
        const cost = Decimal.fromValue(opts.getCost(c));
        const headlineRate = Decimal.fromValue(getHeadlineRate(c));
        let score: Decimal;
        if (!headlineRate.gt(0)) {
          score = cost;
        } else {
          const resource = Decimal.fromValue(opts.getResource(c));
          const effectiveResource = Decimal.sub(resource, reserve);
          const unaffordable = Decimal.max(Decimal.sub(cost, effectiveResource), 0);
          const waitTerm = Decimal.fromValue(unaffordable).div(headlineRate);
          const paybackTerm = cost.div(deltaRate);
          score = Decimal.fromValue(waitTerm).add(paybackTerm);
        }
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
 * `selectionCheapest` when no candidate has a finite beat).
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
