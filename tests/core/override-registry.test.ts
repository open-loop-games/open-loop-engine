import { describe, it, expect } from 'vitest';
import { ref } from 'vue';
import { Decimal } from '@/primitives/decimal';
import {
  createOverrideRegistry,
  createTuningRegistry,
  tunable,
  withTuningRegistries,
  type OverrideRegistry,
  type TuningRegistry,
} from '@/core/override-registry';
import { persistent, beginPersistentContext, endPersistentContext } from '@/core/persistence';
import { createPurchasable } from '@/systems/purchasable';

describe('OverrideRegistry', () => {
  it('scopeVersion bumps on pushScope and on cleanup', () => {
    const reg = createOverrideRegistry<{ f: () => number }>('test');
    reg.setDefault('f', () => 1);
    expect(reg.scopeVersion.value).toBe(0);

    const a = reg.pushScope('a', { f: () => 2 });
    expect(reg.scopeVersion.value).toBe(1);

    const b = reg.pushScope('b', { f: () => 3 });
    expect(reg.scopeVersion.value).toBe(2);

    b();
    expect(reg.scopeVersion.value).toBe(3);
    a();
    expect(reg.scopeVersion.value).toBe(4);
  });

  it('cleanup is idempotent and does not double-bump scopeVersion', () => {
    const reg = createOverrideRegistry<{ f: () => number }>('test');
    reg.setDefault('f', () => 1);
    const cleanup = reg.pushScope('s', { f: () => 2 });
    const before = reg.scopeVersion.value;
    cleanup();
    cleanup(); // second call is a no-op
    expect(reg.scopeVersion.value).toBe(before + 1);
  });

  it('getBaseKeys returns base-map keys only, not scope-only keys', () => {
    const reg = createOverrideRegistry<Record<string, () => number>>('test');
    reg.setDefault('alpha', () => 1);
    reg.setDefault('beta', () => 2);
    expect([...reg.getBaseKeys()].sort()).toEqual(['alpha', 'beta']);

    // Pushing a scope that introduces a new key should NOT change getBaseKeys.
    const cleanup = reg.pushScope('challenge', {
      gamma: () => 3,
    });
    expect([...reg.getBaseKeys()].sort()).toEqual(['alpha', 'beta']);

    cleanup();
    expect([...reg.getBaseKeys()].sort()).toEqual(['alpha', 'beta']);
  });

  it('exposes its name', () => {
    const reg = createOverrideRegistry<Record<string, () => number>>('producer-tuning');
    expect(reg.name).toBe('producer-tuning');
  });
});

describe('createTuningRegistry', () => {
  it('returns an OverrideRegistry with DecimalSource value type narrow', () => {
    const reg = createTuningRegistry('producer-tuning');
    reg.setDefault('foo', () => 42);
    expect(reg.get('foo')()).toBe(42);
    expect(reg.name).toBe('producer-tuning');
  });

  it('auto-registers into the ambient set when called within withTuningRegistries', () => {
    const set = new Set<TuningRegistry>();
    withTuningRegistries(set, () => {
      createTuningRegistry('a');
      createTuningRegistry('b');
    });
    expect(set.size).toBe(2);
    expect([...set].map((r) => r.name).sort()).toEqual(['a', 'b']);
  });

  it('silently skips registration when called outside withTuningRegistries', () => {
    // Matches createModifierChain's "outside ambient = no-op registration"
    // semantics — the primitive still works, just isn't picker-discoverable.
    const reg = createTuningRegistry('lonely');
    reg.setDefault('foo', () => 7);
    expect(reg.get('foo')()).toBe(7);
  });

  it('nested withTuningRegistries calls save and restore the previous ambient', () => {
    const outer = new Set<TuningRegistry>();
    const inner = new Set<TuningRegistry>();
    withTuningRegistries(outer, () => {
      createTuningRegistry('outer-a');
      withTuningRegistries(inner, () => {
        createTuningRegistry('inner-a');
      });
      createTuningRegistry('outer-b');
    });
    expect([...outer].map((r) => r.name).sort()).toEqual(['outer-a', 'outer-b']);
    expect([...inner].map((r) => r.name)).toEqual(['inner-a']);
  });
});

describe('tunable() helper', () => {
  it('returns a computed that reads through the registry', () => {
    const reg = createOverrideRegistry<Record<string, () => number>>('tuning');
    const t = tunable(reg, 'foo', () => 42);
    expect(t.value).toBe(42);
  });

  it('re-evaluates when a scope is pushed and cleaned up', () => {
    const reg = createOverrideRegistry<Record<string, () => number>>('tuning');
    const t = tunable(reg, 'foo', () => 10);
    expect(t.value).toBe(10);

    const restore = reg.pushScope('sim', { foo: () => 999 });
    expect(t.value).toBe(999);

    restore();
    expect(t.value).toBe(10);
  });

  it('re-evaluates when the underlying reactive state changes', () => {
    const reg = createOverrideRegistry<Record<string, () => number>>('tuning');
    const raw = ref(5);
    const t = tunable(reg, 'foo', () => raw.value * 2);
    expect(t.value).toBe(10);
    raw.value = 7;
    expect(t.value).toBe(14);
  });

  it('setDefault does not clobber an existing registration', () => {
    const reg = createOverrideRegistry<Record<string, () => number>>('tuning');
    reg.setDefault('foo', () => 1);
    // Second tunable on same key hits the no-clobber path of setDefault —
    // the first default wins, matching vanilla-vs-mod install order.
    const t = tunable(reg, 'foo', () => 2);
    expect(t.value).toBe(1);
  });
});

describe('tunable pilot: Purchasable effect routed through registry', () => {
  it('scope override replaces observed effect without mutating underlying state', () => {
    const reg = createOverrideRegistry<Record<string, () => Decimal>>('tuning');

    beginPersistentContext('pilot-purchasable');
    const amount = persistent<number>(3, { name: 'amount' });
    endPersistentContext();

    // Consumer-side wiring: the `effect` passed into createPurchasable is a
    // tunable-wrapped computed. Default closure reads the amount ref, so the
    // effect also reacts to player progression. Key convention:
    // `${categoryId}/${defId}/effect` — grep lands on every exposed tunable.
    const purchasable = createPurchasable({
      id: 'double-gold',
      display: { description: 'Double gold' },
      requirements: [],
      effect: tunable(reg, 'upgrades/double-gold/effect', () => Decimal.mul(2, amount.value)),
    });

    // Baseline: closure-driven effect
    expect(new Decimal(purchasable.effect.value).toNumber()).toBe(6);

    // Underlying state still drives reactivity
    amount.value = 5;
    expect(new Decimal(purchasable.effect.value).toNumber()).toBe(10);

    // Sim takeover replaces the value wholesale
    const restore = reg.pushScope('sim-takeover', {
      'upgrades/double-gold/effect': () => new Decimal(9999),
    });
    expect(new Decimal(purchasable.effect.value).toNumber()).toBe(9999);

    // Underlying state is untouched — proves the override is non-destructive
    expect(amount.value).toBe(5);

    restore();
    expect(new Decimal(purchasable.effect.value).toNumber()).toBe(10);
  });
});

describe('tunable pilot: Skill-style multiplier lookup', () => {
  // Pilot 2 proves the pattern against a different shape: instead of
  // wrapping a value passed into a factory, a consumer-owned lookup fn
  // (`getSkillMultiplier(id)`) is built as multiple tunables and sim
  // overrides one by key. This is how games with shared "global skill
  // boost" tuning would wire up their skill bonuses.
  function createSkillBoosts(reg: OverrideRegistry<Record<string, () => Decimal>>) {
    const levels = new Map<string, { value: number }>([
      ['combat', { value: 10 }],
      ['magic', { value: 5 }],
    ]);
    const boosts = new Map<string, ReturnType<typeof tunable<Decimal>>>();
    for (const [id, lvl] of levels) {
      boosts.set(
        id,
        tunable(reg, `skills/${id}/multiplier`, () => Decimal.pow(1.1, lvl.value)),
      );
    }
    return {
      getBoost: (id: string) => boosts.get(id)?.value ?? new Decimal(1),
      bumpLevel: (id: string, delta: number) => {
        const l = levels.get(id);
        if (l) l.value += delta;
      },
    };
  }

  it('scoped override targets a single skill without touching the others', () => {
    const reg = createOverrideRegistry<Record<string, () => Decimal>>('tuning');
    const skills = createSkillBoosts(reg);

    const baseCombat = new Decimal(skills.getBoost('combat')).toNumber();
    const baseMagic = new Decimal(skills.getBoost('magic')).toNumber();
    expect(baseCombat).toBeCloseTo(Math.pow(1.1, 10), 5);
    expect(baseMagic).toBeCloseTo(Math.pow(1.1, 5), 5);

    // Override only combat
    const restore = reg.pushScope('sim', {
      'skills/combat/multiplier': () => new Decimal(100),
    });
    expect(new Decimal(skills.getBoost('combat')).toNumber()).toBe(100);
    // Magic is unchanged
    expect(new Decimal(skills.getBoost('magic')).toNumber()).toBeCloseTo(baseMagic, 5);
    restore();
    expect(new Decimal(skills.getBoost('combat')).toNumber()).toBeCloseTo(baseCombat, 5);
  });
});
