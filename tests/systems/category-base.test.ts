import { describe, it, expect } from 'vitest';
import { createCategoryBase, type CategoryBase } from '@/systems/category-base';
import { createReset } from '@/systems/reset';
import { createEngine, type EngineModule } from '@/engine';
import {
  persistent,
  getAllPersistentRefs,
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
        const count = persistent<DecimalSource>(0, { id: 'count' });
        persistent<DecimalSource>(0, { id: 'best', lifetime: true });
        withPersistentContext('retry/a/inner', () => persistent(0, { id: 'progress' }));
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

describe('createCategoryBase — entry ownership', () => {
  type SeenState = { seen: ReturnType<typeof persistent<number>> };
  type Site = 'B-install' | 'B-connect' | 'A-connect' | 'after-start';

  // Module A builds the category; the entry is registered from `site`.
  function boot(site: Site, persistenceNamespace?: string) {
    let cat!: CategoryBase<ThingDef, void, SeenState>;
    const register = () => cat.register({ id: 'e1' });
    const A: EngineModule = {
      id: 'A',
      install() {
        cat = createCategoryBase<ThingDef, void, SeenState>({
          id: 'cat',
          buildState: () => ({ seen: persistent(0, { id: 'seen' }) }),
        });
      },
      connect: site === 'A-connect' ? register : undefined,
    };
    const B: EngineModule = {
      id: 'B',
      dependencies: ['A'],
      install: site === 'B-install' ? register : () => {},
      connect: site === 'B-connect' ? register : undefined,
    };
    const engine = createEngine({ gameId: 'ownership', persistence: false, persistenceNamespace });
    engine.use(A).use(B);
    engine.start();
    if (site === 'after-start') register();
    return { engine, seen: () => cat.getEntry('e1')!.state.seen };
  }

  function seenAfterReset(seen: () => SeenState['seen'], moduleId: string): number {
    seen().value = 7;
    createReset({ resetPersistentContexts: [moduleId] }).reset();
    return seen().value;
  }

  it.each<Site>(['B-install', 'B-connect', 'A-connect', 'after-start'])(
    'an entry registered from %s joins the reset of the module that built the category',
    (site) => {
      const { seen } = boot(site);
      expect(seenAfterReset(seen, 'B')).toBe(7);
      expect(seenAfterReset(seen, 'A')).toBe(0);
    },
  );

  it.each<Site>(['B-install', 'B-connect', 'A-connect', 'after-start'])(
    'an entry registered from %s keeps its save key',
    (site) => {
      boot(site);
      expect([...getAllPersistentRefs().keys()].filter((k) => k.startsWith('cat'))).toEqual([
        'cat/e1.seen',
      ]);
    },
  );

  it("an entry registered after start under a persistence namespace is in that engine's save", () => {
    const first = boot('after-start', 'ns1');
    expect([...getAllPersistentRefs('ns1').keys()]).toContain('cat/e1.seen');
    expect([...getAllPersistentRefs().keys()]).not.toContain('cat/e1.seen');
    first.engine.dispose();

    const second = boot('after-start', 'ns1');
    expect(second.seen().value).toBe(0);
  });

  it("an entry of a category built outside any persistent context joins the caller's module", () => {
    const cat = createCategoryBase<ThingDef, void, SeenState>({
      id: 'cat',
      buildState: () => ({ seen: persistent(0, { id: 'seen' }) }),
    });
    const engine = createEngine({ gameId: 'ownership', persistence: false });
    engine.use({ id: 'A', install() {} });
    engine.use({ id: 'B', dependencies: ['A'], install: () => cat.register({ id: 'e1' }) });
    engine.start();
    const seen = () => cat.getEntry('e1')!.state.seen;
    expect(seenAfterReset(seen, 'A')).toBe(7);
    expect(seenAfterReset(seen, 'B')).toBe(0);
  });
});
