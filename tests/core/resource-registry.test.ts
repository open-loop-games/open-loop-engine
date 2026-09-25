import { describe, it, expect } from 'vitest';
import { ref } from 'vue';
import { createEngine } from '@/index';
import type { EngineModule } from '@/index';
import { createResource } from '@/core/resource';
import { ResourceRegistryKey } from '@/core/registries';

function goldModule(displayName: string): EngineModule {
  return {
    id: `${displayName}-mod`,
    install() {
      createResource(0, { id: displayName, displayName });
    },
  };
}

// Each engine gets a unique persistence namespace so the shared
// persistent-context store doesn't collide across tests when reusing
// module ids.
let nsCounter = 0;
function testEngine(gameId: string) {
  return createEngine({
    gameId,
    persistence: false,
    persistenceNamespace: `${gameId}-${nsCounter++}`,
  });
}

describe('engine-scoped resource registry', () => {
  it('registers createResource calls made inside install() into the engine registry', () => {
    const engine = testEngine('reg-basic');
    engine.use(goldModule('gold'));
    engine.start();

    const registry = engine.tryInject(ResourceRegistryKey);
    expect(registry).toBeDefined();
    const entries = registry!.list();
    expect(entries.map((e) => e.resource.displayName)).toEqual(['gold']);

    engine.stop();
  });

  it('records the persistence context id (namespace-stripped) on each entry', () => {
    const engine = testEngine('reg-context');
    engine.use(goldModule('gold'));
    engine.start();

    const registry = engine.tryInject(ResourceRegistryKey)!;
    expect(registry.list()[0]!.context).toBe('gold-mod');

    engine.stop();
  });

  it('findByName returns the registered resource', () => {
    const engine = testEngine('reg-find');
    engine.use(goldModule('gold'));
    engine.start();

    const registry = engine.tryInject(ResourceRegistryKey)!;
    const gold = registry.findByName('gold');
    expect(gold).toBeDefined();
    expect(gold!.displayName).toBe('gold');
    expect(registry.findByName('nonexistent')).toBeUndefined();

    engine.stop();
  });

  it('findById returns the registered resource by stable id', () => {
    const engine = testEngine('reg-find-by-id');
    engine.use({
      id: 'cookies-mod',
      install() {
        createResource(0, { id: 'cookies', displayName: 'Cookies' });
      },
    });
    engine.start();

    const registry = engine.tryInject(ResourceRegistryKey)!;
    const cookies = registry.findById('cookies');
    expect(cookies).toBeDefined();
    expect(cookies!.id).toBe('cookies');
    expect(cookies!.displayName).toBe('Cookies');
    expect(registry.findById('Cookies')).toBeUndefined();
    expect(registry.findById('nonexistent')).toBeUndefined();

    engine.stop();
  });

  it('findById falls back to displayName for a wrapped ref, which saves nothing', () => {
    const engine = testEngine('reg-find-by-id-fallback');
    engine.use({
      id: 'income-mod',
      install() {
        createResource(ref(0), { displayName: 'income' });
      },
    });
    engine.start();

    const registry = engine.tryInject(ResourceRegistryKey)!;
    expect(registry.findById('income')).toBeDefined();

    engine.stop();
  });

  it('list() is a snapshot that a later registration does not grow', () => {
    const engine = testEngine('reg-list-snapshot');
    engine.use(goldModule('gold'));
    engine.start();

    const registry = engine.tryInject(ResourceRegistryKey)!;
    const held = registry.list();
    registry.register({ resource: createResource(0, { id: 'gems' }), context: undefined });
    expect(held.map((e) => e.resource.id)).toEqual(['gold']);

    engine.stop();
  });

  it('does not leak registrations between independent engines', () => {
    const a = testEngine('reg-iso-a');
    a.use(goldModule('gold'));
    a.start();

    const b = testEngine('reg-iso-b');
    b.use(goldModule('gems'));
    b.start();

    const regA = a.tryInject(ResourceRegistryKey)!;
    const regB = b.tryInject(ResourceRegistryKey)!;

    expect(regA.list().map((e) => e.resource.displayName)).toEqual(['gold']);
    expect(regB.list().map((e) => e.resource.displayName)).toEqual(['gems']);

    a.stop();
    b.stop();
  });

  it('createResource outside an engine silently skips registration (does not throw)', () => {
    // Top-level resource — no ambient registry, no engine. Must still work as
    // a plain reactive ref for tests and throwaway scripts.
    const orphan = createResource(0, { id: 'orphan', displayName: 'orphan' });
    expect(orphan.displayName).toBe('orphan');
    expect(orphan.value).toEqual(expect.anything());
  });

  it('each engine instance gets its own fresh registry', () => {
    const engine = testEngine('reg-fresh');
    engine.use(goldModule('gold'));
    engine.start();

    const registry = engine.tryInject(ResourceRegistryKey)!;
    const first = registry.list();

    // A second install on the same engine would append, but a different
    // engine must start empty — proves no module-global backing array.
    const other = testEngine('reg-fresh-other');
    other.start();
    expect(other.tryInject(ResourceRegistryKey)!.list()).toEqual([]);
    expect(first.map((e) => e.resource.displayName)).toEqual(['gold']);

    engine.stop();
    other.stop();
  });
});
