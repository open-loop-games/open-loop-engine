import { ref } from 'vue';
import { describe, it, expect } from 'vitest';
import { bn, Decimal, type DecimalSource } from '@/primitives/decimal';
import { createResource, addResource } from '@/core/resource';
import { createCostRequirement } from '@/core/requirements';
import { createConversion } from '@/systems/conversion';

describe('Conversion', () => {
  it('single-input single-output exchange — pays cost, adds output', () => {
    const gold = createResource(bn(0), { displayName: 'Gold' });
    const wood = createResource(bn(0), { displayName: 'Wood' });
    addResource(gold, 100);

    const trade = createConversion({
      inputs: {
        gold: createCostRequirement({ resource: gold, cost: 5 }),
      },
      outputs: {
        wood: { resource: wood, amount: 1 },
      },
    });

    expect(trade.canConvert.value).toBe(true);
    const produced = trade.convert();
    expect(produced.wood.eq(1)).toBe(true);
    expect(gold.value.eq(95)).toBe(true);
    expect(wood.value.eq(1)).toBe(true);
  });

  it('multi-input single-output recipe — every cost paid, single gain', () => {
    const wood = createResource(bn(0), { displayName: 'Wood' });
    const mineral = createResource(bn(0), { displayName: 'Mineral' });
    const beam = createResource(bn(0), { displayName: 'Beam' });
    addResource(wood, 200);
    addResource(mineral, 100);

    const recipe = createConversion({
      inputs: {
        wood: createCostRequirement({ resource: wood, cost: 100 }),
        mineral: createCostRequirement({ resource: mineral, cost: 50 }),
      },
      outputs: {
        beam: { resource: beam, amount: 1 },
      },
    });

    recipe.convert();
    expect(wood.value.eq(100)).toBe(true);
    expect(mineral.value.eq(50)).toBe(true);
    expect(beam.value.eq(1)).toBe(true);
  });

  it('single-input multi-output split — one drain produces multiple gains', () => {
    const shards = createResource(bn(0), { displayName: 'Shards' });
    const points = createResource(bn(0), { displayName: 'Points' });
    const fragments = createResource(bn(0), { displayName: 'Fragments' });
    addResource(shards, 100);

    const split = createConversion({
      inputs: {
        shards: createCostRequirement({
          resource: shards,
          cost: () => shards.value,
          pay: () => {
            shards.value = bn(0);
          },
        }),
      },
      outputs: {
        points: { resource: points, amount: ({ shards }) => shards.div(10) },
        fragments: { resource: fragments, amount: ({ shards }) => shards.div(2) },
      },
    });

    const produced = split.convert();
    expect(produced.points.eq(10)).toBe(true);
    expect(produced.fragments.eq(50)).toBe(true);
    expect(shards.value.eq(0)).toBe(true);
    expect(points.value.eq(10)).toBe(true);
    expect(fragments.value.eq(50)).toBe(true);
  });

  it('multi-input multi-output — full general case', () => {
    const a = createResource(bn(0), { displayName: 'A' });
    const b = createResource(bn(0), { displayName: 'B' });
    const x = createResource(bn(0), { displayName: 'X' });
    const y = createResource(bn(0), { displayName: 'Y' });
    addResource(a, 100);
    addResource(b, 50);

    const conv = createConversion({
      inputs: {
        a: createCostRequirement({ resource: a, cost: 10 }),
        b: createCostRequirement({ resource: b, cost: 5 }),
      },
      outputs: {
        x: { resource: x, amount: ({ a, b }) => a.plus(b) },
        y: { resource: y, amount: ({ a, b }) => a.times(b) },
      },
    });

    const produced = conv.convert();
    expect(produced.x.eq(15)).toBe(true);
    expect(produced.y.eq(50)).toBe(true);
    expect(a.value.eq(90)).toBe(true);
    expect(b.value.eq(45)).toBe(true);
  });

  it('atomic snapshot — same-resource compounding reads consumed amount', () => {
    // a=10, consume-all. snapshot.a = 10. output = 10 * 2 = 20.
    // Pay drains a to 0; add 20 → a = 20. Net +10 from start.
    // If outputs read live post-spend value, output would be 0 and a would
    // end at 0 — this test would fail.
    const a = createResource(bn(0), { displayName: 'A' });
    addResource(a, 10);

    const compound = createConversion({
      inputs: {
        a: createCostRequirement({
          resource: a,
          cost: () => a.value,
          pay: () => {
            a.value = bn(0);
          },
        }),
      },
      outputs: {
        a: { resource: a, amount: ({ a }) => a.times(2) },
      },
    });

    compound.convert();
    expect(a.value.eq(20)).toBe(true);
  });

  it('canConvert false when any input requirement unmet', () => {
    const wood = createResource(bn(0), { displayName: 'Wood' });
    const mineral = createResource(bn(0), { displayName: 'Mineral' });
    const beam = createResource(bn(0), { displayName: 'Beam' });
    addResource(wood, 200);

    const recipe = createConversion({
      inputs: {
        wood: createCostRequirement({ resource: wood, cost: 100 }),
        mineral: createCostRequirement({ resource: mineral, cost: 50 }),
      },
      outputs: {
        beam: { resource: beam, amount: 1 },
      },
    });

    expect(recipe.canConvert.value).toBe(false);
    const produced = recipe.convert();
    expect(produced).toEqual({});
    expect(wood.value.eq(200)).toBe(true);
    expect(beam.value.eq(0)).toBe(true);
  });

  it('onConvert returning false cancels the conversion', () => {
    const gold = createResource(bn(0), { displayName: 'Gold' });
    const wood = createResource(bn(0), { displayName: 'Wood' });
    addResource(gold, 100);

    const trade = createConversion({
      inputs: {
        gold: createCostRequirement({ resource: gold, cost: 10 }),
      },
      outputs: {
        wood: { resource: wood, amount: 1 },
      },
      onConvert: () => false,
    });

    const produced = trade.convert();
    expect(produced).toEqual({});
    expect(gold.value.eq(100)).toBe(true);
    expect(wood.value.eq(0)).toBe(true);
  });

  it('afterConvert fires with produced map after mutation', () => {
    const gold = createResource(bn(0), { displayName: 'Gold' });
    const wood = createResource(bn(0), { displayName: 'Wood' });
    addResource(gold, 100);

    let observed: Record<string, Decimal> | undefined;
    let goldAtHook: Decimal | undefined;
    const trade = createConversion({
      inputs: {
        gold: createCostRequirement({ resource: gold, cost: 10 }),
      },
      outputs: {
        wood: { resource: wood, amount: 3 },
      },
      afterConvert: (_conv, produced) => {
        observed = { ...produced };
        goldAtHook = new Decimal(gold.value);
      },
    });

    trade.convert();
    expect(observed).toBeDefined();
    expect(observed!.wood.eq(3)).toBe(true);
    expect(goldAtHook!.eq(90)).toBe(true);
  });

  it('inline consume-all (buy-mana shape) — drains and exchanges', () => {
    const gold = createResource(bn(0), { displayName: 'Gold' });
    const mana = createResource(bn(0), { displayName: 'Mana' });
    addResource(gold, 7);

    const buyMana = createConversion({
      inputs: {
        gold: createCostRequirement({
          resource: gold,
          cost: () => gold.value,
          pay: () => {
            gold.value = bn(0);
          },
        }),
      },
      outputs: {
        mana: { resource: mana, amount: ({ gold }) => gold.times(50) },
      },
    });

    buyMana.convert();
    expect(gold.value.eq(0)).toBe(true);
    expect(mana.value.eq(350)).toBe(true);
  });

  it('output as constant Computable', () => {
    const gold = createResource(bn(0), { displayName: 'Gold' });
    const wood = createResource(bn(0), { displayName: 'Wood' });
    addResource(gold, 50);

    const trade = createConversion({
      inputs: { gold: createCostRequirement({ resource: gold, cost: 5 }) },
      outputs: { wood: { resource: wood, amount: 2 } },
    });

    expect(trade.currentGain.value.wood.eq(2)).toBe(true);
    trade.convert();
    expect(wood.value.eq(2)).toBe(true);
  });

  it('output as live-reactive ref — currentGain tracks reactive changes', () => {
    const gold = createResource(bn(0), { displayName: 'Gold' });
    const wood = createResource(bn(0), { displayName: 'Wood' });
    addResource(gold, 100);
    const multiplier = ref<DecimalSource>(bn(3));

    const trade = createConversion({
      inputs: { gold: createCostRequirement({ resource: gold, cost: 5 }) },
      outputs: {
        wood: { resource: wood, amount: () => multiplier.value },
      },
    });

    expect(trade.currentGain.value.wood.eq(3)).toBe(true);
    multiplier.value = bn(7);
    expect(trade.currentGain.value.wood.eq(7)).toBe(true);
    trade.convert();
    expect(wood.value.eq(7)).toBe(true);
  });
});
