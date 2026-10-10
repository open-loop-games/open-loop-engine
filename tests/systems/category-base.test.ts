import { describe, it, expect } from 'vitest';
import { createCategoryBase } from '@/systems/category-base';
import {
  persistent,
  getCurrentFullPersistentContext,
  getPersistentContextRefs,
  withPersistentContext,
} from '@/core/persistence';
import type { DecimalSource } from '@/primitives/decimal';

interface ThingDef {
  id: string;
}

describe('createCategoryBase — persistent-context safety', () => {
  it('does not leak the persistent context when a builder throws', () => {
    // A throwing buildState must still pop the context it pushed; otherwise
    // every persistent ref created afterward is silently mis-scoped under the
    // leaked `${categoryId}/${def.id}` prefix.
    expect(getCurrentFullPersistentContext()).toBeUndefined();

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
    expect(getCurrentFullPersistentContext()).toBeUndefined();
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

  it('a def whose build throws after creating refs can be registered again', () => {
    // The first attempt creates its named refs, one of them lifetime-tagged
    // and one in a nested context, then throws; none of them may survive to
    // collide with the retry's refs or be saved under the def's context.
    let attempts = 0;
    const cat = createCategoryBase<
      ThingDef,
      void,
      { count: ReturnType<typeof persistent<DecimalSource>> }
    >({
      id: 'retry',
      buildState: () => {
        const count = persistent<DecimalSource>(0, { name: 'count' });
        persistent<DecimalSource>(0, { name: 'best', lifetime: true });
        withPersistentContext('retry/a/inner', () => persistent(0, { name: 'progress' }));
        if (attempts++ === 0) throw new Error('builder blew up');
        return { count };
      },
    });

    expect(() => cat.register({ id: 'a' })).toThrow('builder blew up');
    expect(getPersistentContextRefs('retry/a').size).toBe(0);

    cat.register({ id: 'a' });
    expect(cat.getEntry('a')).toBeDefined();
    expect(getPersistentContextRefs('retry/a').size).toBe(2);
  });
});
