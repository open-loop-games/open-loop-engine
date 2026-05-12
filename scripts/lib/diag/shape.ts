/**
 * Probe/walker profiling shape-parameter space.
 *
 * Each `ProbeShape` pins a point in the shape-parameter space; the fixture
 * factory turns a shape into a synthetic engine. The axes are drawn from the
 * dimensions the walker and probe actually respond to, not from Producer-
 * specific regime labels.
 *
 * Deferred axes (v1 does not vary them):
 * - accessor-depth (plain-ref vs computed-chain vs deep-computed) — graduates
 *   if the first CPU profile on `active-narrow` can't distinguish
 *   walker-cost-per-entity from accessor-cost-per-call. Cheap to add; deferred
 *   only because v1 shape-library already covers the b2-class attribution
 *   the bench findings identified as dominant.
 * - opaque-predicate density — needs unlock/state conditions wired into
 *   purchasables; graduates when we want to exercise the `'opaque-present'`
 *   refuse path
 * - registration churn — content add/remove mid-run, Phase-shifter-class
 * - predicate shape — v1 uses `resource >= threshold` for every shape;
 *   Looper/Scripter/Director shapes read other state
 * - Decimal magnitude — all shapes operate in f64 range; Scaler shapes
 *   would push into tetration
 */

export type CostRegime = 'always-affordable' | 'boundary' | 'never-affordable';
export type InitialRate = 'zero' | 'nonzero';
export type BlastRadius = 'narrow' | 'wide';

/**
 * Auto-purchase wiring axis. `'none'` leaves the fixture probe-only (the
 * walker sees static content). `'payback-instant'` attaches
 * `setupAutoPurchaseProducers` with policy `'payback-period'` and
 * `interval=0` — every tick that finds an affordable producer buys one,
 * no drain loop. Matches the mechanical shape that produces b7 (tiny
 * per-advance distance on active never-fires) without coupling the
 * measurement to Producer's `interval=1` drain-loop cost.
 */
export type AutoPurchase = 'none' | 'payback-instant';

export interface ProbeShape {
  id: string;
  description: string;

  purchasables: number;
  producers: number;

  costRegime: CostRegime;
  initialRate: InitialRate;
  blastRadius: BlastRadius;
  autoPurchase: AutoPurchase;

  budgetSec: number;
}

const DEFAULT_BUDGET = 30_000;

export const SHAPES: ProbeShape[] = [
  {
    id: 'empty',
    description: 'no content — probe/walker overhead floor',
    purchasables: 0,
    producers: 0,
    costRegime: 'never-affordable',
    initialRate: 'zero',
    blastRadius: 'narrow',
    autoPurchase: 'none',
    budgetSec: DEFAULT_BUDGET,
  },
  {
    id: 'pure-purchasables-no-income',
    description: '7 purchasables, no producers, rate=0 (b2-class analog, minimal)',
    purchasables: 7,
    producers: 0,
    costRegime: 'never-affordable',
    initialRate: 'zero',
    blastRadius: 'narrow',
    autoPurchase: 'none',
    budgetSec: DEFAULT_BUDGET,
  },
  {
    id: 'pure-producers-no-income',
    description: '7 producers not yet owned — rate=0 via count=0',
    purchasables: 0,
    producers: 7,
    costRegime: 'never-affordable',
    initialRate: 'zero',
    blastRadius: 'narrow',
    autoPurchase: 'none',
    budgetSec: DEFAULT_BUDGET,
  },
  {
    id: 'active-narrow',
    description: '7 producers live (count=1), per-producer chains — b7-class minus purchasables',
    purchasables: 0,
    producers: 7,
    costRegime: 'never-affordable',
    initialRate: 'nonzero',
    blastRadius: 'narrow',
    autoPurchase: 'none',
    budgetSec: DEFAULT_BUDGET,
  },
  {
    id: 'active-wide',
    description: '7 producers live, shared chain — blast-radius-wide analog',
    purchasables: 0,
    producers: 7,
    costRegime: 'never-affordable',
    initialRate: 'nonzero',
    blastRadius: 'wide',
    autoPurchase: 'none',
    budgetSec: DEFAULT_BUDGET,
  },
  {
    id: 'active-autopurchase-narrow',
    description:
      '7 producers live + auto-purchase (payback, interval=0) — b7 reproduction (OL-676)',
    purchasables: 0,
    producers: 7,
    costRegime: 'never-affordable',
    initialRate: 'nonzero',
    blastRadius: 'narrow',
    autoPurchase: 'payback-instant',
    budgetSec: DEFAULT_BUDGET,
  },
  {
    id: 'active-autopurchase-wide',
    description:
      '7 producers live, shared chain + auto-purchase — b7 with blast-radius-wide rebuild cost',
    purchasables: 0,
    producers: 7,
    costRegime: 'never-affordable',
    initialRate: 'nonzero',
    blastRadius: 'wide',
    autoPurchase: 'payback-instant',
    budgetSec: DEFAULT_BUDGET,
  },
  {
    id: 'mixed-active',
    description: '7 producers + 7 purchasables, producers live, predicate unreachable',
    purchasables: 7,
    producers: 7,
    costRegime: 'never-affordable',
    initialRate: 'nonzero',
    blastRadius: 'narrow',
    autoPurchase: 'none',
    budgetSec: DEFAULT_BUDGET,
  },
  {
    id: 'mixed-boundary',
    description: '7 producers + 7 purchasables, predicate right at budget edge',
    purchasables: 7,
    producers: 7,
    costRegime: 'boundary',
    initialRate: 'nonzero',
    blastRadius: 'narrow',
    autoPurchase: 'none',
    budgetSec: DEFAULT_BUDGET,
  },
  {
    id: 'scale-20-producers',
    description: '20 producers, no income — walker cost scaling sample',
    purchasables: 0,
    producers: 20,
    costRegime: 'never-affordable',
    initialRate: 'zero',
    blastRadius: 'narrow',
    autoPurchase: 'none',
    budgetSec: DEFAULT_BUDGET,
  },
  {
    id: 'scale-50-producers',
    description: '50 producers, no income — walker cost scaling sample',
    purchasables: 0,
    producers: 50,
    costRegime: 'never-affordable',
    initialRate: 'zero',
    blastRadius: 'narrow',
    autoPurchase: 'none',
    budgetSec: DEFAULT_BUDGET,
  },
  {
    id: 'scale-100-producers',
    description: '100 producers, no income — walker cost scaling sample',
    purchasables: 0,
    producers: 100,
    costRegime: 'never-affordable',
    initialRate: 'zero',
    blastRadius: 'narrow',
    autoPurchase: 'none',
    budgetSec: DEFAULT_BUDGET,
  },
];

export function findShape(id: string): ProbeShape | undefined {
  return SHAPES.find((s) => s.id === id);
}
