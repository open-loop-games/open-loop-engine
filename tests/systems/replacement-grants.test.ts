import { describe, it, expect } from 'vitest';
import { ref, nextTick } from 'vue';
import { Decimal } from '@/primitives/decimal';
import { createModifierChain, createMultiplicativeModifier } from '@/core/modifier';
import { createConditionalEffectSystem } from '@/systems/conditional-effect';
import { replacementGrants } from '@/systems/replacement-grants';

describe('replacementGrants', () => {
  it('cancels the target multiplier and applies the replacement', async () => {
    // Base chain contains a ×(1.1^n) multiplier we want to swap out.
    const tickspeed = ref(4);
    const galaxies = ref(0);
    const chain = createModifierChain('test-production');

    chain.add(
      createMultiplicativeModifier({
        multiplier: () => Decimal.pow(1.1, tickspeed.value),
        description: 'Tickspeed base',
      }),
    );

    // Without any replacement, chain.apply(1) = 1 × 1.1^4 ≈ 1.4641
    expect(new Decimal(chain.apply(1)).toNumber()).toBeCloseTo(Math.pow(1.1, 4), 5);

    // Bind a replacement via a conditional effect, which is the idiomatic path.
    const effects = createConditionalEffectSystem({ id: 'test-effects' });
    const active = ref(false);
    effects.register({
      id: 'rewire',
      active,
      grants: replacementGrants({
        chain,
        cancel: () => Decimal.pow(1.1, tickspeed.value),
        replacement: () =>
          Decimal.pow(Decimal.add(1.05, Decimal.mul(galaxies.value, 0.005)), tickspeed.value),
        description: 'Rewire',
      }),
    });

    // Activate: the ×1.1^n cancels and (1.05 + 0.005·g)^n applies.
    // With g=0, expected = 1.05^4 ≈ 1.21550625
    active.value = true;
    await nextTick();
    expect(new Decimal(chain.apply(1)).toNumber()).toBeCloseTo(Math.pow(1.05, 4), 5);

    // Scaling the replacement variable: g=10 → (1.05 + 0.05)^4 = 1.1^4
    galaxies.value = 10;
    expect(new Decimal(chain.apply(1)).toNumber()).toBeCloseTo(Math.pow(1.1, 4), 5);

    // Deactivate: original multiplier is restored.
    active.value = false;
    galaxies.value = 0;
    await nextTick();
    expect(new Decimal(chain.apply(1)).toNumber()).toBeCloseTo(Math.pow(1.1, 4), 5);
  });

  it('surfaces both entries on the chain for full attribution', async () => {
    const chain = createModifierChain('test-attribution');
    const effects = createConditionalEffectSystem({ id: 'test-attr-effects' });

    effects.register({
      id: 'rewire',
      active: ref(true),
      grants: replacementGrants({
        chain,
        cancel: () => 2,
        replacement: () => 3,
        description: 'Rewire',
      }),
    });
    await nextTick();

    // Both modifiers are on the chain as distinct entries.
    expect(chain.modifiers.length).toBe(2);

    const descs = chain.modifiers.map((m) => {
      const d = typeof m.description === 'function' ? m.description() : m.description;
      return Array.isArray(d) ? undefined : d?.text;
    });
    expect(descs).toEqual(['Rewire (cancel)', 'Rewire (replacement)']);
  });
});
