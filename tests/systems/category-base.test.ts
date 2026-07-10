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
