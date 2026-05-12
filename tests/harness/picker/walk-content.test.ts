import { describe, it, expect } from 'vitest';
import { computed, ref } from 'vue';
import {
  createEngine,
  createModifierChain,
  createMultiplicativeModifier,
  createTemporaryEffectSystem,
  createPersistentEffectSystem,
  type EngineModule,
} from '@/index';
import { walkContent } from '@/harness/picker';

describe('walkContent', () => {
  it('emits one entry per binding across temporary + persistent systems', () => {
    const mod: EngineModule = {
      id: 'fx',
      install(ctx) {
        const damage = createModifierChain('damage');
        const speed = createModifierChain('speed');
        const regen = createModifierChain('regen');

        const temp = createTemporaryEffectSystem({
          id: 'buffs',
          registerTick: (cb) => ctx.onTick(cb),
        });
        temp.register({
          id: 'haste',
          duration: 5,
          modifiers: [
            { chain: speed, modifier: createMultiplicativeModifier({ multiplier: 2 }) },
            { chain: damage, modifier: createMultiplicativeModifier({ multiplier: 1.25 }) },
          ],
        });

        const pers = createPersistentEffectSystem({ id: 'auras' });
        const libraryBuilt = ref(true);
        pers.register({
          id: 'library-bonus',
          active: computed(() => libraryBuilt.value),
          modifiers: [
            { chain: regen, modifier: createMultiplicativeModifier({ multiplier: 1.5 }) },
          ],
        });
      },
    };
    const engine = createEngine({
      gameId: 'wco-1',
      persistence: false,
      persistenceNamespace: `wco-1-${Math.random().toString(36).slice(2)}`,
    });
    engine.use(mod);
    engine.start();

    const entries = walkContent(engine);
    expect(entries).toHaveLength(3);
    expect(entries.map((e) => e.label).sort()).toEqual([
      'auras.library-bonus[0]',
      'buffs.haste[0]',
      'buffs.haste[1]',
    ]);
    for (const e of entries) {
      expect(e.address.source).toBe('content');
    }
    engine.stop();
  });

  it('defs with no modifiers produce no entries', () => {
    const mod: EngineModule = {
      id: 'fx',
      install(ctx) {
        const temp = createTemporaryEffectSystem({
          id: 'buffs',
          registerTick: (cb) => ctx.onTick(cb),
        });
        temp.register({ id: 'no-mods', duration: 5 });
      },
    };
    const engine = createEngine({
      gameId: 'wco-2',
      persistence: false,
      persistenceNamespace: `wco-2-${Math.random().toString(36).slice(2)}`,
    });
    engine.use(mod);
    engine.start();

    expect(walkContent(engine)).toEqual([]);
    engine.stop();
  });

  it('resolves factory-style modifier bindings at walk time', () => {
    const mod: EngineModule = {
      id: 'fx',
      install(ctx) {
        const chain = createModifierChain('maxHealth');
        const temp = createTemporaryEffectSystem({
          id: 'buffs',
          registerTick: (cb) => ctx.onTick(cb),
        });
        temp.register({
          id: 'shield',
          duration: 5,
          modifiers: () => [
            { chain, modifier: () => createMultiplicativeModifier({ multiplier: 3 }) },
          ],
        });
      },
    };
    const engine = createEngine({
      gameId: 'wco-3',
      persistence: false,
      persistenceNamespace: `wco-3-${Math.random().toString(36).slice(2)}`,
    });
    engine.use(mod);
    engine.start();

    const entries = walkContent(engine);
    expect(entries).toHaveLength(1);
    expect(entries[0].label).toBe('buffs.shield[0]');
    expect(entries[0].address.source).toBe('content');
    engine.stop();
  });

  it('engine without EffectSystemRegistryKey degrades to empty array', () => {
    const engine = createEngine({
      gameId: 'wco-4',
      persistence: false,
      persistenceNamespace: `wco-4-${Math.random().toString(36).slice(2)}`,
    });
    engine.use({ id: 'noop', install() {} });
    engine.start();
    expect(walkContent(engine)).toEqual([]);
    engine.stop();
  });
});
