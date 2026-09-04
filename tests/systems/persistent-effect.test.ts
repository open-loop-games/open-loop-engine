import { describe, it, expect, vi } from 'vitest';
import { ref, computed, nextTick } from 'vue';
import { Decimal } from '@/primitives/decimal';
import { createPersistentEffectSystem } from '@/systems/persistent-effect';
import {
  createModifierChain,
  createMultiplicativeModifier,
  createAdditiveModifier,
} from '@/core/modifier';

function createSystem() {
  return createPersistentEffectSystem({ id: 'test' });
}

// ============================================================================
// Registration
// ============================================================================

describe('registration', () => {
  it('register + getDef round-trip', () => {
    const system = createSystem();
    system.register({ id: 'belt', active: ref(false) });
    expect(system.getDef('belt')).toBeDefined();
    expect(system.getDef('belt')!.id).toBe('belt');
    expect(system.getDef('unknown')).toBeUndefined();
  });

  it('register accepts array of defs', () => {
    const system = createSystem();
    system.register([
      { id: 'belt', active: ref(false) },
      { id: 'helm', active: ref(false) },
    ]);
    expect(system.getDef('belt')).toBeDefined();
    expect(system.getDef('helm')).toBeDefined();
  });

  it('throws on duplicate registration', () => {
    const system = createSystem();
    system.register({ id: 'belt', active: ref(false) });
    expect(() => system.register({ id: 'belt', active: ref(false) })).toThrow(/duplicate/i);
  });
});

// ============================================================================
// Activation edges
// ============================================================================

describe('activation', () => {
  it('applies bindings on false → true edge', async () => {
    const system = createSystem();
    const chain = createModifierChain('maxHealth');
    const active = ref(false);

    system.register({
      id: 'belt',
      active,
      modifiers: [{ chain, modifier: () => createMultiplicativeModifier({ multiplier: 4 }) }],
    });

    expect(chain.modifiers.length).toBe(0);
    expect(system.isActive('belt').value).toBe(false);

    active.value = true;
    await nextTick();

    expect(chain.modifiers.length).toBe(1);
    expect(system.isActive('belt').value).toBe(true);
    expect(system.getActive().map((d) => d.id)).toEqual(['belt']);
  });

  it('applies bindings synchronously under a sim (no flush boundary)', () => {
    // A headless sim drives stepOnce() in a tight loop with no microtask
    // boundary between steps. The active-predicate watch must fire on a 'sync'
    // flush so a mid-run activation binds its modifiers immediately — otherwise
    // the effect is silently a step (or more) late in the sim.
    const system = createSystem();
    const chain = createModifierChain('maxHealth');
    const active = ref(false);

    system.register({
      id: 'belt',
      active,
      modifiers: [{ chain, modifier: () => createMultiplicativeModifier({ multiplier: 4 }) }],
    });

    active.value = true;
    // No await nextTick() — the binding must already be present.
    expect(chain.modifiers.length).toBe(1);
    expect(system.isActive('belt').value).toBe(true);
  });

  it('removes bindings on true → false edge', async () => {
    const system = createSystem();
    const chain = createModifierChain('maxHealth');
    const active = ref(true);

    system.register({
      id: 'belt',
      active,
      modifiers: [{ chain, modifier: () => createMultiplicativeModifier({ multiplier: 4 }) }],
    });

    // immediate watch applies on registration
    expect(chain.modifiers.length).toBe(1);
    expect(system.isActive('belt').value).toBe(true);

    active.value = false;
    await nextTick();

    expect(chain.modifiers.length).toBe(0);
    expect(system.isActive('belt').value).toBe(false);
    expect(system.getActive()).toEqual([]);
  });

  it('one registration binds and unbinds a batch across N distinct chains', async () => {
    // The batch shape: a single def scopes a whole set of mechanics to one
    // predicate, so they freeze and thaw together rather than per-chain.
    const system = createSystem();
    const chains = ['canvass', 'files', 'tipline'].map((id) => createModifierChain(id));
    const active = ref(false);

    system.register({
      id: 'phase-scope',
      active,
      modifiers: chains.map((chain) => ({
        chain,
        modifier: () => createMultiplicativeModifier({ multiplier: 0 }),
      })),
    });

    expect(chains.map((c) => c.modifiers.length)).toEqual([0, 0, 0]);

    active.value = true;
    await nextTick();
    expect(chains.map((c) => c.modifiers.length)).toEqual([1, 1, 1]);
    expect(chains.map((c) => new Decimal(c.apply(4)).toNumber())).toEqual([0, 0, 0]);

    active.value = false;
    await nextTick();
    expect(chains.map((c) => c.modifiers.length)).toEqual([0, 0, 0]);
  });

  it('fires onActivate/onDeactivate hooks on edges', async () => {
    const system = createSystem();
    const onActivate = vi.fn();
    const onDeactivate = vi.fn();
    const active = ref(false);

    system.register({ id: 'belt', active, onActivate, onDeactivate });

    expect(onActivate).not.toHaveBeenCalled();

    active.value = true;
    await nextTick();
    expect(onActivate).toHaveBeenCalledTimes(1);
    expect(onDeactivate).not.toHaveBeenCalled();

    active.value = false;
    await nextTick();
    expect(onDeactivate).toHaveBeenCalledTimes(1);
  });

  it('accepts computed predicates', async () => {
    const system = createSystem();
    const chain = createModifierChain('xp');
    const built = ref(false);
    const level = ref(0);

    system.register({
      id: 'library',
      active: computed(() => built.value && level.value >= 3),
      modifiers: [{ chain, modifier: () => createAdditiveModifier({ addend: 10 }) }],
    });

    built.value = true;
    await nextTick();
    expect(chain.modifiers.length).toBe(0);

    level.value = 3;
    await nextTick();
    expect(chain.modifiers.length).toBe(1);

    built.value = false;
    await nextTick();
    expect(chain.modifiers.length).toBe(0);
  });
});

// ============================================================================
// Isolation — multiple defs on the same chain
// ============================================================================

describe('binding isolation', () => {
  it('removing one def does not affect another def bound to the same chain', async () => {
    const system = createSystem();
    const chain = createModifierChain('shared');
    const aActive = ref(true);
    const bActive = ref(true);

    system.register([
      {
        id: 'a',
        active: aActive,
        modifiers: [{ chain, modifier: () => createAdditiveModifier({ addend: 5 }) }],
      },
      {
        id: 'b',
        active: bActive,
        modifiers: [{ chain, modifier: () => createMultiplicativeModifier({ multiplier: 2 }) }],
      },
    ]);

    expect(chain.modifiers.length).toBe(2);

    aActive.value = false;
    await nextTick();

    expect(chain.modifiers.length).toBe(1);
    expect(system.isActive('a').value).toBe(false);
    expect(system.isActive('b').value).toBe(true);

    bActive.value = false;
    await nextTick();

    expect(chain.modifiers.length).toBe(0);
  });
});

// ============================================================================
// Load-time reconstruction
// ============================================================================

describe('load-time reconstruction', () => {
  it('immediate watch applies bindings for defs already active at registration', () => {
    // Simulates saved state: the game state ref is "already true" at engine boot.
    // No explicit restore() call — register() alone re-applies bindings.
    const system = createSystem();
    const chain = createModifierChain('maxHealth');
    const savedBuilt = ref(true); // as if loaded from save

    system.register({
      id: 'belt',
      active: savedBuilt,
      modifiers: [{ chain, modifier: () => createMultiplicativeModifier({ multiplier: 4 }) }],
    });

    expect(chain.modifiers.length).toBe(1);
    expect(system.isActive('belt').value).toBe(true);
  });

  it('reconstruction respects computed predicates reading saved refs', () => {
    const system = createSystem();
    const chain = createModifierChain('dmg');
    const progress = ref(5); // loaded save value

    system.register({
      id: 'milestone',
      active: computed(() => progress.value >= 3),
      modifiers: [{ chain, modifier: () => createAdditiveModifier({ addend: 100 }) }],
    });

    expect(chain.modifiers.length).toBe(1);
  });
});

// ============================================================================
// Queries & events
// ============================================================================

describe('queries', () => {
  it('getByTag filters active defs by tag', async () => {
    const system = createSystem();
    const a = ref(true);
    const b = ref(true);
    const c = ref(false);

    system.register([
      { id: 'a', active: a, tags: ['echo'] },
      { id: 'b', active: b, tags: ['echo', 'flame'] },
      { id: 'c', active: c, tags: ['echo'] },
    ]);

    expect(
      system
        .getByTag('echo')
        .map((d) => d.id)
        .sort(),
    ).toEqual(['a', 'b']);
    expect(system.getByTag('flame').map((d) => d.id)).toEqual(['b']);
  });

  it('emits activated/deactivated events', async () => {
    const system = createSystem();
    const active = ref(false);
    const activated = vi.fn();
    const deactivated = vi.fn();
    system.on('activated', activated);
    system.on('deactivated', deactivated);

    system.register({ id: 'belt', active });

    active.value = true;
    await nextTick();
    expect(activated).toHaveBeenCalledTimes(1);

    active.value = false;
    await nextTick();
    expect(deactivated).toHaveBeenCalledTimes(1);
  });
});

// ============================================================================
// Dispose
// ============================================================================

describe('dispose', () => {
  it('removes all bindings and stops watchers', async () => {
    const system = createSystem();
    const chain = createModifierChain('x');
    const active = ref(true);

    system.register({
      id: 'belt',
      active,
      modifiers: [{ chain, modifier: () => createMultiplicativeModifier({ multiplier: 2 }) }],
    });
    expect(chain.modifiers.length).toBe(1);

    system.dispose();
    expect(chain.modifiers.length).toBe(0);

    // Further changes to active must not re-apply
    active.value = false;
    await nextTick();
    active.value = true;
    await nextTick();
    expect(chain.modifiers.length).toBe(0);
  });
});
