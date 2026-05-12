/**
 * Probe-layer diag mode.
 *
 * Measures end-to-end `eventDrivenProbe` wall time per synthetic engine
 * shape. Enables the engine profiler so walker / advance / fast-tick phase
 * attribution comes from `profile()` labels inside
 * `src/harness/probe/event.ts` and `src/harness/walker/index.ts` rather
 * than a reimplemented loop.
 *
 * Two sub-modes:
 * - sweep (default): run every shape, print a summary table
 * - single (`--shape=foo`): run one shape, print full breakdown;
 *   suitable for `node --cpu-prof` flame graphs
 */

import {
  enableProfiling,
  getProfileReport,
  eventDrivenProbe,
  type Engine,
  type ProfileReport,
} from '@/index';
import { Session } from 'node:inspector/promises';
import { writeFileSync } from 'node:fs';
import { buildFixture } from '../fixture';
import { SHAPES, findShape, type ProbeShape } from '../shape';
import { fmtMs, fmtSec } from '../format';
import { writeEnvelope } from '../envelope';

declare const process: { exit(code: number): never };

export interface ProbeArgs {
  shape?: string;
  maxIters: number;
  tickDelta: number;
  profileOut?: string;
  writeTo?: string;
}

interface ProbeStats {
  shape: string;
  wallMs: number;
  terminated: 'predicate' | 'maxSimTime';
  simTimeReached: number;
  profile: ProfileReport;
}

async function runOne(
  shape: ProbeShape,
  tickDelta: number,
  maxIters: number,
  profileOut?: string,
): Promise<ProbeStats> {
  const { engine, accessor, predicate } = await buildFixture(shape);

  let session: Session | undefined;
  if (profileOut) {
    session = new Session();
    session.connect();
    await session.post('Profiler.enable');
    await session.post('Profiler.start');
  }

  const dispose = enableProfiling();
  const t0 = performance.now();

  // Single-seed single-beat sweep — reusing the pre-built fixture engine
  // (buildEngine is called once per `(beat × seed)`; one of each here).
  const results = eventDrivenProbe({
    buildEngine: (): Engine => engine,
    buildAccessor: () => accessor,
    beats: [{ id: shape.id, predicate }],
    seeds: [0],
    maxSimTime: shape.budgetSec,
    tickDelta,
  });

  const wallMs = performance.now() - t0;
  const report = getProfileReport();
  dispose();

  const counts = results[0]!.counts;
  const terminated: ProbeStats['terminated'] = counts.predicate > 0 ? 'predicate' : 'maxSimTime';
  const simTimeReached = results[0]!.terminationTime?.avg ?? shape.budgetSec;

  if (session && profileOut) {
    const { profile } = await session.post('Profiler.stop');
    writeFileSync(profileOut, JSON.stringify(profile));
    await session.post('Profiler.disable');
    session.disconnect();
  }

  // maxIters is no longer a hard-stop — the engine's probe runs to
  // predicate or maxSimTime. Parameter preserved in the envelope for
  // backward-compat with historical baselines.
  void maxIters;

  return {
    shape: shape.id,
    wallMs,
    terminated,
    simTimeReached,
    profile: report,
  };
}

function phaseMs(report: ProfileReport, label: string): number {
  return report.entries.find((e) => e.name === label)?.totalMs ?? 0;
}

function phaseCalls(report: ProfileReport, label: string): number {
  return report.entries.find((e) => e.name === label)?.calls ?? 0;
}

function printOne(s: ProbeStats): void {
  const walkerMs = phaseMs(s.profile, 'walker.buildSnapshot');
  const advanceMs = phaseMs(s.profile, 'probe.advance');
  const stasisMs = phaseMs(s.profile, 'probe.stasisFastTick');
  const tieMs = phaseMs(s.profile, 'probe.tieFastTick');
  const opaqueMs = phaseMs(s.profile, 'probe.opaqueTick');

  console.log(`\n## ${s.shape}`);
  console.log(`   wall=${fmtMs(s.wallMs)}  term=${s.terminated}  sim=${fmtSec(s.simTimeReached)}`);
  console.log(
    `   rebuilds=${phaseCalls(s.profile, 'walker.buildSnapshot')}  ` +
      `advances=${phaseCalls(s.profile, 'probe.advance')}  ` +
      `stasis=${phaseCalls(s.profile, 'probe.stasisFastTick')}  ` +
      `ties=${phaseCalls(s.profile, 'probe.tieFastTick')}  ` +
      `opaque=${phaseCalls(s.profile, 'probe.opaqueTick')}`,
  );
  const totalMs = s.wallMs || 1;
  const pct = (ms: number): string => `${((ms / totalMs) * 100).toFixed(0)}%`;
  console.log(
    `   phase split: walker=${fmtMs(walkerMs)} (${pct(walkerMs)})  ` +
      `advance=${fmtMs(advanceMs)} (${pct(advanceMs)})  ` +
      `stasis=${fmtMs(stasisMs)} (${pct(stasisMs)})  ` +
      `tie=${fmtMs(tieMs)} (${pct(tieMs)})  ` +
      `opaque=${fmtMs(opaqueMs)} (${pct(opaqueMs)})`,
  );
}

export async function runProbeMode(args: ProbeArgs): Promise<void> {
  const collected: ProbeStats[] = [];

  if (args.shape) {
    const shape = findShape(args.shape);
    if (!shape) {
      console.error(`unknown shape '${args.shape}'. known:`, SHAPES.map((s) => s.id).join(', '));
      return process.exit(1);
    }
    console.log(`# diag probe: shape=${shape.id}, tickDelta=${args.tickDelta}`);
    const stats = await runOne(shape, args.tickDelta, args.maxIters, args.profileOut);
    printOne(stats);
    collected.push(stats);
    if (args.profileOut) console.log(`   profile written to ${args.profileOut}`);
  } else {
    console.log(`# diag probe: sweep, tickDelta=${args.tickDelta}`);
    for (const shape of SHAPES) {
      const stats = await runOne(shape, args.tickDelta, args.maxIters);
      printOne(stats);
      collected.push(stats);
    }
  }

  if (args.writeTo) {
    writeEnvelope(
      args.writeTo,
      'probe',
      {
        shape: args.shape,
        shapes: args.shape ? [args.shape] : SHAPES.map((s) => s.id),
        tickDelta: args.tickDelta,
        maxIters: args.maxIters,
      },
      { shapes: collected },
    );
  }
}
