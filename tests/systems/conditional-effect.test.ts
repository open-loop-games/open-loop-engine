import { describe, it, expect, vi } from 'vitest';
import { ref, computed, effectScope, nextTick } from 'vue';
import { Decimal } from '@/primitives/decimal';
import { createConditionalEffectSystem } from '@/systems/conditional-effect';
import {
  createModifierChain,
  createMultiplicativeModifier,
  createAdditiveModifier,
} from '@/core/modifier';

function createSystem() {
  return createConditionalEffectSystem({ id: 'test' });
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
      grants: [{ chain, modifier: () => createMultiplicativeModifier({ multiplier: 4 }) }],
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
    // A headless sim drives tickOnce() in a tight loop with no microtask
    // boundary between steps. The active-predicate watch must fire on a 'sync'
    // flush so a mid-run activation binds its modifiers immediately — otherwise
    // the effect is silently a step (or more) late in the sim.
    const system = createSystem();
    const chain = createModifierChain('maxHealth');
    const active = ref(false);

    system.register({
      id: 'belt',
      active,
      grants: [{ chain, modifier: () => createMultiplicativeModifier({ multiplier: 4 }) }],
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
      grants: [{ chain, modifier: () => createMultiplicativeModifier({ multiplier: 4 }) }],
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
      grants: chains.map((chain) => ({
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
      grants: [{ chain, modifier: () => createAdditiveModifier({ addend: 10 }) }],
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
        grants: [{ chain, modifier: () => createAdditiveModifier({ addend: 5 }) }],
      },
      {
        id: 'b',
        active: bActive,
        grants: [{ chain, modifier: () => createMultiplicativeModifier({ multiplier: 2 }) }],
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

describe('chain order', () => {
  function registerFlatAndDouble(flatActive: boolean) {
    const system = createSystem();
    const chain = createModifierChain('dmg');
    const flat = ref(flatActive);
    system.register([
      {
        id: 'flat',
        active: flat,
        grants: [{ chain, modifier: () => createAdditiveModifier({ addend: 10 }) }],
      },
      {
        id: 'double',
        active: ref(true),
        grants: [{ chain, modifier: createMultiplicativeModifier({ multiplier: 2 }) }],
      },
    ]);
    return { chain, flat };
  }

  it('a binding that toggles off and on keeps its place in the chain', () => {
    const { chain, flat } = registerFlatAndDouble(true);
    expect(Decimal.eq(chain.apply(1), 22)).toBe(true);
    flat.value = false;
    expect(Decimal.eq(chain.apply(1), 2)).toBe(true);
    flat.value = true;
    expect(Decimal.eq(chain.apply(1), 22)).toBe(true);
  });

  it('the chain value follows registration order, not activation order', () => {
    const { chain, flat } = registerFlatAndDouble(false);
    flat.value = true;
    expect(Decimal.eq(chain.apply(1), 22)).toBe(true);
  });
});

describe('predicates its own edge flips', () => {
  it('an activation hook that falsifies the predicate settles deactivated, events in order', () => {
    const system = createSystem();
    const chain = createModifierChain('charge');
    const charges = ref(1);
    const events: string[] = [];
    system.on('activated', () => events.push('activated'));
    system.on('deactivated', () => events.push('deactivated'));
    system.register({
      id: 'spend-charge',
      active: () => charges.value > 0,
      grants: [{ chain, modifier: createMultiplicativeModifier({ multiplier: 2 }) }],
      onActivate: () => charges.value--,
    });

    expect(events).toEqual(['activated', 'deactivated']);
    expect(system.isActive('spend-charge').value).toBe(false);
    expect(system.getActive()).toEqual([]);
    expect(Decimal.eq(chain.apply(1), 1)).toBe(true);
  });

  it('throws when the predicate reads a value its own bindings change', () => {
    const system = createSystem();
    const chain = createModifierChain('feedback');
    expect(() =>
      system.register({
        id: 'catch-up',
        active: () => Decimal.lt(chain.apply(1), 10),
        grants: [{ chain, modifier: createMultiplicativeModifier({ multiplier: 100 }) }],
      }),
    ).toThrow(/its own bindings/);
  });
});

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
      grants: [{ chain, modifier: () => createMultiplicativeModifier({ multiplier: 4 }) }],
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
      grants: [{ chain, modifier: () => createAdditiveModifier({ addend: 100 }) }],
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

  it('getActive and getByTag are reactive, like temporary-effect', () => {
    const system = createSystem();
    const aura = ref(false);
    system.register({ id: 'aura', active: aura, tags: ['glow'] });
    const active = computed(() => system.getActive().map((d) => d.id));
    const glowing = computed(() => system.getByTag('glow').length);
    expect(active.value).toEqual([]);
    expect(glowing.value).toBe(0);

    aura.value = true;
    expect(active.value).toEqual(['aura']);
    expect(glowing.value).toBe(1);
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
      grants: [{ chain, modifier: () => createMultiplicativeModifier({ multiplier: 2 }) }],
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

// ============================================================================
// Grant vocabulary + Predicate active
// ============================================================================

describe('modifiers take Grants, active takes a Predicate', () => {
  const value = (chain: ReturnType<typeof createModifierChain>) =>
    Decimal.fromValue(chain.apply(1)).toNumber();

  it('a shorthand grant binds while active', () => {
    const system = createSystem();
    const chain = createModifierChain('xp');
    const built = ref(false);
    system.register({
      id: 'library',
      active: built,
      grants: [{ chain, mult: 2, description: 'Library' }],
    });

    expect(value(chain)).toBe(1);
    built.value = true;
    expect(value(chain)).toBe(2);
    built.value = false;
    expect(value(chain)).toBe(1);
  });

  it('when ANDs into the grant', () => {
    const system = createSystem();
    const chain = createModifierChain('xp');
    const lit = ref(false);
    system.register({
      id: 'library',
      active: true,
      grants: [{ chain, add: 1, description: 'Lamp', when: () => lit.value }],
    });

    expect(value(chain)).toBe(1);
    lit.value = true;
    expect(value(chain)).toBe(2);
  });

  it("active as a Gate whose handles the runtime doesn't carry throws at register", () => {
    const system = createSystem();
    expect(() => system.register({ id: 'lit', active: { kind: 'flag', id: 'lamp' } })).toThrow(
      /conditional effect 'lit' active: /,
    );
  });
});

describe('createConditionalEffectSystem — teardown', () => {
  it('a definition registered outside any scope stops with the scope that built the system', () => {
    const scope = effectScope();
    const system = scope.run(() => createConditionalEffectSystem({ id: 'late-fx' }))!;
    const active = ref(false);
    const onActivate = vi.fn();
    system.register({ id: 'late', active, onActivate });
    scope.stop();

    active.value = true;
    expect(onActivate).not.toHaveBeenCalled();
  });
});
