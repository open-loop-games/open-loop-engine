#!/usr/bin/env npx tsx --tsconfig tsconfig.scripts.json
/**
 * Engine diag CLI — walker / probe / diff under one entrypoint.
 *
 * Consolidates what used to be `pnpm bench`, `pnpm micro`, `pnpm
 * profile:walker`, `pnpm profile:probe`, and the un-pnpm'd
 * `scripts/profile-probe-diff.ts`. The instrumented probe loop previously
 * hand-rolled here now lives behind `profile()` labels in
 * `src/harness/probe/event.ts` and `src/harness/walker/index.ts` — this
 * script is a thin dispatcher + envelope wrapper.
 *
 * Usage:
 *   pnpm diag walker                                   # walker sweep
 *   pnpm diag walker --shape=active-wide --iters=5000
 *   pnpm diag probe                                    # probe sweep
 *   pnpm diag probe --shape=active-wide --write-to=profiles/probe.json
 *   pnpm diag diff profiles/baseline.json profiles/candidate.json
 *
 * For a CPU profile:
 *   node --cpu-prof --cpu-prof-dir=profiles \
 *     npx tsx scripts/diag.ts probe --shape=active-wide
 */

import { runWalkerMode } from './lib/diag/modes/walker';
import { runProbeMode } from './lib/diag/modes/probe';
import { runDiff } from './lib/diag/modes/diff';

declare const process: { argv: string[]; exit(code: number): never };

function usage(code = 0): never {
  console.log(`Usage:
  pnpm diag walker [--shape=ID] [--iters=N] [--write-to=PATH]
  pnpm diag probe  [--shape=ID] [--max-iters=N] [--tick-delta=N] [--write-to=PATH] [--profile-out=PATH]
  pnpm diag diff   <baseline.json> <candidate.json> [--wall-threshold=N] [--walker-threshold=N]`);
  return process.exit(code);
}

async function main(): Promise<void> {
  const [mode, ...rest] = process.argv.slice(2);
  if (!mode || mode === '--help' || mode === '-h' || mode === 'help') usage(0);

  if (mode === 'walker') {
    let shape: string | undefined;
    let iters = 2000;
    let writeTo: string | undefined;
    for (const a of rest) {
      if (a.startsWith('--shape=')) shape = a.slice('--shape='.length);
      else if (a.startsWith('--iters=')) iters = Number(a.slice('--iters='.length));
      else if (a.startsWith('--write-to=')) writeTo = a.slice('--write-to='.length);
    }
    await runWalkerMode({ shape, iters, writeTo });
    return;
  }

  if (mode === 'probe') {
    let shape: string | undefined;
    let maxIters = 60_000;
    let tickDelta = 1;
    let writeTo: string | undefined;
    let profileOut: string | undefined;
    for (const a of rest) {
      if (a.startsWith('--shape=')) shape = a.slice('--shape='.length);
      else if (a.startsWith('--max-iters=')) maxIters = Number(a.slice('--max-iters='.length));
      else if (a.startsWith('--tick-delta=')) tickDelta = Number(a.slice('--tick-delta='.length));
      else if (a.startsWith('--write-to=')) writeTo = a.slice('--write-to='.length);
      else if (a.startsWith('--profile-out=')) profileOut = a.slice('--profile-out='.length);
    }
    await runProbeMode({ shape, maxIters, tickDelta, writeTo, profileOut });
    return;
  }

  if (mode === 'diff') {
    const positional: string[] = [];
    let wallThreshold = 10;
    let walkerThreshold = 5;
    for (const a of rest) {
      if (a.startsWith('--wall-threshold='))
        wallThreshold = Number(a.slice('--wall-threshold='.length));
      else if (a.startsWith('--walker-threshold='))
        walkerThreshold = Number(a.slice('--walker-threshold='.length));
      else positional.push(a);
    }
    if (positional.length !== 2) {
      console.error('diff: expected two positional paths');
      return process.exit(2);
    }
    runDiff({
      baseline: positional[0]!,
      candidate: positional[1]!,
      wallThreshold,
      walkerThreshold,
    });
    return;
  }

  console.error(`unknown mode '${mode}'`);
  usage(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
