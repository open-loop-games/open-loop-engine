import { describe, it, expect } from 'vitest';
import type { Analyzer, AnalyzerSummary } from '@/primitives/types';
import { createCycle, createCycleLog } from '@/systems';
import { runMatrix } from '@/harness';

/** An analyzer that counts finalize calls. The presence of this counter
 *  inside the factory proves fresh construction per run is honored. */
function createLoopCounterAnalyzer(): Analyzer {
  let finalized = 0;
  return {
    id: 'cycle-counter',
    onRunFinalize: () => {
      finalized += 1;
    },
    summarize: (): AnalyzerSummary => ({
      id: 'cycle-counter',
      metrics: { finalized },
    }),
  };
}

describe('runMatrix composition with direct CycleLog finalize subscription', () => {
  it('delivers one onRunFinalize call per completed cycle, isolated per run', () => {
    // Each cell.tick drives an internally-registered cycle tick handler.
    // The cycle ends every 1 second of elapsed time — at dt=0.05, that's
    // one cycle per 20 ticks. 100 ticks ⇒ 5 finalized cycles per run.
    let loopTickHandler: ((dt: number) => void) | null = null;

    const result = runMatrix({
      cells: [
        {
          id: 'five-cycles',
          setup: () => {
            const analyzers = [createLoopCounterAnalyzer()];
            const cycle = createCycle({
              endCondition: () => cycle.elapsed.value >= 1.0 - 1e-9,
              thingsToReset: [],
              registerTick: (cb) => {
                loopTickHandler = cb;
                return () => {
                  loopTickHandler = null;
                };
              },
            });
            const log = createCycleLog({ cycle, metrics: {} });
            for (const analyzer of analyzers) {
              const hook = analyzer.onRunFinalize;
              if (hook) log.on('finalized', (entry) => hook(entry));
            }
            cycle.resume();
            return analyzers;
          },
          tick: (dt) => loopTickHandler?.(dt),
          iterations: 100,
          tickDelta: 0.05,
        },
      ],
      seeds: [1, 2],
    });

    const perRunFinalized = result.cells[0]!.runs.map(
      (r) => r.analyzerSummaries[0]!.metrics.finalized,
    );
    expect(perRunFinalized).toEqual([5, 5]);
  });
});
