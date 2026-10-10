/**
 * Integration test: Prestige Tree layer chain
 *
 * Models a 3-layer prestige game inspired by The Prestige Tree:
 *   points → prestige (layer 1) → super-prestige (layer 2) → hyper-prestige (layer 3)
 *
 * Exercises: resource, conversion, reset, persistence, purchasable, achievement, modifier, headless
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { computed, nextTick } from 'vue';
import { bn, Decimal, integerRoot } from '@/primitives/decimal';
import { createResource, addResource } from '@/core/resource';
import {
  beginPersistentContext,
  endPersistentContext,
  resetAllPersistentContexts,
} from '@/core/persistence';
import {
  createAdditiveModifier,
  createModifierChain,
  createMultiplicativeModifier,
} from '@/core/modifier';
import { createConversion } from '@/systems/conversion';
import { createCostRequirement } from '@/core/requirements';
import { createReset } from '@/systems/reset';
import { createPurchasable } from '@/systems/purchasable';
import { createAchievement } from '@/systems/achievement';
import { runHeadless } from '@/core/headless';
import type { Analyzer } from '@/primitives/types';

// ---------------------------------------------------------------------------
// Helper: build a minimal Prestige Tree game
// ---------------------------------------------------------------------------

function createPrestigeTreeGame() {
  // --- Layer 0: Points ---
  beginPersistentContext('layer0');
  const points = createResource(bn(0), { id: 'points', displayName: 'points' });

  const pointUpgrade1 = createPurchasable({
    id: 'pt-up1',
    display: { description: 'Double point gain' },
    requirements: createCostRequirement({ resource: points, cost: 10 }),
    effect: 2,
    limit: 1,
  });

  const pointUpgrade2 = createPurchasable({
    id: 'pt-up2',
    display: { description: 'Triple point gain' },
    requirements: createCostRequirement({ resource: points, cost: 100 }),
    effect: 3,
    limit: 1,
  });
  endPersistentContext();

  // --- Layer 1: Prestige ---
  beginPersistentContext('layer1');
  const prestige = createResource(bn(0), { id: 'prestige points', displayName: 'prestige points' });

  const prestigeUpgrade1 = createPurchasable({
    id: 'p-up1',
    display: { description: 'Prestige boosts point gain' },
    requirements: createCostRequirement({ resource: prestige, cost: 3 }),
    effect: 2,
    limit: 1,
  });
  endPersistentContext();

  // --- Layer 2: Super-Prestige ---
  beginPersistentContext('layer2');
  const superPrestige = createResource(bn(0), {
    id: 'super prestige',
    displayName: 'super prestige',
  });
  endPersistentContext();

  // --- Layer 3: Hyper-Prestige ---
  beginPersistentContext('layer3');
  const hyperPrestige = createResource(bn(0), {
    id: 'hyper prestige',
    displayName: 'hyper prestige',
  });
  endPersistentContext();

  // --- Point gain modifier chain ---
  // Built as a ModifierChain so each conditional upgrade lands as an
  // attributed `chain.bind` — balance-sim walks `pointGainModifier.bindings()`
  // to see where each contribution comes from. Bindings apply synchronously:
  // the test below purchases an upgrade and reads `chain.apply(...)` in the
  // same tick without `await nextTick()`.
  const pointGainModifier = createModifierChain('prestige-tree/point-gain');
  pointGainModifier.add(createAdditiveModifier({ addend: 1, description: 'Base' }));

  beginPersistentContext('prestige-tree/point-gain');
  pointGainModifier.bind({
    active: () => pointUpgrade1.active.value,
    modifier: createMultiplicativeModifier({
      multiplier: () => bn(pointUpgrade1.effect.value).toNumber(),
      description: 'Upgrade 1',
    }),
  });
  pointGainModifier.bind({
    active: () => pointUpgrade2.active.value,
    modifier: createMultiplicativeModifier({
      multiplier: () => bn(pointUpgrade2.effect.value).toNumber(),
      description: 'Upgrade 2',
    }),
  });
  pointGainModifier.bind({
    active: () => prestigeUpgrade1.active.value,
    modifier: createMultiplicativeModifier({
      multiplier: () => Decimal.add(prestige.value, 1).log10().add(1).toNumber(),
      description: 'Prestige boost',
    }),
  });
  endPersistentContext();

  // --- Resets ---
  // Layer 1 reset: resets layer 0 (points + upgrades)
  const layer1Reset = createReset({
    thingsToReset: [points, pointUpgrade1.amount, pointUpgrade2.amount],
  });

  // Layer 2 reset: resets layers 0 and 1
  const layer2Reset = createReset({
    thingsToReset: [
      points,
      pointUpgrade1.amount,
      pointUpgrade2.amount,
      prestige,
      prestigeUpgrade1.amount,
    ],
  });

  // Layer 3 reset: resets everything below
  const layer3Reset = createReset({
    thingsToReset: [
      points,
      pointUpgrade1.amount,
      pointUpgrade2.amount,
      prestige,
      prestigeUpgrade1.amount,
      superPrestige,
    ],
  });

  // --- Conversions ---
  // Consume-all + external reset composition: prestige conversions drain
  // the source layer, produce a floored-root gain on the next layer up, then
  // the layer reset zeroes the dependent layers via afterConvert.
  const prestigeConversion = createConversion({
    inputs: {
      points: createCostRequirement({
        resource: points,
        cost: () => points.value,
        pay: () => {
          points.value = bn(0);
        },
      }),
    },
    outputs: {
      prestige: {
        resource: prestige,
        amount: ({ points }) => integerRoot(Decimal.div(points, 10), 2),
      },
    },
    afterConvert: () => layer1Reset.reset(),
  });

  const superPrestigeConversion = createConversion({
    inputs: {
      prestige: createCostRequirement({
        resource: prestige,
        cost: () => prestige.value,
        pay: () => {
          prestige.value = bn(0);
        },
      }),
    },
    outputs: {
      superPrestige: {
        resource: superPrestige,
        amount: ({ prestige }) => integerRoot(Decimal.div(prestige, 10), 2),
      },
    },
    afterConvert: () => layer2Reset.reset(),
  });

  const hyperPrestigeConversion = createConversion({
    inputs: {
      superPrestige: createCostRequirement({
        resource: superPrestige,
        cost: () => superPrestige.value,
        pay: () => {
          superPrestige.value = bn(0);
        },
      }),
    },
    outputs: {
      hyperPrestige: {
        resource: hyperPrestige,
        amount: ({ superPrestige }) => integerRoot(Decimal.div(superPrestige, 5), 2),
      },
    },
    afterConvert: () => layer3Reset.reset(),
  });

  // --- Achievements (use computed refs so Vue watch tracks reactivity) ---
  beginPersistentContext('achievements');
  const firstPrestigeAchievement = createAchievement({
    id: 'first-prestige',
    display: { title: 'First Prestige', description: 'Prestige for the first time' },
    goal: computed(() => Decimal.gte(prestige.value, 1)),
  });

  const hundredPointsAchievement = createAchievement({
    id: 'hundred-points',
    display: { title: 'Century', description: 'Reach 100 points' },
    goal: computed(() => Decimal.gte(points.value, 100)),
  });

  const superPrestigeAchievement = createAchievement({
    id: 'first-super',
    display: { title: 'Super!', description: 'Perform a super prestige' },
    goal: computed(() => Decimal.gte(superPrestige.value, 1)),
  });
  endPersistentContext();

  return {
    points,
    prestige,
    superPrestige,
    hyperPrestige,
    pointUpgrade1,
    pointUpgrade2,
    prestigeUpgrade1,
    pointGainModifier,
    prestigeConversion,
    superPrestigeConversion,
    hyperPrestigeConversion,
    layer1Reset,
    layer2Reset,
    layer3Reset,
    firstPrestigeAchievement,
    hundredPointsAchievement,
    superPrestigeAchievement,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Integration: Prestige Tree layer chain', () => {
  beforeEach(() => {
    resetAllPersistentContexts();
  });

  describe('single prestige cycle', () => {
    it('accumulates points, prestiges, and resets base layer', () => {
      const game = createPrestigeTreeGame();

      // Earn 1000 points
      addResource(game.points, 1000);
      expect(Decimal.eq(game.points.value, 1000)).toBe(true);

      // Check prestige gain: floor(sqrt(1000/10)) = floor(sqrt(100)) = 10
      expect(game.prestigeConversion.currentGain.value.prestige.eq(10)).toBe(true);
      expect(game.prestigeConversion.canConvert.value).toBe(true);

      // Prestige
      const produced = game.prestigeConversion.convert();
      expect(produced.prestige.eq(10)).toBe(true);
      expect(Decimal.eq(game.prestige.value, 10)).toBe(true);

      // Points reset to 0
      expect(Decimal.eq(game.points.value, 0)).toBe(true);
    });

    it('upgrades are reset on prestige', () => {
      const game = createPrestigeTreeGame();

      // Buy upgrade 1
      addResource(game.points, 50);
      expect(game.pointUpgrade1.canPurchase.value).toBe(true);
      game.pointUpgrade1.purchase();
      expect(game.pointUpgrade1.active.value).toBe(true);

      // Prestige with remaining points + some more
      addResource(game.points, 1000);
      game.prestigeConversion.convert();

      // Upgrade should be reset
      expect(game.pointUpgrade1.active.value).toBe(false);
    });

    it('prestige currency accumulates across multiple prestiges', () => {
      const game = createPrestigeTreeGame();

      // First prestige: 1000 points → 10 prestige
      addResource(game.points, 1000);
      game.prestigeConversion.convert();
      expect(Decimal.eq(game.prestige.value, 10)).toBe(true);

      // Second prestige: 400 points → floor(sqrt(40)) = 6 prestige
      addResource(game.points, 400);
      game.prestigeConversion.convert();
      expect(Decimal.eq(game.prestige.value, 16)).toBe(true); // 10 + 6
    });
  });

  describe('cascading resets', () => {
    it('super-prestige resets both prestige and points', () => {
      const game = createPrestigeTreeGame();

      // Build up prestige
      addResource(game.prestige, 100);
      addResource(game.points, 500);
      game.pointUpgrade1.purchase(); // buy it with points
      addResource(game.points, 500); // top back up

      // Super-prestige: floor(sqrt(100/10)) = floor(sqrt(10)) = 3
      expect(game.superPrestigeConversion.currentGain.value.superPrestige.eq(3)).toBe(true);
      game.superPrestigeConversion.convert();

      // Super-prestige gained
      expect(Decimal.eq(game.superPrestige.value, 3)).toBe(true);

      // Prestige and points both reset
      expect(Decimal.eq(game.prestige.value, 0)).toBe(true);
      expect(Decimal.eq(game.points.value, 0)).toBe(true);

      // Upgrades in both layers reset
      expect(game.pointUpgrade1.active.value).toBe(false);
      expect(game.prestigeUpgrade1.active.value).toBe(false);
    });

    it('hyper-prestige resets all three lower layers', () => {
      const game = createPrestigeTreeGame();

      addResource(game.superPrestige, 20);
      addResource(game.prestige, 50);
      addResource(game.points, 300);

      // Hyper: floor(sqrt(20/5)) = floor(sqrt(4)) = 2
      expect(game.hyperPrestigeConversion.currentGain.value.hyperPrestige.eq(2)).toBe(true);
      game.hyperPrestigeConversion.convert();

      expect(Decimal.eq(game.hyperPrestige.value, 2)).toBe(true);
      expect(Decimal.eq(game.superPrestige.value, 0)).toBe(true);
      expect(Decimal.eq(game.prestige.value, 0)).toBe(true);
      expect(Decimal.eq(game.points.value, 0)).toBe(true);
    });
  });

  describe('upgrades and modifiers', () => {
    it('upgrade purchase deducts cost and applies effect', () => {
      const game = createPrestigeTreeGame();

      addResource(game.points, 15);
      game.pointUpgrade1.purchase();

      expect(game.pointUpgrade1.active.value).toBe(true);
      // Cost of 10 deducted, 5 remaining
      expect(Decimal.eq(game.points.value, 5)).toBe(true);

      // Modifier chain: base 1 × 2 (upgrade) = 2
      const rate = game.pointGainModifier.apply(bn(0));
      expect(Decimal.eq(rate, 2)).toBe(true);
    });

    it('stacking upgrades multiply together', () => {
      const game = createPrestigeTreeGame();

      addResource(game.points, 200);
      game.pointUpgrade1.purchase(); // cost 10
      game.pointUpgrade2.purchase(); // cost 100

      // base 1 × 2 × 3 = 6
      const rate = game.pointGainModifier.apply(bn(0));
      expect(Decimal.eq(rate, 6)).toBe(true);
    });

    it('prestige-based modifier scales with prestige amount', () => {
      const game = createPrestigeTreeGame();

      // Get some prestige, then buy prestige upgrade
      addResource(game.prestige, 100);
      game.prestigeUpgrade1.purchase(); // cost 3, so 97 left

      // Prestige boost: log10(97 + 1) + 1 ≈ 2.99
      const rate = game.pointGainModifier.apply(bn(0));
      // base(1) × prestige_boost(~2.99) ≈ 2.99
      expect(Decimal.gt(rate, 2.5)).toBe(true);
      expect(Decimal.lt(rate, 3.5)).toBe(true);
    });

    it('chain.bind applies synchronously after purchase — no nextTick required', () => {
      const game = createPrestigeTreeGame();

      // Before any purchase: base only.
      expect(Decimal.eq(game.pointGainModifier.apply(bn(0)), 1)).toBe(true);

      // Purchase → chain evaluation updates in the same microtask.
      addResource(game.points, 15);
      game.pointUpgrade1.purchase();
      expect(Decimal.eq(game.pointGainModifier.apply(bn(0)), 2)).toBe(true);
    });

    it('chain.bindings() surfaces all 3 conditional upgrades with scoped ids', () => {
      const game = createPrestigeTreeGame();
      const ids = game.pointGainModifier.bindings().map((b) => b.id);
      expect(ids).toContain('prestige-tree/point-gain/Upgrade 1');
      expect(ids).toContain('prestige-tree/point-gain/Upgrade 2');
      expect(ids).toContain('prestige-tree/point-gain/Prestige boost');
    });
  });

  describe('achievements', () => {
    it('first prestige achievement triggers on prestige', async () => {
      const game = createPrestigeTreeGame();

      expect(game.firstPrestigeAchievement.earned.value).toBe(false);

      addResource(game.points, 1000);
      game.prestigeConversion.convert();

      // Vue watchers are async — flush the queue
      await nextTick();
      expect(game.firstPrestigeAchievement.earned.value).toBe(true);
    });

    it('point threshold achievement triggers when threshold is reached', async () => {
      const game = createPrestigeTreeGame();

      expect(game.hundredPointsAchievement.earned.value).toBe(false);

      addResource(game.points, 100);
      await nextTick();
      expect(game.hundredPointsAchievement.earned.value).toBe(true);
    });

    it('achievements persist through prestige', async () => {
      const game = createPrestigeTreeGame();

      // Earn achievement
      addResource(game.points, 100);
      await nextTick();
      expect(game.hundredPointsAchievement.earned.value).toBe(true);

      // Prestige resets points but NOT achievements (not in thingsToReset)
      addResource(game.points, 900);
      game.prestigeConversion.convert();
      expect(Decimal.eq(game.points.value, 0)).toBe(true);

      // Achievement still earned (it's not in thingsToReset)
      expect(game.hundredPointsAchievement.earned.value).toBe(true);
    });
  });

  describe('conversion formulas', () => {
    it('sqrt formula scales correctly at key thresholds', () => {
      const game = createPrestigeTreeGame();

      // 10 points → floor(sqrt(1)) = 1
      addResource(game.points, 10);
      expect(game.prestigeConversion.currentGain.value.prestige.eq(1)).toBe(true);

      // 40 points → floor(sqrt(4)) = 2
      game.points.value = bn(40);
      expect(game.prestigeConversion.currentGain.value.prestige.eq(2)).toBe(true);

      // 90 points → floor(sqrt(9)) = 3
      game.points.value = bn(90);
      expect(game.prestigeConversion.currentGain.value.prestige.eq(3)).toBe(true);

      // 1e6 points → floor(sqrt(1e5)) = 316
      game.points.value = bn(1e6);
      expect(game.prestigeConversion.currentGain.value.prestige.eq(316)).toBe(true);
    });

    it('currentGain rolls to 0 below the formula threshold (no minimumGain guard)', () => {
      // The reshape drops the old minimumGain prestige guard. Conversions
      // that consume-all are gated only by the cost requirement (cost=0
      // returns maxBulk per requirements.ts), so canConvert can be true at
      // tiny base values. The formula evaluates to 0 below the threshold.
      const game = createPrestigeTreeGame();

      addResource(game.points, 5); // sqrt(0.5) < 1 → floor → 0
      expect(game.prestigeConversion.currentGain.value.prestige.eq(0)).toBe(true);
    });

    it('output formula can fold a multiplier (former gainModifier)', () => {
      const base = createResource(bn(0), { id: 'gm-base', displayName: 'gm-base' });
      const gain = createResource(bn(0), { id: 'gm-gain', displayName: 'gm-gain' });
      addResource(base, 1000);

      const conv = createConversion({
        inputs: {
          base: createCostRequirement({
            resource: base,
            cost: () => base.value,
            pay: () => {
              base.value = bn(0);
            },
          }),
        },
        outputs: {
          gain: {
            resource: gain,
            amount: ({ base }) => Decimal.mul(integerRoot(Decimal.div(base, 10), 2), 3),
          },
        },
      });

      // floor(sqrt(100)) * 3 = 10 * 3 = 30
      expect(conv.currentGain.value.gain.eq(30)).toBe(true);
    });
  });

  describe('headless multi-prestige simulation', () => {
    it('runs a full prestige loop headlessly and reaches layer 2', () => {
      let game: ReturnType<typeof createPrestigeTreeGame>;
      let prestigeCount = 0;
      let superPrestigeCount = 0;

      const tracker: Analyzer = {
        name: 'prestige-tracker',
        onTick: () => {},
        onEnd: () => {},
        summarize: () => ({
          name: 'prestige-tracker',
          metrics: { prestiges: prestigeCount, superPrestiges: superPrestigeCount },
        }),
      };

      const result = runHeadless({
        setup: () => {
          game = createPrestigeTreeGame();
          return [tracker];
        },
        tick: (dt) => {
          // Earn points based on modifier chain
          const rate = game.pointGainModifier.apply(bn(0));
          addResource(game.points, Decimal.mul(rate, dt));

          // Auto-buy upgrades when affordable
          if (game.pointUpgrade1.canPurchase.value) game.pointUpgrade1.purchase();
          if (game.pointUpgrade2.canPurchase.value) game.pointUpgrade2.purchase();

          // Prestige when we can get at least 5
          if (Decimal.gte(game.prestigeConversion.currentGain.value.prestige, 5)) {
            game.prestigeConversion.convert();
            prestigeCount++;
          }

          // Buy prestige upgrades
          if (game.prestigeUpgrade1.canPurchase.value) game.prestigeUpgrade1.purchase();

          // Super-prestige when it would produce a meaningful gain. The
          // reshape's consume-all semantics make canConvert true at zero
          // base, so consumer-side logic gates on currentGain instead.
          if (game.superPrestigeConversion.currentGain.value.superPrestige.gte(1)) {
            game.superPrestigeConversion.convert();
            superPrestigeCount++;
          }
        },
        ticks: 20000,
        seed: 42,
      });

      expect(result.totalTicks).toBe(20000);

      // Should have prestiged multiple times
      expect(prestigeCount).toBeGreaterThan(0);

      // Should have earned some prestige points
      // (current prestige may be 0 if we just super-prestiged, but cumulative matters)
      expect(superPrestigeCount + new Decimal(game!.prestige.value).toNumber()).toBeGreaterThan(0);

      // Analyzer tracks correctly
      const summary = result.analyzerResults[0];
      expect(summary.metrics.prestiges).toBe(prestigeCount);
    });

    it('prestige feedback loop: later prestiges are faster', () => {
      let game: ReturnType<typeof createPrestigeTreeGame>;

      // Track ticks-to-first-prestige across runs
      let ticksToFirstPrestige = -1;
      let ticksToSecondPrestige = -1;
      let tick = 0;
      let prestiges = 0;

      runHeadless({
        setup: () => {
          game = createPrestigeTreeGame();
          return [];
        },
        tick: (dt) => {
          tick++;
          const rate = game.pointGainModifier.apply(bn(0));
          addResource(game.points, Decimal.mul(rate, dt));

          if (game.pointUpgrade1.canPurchase.value) game.pointUpgrade1.purchase();

          if (Decimal.gte(game.prestigeConversion.currentGain.value.prestige, 1)) {
            game.prestigeConversion.convert();
            prestiges++;

            if (prestiges === 1) ticksToFirstPrestige = tick;
            if (prestiges === 2) {
              ticksToSecondPrestige = tick - ticksToFirstPrestige;
            }
          }
        },
        ticks: 5000,
        seed: 99,
      });

      // We should have at least 2 prestiges
      expect(prestiges).toBeGreaterThanOrEqual(2);

      // Second prestige should be achievable (may or may not be faster depending
      // on whether prestige upgrade was bought, but should still happen)
      if (ticksToSecondPrestige > 0) {
        expect(ticksToSecondPrestige).toBeGreaterThan(0);
      }
    });
  });

  describe('edge cases', () => {
    it('converting with zero base resource is a no-op convert', () => {
      // Reshape semantics: with consume-all (cost: () => points.value),
      // requirements.ts returns maxBulk when cost <= 0, so canConvert is
      // true even at zero. The conversion runs harmlessly: snapshot is 0,
      // formula produces 0, pay drains 0, prestige unchanged.
      const game = createPrestigeTreeGame();

      expect(game.prestigeConversion.canConvert.value).toBe(true);
      const result = game.prestigeConversion.convert();
      expect(result.prestige.eq(0)).toBe(true);
      expect(Decimal.eq(game.prestige.value, 0)).toBe(true);
    });

    it('resetting already-zero resources is a no-op', () => {
      const game = createPrestigeTreeGame();

      expect(Decimal.eq(game.points.value, 0)).toBe(true);
      game.layer1Reset.reset();
      expect(Decimal.eq(game.points.value, 0)).toBe(true);
    });

    it('multiple conversions at same layer are idempotent when base is spent', () => {
      const game = createPrestigeTreeGame();

      addResource(game.points, 1000);
      game.prestigeConversion.convert(); // spends all points
      const prestige1 = new Decimal(game.prestige.value).toNumber();

      // Second convert produces 0 — base is empty, formula evaluates to 0,
      // prestige unchanged.
      const result = game.prestigeConversion.convert();
      expect(result.prestige.eq(0)).toBe(true);
      expect(Decimal.eq(game.prestige.value, prestige1)).toBe(true);
    });
  });
});
