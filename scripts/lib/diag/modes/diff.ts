/**
 * Diff two probe-mode envelope JSONs and report per-shape perf deltas.
 * Exits non-zero on regressions beyond configured thresholds so CI / `pnpm`
 * scripts can gate on perf regressions.
 *
 * Default thresholds: wallMs +10% | walker% +5 percentage points.
 * Walker% is the fraction of wall time spent in `walker.buildSnapshot`
 * across rebuilds — the dominant shape of probe-layer regressions.
 */

import { readFileSync } from 'node:fs';
import type { ProfileReport } from '@/index';
import { fmtMs, fmtPct, fmtPp } from '../format';

declare const process: { exit(code: number): never };

interface ProbeShapeStats {
  shape: string;
  wallMs: number;
  terminated: string;
  simTimeReached: number;
  profile: ProfileReport;
}

interface ProbeEnvelope {
  mode: string;
  timestamp: string;
  config: {
    mode?: string;
    shapes?: string[];
    gitSha?: string;
    gitDirty?: boolean;
    tickDelta?: number;
    maxIters?: number;
  };
  result: { shapes: ProbeShapeStats[] };
}

export interface DiffArgs {
  baseline: string;
  candidate: string;
  wallThreshold: number;
  walkerThreshold: number;
}

function loadEnvelope(path: string): ProbeEnvelope {
  return JSON.parse(readFileSync(path, 'utf8')) as ProbeEnvelope;
}

function phaseMs(report: ProfileReport, label: string): number {
  return report.entries.find((e) => e.name === label)?.totalMs ?? 0;
}

function phaseCalls(report: ProfileReport, label: string): number {
  return report.entries.find((e) => e.name === label)?.calls ?? 0;
}

function walkerPct(s: ProbeShapeStats): number {
  return s.wallMs > 0 ? (phaseMs(s.profile, 'walker.buildSnapshot') / s.wallMs) * 100 : 0;
}

function formatHeader(label: string, env: ProbeEnvelope): string {
  const { gitSha, gitDirty, tickDelta, maxIters } = env.config;
  const sha = gitSha ?? '?';
  const dirty = gitDirty ? '-dirty' : '';
  return `  ${label}: ${env.mode} @ ${env.timestamp}  git=${sha}${dirty}  tickDelta=${tickDelta ?? '?'} maxIters=${maxIters ?? '?'}`;
}

export function runDiff(args: DiffArgs): void {
  const baseline = loadEnvelope(args.baseline);
  const candidate = loadEnvelope(args.candidate);

  const baseMap = new Map(baseline.result.shapes.map((s) => [s.shape, s]));
  const candMap = new Map(candidate.result.shapes.map((s) => [s.shape, s]));

  console.log(`# diag diff`);
  console.log(formatHeader('baseline ', baseline));
  console.log(formatHeader('candidate', candidate));
  console.log(
    `  thresholds: wallMs ±${args.wallThreshold}% | walker% ±${args.walkerThreshold}pp (regression = candidate worse)`,
  );
  console.log();

  let regressionRows = 0;

  for (const [shape, before] of baseMap) {
    const after = candMap.get(shape);
    if (!after) continue;

    const wallPctDelta =
      before.wallMs > 0 ? ((after.wallMs - before.wallMs) / before.wallMs) * 100 : 0;
    const walkerBefore = walkerPct(before);
    const walkerAfter = walkerPct(after);
    const walkerPpDelta = walkerAfter - walkerBefore;

    const regressed = wallPctDelta > args.wallThreshold || walkerPpDelta > args.walkerThreshold;
    const improved = wallPctDelta < -args.wallThreshold || walkerPpDelta < -args.walkerThreshold;
    const marker = regressed ? '✗' : improved ? '▼' : ' ';
    if (regressed) regressionRows++;

    const beforeRebuilds = phaseCalls(before.profile, 'walker.buildSnapshot');
    const afterRebuilds = phaseCalls(after.profile, 'walker.buildSnapshot');
    const beforeAdv = phaseCalls(before.profile, 'probe.advance');
    const afterAdv = phaseCalls(after.profile, 'probe.advance');

    console.log(`${marker} ${shape}`);
    console.log(
      `    wall:    ${fmtMs(before.wallMs)} → ${fmtMs(after.wallMs)} (${fmtPct(wallPctDelta)})`,
    );
    console.log(
      `    walker%: ${walkerBefore.toFixed(0)}% → ${walkerAfter.toFixed(0)}% (${fmtPp(walkerPpDelta)})`,
    );
    console.log(
      `    rebuilds: ${beforeRebuilds} → ${afterRebuilds}  advances: ${beforeAdv} → ${afterAdv}`,
    );
  }

  const missing = [...baseMap.keys()].filter((s) => !candMap.has(s));
  const added = [...candMap.keys()].filter((s) => !baseMap.has(s));
  if (missing.length > 0) console.log(`\n  missing in candidate: ${missing.join(', ')}`);
  if (added.length > 0) console.log(`\n  new in candidate: ${added.join(', ')}`);

  if (regressionRows > 0) {
    console.error(`\n✗ ${regressionRows} shape(s) regressed beyond threshold — see rows marked ✗`);
    return process.exit(1);
  }
  console.log(`\n✓ no regression beyond threshold`);
}
