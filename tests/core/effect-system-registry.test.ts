import { describe, it, expect, beforeEach } from 'vitest';
import { computed, ref } from 'vue';
import {
  createEffectSystemRegistry,
  withEffectSystemRegistry,
  getCurrentEffectSystemRegistry,
} from '@/core/registries';
import { createTemporaryEffectSystem } from '@/systems/temporary-effect';
import { createPersistentEffectSystem } from '@/systems/persistent-effect';
import { resetAllPersistentContexts } from '@/core/persistence';

beforeEach(() => {
  resetAllPersistentContexts();
});

describe('EffectSystemRegistry', () => {
  it('starts empty', () => {
    const registry = createEffectSystemRegistry();
    expect(registry.size).toBe(0);
    expect(registry.all()).toEqual([]);
  });

  it('auto-registers temporary and persistent systems created in scope', () => {
    const registry = createEffectSystemRegistry();
    withEffectSystemRegistry(registry, () => {
      createTemporaryEffectSystem({ id: 'buffs', registerTick: () => () => {} });
      createPersistentEffectSystem({ id: 'conditions' });
    });

    expect(registry.size).toBe(2);
    expect(registry.has('buffs')).toBe(true);
    expect(registry.has('conditions')).toBe(true);
    expect(registry.get('buffs')?.kind).toBe('temporary');
    expect(registry.get('conditions')?.kind).toBe('persistent');
  });

  it('preserves insertion order in all()', () => {
    const registry = createEffectSystemRegistry();
    withEffectSystemRegistry(registry, () => {
      createTemporaryEffectSystem({ id: 'first', registerTick: () => () => {} });
      createPersistentEffectSystem({ id: 'second' });
      createTemporaryEffectSystem({ id: 'third', registerTick: () => () => {} });
    });
    expect(registry.all().map((s) => s.id)).toEqual(['first', 'second', 'third']);
  });

  it('throws on duplicate effect-system id within the same registry', () => {
    const registry = createEffectSystemRegistry();
    expect(() =>
      withEffectSystemRegistry(registry, () => {
        createTemporaryEffectSystem({ id: 'dup', registerTick: () => () => {} });
        createPersistentEffectSystem({ id: 'dup' });
      }),
    ).toThrow(/duplicate effect-system id "dup"/);
  });

  it('construction outside a withEffectSystemRegistry block does not register', () => {
    expect(getCurrentEffectSystemRegistry()).toBeUndefined();

    const system = createTemporaryEffectSystem({ id: 'lonely', registerTick: () => () => {} });
    expect(system.id).toBe('lonely');

    const registry = createEffectSystemRegistry();
    expect(registry.has('lonely')).toBe(false);
  });

  it('allDefs() on temporary system snapshots registered defs in insertion order', () => {
    const system = createTemporaryEffectSystem({ id: 'buffs', registerTick: () => () => {} });
    system.register({ id: 'haste', duration: 5 });
    system.register({ id: 'shield', duration: 10 });

    const defs = system.allDefs();
    expect(defs).toHaveLength(2);
    expect(defs.map((d) => d.id)).toEqual(['haste', 'shield']);
  });

  it('allDefs() on persistent system snapshots registered defs', () => {
    const flag = ref(false);
    const system = createPersistentEffectSystem({ id: 'conditions' });
    system.register({ id: 'library', active: computed(() => flag.value) });
    system.register({ id: 'temple', active: computed(() => !flag.value) });

    const defs = system.allDefs();
    expect(defs).toHaveLength(2);
    expect(defs.map((d) => d.id).sort()).toEqual(['library', 'temple']);
  });
});
