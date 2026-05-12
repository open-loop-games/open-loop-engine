/**
 * Walker-layer diag mode.
 *
 * Isolates `createTransitionSnapshot` cost independent of the probe loop or
 * simulateTick. Iterates the walker against synthetic engines of varying
 * shape, reports per-call wall time and scaling curves across shape axes.
 *
 * Phase attribution comes from `profile()` labels inside
 * `src/harness/walker/index.ts` — the script's job is iteration + summary.
 */

import { createTransitionSnapshot } from '@/index';
import { buildFixture } from '../fixture';
import { SHAPES, findShape, type ProbeShape } from '../shape';
import { writeEnvelope } from '../envelope';

declare const process: { exit(code: number): never };

export interface WalkerArgs {
  shape?: string;
  iters: number;
  writeTo?: string;
}

interface WalkerStats {
  shape: string;
  purchasables: number;
  producers: number;
  snapshotSize: number;
  samples: number;
  totalMs: number;
  meanUs: number;
  p50Us: number;
  p95Us: number;
  p99Us: number;
  maxUs: number;
}

async function runOne(shape: ProbeShape, iters: number): Promise<WalkerStats> {
  const { engine, accessor } = await buildFixture(shape);

  // Warmup — let Vue flush initial effect queue.
  for (let i = 0; i < Math.min(100, iters); i++) {
    createTransitionSnapshot(engine, accessor);
  }

  const samples: number[] = new Array(iters);
  let snapshotSize = 0;
  const t0 = performance.now();
  for (let i = 0; i < iters; i++) {
    const s0 = performance.now();
    const snap = createTransitionSnapshot(engine, accessor);
    samples[i] = performance.now() - s0;
    if (i === iters - 1) snapshotSize = snap.all.length;
  }
  const totalMs = performance.now() - t0;

  const sorted = [...samples].sort((a, b) => a - b);
  const p = (q: number): number =>
    sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? 0;

  return {
    shape: shape.id,
    purchasables: shape.purchasables,
    producers: shape.producers,
    snapshotSize,
    samples: iters,
    totalMs,
    meanUs: (totalMs / iters) * 1000,
    p50Us: p(0.5) * 1000,
    p95Us: p(0.95) * 1000,
    p99Us: p(0.99) * 1000,
    maxUs: (sorted[sorted.length - 1] ?? 0) * 1000,
  };
}

function formatTable(rows: WalkerStats[]): string {
  const lines: string[] = [];
  const header = [
    'shape',
    'P',
    'pr',
    'snap',
    'samples',
    'mean µs',
    'p50 µs',
    'p95 µs',
    'p99 µs',
    'max µs',
  ].map((s, i) => s.padEnd(i === 0 ? 32 : 10));
  lines.push(header.join(''));
  lines.push('-'.repeat(header.join('').length));
  for (const r of rows) {
    const cells = [
      r.shape.padEnd(32),
      String(r.purchasables).padEnd(10),
      String(r.producers).padEnd(10),
      String(r.snapshotSize).padEnd(10),
      String(r.samples).padEnd(10),
      r.meanUs.toFixed(1).padEnd(10),
      r.p50Us.toFixed(1).padEnd(10),
      r.p95Us.toFixed(1).padEnd(10),
      r.p99Us.toFixed(1).padEnd(10),
      r.maxUs.toFixed(1).padEnd(10),
    ];
    lines.push(cells.join(''));
  }
  return lines.join('\n');
}

export async function runWalkerMode(args: WalkerArgs): Promise<void> {
  const collected: WalkerStats[] = [];

  if (args.shape) {
    const shape = findShape(args.shape);
    if (!shape) {
      console.error(`unknown shape '${args.shape}'. known:`, SHAPES.map((s) => s.id).join(', '));
      return process.exit(1);
    }
    console.log(`# diag walker: shape=${shape.id}, iters=${args.iters}`);
    const row = await runOne(shape, args.iters);
    console.log(formatTable([row]));
    collected.push(row);
  } else {
    console.log(`# diag walker: sweep, iters=${args.iters} per shape\n`);
    for (const shape of SHAPES) {
      const row = await runOne(shape, args.iters);
      collected.push(row);
    }
    console.log(formatTable(collected));
  }

  if (args.writeTo) {
    writeEnvelope(
      args.writeTo,
      'walker',
      {
        shape: args.shape,
        shapes: args.shape ? [args.shape] : SHAPES.map((s) => s.id),
        iters: args.iters,
      },
      { shapes: collected },
    );
  }
}
