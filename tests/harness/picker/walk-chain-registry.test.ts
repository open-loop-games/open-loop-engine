import { describe, it, expect } from 'vitest';
import {
  createEngine,
  createModifierChain,
  createMultiplicativeModifier,
  type EngineModule,
} from '@/index';
import { walkChainRegistry } from '@/harness/picker';

describe('walkChainRegistry', () => {
  it('emits chain-apply + per-modifier entries across all registered chains', () => {
    const mod: EngineModule = {
      id: 'economy',
      install() {
        const speed = createModifierChain('speed');
        speed.add(createMultiplicativeModifier({ multiplier: 2 }));
        speed.add(createMultiplicativeModifier({ multiplier: 1.5 }));
        const damage = createModifierChain('damage');
        damage.add(createMultiplicativeModifier({ multiplier: 3 }));
      },
    };
    const engine = createEngine({ gameId: 'wcr-1', persistence: false });
    engine.use(mod);
    engine.start();

    const entries = walkChainRegistry(engine);
    // 2 chain-apply entries + 3 per-modifier entries
    expect(entries).toHaveLength(5);
    expect(entries.map((e) => e.label)).toEqual([
      'speed[*]',
      'speed[0]',
      'speed[1]',
      'damage[*]',
      'damage[0]',
    ]);
    expect(entries.every((e) => e.address.walker === 'chain-registry')).toBe(true);

    engine.stop();
  });

  it('empty chains still produce a chain-apply entry (perturbable-before-populated)', () => {
    const mod: EngineModule = {
      id: 'empty',
      install() {
        createModifierChain('empty-chain');
      },
    };
    const engine = createEngine({ gameId: 'wcr-2', persistence: false });
    engine.use(mod);
    engine.start();

    const entries = walkChainRegistry(engine);
    expect(entries).toHaveLength(1);
    expect(entries[0].label).toBe('empty-chain[*]');
    expect(entries[0].address).toMatchObject({
      walker: 'chain-registry',
      chainId: 'empty-chain',
      kind: 'chain-apply',
    });
    expect(entries[0].indexInChain).toBe(-1);

    engine.stop();
  });

  it('engine without ChainRegistryKey degrades to empty array', () => {
    const engine = createEngine({ gameId: 'wcr-3', persistence: false });
    // Never started — no injections populated yet.
    expect(walkChainRegistry(engine)).toEqual([]);
  });
});
