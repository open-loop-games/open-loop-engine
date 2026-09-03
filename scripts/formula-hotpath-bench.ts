#!/usr/bin/env npx tsx --tsconfig tsconfig.scripts.json
/**
 * Formula hot-path bench. Measures Formula.evaluate() and ModifierChain.apply()
 * overhead at borglike's hot-path call volumes, against inline native math
 * and direct Decimal-chain baselines. Run before borglike starts migrating
 * formula-shaped sites so any engine gap surfaces as its own ticket rather
 * than inside the port.
 *
 * Scenarios cover borglike's hot-path inventory:
 *   - linear monster HP: baseHp * (1 + depth * 0.15), per-monster-per-tick
 *   - polynomial spell damage: baseDmg * spellLevel ^ 1.2, per-cast
 *   - exponential XP curve: xpPerLevel * 1.1 ^ level, on XP change
 *   - modifier-chain accumulation: 5 stacked buffs on a base value, per-query
 *
 * Call volume target: 10k+/s per F3 (60 fps × 100 monsters × 2 formulas).
 * 100k iters/case gives stable ns/op; extend if noise dominates.
 *
 * Usage:
 *   npx tsx --tsconfig tsconfig.scripts.json scripts/formula-hotpath-bench.ts
 */

import { ref } from 'vue';
import Decimal, { bn, type DecimalSource } from '@/primitives/decimal';
import { F as Formula, calculateMaxAffordable } from '@/core/formulas/formulas';
import { createResource } from '@/core/resource';
import {
  createModifierChain,
  createAdditiveModifier,
  createMultiplicativeModifier,
  createExponentialModifier,
} from '@/core/modifier';

declare const process: { argv: string[]; exit(code: number): never };

function time<T>(label: string, fn: (i: number) => T, iters: number): T {
  // Warmup so V8 compiles the hot paths before measuring.
  for (let i = 0; i < 10_000; i++) fn(i);
  const t0 = performance.now();
  let sink = fn(0);
  for (let i = 0; i < iters; i++) sink = fn(i);
  const t1 = performance.now();
  const ns = ((t1 - t0) * 1e6) / iters;
  const ms = (t1 - t0).toFixed(2);
  console.log(
    `  ${label.padEnd(48)} ${ns.toFixed(1).padStart(9)} ns/op  (${ms.padStart(8)} ms / ${iters.toLocaleString()} iters)`,
  );
  return sink;
}

// ---------------------------------------------------------------------------
// Scenario A: Linear monster HP scaling
// baseHp * (1 + depth * 0.15)
// Borglike reference: monster stat scaling per depth (data/monsters.ts). Per
// monster, evaluated every tick for UI/AI.
// ---------------------------------------------------------------------------
function scenarioLinear(): void {
  console.log('\n### Scenario A — linear monster HP: baseHp * (1 + depth * 0.15)');
  console.log(
    '### Shape: 1 variable, 2 binops, layer-0 inputs. Representative per-monster-per-tick.',
  );
  const baseHp = 10;
  const iters = 100_000;

  const depthRef = ref(0 as number);
  const formula = Formula.variable(depthRef).mul(0.15).add(1).mul(baseHp);

  time('inline native math', (i) => baseHp * (1 + i * 0.15), iters);
  time(
    'Formula.evaluate() with ref-mutation',
    (i) => {
      depthRef.value = i;
      return formula.evaluate();
    },
    iters,
  );
  time('Formula.evaluate(depth) with variable override', (i) => formula.evaluate(i), iters);
  time(
    'Decimal chain (no Formula)',
    (i) => Decimal.mul(Decimal.add(Decimal.mul(i, 0.15), 1), baseHp),
    iters,
  );
}

// ---------------------------------------------------------------------------
// Scenario B: Polynomial spell damage
// baseDmg * spellLevel ^ 1.2
// Per-cast; lower volume than monster scaling but still hot during combat.
// ---------------------------------------------------------------------------
function scenarioPolynomial(): void {
  console.log('\n### Scenario B — polynomial spell damage: baseDmg * spellLevel ^ 1.2');
  console.log('### Shape: 1 variable, 1 pow (non-integer), 1 mul. Representative per-cast.');
  const baseDmg = 25;
  const iters = 100_000;

  const levelRef = ref(1 as number);
  const formula = Formula.variable(levelRef).pow(1.2).mul(baseDmg);

  time('inline native math', (i) => baseDmg * Math.pow(i + 1, 1.2), iters);
  time(
    'Formula.evaluate() with ref-mutation',
    (i) => {
      levelRef.value = i + 1;
      return formula.evaluate();
    },
    iters,
  );
  time('Formula.evaluate(level) with variable override', (i) => formula.evaluate(i + 1), iters);
  time('Decimal chain (no Formula)', (i) => Decimal.mul(Decimal.pow(i + 1, 1.2), baseDmg), iters);
}

// ---------------------------------------------------------------------------
// Scenario C: Exponential XP-to-level curve
// xpPerLevel * 1.1 ^ level
// On XP change; lower volume than per-tick but bursty during leveling.
// ---------------------------------------------------------------------------
function scenarioExponential(): void {
  console.log('\n### Scenario C — exponential XP curve: xpPerLevel * 1.1 ^ level');
  console.log('### Shape: 1 variable in exponent, 1 mul. pow_base is the invertible path.');
  const xpPerLevel = 100;
  const iters = 100_000;

  const levelRef = ref(0 as number);
  const formula = Formula.pow_base(1.1, levelRef).mul(xpPerLevel);

  time('inline native math', (i) => xpPerLevel * Math.pow(1.1, i % 100), iters);
  time(
    'Formula.evaluate() with ref-mutation',
    (i) => {
      levelRef.value = i % 100;
      return formula.evaluate();
    },
    iters,
  );
  time('Formula.evaluate(level) with variable override', (i) => formula.evaluate(i % 100), iters);
  time(
    'Decimal chain (no Formula)',
    (i) => Decimal.mul(Decimal.pow(1.1, i % 100), xpPerLevel),
    iters,
  );
}

// ---------------------------------------------------------------------------
// Scenario D: Modifier-chain accumulation
// 5 stacked modifiers on a base value, chain.apply(base) per query.
// Borglike reference: class tier thresholds with equipment/buff modifiers
// stacked, evaluated during AI tier-selection per monster per tick.
// ---------------------------------------------------------------------------
function scenarioModifierChain(): void {
  console.log('\n### Scenario D — modifier chain apply: 5 stacked buffs on base value');
  console.log('### Shape: +add, +add, ×mul, ×mul, ^exp. Representative per-query.');
  const iters = 100_000;
  const base = 100;

  const chain = createModifierChain('bench');
  chain.add(createAdditiveModifier({ addend: 10 }));
  chain.add(createAdditiveModifier({ addend: 25 }));
  chain.add(createMultiplicativeModifier({ multiplier: 1.5 }));
  chain.add(createMultiplicativeModifier({ multiplier: 2 }));
  chain.add(createExponentialModifier({ exponent: 1.1 }));

  time(
    'inline native math (5 ops)',
    (_i) => {
      let v = base;
      v += 10;
      v += 25;
      v *= 1.5;
      v *= 2;
      v = Math.pow(v, 1.1);
      return v;
    },
    iters,
  );
  time('chain.apply(base)', (_i) => chain.apply(base), iters);
  time('chain.apply(Decimal)', (_i) => chain.apply(bn(base)), iters);
}

// ---------------------------------------------------------------------------
// Scenario E: Formula construction cost (cold-path control)
// Formula creation is one-time per formula; this measures "is construction
// so cheap we can build fresh formulas per-call?" (spoiler: almost certainly
// no, but measuring clarifies the architectural constraint).
// ---------------------------------------------------------------------------
function scenarioFormulaConstruction(): void {
  console.log('\n### Scenario E — Formula construction cost (per-call is an anti-pattern)');
  console.log('### If this is cheap, some per-call construction sites may be fine.');
  const iters = 10_000;
  const baseHp = 10;

  time(
    'Formula.variable(ref).mul(0.15).add(1).mul(baseHp)',
    (i) => {
      const depthRef = ref(i as number);
      return Formula.variable(depthRef).mul(0.15).add(1).mul(baseHp);
    },
    iters,
  );
  time(
    'Formula.variable(number).pow(1.2).mul(baseDmg)',
    (i) =>
      Formula.variable(i + 1)
        .pow(1.2)
        .mul(25),
    iters,
  );
}

/**
 * Scenario F — the "buy max" threshold guard.
 *
 * `calculateMaxAffordable` caches an affordability band so a tick that only
 * moves the resource answers without re-solving the curve. The guard is keyed
 * on a token that evaluates the cost curve, so this measures what that key
 * costs on the hot path against what it saves.
 *
 * Two things to keep in mind when reading or extending this. The function
 * returns a `computed`, so a reactive dep has to be dirtied every iteration or
 * the timing is of Vue's cache rather than the guard. And the guard-miss case
 * has to move the *level*, not the resource, or it stays a hit.
 */
function scenarioMaxAffordableGuard(): void {
  console.log('\n### Scenario F — calculateMaxAffordable threshold guard');
  console.log('### Shape: exponential cost 10 x 1.15^level, "buy max" over a growing wallet');
  const iters = 100_000;

  const hitLevel = ref<DecimalSource>(0);
  const hitCost = Formula.exponential(hitLevel, 10, 1.15);
  const hitWallet = ref<DecimalSource>(1e6);
  const hitResource = createResource(hitWallet);
  const hitAffordable = calculateMaxAffordable(hitCost, hitResource, true, 1e9);
  void hitAffordable.value; // prime the guard before timing
  time(
    'guard hit (resource nudged inside the band)',
    (i) => {
      // Tiny relative moves keep the wallet inside the cached band while still
      // dirtying the computed, which is exactly the production tick the guard exists for.
      hitWallet.value = Decimal.add(1e6, (i % 100) * 1e-6);
      return hitAffordable.value;
    },
    iters,
  );

  const missLevel = ref<DecimalSource>(0);
  const missCost = Formula.exponential(missLevel, 10, 1.15);
  const missResource = createResource(ref<DecimalSource>(1e6));
  const missAffordable = calculateMaxAffordable(missCost, missResource, true, 1e9);
  void missAffordable.value; // prime the guard before timing
  time(
    'guard miss — level moved (full recomputation)',
    (i) => {
      missLevel.value = i % 50;
      return missAffordable.value;
    },
    iters,
  );

  const baseCost = Formula.exponential(ref<DecimalSource>(7), 10, 1.15);
  time(
    'baseline: invertIntegral + evaluateIntegral',
    () => baseCost.invertIntegral(Decimal.add(1e6, baseCost.evaluateIntegral())),
    iters,
  );
  time('baseline: formula.evaluate() (the guard key)', () => baseCost.evaluate(), iters);
}

console.log('OL-525 F3 pre-bench — Formula.evaluate() vs inline vs Decimal chain');
console.log(`Node: ${process.argv[0]}`);
console.log('All timings after 10k-iter warmup; results are ns/op.');

scenarioLinear();
scenarioPolynomial();
scenarioExponential();
scenarioModifierChain();
scenarioFormulaConstruction();
scenarioMaxAffordableGuard();

console.log('\nDone.');
