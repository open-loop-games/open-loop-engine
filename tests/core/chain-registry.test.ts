import { describe, it, expect } from 'vitest';
import { createModifierChain } from '@/core';
import { createChainRegistry, withChainRegistry, getCurrentChainRegistry } from '@/core/registries';

describe('ChainRegistry', () => {
  it('starts empty', () => {
    const registry = createChainRegistry();
    expect(registry.size).toBe(0);
    expect(registry.all()).toEqual([]);
  });

  it('registers chains and looks them up by id', () => {
    const registry = createChainRegistry();
    withChainRegistry(registry, () => {
      createModifierChain('alpha');
      createModifierChain('beta');
    });

    expect(registry.size).toBe(2);
    expect(registry.has('alpha')).toBe(true);
    expect(registry.has('beta')).toBe(true);
    expect(registry.get('alpha')?.id).toBe('alpha');
    expect(registry.get('missing')).toBeUndefined();
  });

  it('preserves insertion order in all()', () => {
    const registry = createChainRegistry();
    withChainRegistry(registry, () => {
      createModifierChain('one');
      createModifierChain('two');
      createModifierChain('three');
    });
    expect(registry.all().map((c) => c.id)).toEqual(['one', 'two', 'three']);
  });

  it('throws on duplicate id within the same registry', () => {
    const registry = createChainRegistry();
    expect(() =>
      withChainRegistry(registry, () => {
        createModifierChain('dup');
        createModifierChain('dup');
      }),
    ).toThrow(/duplicate chain id "dup"/);
  });

  it('construction outside a withChainRegistry block does not register anywhere', () => {
    // Sanity: ambient is undefined here.
    expect(getCurrentChainRegistry()).toBeUndefined();

    const chain = createModifierChain('lonely');
    expect(chain.id).toBe('lonely');

    // And a fresh registry is still empty.
    const registry = createChainRegistry();
    expect(registry.has('lonely')).toBe(false);
  });

  it('restores the previous ambient on block exit (nested)', () => {
    const outer = createChainRegistry();
    const inner = createChainRegistry();

    withChainRegistry(outer, () => {
      createModifierChain('outer-a');
      withChainRegistry(inner, () => {
        createModifierChain('inner-a');
      });
      createModifierChain('outer-b');
    });

    expect(outer.all().map((c) => c.id)).toEqual(['outer-a', 'outer-b']);
    expect(inner.all().map((c) => c.id)).toEqual(['inner-a']);
  });

  it('restores the previous ambient even when the block throws', () => {
    const registry = createChainRegistry();
    expect(() =>
      withChainRegistry(registry, () => {
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(getCurrentChainRegistry()).toBeUndefined();
  });
});
