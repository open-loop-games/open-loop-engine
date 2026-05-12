import { describe, it, expect, vi } from 'vitest';
import { ref } from 'vue';
import { Decimal, bn } from '@/primitives/decimal';
import {
  createAdditiveModifier,
  createMultiplicativeModifier,
  createExponentialModifier,
  createSequentialModifier,
  createModifierChain,
} from '@/core/modifier';
import { withPersistentContext } from '@/core/persistence';

describe('Modifier system', () => {
  it('additive modifier adds to value', () => {
    const mod = createAdditiveModifier({ addend: bn(10) });
    const result = mod.apply(bn(100));
    expect(new Decimal(result).eq(110)).toBe(true);
  });
  it('multiplicative modifier multiplies value', () => {
    const mod = createMultiplicativeModifier({ multiplier: bn(2) });
    const result = mod.apply(bn(50));
    expect(new Decimal(result).eq(100)).toBe(true);
  });
  it('exponential modifier raises to power', () => {
    const mod = createExponentialModifier({ exponent: bn(2) });
    const result = mod.apply(bn(3));
    expect(new Decimal(result).eq(9)).toBe(true);
  });
  it('sequential modifier chains in order', () => {
    const seq = createSequentialModifier([
      createAdditiveModifier({ addend: bn(10) }),
      createMultiplicativeModifier({ multiplier: bn(2) }),
    ]);
    const result = seq.apply(bn(100));
    expect(new Decimal(result).eq(220)).toBe(true);
  });
  it('sequential modifier inverts in reverse', () => {
    const add = createAdditiveModifier({ addend: bn(10) });
    const mul = createMultiplicativeModifier({ multiplier: bn(2) });
    const seq = createSequentialModifier([add, mul]);
    const inverted = seq.invert!(bn(220));
    expect(new Decimal(inverted).eq(100)).toBe(true);
  });
  it('disabled modifiers are skipped', () => {
    const enabled = ref(false);
    const mod = createAdditiveModifier({ addend: bn(999), enabled });
    const seq = createSequentialModifier([mod]);
    const result = seq.apply(bn(100));
    expect(new Decimal(result).eq(100)).toBe(true);
  });

  describe('currentValue', () => {
    it('additive modifier exposes current addend', () => {
      const addend = ref(bn(10));
      const mod = createAdditiveModifier({ addend });
      expect(mod.currentValue.value.eq(10)).toBe(true);
      addend.value = bn(25);
      expect(mod.currentValue.value.eq(25)).toBe(true);
    });
    it('multiplicative modifier exposes current multiplier', () => {
      const multiplier = ref(bn(3));
      const mod = createMultiplicativeModifier({ multiplier });
      expect(mod.currentValue.value.eq(3)).toBe(true);
      multiplier.value = bn(5);
      expect(mod.currentValue.value.eq(5)).toBe(true);
    });
    it('exponential modifier exposes current exponent', () => {
      const exponent = ref(bn(2));
      const mod = createExponentialModifier({ exponent });
      expect(mod.currentValue.value.eq(2)).toBe(true);
      exponent.value = bn(0.5);
      expect(mod.currentValue.value.eq(0.5)).toBe(true);
    });
  });

  describe('children', () => {
    it('sequential modifier exposes children array', () => {
      const add = createAdditiveModifier({ addend: bn(10) });
      const mul = createMultiplicativeModifier({ multiplier: bn(2) });
      const seq = createSequentialModifier([add, mul]);
      expect(seq.children).toHaveLength(2);
      expect(seq.children[0]).toBe(add);
      expect(seq.children[1]).toBe(mul);
    });
    it('children reflect enabled state', () => {
      const enabled = ref(true);
      const mod = createAdditiveModifier({ addend: bn(5), enabled });
      const seq = createSequentialModifier([mod]);
      expect(seq.children[0].enabled).toBe(enabled);
      enabled.value = false;
      expect(seq.children[0].enabled!.value).toBe(false);
    });
    it('children currentValue is readable for inspection', () => {
      const add = createAdditiveModifier({ addend: bn(7) });
      const mul = createMultiplicativeModifier({ multiplier: bn(3) });
      const seq = createSequentialModifier([add, mul]);
      const [child0, child1] = seq.children;
      expect((child0 as any).currentValue.value.eq(7)).toBe(true);
      expect((child1 as any).currentValue.value.eq(3)).toBe(true);
    });
  });
});

describe('createModifierChain', () => {
  it('starts as identity (passthrough)', () => {
    const chain = createModifierChain('test');
    expect(Decimal.eq(chain.apply(100), 100)).toBe(true);
    expect(chain.modifiers.length).toBe(0);
  });

  it('applies added modifiers in order', () => {
    const chain = createModifierChain('prod');
    chain.add(createAdditiveModifier({ addend: 10 }));
    chain.add(createMultiplicativeModifier({ multiplier: 2 }));

    // (100 + 10) × 2 = 220
    expect(Decimal.eq(chain.apply(100), 220)).toBe(true);
  });

  it('supports inversion when all modifiers are invertible', () => {
    const chain = createModifierChain('inv');
    chain.add(createAdditiveModifier({ addend: 10 }));
    chain.add(createMultiplicativeModifier({ multiplier: 2 }));

    const result = chain.apply(100); // 220
    expect(chain.invert).toBeDefined();
    expect(Decimal.eq(chain.invert!(result), 100)).toBe(true);
  });

  it('add returns remove function', () => {
    const chain = createModifierChain('remove');
    const mod = createAdditiveModifier({ addend: 50 });
    const remove = chain.add(mod);

    expect(Decimal.eq(chain.apply(100), 150)).toBe(true);

    remove();
    expect(Decimal.eq(chain.apply(100), 100)).toBe(true);
    expect(chain.modifiers.length).toBe(0);
  });

  it('remove by reference', () => {
    const chain = createModifierChain('ref-remove');
    const mod = createAdditiveModifier({ addend: 25 });
    chain.add(mod);
    chain.remove(mod);

    expect(Decimal.eq(chain.apply(100), 100)).toBe(true);
  });

  it('remove is no-op for unknown modifier', () => {
    const chain = createModifierChain('noop');
    const mod = createAdditiveModifier({ addend: 10 });
    chain.add(mod);

    const other = createAdditiveModifier({ addend: 20 });
    chain.remove(other); // should not throw or change anything

    expect(chain.modifiers.length).toBe(1);
    expect(Decimal.eq(chain.apply(100), 110)).toBe(true);
  });

  it('exposes modifiers as readonly list', () => {
    const chain = createModifierChain('list');
    const mod1 = createAdditiveModifier({ addend: 1 });
    const mod2 = createMultiplicativeModifier({ multiplier: 2 });
    chain.add(mod1);
    chain.add(mod2);

    expect(chain.modifiers.length).toBe(2);
  });

  it('emits change event on add', () => {
    const chain = createModifierChain('evt-add');
    const changeCb = vi.fn();
    chain.on('change', changeCb);

    chain.add(createAdditiveModifier({ addend: 1 }));
    expect(changeCb).toHaveBeenCalledOnce();
  });

  it('emits change event on remove', () => {
    const chain = createModifierChain('evt-rm');
    const mod = createAdditiveModifier({ addend: 1 });
    chain.add(mod);

    const changeCb = vi.fn();
    chain.on('change', changeCb);
    chain.remove(mod);
    expect(changeCb).toHaveBeenCalledOnce();
  });

  it('respects modifier enabled flags', () => {
    const chain = createModifierChain('enabled');
    const enabled = ref(true);
    chain.add(createAdditiveModifier({ addend: 50, enabled }));

    expect(Decimal.eq(chain.apply(100), 150)).toBe(true);

    enabled.value = false;
    expect(Decimal.eq(chain.apply(100), 100)).toBe(true);
  });

  it('exposes descriptions from child modifiers', () => {
    const chain = createModifierChain('desc');
    chain.add(createAdditiveModifier({ addend: 10, description: 'Bonus' }));
    chain.add(createMultiplicativeModifier({ multiplier: 2, description: 'Upgrade' }));

    expect(chain.description).toBeDefined();
    const descs = (chain.description as () => any[])();
    expect(descs).toHaveLength(2);
    expect(descs[0].text).toBe('Bonus');
    expect(descs[1].text).toBe('Upgrade');
  });

  it('has correct id', () => {
    const chain = createModifierChain('my-chain');
    expect(chain.id).toBe('my-chain');
  });
});

describe('chain.bind', () => {
  it('adds a modifier with auto-derived id from context and description', () => {
    const chain = createModifierChain('bind-basic');
    withPersistentContext('category/item', () => {
      chain.bind({
        modifier: createMultiplicativeModifier({ multiplier: 2, description: 'Upgrade' }),
      });
    });
    expect(Decimal.eq(chain.apply(100), 200)).toBe(true);
    const recs = chain.bindings();
    expect(recs).toHaveLength(1);
    expect(recs[0].id).toBe('category/item/Upgrade');
    expect(recs[0].scope).toBe('category/item');
  });

  it('gates evaluation on the active predicate, synchronously', () => {
    const chain = createModifierChain('bind-active');
    const active = ref(false);
    withPersistentContext('ctx/item', () => {
      chain.bind({
        active,
        modifier: createMultiplicativeModifier({ multiplier: 2, description: 'Boost' }),
      });
    });
    // Predicate false → passthrough, same tick.
    expect(Decimal.eq(chain.apply(100), 100)).toBe(true);
    active.value = true;
    // Flip → evaluation updates synchronously, no nextTick required.
    expect(Decimal.eq(chain.apply(100), 200)).toBe(true);
    active.value = false;
    expect(Decimal.eq(chain.apply(100), 100)).toBe(true);
  });

  it('AND-composes active predicate with the modifier’s existing enabled flag', () => {
    const chain = createModifierChain('bind-compose');
    const active = ref(true);
    const modEnabled = ref(true);
    withPersistentContext('ctx/item2', () => {
      chain.bind({
        active,
        modifier: createMultiplicativeModifier({
          multiplier: 2,
          description: 'Dual-gated',
          enabled: modEnabled,
        }),
      });
    });
    expect(Decimal.eq(chain.apply(100), 200)).toBe(true);
    modEnabled.value = false;
    expect(Decimal.eq(chain.apply(100), 100)).toBe(true);
    modEnabled.value = true;
    active.value = false;
    expect(Decimal.eq(chain.apply(100), 100)).toBe(true);
  });

  it('accepts a modifier factory form', () => {
    const chain = createModifierChain('bind-factory');
    withPersistentContext('factory-ctx', () => {
      chain.bind({
        modifier: () => createAdditiveModifier({ addend: 25, description: 'Plus' }),
      });
    });
    expect(Decimal.eq(chain.apply(100), 125)).toBe(true);
    expect(chain.bindings()[0].id).toBe('factory-ctx/Plus');
  });

  it('throws when the binding id collides within a chain', () => {
    const chain = createModifierChain('bind-collide');
    withPersistentContext('dup-ctx', () => {
      chain.bind({
        modifier: createMultiplicativeModifier({ multiplier: 2, description: 'Same' }),
      });
      expect(() =>
        chain.bind({
          modifier: createMultiplicativeModifier({ multiplier: 3, description: 'Same' }),
        }),
      ).toThrow(/duplicate binding id/);
    });
  });

  it('warns and proceeds when called outside any persistent context', () => {
    const chain = createModifierChain('bind-outside');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      chain.bind({
        modifier: createMultiplicativeModifier({ multiplier: 2, description: 'Rogue' }),
      });
      expect(warn).toHaveBeenCalledOnce();
      expect(Decimal.eq(chain.apply(100), 200)).toBe(true);
      const recs = chain.bindings();
      expect(recs).toHaveLength(1);
      expect(recs[0].id).toBe('Rogue');
      expect(recs[0].scope).toBeUndefined();
    } finally {
      warn.mockRestore();
    }
  });

  it('throws when neither id nor description is available', () => {
    const chain = createModifierChain('bind-nodesc');
    withPersistentContext('no-desc-ctx', () => {
      const bareMod = createMultiplicativeModifier({ multiplier: 2 });
      expect(() => chain.bind({ modifier: bareMod })).toThrow(/cannot auto-derive binding id/);
    });
  });

  it('honours an explicit id override', () => {
    const chain = createModifierChain('bind-explicit-id');
    withPersistentContext('override-ctx', () => {
      chain.bind({
        id: 'custom-key',
        modifier: createMultiplicativeModifier({ multiplier: 2, description: 'Any' }),
      });
    });
    expect(chain.bindings()[0].id).toBe('custom-key');
  });

  it('remover detaches the modifier and the binding record', () => {
    const chain = createModifierChain('bind-remove');
    const remove = withPersistentContext('rm-ctx', () =>
      chain.bind({
        modifier: createMultiplicativeModifier({ multiplier: 2, description: 'Temp' }),
      }),
    );
    expect(Decimal.eq(chain.apply(100), 200)).toBe(true);
    expect(chain.bindings()).toHaveLength(1);
    remove();
    expect(Decimal.eq(chain.apply(100), 100)).toBe(true);
    expect(chain.bindings()).toHaveLength(0);
  });

  it('records tags on the binding', () => {
    const chain = createModifierChain('bind-tags');
    withPersistentContext('tag-ctx', () => {
      chain.bind({
        modifier: createMultiplicativeModifier({ multiplier: 2, description: 'Tagged' }),
        tags: ['source:upgrade', 'kind:mult'],
      });
    });
    expect(chain.bindings()[0].tags).toEqual(['source:upgrade', 'kind:mult']);
  });

  it('raw add()-added modifiers do not show up in bindings()', () => {
    const chain = createModifierChain('bind-raw-mix');
    chain.add(createAdditiveModifier({ addend: 5, description: 'Raw' }));
    withPersistentContext('mix-ctx', () => {
      chain.bind({
        modifier: createMultiplicativeModifier({ multiplier: 2, description: 'Bound' }),
      });
    });
    expect(chain.modifiers).toHaveLength(2);
    const recs = chain.bindings();
    expect(recs).toHaveLength(1);
    expect(recs[0].id).toBe('mix-ctx/Bound');
  });
});
