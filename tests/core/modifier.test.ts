import { describe, it, expect, vi } from 'vitest';
import { computed, ref, unref } from 'vue';
import { Decimal, bn, type DecimalSource } from '@/primitives/decimal';
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

  it('emits changed event on add', () => {
    const chain = createModifierChain('evt-add');
    const changeCb = vi.fn();
    chain.on('changed', changeCb);

    chain.add(createAdditiveModifier({ addend: 1 }));
    expect(changeCb).toHaveBeenCalledOnce();
  });

  it('emits changed event on remove', () => {
    const chain = createModifierChain('evt-rm');
    const mod = createAdditiveModifier({ addend: 1 });
    chain.add(mod);

    const changeCb = vi.fn();
    chain.on('changed', changeCb);
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

  it('chain.enabled stays reactive when modifiers are added after first read', () => {
    // Pre-fix, `recompose` reassigned `chain.enabled` to a fresh ComputedRef on
    // every add/remove. A consumer that already captured the original ref
    // stayed attached to it, and modifiers added later — along with any
    // toggles on their `enabled` flags — were invisible until something else
    // forced the consumer to re-evaluate. The fix made `chain.enabled` a
    // stable ComputedRef whose body re-reads `items` on each evaluation,
    // triggered by an `itemsVersion` bump inside recompose.
    const chain = createModifierChain('enabled-add-reactivity');
    const firstEnabled = ref(false);
    chain.add(createAdditiveModifier({ addend: 10, enabled: firstEnabled }));

    const observed = computed(() => unref(chain.enabled));
    expect(observed.value).toBe(false);

    // Add a second modifier with enabled=true. Without re-touching firstEnabled,
    // observed must reflect the new chain state — i.e. some flagged modifier
    // is now active.
    const secondEnabled = ref(true);
    chain.add(createAdditiveModifier({ addend: 20, enabled: secondEnabled }));

    expect(observed.value).toBe(true);
  });

  it('chain.apply stays reactive when a modifier is added after first read', () => {
    // Pre-fix, `chain.apply` was a data-property reassigned by recompose, so a
    // `computed` reading it captured no dependency on chain composition and
    // served a stale value. The fix makes `apply` a getter that reads
    // `itemsVersion`, so adds/removes invalidate the consumer.
    const chain = createModifierChain('apply-add-reactivity');
    chain.add(createAdditiveModifier({ addend: 10 }));

    const observed = computed(() => chain.apply(100));
    expect(Decimal.eq(observed.value, 110)).toBe(true);

    chain.add(createMultiplicativeModifier({ multiplier: 2 }));
    // (100 + 10) × 2 = 220 — must reflect the modifier added AFTER first read.
    expect(Decimal.eq(observed.value, 220)).toBe(true);
  });

  it('chain.apply stays reactive when a modifier is removed after first read', () => {
    const chain = createModifierChain('apply-remove-reactivity');
    chain.add(createAdditiveModifier({ addend: 10 }));
    const mul = createMultiplicativeModifier({ multiplier: 2 });
    chain.add(mul);

    const observed = computed(() => chain.apply(100));
    expect(Decimal.eq(observed.value, 220)).toBe(true);

    chain.remove(mul);
    expect(Decimal.eq(observed.value, 110)).toBe(true);
  });

  it('chain.description stays reactive when a modifier is added after first read', () => {
    const chain = createModifierChain('desc-add-reactivity');
    chain.add(createAdditiveModifier({ addend: 10, description: 'Bonus' }));

    const count = computed(() => {
      const d = chain.description;
      return d == null ? 0 : (d as () => { text: string }[])().length;
    });
    expect(count.value).toBe(1);

    chain.add(createMultiplicativeModifier({ multiplier: 2, description: 'Upgrade' }));
    expect(count.value).toBe(2);
  });
});

describe('chain order', () => {
  const plus10 = () => createAdditiveModifier({ addend: 10 });
  const times2 = () => createMultiplicativeModifier({ multiplier: 2 });

  it('evaluates modifiers in the order they were added', () => {
    const a = createModifierChain('order-a');
    a.add(plus10());
    a.add(times2());
    const b = createModifierChain('order-b');
    b.add(times2());
    b.add(plus10());
    expect(new Decimal(a.apply(1)).toNumber()).toBe(22);
    expect(new Decimal(b.apply(1)).toNumber()).toBe(12);
  });

  it('replace swaps a modifier in place', () => {
    const chain = createModifierChain('replace');
    const flat = plus10();
    const double = times2();
    chain.add(flat);
    chain.add(double);
    const bigger = createAdditiveModifier({ addend: 20 });
    expect(chain.replace(flat, bigger)).toBe(true);
    expect(chain.modifiers).toEqual([bigger, double]);
    expect(new Decimal(chain.apply(1)).toNumber()).toBe(42);
    expect(chain.replace(flat, bigger)).toBe(false);
  });

  it('a reserved slot holds its place while it is empty', () => {
    const chain = createModifierChain('slot');
    const slot = chain.reserve();
    chain.add(times2());
    expect(chain.modifiers).toHaveLength(1);

    const flat = plus10();
    const removeFlat = slot.add(flat);
    expect(chain.modifiers[0]).toBe(flat);
    expect(new Decimal(chain.apply(1)).toNumber()).toBe(22);

    removeFlat();
    expect(new Decimal(chain.apply(1)).toNumber()).toBe(2);
    slot.add(plus10());
    expect(new Decimal(chain.apply(1)).toNumber()).toBe(22);
  });

  it('modifiers in one slot keep their add order, and release empties the slot', () => {
    const chain = createModifierChain('slot-release');
    const slot = chain.reserve();
    chain.add(times2());
    const first = plus10();
    const second = createAdditiveModifier({ addend: 5 });
    slot.add(first);
    slot.add(second);
    expect(chain.modifiers.slice(0, 2)).toEqual([first, second]);

    chain.remove(first);
    expect(chain.modifiers).toHaveLength(2);
    slot.release();
    expect(new Decimal(chain.apply(1)).toNumber()).toBe(2);
  });

  it('a computed over the chain tracks slot changes', () => {
    const chain = createModifierChain('slot-reactive');
    const slot = chain.reserve();
    const value = computed(() => new Decimal(chain.apply(1)).toNumber());
    expect(value.value).toBe(1);
    const remove = slot.add(times2());
    expect(value.value).toBe(2);
    remove();
    expect(value.value).toBe(1);
  });
});

describe('nested chains', () => {
  it('a chain describes itself as one flat line per described child', () => {
    const inner = createModifierChain('desc-inner');
    const outer = createModifierChain('desc-outer');
    inner.add(createMultiplicativeModifier({ multiplier: 3, description: 'Triple' }));
    outer.add(createAdditiveModifier({ addend: 1, description: 'Base' }));
    outer.add(inner);
    const desc = outer.description;
    const lines = typeof desc === 'function' ? desc() : desc;
    expect(Array.isArray(lines) && lines.map((l) => l.text)).toEqual(['Base', 'Triple']);
  });

  it('an outer chain drops invert once an added inner chain loses it', () => {
    const inner = createModifierChain('nest-inner');
    const outer = createModifierChain('nest-outer');
    inner.add(createMultiplicativeModifier({ multiplier: 2 }));
    outer.add(inner);
    expect(outer.invert).toBeTypeOf('function');

    inner.add({ apply: (x) => Decimal.add(x, 1) });
    expect(outer.invert).toBeUndefined();
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

  it('binding with active delegates to a class-based modifier', () => {
    class Doubler {
      description = { text: 'Doubler', formattedValue: '×2' };
      apply(x: DecimalSource) {
        return Decimal.times(x, 2);
      }
      invert(x: DecimalSource) {
        return Decimal.div(x, 2);
      }
    }
    const chain = createModifierChain('bind-class');
    chain.bind({ id: 'doubler', active: ref(true), modifier: new Doubler() });
    expect(Decimal.eq(chain.apply(5), 10)).toBe(true);
    expect(Decimal.eq(chain.invert!(10), 5)).toBe(true);
  });

  it('a chain bound with active stays live as the inner chain changes', () => {
    const inner = createModifierChain('bind-inner');
    const outer = createModifierChain('bind-outer');
    outer.bind({ id: 'inner', active: ref(true), modifier: inner });
    const value = computed(() => new Decimal(outer.apply(1)).toNumber());
    expect(value.value).toBe(1);

    inner.add(createMultiplicativeModifier({ multiplier: 3, description: 'Triple' }));
    expect(value.value).toBe(3);
    expect(outer.description).toBeTypeOf('function');

    inner.add({ apply: (x) => Decimal.add(x, 1) });
    expect(outer.invert).toBeUndefined();
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
