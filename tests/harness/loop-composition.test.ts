import { describe, it, expect } from 'vitest';
import type { Analyzer, AnalyzerResult } from '@/primitives/types';
import { createLoop, createLoopLog } from '@/systems';
import { runMatrix } from '@/harness';

/** An analyzer that counts finalize calls. The presence of this counter
 *  inside the factory proves fresh construction per run is honored. */
function createLoopCounterAnalyzer(): Analyzer {
  let finalized = 0;
  return {
    name: 'loop-counter',
    onLoopFinalize: () => {
      finalized += 1;
    },
    summarize: (): AnalyzerResult => ({
      name: 'loop-counter',
      metrics: { finalized },
    }),
  };
}

describe('runMatrix composition with direct LoopLog finalize subscription', () => {
  it('delivers one onLoopFinalize call per completed loop, isolated per run', () => {
    // Each cell.tick drives an internally-registered loop tick handler.
    // The loop ends every 1 second of elapsed time — at dt=0.05, that's
    // one loop per 20 ticks. 100 ticks ⇒ 5 finalized loops per run.
    let loopTickHandler: ((dt: number) => void) | null = null;

    const result = runMatrix({
      cells: [
        {
          name: 'five-loops',
          setup: () => {
            const analyzers = [createLoopCounterAnalyzer()];
            const loop = createLoop({
              endCondition: () => loop.elapsed.value >= 1.0 - 1e-9,
              thingsToReset: [],
              registerTick: (cb) => {
                loopTickHandler = cb;
                return () => {
                  loopTickHandler = null;
                };
              },
            });
            const log = createLoopLog({ loop, metrics: {} });
            for (const analyzer of analyzers) {
              const hook = analyzer.onLoopFinalize;
              if (hook) log.on('finalize', (entry) => hook(entry));
            }
            loop.run();
            return analyzers;
          },
          tick: (dt) => loopTickHandler?.(dt),
          ticks: 100,
          tickDelta: 0.05,
        },
      ],
      seeds: [1, 2],
    });

    const perRunFinalized = result.cells[0]!.runs.map(
      (r) => r.analyzerResults[0]!.metrics.finalized,
    );
    expect(perRunFinalized).toEqual([5, 5]);
  });
});
