import { describe, it, expect } from 'vitest';
import { createModifierChain, createMultiplicativeModifier } from '@/core/modifier';
import { enableProfiling, getProfileReport } from '@/core/profiler';

describe('profiler wrap sites', () => {
  it('records modifier.chain.apply while profiling is on', () => {
    const chain = createModifierChain('profiled');
    chain.add(createMultiplicativeModifier({ multiplier: 2 }));
    const off = enableProfiling();
    try {
      chain.apply(3);
      expect(getProfileReport().entries.map((e) => e.name)).toContain('modifier.chain.apply');
    } finally {
      off();
    }
  });
});
