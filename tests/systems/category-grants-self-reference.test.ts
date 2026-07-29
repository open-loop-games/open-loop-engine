/**
 * Regression tests for self-referential grants getters (#18).
 *
 * A grants value getter that reads back through its own category's accessor
 * used to be forced into its first evaluation at bind time — before the entry
 * landed in the category map — by chain.bind invoking the modifier's
 * description getter for attribution-id derivation. The lookup missed with
 * zero reactive deps and the computed froze at its fallback permanently.
 *
 * Two guards now cover this: bind derives the id from the grant's stable
 * description text without invoking the value formatter, and the category
 * entry map is registration-reactive so a pre-registration miss re-evaluates
 * once the entry lands.
 */
import { describe, it, expect, vi } from 'vitest';
import { computed, ref } from 'vue';
import { Decimal } from '@/primitives/decimal';
import type { DecimalSource } from '@/core/persistence';
import { createResource } from '@/core/resource';
import { createCostRequirement } from '@/core/requirements';
import {
  createPurchasableCategory,
  type PurchasableCategory,
} from '@/systems/purchasable-category';
import { createModifierChain, createMultiplicativeModifier } from '@/core/modifier';

interface PerkDef {
  id: string;
  name: string;
  cost: number;
  factor: number;
}

describe('self-referential grants (#18)', () => {
  it('grants mult reading back through the category accessor tracks the purchased amount', () => {
    const gold = createResource<DecimalSource>(1000, { displayName: 'gold' });
    const chain = createModifierChain('grants-selfref-a');

    const category: PurchasableCategory<PerkDef> = createPurchasableCategory<PerkDef>({
      id: 'grants-selfref-a',
      mapPurchasable: (def) => ({
        display: { description: def.name },
        requirements: createCostRequirement({ resource: gold, cost: def.cost }),
        limit: 5,
        grants: [
          {
            chain,
            // Self-referential: reads back through the category's own accessor.
            mult: () => Decimal.pow(def.factor, category.getPurchasable(def.id)?.amount.value ?? 0),
            description: def.name,
          },
        ],
      }),
    });

    category.register([{ id: 'perk', name: 'Perk', cost: 10, factor: 2 }]);

    const p = category.getPurchasable('perk')!;
    expect(new Decimal(chain.apply(1)).toNumber()).toBe(1); // unpurchased: inactive

    expect(new Decimal(p.purchase()).toNumber()).toBe(1);
    expect(new Decimal(chain.apply(1)).toNumber()).toBe(2); // factor^amount = 2^1

    expect(new Decimal(p.purchase()).toNumber()).toBe(1);
    expect(new Decimal(chain.apply(1)).toNumber()).toBe(4); // keeps tracking: 2^2
  });

  it('bind with a description option never invokes the modifier description getter', () => {
    const chain = createModifierChain('grants-selfref-b');
    const descriptionSpy = vi.fn(() => 'Spied');

    chain.bind({
      description: 'Spied',
      modifier: createMultiplicativeModifier({
        multiplier: 2,
        description: descriptionSpy,
      }),
    });

    expect(descriptionSpy).not.toHaveBeenCalled();
    expect(chain.bindings()[0].id).toBe('Spied');
  });

  it('grants attribution ids derive from the grant description text', () => {
    const gold = createResource<DecimalSource>(1000, { displayName: 'gold' });
    const chain = createModifierChain('grants-selfref-c');

    const category = createPurchasableCategory<PerkDef>({
      id: 'grants-selfref-c',
      mapPurchasable: (def) => ({
        display: { description: def.name },
        requirements: createCostRequirement({ resource: gold, cost: def.cost }),
        limit: 5,
        grants: [{ chain, mult: 2, description: def.name }],
      }),
    });
    category.register([{ id: 'perk', name: 'Perk', cost: 10, factor: 2 }]);

    expect(chain.bindings().map((b) => b.id)).toEqual(['grants-selfref-c/perk/Perk']);
  });

  it('category accessors are registration-reactive — a pre-registration miss heals', () => {
    const gold = createResource<DecimalSource>(1000, { displayName: 'gold' });

    const category = createPurchasableCategory<PerkDef>({
      id: 'grants-selfref-d',
      mapPurchasable: (def) => ({
        display: { description: def.name },
        requirements: createCostRequirement({ resource: gold, cost: def.cost }),
        limit: 5,
      }),
    });

    // First evaluation happens before registration: the lookup misses. The
    // version-ref read inside the accessor is the only dep keeping this
    // computed invalidatable.
    const amount = computed(() => category.getPurchasable('perk')?.amount.value ?? Decimal.dNegOne);
    expect(new Decimal(amount.value).toNumber()).toBe(-1);

    category.register([{ id: 'perk', name: 'Perk', cost: 10, factor: 2 }]);
    expect(new Decimal(amount.value).toNumber()).toBe(0); // healed: entry found

    category.getPurchasable('perk')!.purchase();
    expect(new Decimal(amount.value).toNumber()).toBe(1); // tracks the real ref now
  });

  it('pins the Vue semantics the version ref exists for: a zero-dep computed freezes', () => {
    // Not an engine test — documents the reactivity behavior that makes the
    // registration-reactive read barrier necessary. If this ever fails, Vue
    // changed zero-dep computed semantics and the barrier can be revisited.
    const map = new Map<string, { value: ReturnType<typeof ref<number>> }>();
    const frozen = computed(() => map.get('x')?.value.value ?? 0);
    expect(frozen.value).toBe(0);
    map.set('x', { value: ref(5) });
    expect(frozen.value).toBe(0); // no dep → no invalidation path

    const version = ref(0);
    const healed = computed(() => {
      void version.value;
      return map.get('y')?.value.value ?? 0;
    });
    expect(healed.value).toBe(0);
    map.set('y', { value: ref(5) });
    version.value++;
    expect(healed.value).toBe(5);
  });
});
