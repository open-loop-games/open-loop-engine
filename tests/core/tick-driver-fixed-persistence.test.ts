import { describe, it, expect } from 'vitest';
import { createEngine } from '@/index';
import { getAllPersistentRefs } from '@/core/persistence';

function createMapStorage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => m.set(k, v),
    removeItem: (k: string) => m.delete(k),
    _map: m,
  };
}

/**
 * A namespaced fixed-mode engine must include its tick accumulator in its own
 * namespaced save and restore it deterministically across a reload. The bug:
 * the accumulator registered under a process-global `tick-driver_${counter}`
 * context outside the engine's namespace, so it was filtered out of the
 * namespaced save entirely and stranded in the default bucket
 * (open-loop-engine#9).
 */
describe('fixed-mode accumulator survives a namespaced save/reload', () => {
  it('the accumulator context lives in the engine namespace, not the default bucket', () => {
    const engine = createEngine({
      gameId: 'g',
      persistenceNamespace: 'alpha',
      tickMode: 'fixed',
      fixedDt: 0.02,
    });
    engine.start();

    const inNamespace = [...getAllPersistentRefs('alpha').keys()];
    const inDefault = [...getAllPersistentRefs(undefined).keys()];

    expect(inNamespace).toContain('tick-driver.accumulator');
    // The strand-in-default-bucket regression: the accumulator must NOT leak
    // into the unnamespaced bucket, where the namespaced save can't see it.
    expect(inDefault.some((k) => k.includes('accumulator'))).toBe(false);

    engine.dispose();
  });

  it('the banked remainder is restored, driving the next sub-step early', () => {
    const storage = createMapStorage();
    const make = () =>
      createEngine({
        gameId: 'g',
        persistenceNamespace: 'alpha',
        tickMode: 'fixed',
        fixedDt: 0.02,
        storageAdapter: storage,
      });

    const a = make();
    a.start();
    a.tickDriver.advanceTime(0.05); // drains two 0.02 sub-steps, banks 0.01
    a.save();
    a.dispose();

    const b = make();
    b.start();
    expect(b.load().success).toBe(true);

    // With the 0.01 remainder restored, a further 0.011 crosses one 0.02 step
    // (0.01 + 0.011 = 0.021 → one sub-tick). Without restore the accumulator
    // starts at 0 and 0.011 < 0.02 fires nothing.
    let ticks = 0;
    b.tickDriver.onTick(() => ticks++);
    b.tickDriver.advanceTime(0.011);
    expect(ticks).toBe(1);

    b.dispose();
  });
});
