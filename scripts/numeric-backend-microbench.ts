#!/usr/bin/env npx tsx --tsconfig tsconfig.scripts.json
/**
 * Microbench for typeof-dispatched arithmetic feasibility: `number | Decimal`
 * union return, vs. status-quo Decimal-statics + vs. pure-number baseline.
 *
 * The `@/primitives/decimal` import runs the engine's patching side-effect,
 * so `Decimal.add` / `Decimal.mul` / etc. in this script are the
 * fast-path-dispatched versions. `add5` / `mul5` / `gt5` below are
 * hand-rolled reference implementations — present only to confirm the
 * patched versions match the reference numbers from the feasibility study.
 *
 * Scenarios 1 and 5 isolate the accumulator self-poisoning shape. A plain
 * `a = Decimal.add(a, b)` reduce wraps the fast-path result to Decimal once
 * and then takes the slow path on every subsequent iteration; the "fresh
 * num+num" and renorm-guarded scenarios measure the actual fast-path cost
 * and the ModifierChain-shaped recovery under `renormIfLayer0`.
 *
 * Usage:
 *   pnpm diag-numeric           # with alias (see package.json)
 *   npx tsx --tsconfig tsconfig.scripts.json scripts/numeric-backend-microbench.ts
 */

import Decimal, { renormIfLayer0 } from '@/primitives/decimal';
import { createSequentialModifier, createAdditiveModifier } from '@/core/modifier';

declare const process: { argv: string[]; exit(code: number): never };

type DSrc = number | Decimal;
const OVERFLOW_ABS = 1e15;

// Framing (5): typeof-dispatched add. Both number → native + overflow
// check, promote on threshold. Either side Decimal → delegate.
function add5(a: DSrc, b: DSrc): DSrc {
  if (typeof a === 'number' && typeof b === 'number') {
    const r = a + b;
    if (r < OVERFLOW_ABS && r > -OVERFLOW_ABS) return r;
    return Decimal.add(a, b);
  }
  return Decimal.add(a, b);
}

function mul5(a: DSrc, b: DSrc): DSrc {
  if (typeof a === 'number' && typeof b === 'number') {
    const r = a * b;
    if (r < OVERFLOW_ABS && r > -OVERFLOW_ABS) return r;
    return Decimal.mul(a, b);
  }
  return Decimal.mul(a, b);
}

function gt5(a: DSrc, b: DSrc): boolean {
  if (typeof a === 'number' && typeof b === 'number') return a > b;
  return Decimal.gt(a, b);
}

// Warmup runs so V8 compiles the hot paths before we measure.
function warmup(): void {
  let sink = 0;
  for (let i = 0; i < 5_000; i++) {
    sink += i;
    const d = new Decimal(i);
    d.add(1);
    Decimal.add(i, 1);
    add5(i, 1);
    mul5(i, 2);
    gt5(i, 500);
  }
  if (sink === -1) console.log('');
}

function time(
  label: string,
  iters: number,
  fn: () => unknown,
): { label: string; ns_per_op: number; total_ms: number; iters: number } {
  // Triple-run, median, to blunt noise from GC and scheduling.
  const runs: number[] = [];
  for (let run = 0; run < 3; run++) {
    const t0 = performance.now();
    const sink: unknown = fn();
    const t1 = performance.now();
    runs.push(t1 - t0);
    if (sink === undefined) console.log('');
  }
  runs.sort((a, b) => a - b);
  const total_ms = runs[1];
  const ns_per_op = (total_ms * 1e6) / iters;
  console.log(
    `  ${label.padEnd(48)}  ${ns_per_op.toFixed(1).padStart(8)} ns/op   (${total_ms.toFixed(2)} ms / ${iters.toLocaleString()} iters)`,
  );
  return { label, ns_per_op, total_ms, iters };
}

// --------------------------------------------------------------------
// Scenario 1: tight add loop — the hot-path shape the engine worries about
// --------------------------------------------------------------------

function benchAddTight(iters: number) {
  console.log('\n### Scenario 1: tight add loop (shape-labeled, OL-690)');

  const a0 = 1;
  const b0 = 3;
  const aD0 = new Decimal(1);
  const bD0 = new Decimal(3);

  time('native number       a + b                ', iters, () => {
    let a = a0;
    const b = b0;
    for (let i = 0; i < iters; i++) {
      a = a + b;
      if (a > 1e14) a = a0;
    }
    return a;
  });

  // Self-poisoning accumulator: iter 0 uses the fast path, returns a wrapped
  // Decimal, then every subsequent iteration misses typeof dispatch. This is
  // the renorm-unguarded accumulator shape.
  time('Decimal.add(a, b)   [self-poisoning acc]  ', iters, () => {
    let a: DSrc = a0;
    const b = b0;
    for (let i = 0; i < iters; i++) {
      a = Decimal.add(a, b);
      if (Decimal.gt(a, 1e14)) a = a0;
    }
    return a;
  });

  // Renorm-guarded accumulator: fast path fires on every iteration.
  time('Decimal.add + renorm [renormed acc]', iters, () => {
    let a: DSrc = a0;
    const b = b0;
    for (let i = 0; i < iters; i++) {
      // A Decimal in comes back a number or a Decimal, never a string.
      a = renormIfLayer0(Decimal.add(a, b)) as DSrc;
      if (Decimal.gt(a, 1e14)) a = a0;
    }
    return a;
  });

  // Fresh inputs every iter: isolates the true single-op fast-path cost with
  // no accumulator carry. Reference for "what does the fast path actually
  // cost when it fires?"
  time('Decimal.add(i, 1)   [fresh num+num/iter]  ', iters, () => {
    let sink: DSrc = 0;
    for (let i = 0; i < iters; i++) {
      sink = Decimal.add(i, 1);
    }
    return sink;
  });

  time('Decimal.add(aD, bD) [both Decimal inputs] ', iters, () => {
    let a = aD0;
    const b = bD0;
    for (let i = 0; i < iters; i++) {
      a = new Decimal(Decimal.add(a, b));
      if (Decimal.gt(a, 1e14)) a = aD0;
    }
    return a;
  });

  time('aD.add(bD)          [method on instance]  ', iters, () => {
    let a = aD0;
    const b = bD0;
    for (let i = 0; i < iters; i++) {
      a = a.add(b);
      if (a.gt(1e14)) a = aD0;
    }
    return a;
  });

  time('add5(a, b)          [framing (5), both num]', iters, () => {
    let a: DSrc = a0;
    const b = b0;
    for (let i = 0; i < iters; i++) {
      a = add5(a, b);
      if (gt5(a, 1e14)) a = a0;
    }
    return a;
  });

  time('add5(aD, bD)        [framing (5), both Dec]', iters, () => {
    let a: DSrc = aD0;
    const b: DSrc = bD0;
    for (let i = 0; i < iters; i++) {
      a = add5(a, b);
      if (gt5(a, 1e14)) a = aD0;
    }
    return a;
  });
}

// --------------------------------------------------------------------
// Scenario 5: ModifierChain regression sentinel
// 5-step additive chain — the canonical engine accumulator shape.
// With renorm-guarded accumulators the fast path fires on every step;
// a regression would push this back toward the ~1000 ns baseline floor.
// --------------------------------------------------------------------

function benchModifierChain(iters: number) {
  console.log('\n### Scenario 5: 5-step additive ModifierChain (OL-690 sentinel)');

  const chain = createSequentialModifier([
    createAdditiveModifier({ addend: 1 }),
    createAdditiveModifier({ addend: 2 }),
    createAdditiveModifier({ addend: 3 }),
    createAdditiveModifier({ addend: 4 }),
    createAdditiveModifier({ addend: 5 }),
  ]);

  time('ModifierChain.apply(0)  [5-step additive] ', iters, () => {
    let acc: DSrc = 0;
    for (let i = 0; i < iters; i++) {
      const r = chain.apply(0);
      // touch the result to prevent DCE; keep cheap.
      acc = typeof r === 'number' ? r : typeof r === 'string' ? 0 : r.mag;
    }
    return acc;
  });
}

// --------------------------------------------------------------------
// Scenario 2: polymorphic call site — mixed number/Decimal inputs
// Tests whether V8 megamorphic deopt degrades the typeof dispatch.
// --------------------------------------------------------------------

function benchAddPolymorphic(iters: number) {
  console.log('\n### Scenario 2: polymorphic (mixed number/Decimal inputs)');

  // Interleave: half calls receive number+number, half receive Decimal+Decimal.
  // V8 must keep the typeof branch effective across both shapes.
  const aNums: DSrc[] = [];
  const bNums: DSrc[] = [];
  for (let i = 0; i < 1000; i++) {
    if (i % 2 === 0) {
      aNums.push(i + 1);
      bNums.push(2);
    } else {
      aNums.push(new Decimal(i + 1));
      bNums.push(new Decimal(2));
    }
  }

  time('Decimal.add(a, b)   [mixed DSrc inputs]   ', iters, () => {
    let acc = 0;
    for (let i = 0; i < iters; i++) {
      const r = Decimal.add(aNums[i % 1000], bNums[i % 1000]);
      acc += typeof r === 'number' ? r : r.layer; // touch to prevent DCE
    }
    return acc;
  });

  time('add5(a, b)          [framing (5), mixed]  ', iters, () => {
    let acc = 0;
    for (let i = 0; i < iters; i++) {
      const r = add5(aNums[i % 1000], bNums[i % 1000]);
      acc += typeof r === 'number' ? r : r.layer;
    }
    return acc;
  });
}

// --------------------------------------------------------------------
// Scenario 3: formula-shaped 3-chain — simulate Formula.evaluate cost
// A minimal stand-in for `Formula.variable(x).mul(10).pow(2).add(100)`
// evaluated once per iteration.
// --------------------------------------------------------------------

function benchFormulaChain(iters: number) {
  console.log('\n### Scenario 3: 3-op formula chain per iteration');

  // shape: result = (x * 10) ^ 2 + 100, for small x
  time('native number       chain                 ', iters, () => {
    let acc = 0;
    for (let i = 0; i < iters; i++) {
      const x = (i % 20) + 1;
      const r = Math.pow(x * 10, 2) + 100;
      acc += r > 1e6 ? 0 : r;
    }
    return acc;
  });

  time('Decimal.X statics   chain [DSrc num inputs]', iters, () => {
    let acc = 0;
    for (let i = 0; i < iters; i++) {
      const x = (i % 20) + 1;
      const r = Decimal.add(Decimal.pow(Decimal.mul(x, 10), 2), 100);
      acc += Decimal.gt(r, 1e6) ? 0 : (r as Decimal).toNumber();
    }
    return acc;
  });

  time('framing (5)         chain [num inputs]    ', iters, () => {
    let acc = 0;
    for (let i = 0; i < iters; i++) {
      const x = (i % 20) + 1;
      const step1 = mul5(x, 10);
      // no pow5 yet — simulate via mul5 with the layer-0 hot path
      const step2 = mul5(step1, step1);
      const r = add5(step2, 100);
      acc += gt5(r, 1e6) ? 0 : typeof r === 'number' ? r : r.toNumber();
    }
    return acc;
  });
}

// --------------------------------------------------------------------
// Scenario 4: allocation pressure (GC-proximal signal)
// --------------------------------------------------------------------

function benchAllocation(iters: number) {
  console.log('\n### Scenario 4: allocation pressure proxy');

  // Report heap delta after each bench as a GC / allocation proxy.
  // Not authoritative (V8 may defer GC) but directional.
  const reportHeap = () => {
    const m = (
      globalThis as { process?: { memoryUsage?: () => { heapUsed: number } } }
    ).process?.memoryUsage?.();
    return m ? `${(m.heapUsed / 1024 / 1024).toFixed(1)} MB` : 'n/a';
  };

  console.log(`  heap before Decimal.add bench:  ${reportHeap()}`);
  time('Decimal.add(a, b)   [iters of num+num]    ', iters, () => {
    let acc: DSrc = 0;
    for (let i = 0; i < iters; i++) acc = Decimal.add(acc, 1);
    return acc;
  });
  console.log(`  heap after  Decimal.add bench:  ${reportHeap()}`);

  console.log(`  heap before add5 bench:         ${reportHeap()}`);
  time('add5(a, b)          [iters of num+num]    ', iters, () => {
    let acc: DSrc = 0;
    for (let i = 0; i < iters; i++) acc = add5(acc, 1);
    return acc;
  });
  console.log(`  heap after  add5 bench:         ${reportHeap()}`);
}

// --------------------------------------------------------------------
// Main
// --------------------------------------------------------------------

async function main() {
  const iters = Number(process.argv[2] ?? 5_000_000);
  console.log(`OL-686 framing (5) microbench`);
  console.log(`Iterations per case: ${iters.toLocaleString()}`);
  console.log(`Node: ${process.argv[0]}`);

  console.log('\nWarmup...');
  warmup();
  warmup();

  benchAddTight(iters);
  benchAddPolymorphic(Math.min(iters, 2_000_000));
  benchFormulaChain(Math.min(iters, 1_000_000));
  benchAllocation(Math.min(iters, 1_000_000));
  benchModifierChain(Math.min(iters, 1_000_000));

  console.log('\nDone.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
