import { describe, it, expect } from 'vitest';
import { createCategoryBase } from '@/systems/category-base';
import { persistent, getCurrentFullContext, type DecimalSource } from '@/core/persistence';

interface ThingDef {
  id: string;
}

describe('createCategoryBase — persistent-context safety', () => {
  it('does not leak the persistent context when a builder throws', () => {
    // A throwing buildState must still pop the context it pushed; otherwise
    // every persistent ref created afterward is silently mis-scoped under the
    // leaked `${categoryId}/${def.id}` prefix.
    expect(getCurrentFullContext()).toBeUndefined();

    const cat = createCategoryBase<
      ThingDef,
      void,
      { count: ReturnType<typeof persistent<DecimalSource>> }
    >({
      id: 'things',
      buildState: (def) => {
        if (def.id === 'boom') throw new Error('builder blew up');
        return { count: persistent<DecimalSource>(0) };
      },
    });

    expect(() => cat.register({ id: 'boom' })).toThrow('builder blew up');
    // Stack must be balanced back to empty after the caught throw.
    expect(getCurrentFullContext()).toBeUndefined();
  });
});

describe('createCategoryBase — batch registration', () => {
  function makeThrowingOn(badId: string) {
    return createCategoryBase<
      ThingDef,
      void,
      { count: ReturnType<typeof persistent<DecimalSource>> }
    >({
      id: `batch-${badId}`,
      buildState: (def) => {
        if (def.id === badId) throw new Error('builder blew up');
        return { count: persistent<DecimalSource>(0) };
      },
    });
  }

  it('a builder throw mid-batch leaves registry and entries in step', () => {
    const cat = makeThrowingOn('b');
    expect(() => cat.register([{ id: 'a' }, { id: 'b' }, { id: 'c' }])).toThrow('builder blew up');

    expect(cat.getAll().map((e) => e.def.id)).toEqual(['a']);
    expect(cat.registry.getAll().map((d) => d.id)).toEqual(['a']);
    expect(cat.getDef('b')).toBeUndefined();

    cat.register({ id: 'c' });
    expect(cat.getEntry('c')).toBeDefined();
    expect(cat.registry.size).toBe(2);
  });
});
