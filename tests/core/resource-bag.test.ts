import { describe, it, expect } from 'vitest';
import { computed, nextTick, watch } from 'vue';
import { Decimal } from '@/primitives/decimal';
import { bn } from '@/primitives/decimal';
import type { DecimalSource } from '@/primitives/decimal';
import { beginPersistentContext, endPersistentContext, persistent } from '@/core/persistence';
import { createResource, addResource } from '@/core/resource';
import { createSaveManager, createMemoryStorage } from '@/core/save-manager';
import {
  createResourceBag,
  transferBetweenBags,
  bulkTransfer,
  sumAmountsAsDecimal,
} from '@/core/resource-bag';

describe('ResourceBag', () => {
  describe('basic operations', () => {
    it('creates empty bag', () => {
      const bag = createResourceBag();
      expect(bag.isEmpty()).toBe(true);
      expect(bag.total().eq(0)).toBe(true);
      expect(bag.types()).toEqual([]);
      expect(bag.entries()).toEqual([]);
    });

    it('creates bag with initial values', () => {
      const bag = createResourceBag({ initial: { wood: 10, iron: 5 } });
      expect(bag.get('wood').eq(10)).toBe(true);
      expect(bag.get('iron').eq(5)).toBe(true);
      expect(bag.get('gold').eq(0)).toBe(true);
      expect(bag.isEmpty()).toBe(false);
    });

    it('get returns Decimal.dZero for missing types', () => {
      const bag = createResourceBag();
      const result = bag.get('nonexistent');
      expect(result.eq(0)).toBe(true);
    });

    it('set sets amount for a type', () => {
      const bag = createResourceBag();
      bag.set('wood', 42);
      expect(bag.get('wood').eq(42)).toBe(true);
    });

    it('add increases amount and returns added', () => {
      const bag = createResourceBag({ initial: { wood: 10 } });
      const added = bag.add('wood', 5);
      expect(added.eq(5)).toBe(true);
      expect(bag.get('wood').eq(15)).toBe(true);
    });

    it('add to new type works', () => {
      const bag = createResourceBag();
      const added = bag.add('gold', 100);
      expect(added.eq(100)).toBe(true);
      expect(bag.get('gold').eq(100)).toBe(true);
    });

    it('subtract decreases amount and returns subtracted', () => {
      const bag = createResourceBag({ initial: { wood: 10 } });
      const removed = bag.subtract('wood', 3);
      expect(removed.eq(3)).toBe(true);
      expect(bag.get('wood').eq(7)).toBe(true);
    });

    it('subtract more than available clamps to zero', () => {
      const bag = createResourceBag({ initial: { wood: 5 } });
      const removed = bag.subtract('wood', 20);
      expect(removed.eq(5)).toBe(true);
      expect(bag.get('wood').eq(0)).toBe(true);
    });

    it('subtract with allowNegative goes below zero', () => {
      const bag = createResourceBag({ initial: { wood: 5 } });
      const removed = bag.subtract('wood', 20, true);
      expect(removed.eq(20)).toBe(true);
      expect(bag.get('wood').eq(-15)).toBe(true);
    });

    it('add with a negative amount is a no-op returning zero', () => {
      const bag = createResourceBag({ initial: { wood: 5 } });
      expect(bag.add('wood', -10).toNumber()).toBe(0);
      expect(bag.get('wood').toNumber()).toBe(5);
    });

    it('subtract with a negative amount is a no-op, so it cannot bypass capacity', () => {
      const bag = createResourceBag({ capacity: 10, initial: { wood: 5 } });
      expect(bag.subtract('wood', -100).toNumber()).toBe(0);
      expect(bag.subtract('wood', -100, true).toNumber()).toBe(0);
      expect(bag.get('wood').toNumber()).toBe(5);
    });

    it('total sums all types', () => {
      const bag = createResourceBag({ initial: { wood: 10, iron: 5, gold: 3 } });
      expect(bag.total().eq(18)).toBe(true);
    });

    it('types returns non-zero type IDs', () => {
      const bag = createResourceBag({ initial: { wood: 10, iron: 0, gold: 3 } });
      const types = bag.types();
      expect(types).toContain('wood');
      expect(types).toContain('gold');
      expect(types).not.toContain('iron');
    });

    it('entries returns non-zero pairs', () => {
      const bag = createResourceBag({ initial: { wood: 10, iron: 0 } });
      const entries = bag.entries();
      expect(entries.length).toBe(1);
      expect(entries[0][0]).toBe('wood');
      expect(entries[0][1].eq(10)).toBe(true);
    });

    it('amounts exposes live non-zero map with stable reference', () => {
      const bag = createResourceBag({ initial: { wood: 10, iron: 5 } });
      const ref = bag.amounts;

      expect(ref.size).toBe(2);
      expect(ref.get('wood')?.eq(10)).toBe(true);

      bag.add('gold', 7);
      expect(ref.size).toBe(3);
      expect(ref.get('gold')?.eq(7)).toBe(true);

      bag.subtract('wood', 10);
      expect(ref.has('wood')).toBe(false);
      expect(ref.size).toBe(2);

      bag.clear();
      expect(bag.amounts).toBe(ref);
      expect(ref.size).toBe(0);

      bag.restore({ stone: '3' });
      expect(bag.amounts).toBe(ref);
      expect(ref.get('stone')?.eq(3)).toBe(true);
    });

    it('clear sets everything to zero', () => {
      const bag = createResourceBag({ initial: { wood: 10, iron: 5 } });
      bag.clear();
      expect(bag.isEmpty()).toBe(true);
      expect(bag.get('wood').eq(0)).toBe(true);
    });

    it('has checks single type', () => {
      const bag = createResourceBag({ initial: { wood: 10 } });
      expect(bag.has('wood', 5)).toBe(true);
      expect(bag.has('wood', 15)).toBe(false);
    });

    it('hasAll checks multiple types', () => {
      const bag = createResourceBag({ initial: { wood: 10, iron: 5 } });
      expect(bag.hasAll({ wood: 5, iron: 3 })).toBe(true);
      expect(bag.hasAll({ wood: 5, iron: 10 })).toBe(false);
    });

    it('hasAll with empty requirements returns true', () => {
      const bag = createResourceBag();
      expect(bag.hasAll({})).toBe(true);
    });

    it('displayName defaults to empty string', () => {
      const bag = createResourceBag();
      expect(bag.displayName).toBe('');
    });

    it('displayName can be set via options', () => {
      const bag = createResourceBag({ displayName: 'Inventory' });
      expect(bag.displayName).toBe('Inventory');
    });
  });

  describe('total capacity', () => {
    it('remainingCapacity returns Infinity when uncapped', () => {
      const bag = createResourceBag({ initial: { wood: 10 } });
      expect(bag.remainingCapacity().eq(Decimal.dInf)).toBe(true);
    });

    it('remainingCapacity returns correct value when capped', () => {
      const bag = createResourceBag({ capacity: 20, initial: { wood: 8 } });
      expect(bag.remainingCapacity().eq(12)).toBe(true);
    });

    it('block overflow: add beyond total capacity returns zero', () => {
      const bag = createResourceBag({ capacity: 10, initial: { wood: 8 }, overflow: 'block' });
      const added = bag.add('iron', 5);
      expect(added.eq(0)).toBe(true);
      expect(bag.get('iron').eq(0)).toBe(true);
      expect(bag.get('wood').eq(8)).toBe(true);
    });

    it('block overflow: add within total capacity succeeds', () => {
      const bag = createResourceBag({ capacity: 10, initial: { wood: 5 }, overflow: 'block' });
      const added = bag.add('iron', 3);
      expect(added.eq(3)).toBe(true);
      expect(bag.get('iron').eq(3)).toBe(true);
    });

    it('destroy overflow: add beyond total capacity caps', () => {
      const bag = createResourceBag({ capacity: 10, initial: { wood: 8 }, overflow: 'discard' });
      const added = bag.add('iron', 5);
      expect(added.eq(2)).toBe(true);
      expect(bag.get('iron').eq(2)).toBe(true);
    });

    it('set clamps to total capacity', () => {
      const bag = createResourceBag({ capacity: 10, initial: { wood: 5 } });
      bag.set('iron', 20);
      expect(bag.get('iron').eq(5)).toBe(true);
    });
  });

  describe('per-type capacity', () => {
    it('remainingCapacityForType returns Infinity when uncapped', () => {
      const bag = createResourceBag();
      expect(bag.remainingCapacityForType('wood').eq(Decimal.dInf)).toBe(true);
    });

    it('remainingCapacityForType respects per-type cap', () => {
      const bag = createResourceBag({ capacityPerType: { wood: 15 }, initial: { wood: 10 } });
      expect(bag.remainingCapacityForType('wood').eq(5)).toBe(true);
    });

    it('block overflow: add beyond per-type cap returns zero', () => {
      const bag = createResourceBag({ capacityPerType: { wood: 10 }, overflow: 'block' });
      bag.set('wood', 8);
      const added = bag.add('wood', 5);
      expect(added.eq(0)).toBe(true);
      expect(bag.get('wood').eq(8)).toBe(true);
    });

    it('destroy overflow: add beyond per-type cap caps', () => {
      const bag = createResourceBag({ capacityPerType: { wood: 10 }, overflow: 'discard' });
      bag.set('wood', 8);
      const added = bag.add('wood', 5);
      expect(added.eq(2)).toBe(true);
      expect(bag.get('wood').eq(10)).toBe(true);
    });

    it('uncapped type is not limited by per-type caps', () => {
      const bag = createResourceBag({ capacityPerType: { wood: 10 } });
      bag.add('iron', 1000);
      expect(bag.get('iron').eq(1000)).toBe(true);
    });
  });

  describe('both capacities active', () => {
    it('effective remaining is minimum of type and total', () => {
      const bag = createResourceBag({
        capacity: 20,
        capacityPerType: { wood: 8 },
        initial: { wood: 5, iron: 10 },
      });
      // total remaining = 20 - 15 = 5, wood type remaining = 8 - 5 = 3
      expect(bag.remainingCapacityForType('wood').eq(3)).toBe(true);
      // iron has no type cap, so limited only by total: 5
      expect(bag.remainingCapacityForType('iron').eq(5)).toBe(true);
    });

    it('block respects whichever cap is tighter', () => {
      const bag = createResourceBag({
        capacity: 100,
        capacityPerType: { wood: 10 },
        initial: { wood: 8 },
        overflow: 'block',
      });
      // type cap is tighter (2 remaining vs 92 total remaining)
      const added = bag.add('wood', 5);
      expect(added.eq(0)).toBe(true);
    });
  });

  describe('transferBetweenBags', () => {
    it('transfers amount between bags', () => {
      const from = createResourceBag({ initial: { wood: 20 } });
      const to = createResourceBag();
      const transferred = transferBetweenBags(from, to, 'wood', 10);
      expect(transferred.eq(10)).toBe(true);
      expect(from.get('wood').eq(10)).toBe(true);
      expect(to.get('wood').eq(10)).toBe(true);
    });

    it('transfer limited by source availability', () => {
      const from = createResourceBag({ initial: { wood: 3 } });
      const to = createResourceBag();
      const transferred = transferBetweenBags(from, to, 'wood', 10);
      expect(transferred.eq(3)).toBe(true);
      expect(from.get('wood').eq(0)).toBe(true);
      expect(to.get('wood').eq(3)).toBe(true);
    });

    it('transfer limited by target capacity (destroy)', () => {
      const from = createResourceBag({ initial: { wood: 20 } });
      const to = createResourceBag({ capacity: 5, overflow: 'discard' });
      const transferred = transferBetweenBags(from, to, 'wood', 10);
      expect(transferred.eq(5)).toBe(true);
      expect(from.get('wood').eq(15)).toBe(true);
      expect(to.get('wood').eq(5)).toBe(true);
    });

    it('transfer limited by target capacity (block)', () => {
      const from = createResourceBag({ initial: { wood: 20 } });
      const to = createResourceBag({ capacity: 5, initial: { wood: 3 }, overflow: 'block' });
      // only 2 remaining, and block mode means 10 > 2 so nothing transfers
      const transferred = transferBetweenBags(from, to, 'wood', 10);
      expect(transferred.eq(0)).toBe(true);
      expect(from.get('wood').eq(20)).toBe(true);
      expect(to.get('wood').eq(3)).toBe(true);
    });
  });

  describe('bulkTransfer', () => {
    it('partial: transfers as much as possible per type', () => {
      const from = createResourceBag({ initial: { wood: 10, iron: 3 } });
      const to = createResourceBag();
      const result = bulkTransfer(from, to, { wood: 5, iron: 10 });
      expect(new Decimal(result['wood']).eq(5)).toBe(true);
      expect(new Decimal(result['iron']).eq(3)).toBe(true);
    });

    it('allOrNothing: succeeds when all fit', () => {
      const from = createResourceBag({ initial: { wood: 10, iron: 10 } });
      const to = createResourceBag();
      const result = bulkTransfer(from, to, { wood: 5, iron: 3 }, true);
      expect(new Decimal(result['wood']).eq(5)).toBe(true);
      expect(new Decimal(result['iron']).eq(3)).toBe(true);
      expect(from.get('wood').eq(5)).toBe(true);
      expect(from.get('iron').eq(7)).toBe(true);
    });

    it('allOrNothing: fails when any type insufficient', () => {
      const from = createResourceBag({ initial: { wood: 10, iron: 1 } });
      const to = createResourceBag();
      const result = bulkTransfer(from, to, { wood: 5, iron: 3 }, true);
      expect(Object.keys(result).length).toBe(0);
      expect(from.get('wood').eq(10)).toBe(true);
      expect(from.get('iron').eq(1)).toBe(true);
    });

    it('allOrNothing: fails when target capacity insufficient', () => {
      const from = createResourceBag({ initial: { wood: 10, iron: 10 } });
      const to = createResourceBag({ capacity: 6, overflow: 'block' });
      const result = bulkTransfer(from, to, { wood: 5, iron: 5 }, true);
      expect(Object.keys(result).length).toBe(0);
      expect(from.get('wood').eq(10)).toBe(true);
    });

    it('sumAmountsAsDecimal: 10-element boundary wrap returns Decimal instance', () => {
      // Regression guard for the final-wrap contract: renormIfLayer0 may keep
      // the accumulator in number-space for fast-path firing between steps,
      // but the reduce's boundary must return a Decimal so callers can chain
      // instance methods. 10 elements is deep enough to catch any stray
      // number leaking through a missing boundary wrap.
      const amounts: Record<string, number> = {};
      for (let i = 0; i < 10; i++) amounts[`r${i}`] = i + 1;
      const total = sumAmountsAsDecimal(Object.values(amounts));
      expect(total).toBeInstanceOf(Decimal);
      expect(total.eq(55)).toBe(true);
      // Chain-form works — proves the boundary actually returned an instance,
      // not a primed number that happened to coerce.
      expect(total.add(5).toNumber()).toBe(60);
    });
  });

  describe('link', () => {
    it('initial sync copies resource value to bag', () => {
      beginPersistentContext('test-link-init');
      const gold = createResource(bn(50), { id: 'Gold', displayName: 'Gold' });
      endPersistentContext();
      const bag = createResourceBag();
      bag.link('gold', gold);
      expect(bag.get('gold').eq(50)).toBe(true);
    });

    it('initial sync clamps the resource back when it already exceeds capacity', () => {
      // Linking a resource whose value is over the bag's cap must reconcile
      // both sides immediately — the initial sync runs before the watchers
      // install, so nothing else will. Otherwise the bag holds 100 while the
      // resource still reads 150 and cost/cap checks disagree indefinitely.
      beginPersistentContext('test-link-init-clamp');
      const gold = createResource(bn(150), { id: 'Gold', displayName: 'Gold' });
      endPersistentContext();
      const bag = createResourceBag({ capacity: 100 });
      bag.link('gold', gold);
      expect(bag.get('gold').eq(100)).toBe(true);
      expect(new Decimal(gold.value).eq(100)).toBe(true);
    });

    it('bag change propagates to resource', async () => {
      beginPersistentContext('test-link-bag-to-res');
      const gold = createResource(bn(10), { id: 'Gold', displayName: 'Gold' });
      endPersistentContext();
      const bag = createResourceBag();
      bag.link('gold', gold);
      bag.set('gold', 99);
      await nextTick();
      expect(new Decimal(gold.value).eq(99)).toBe(true);
    });

    it('resource change propagates to bag', async () => {
      beginPersistentContext('test-link-res-to-bag');
      const gold = createResource(bn(10), { id: 'Gold', displayName: 'Gold' });
      endPersistentContext();
      const bag = createResourceBag();
      bag.link('gold', gold);
      addResource(gold, 20);
      await nextTick();
      expect(bag.get('gold').eq(30)).toBe(true);
    });

    it('capacity clamping on resource increase propagates back', async () => {
      beginPersistentContext('test-link-clamp');
      const gold = createResource(bn(5), { id: 'Gold', displayName: 'Gold' });
      endPersistentContext();
      const bag = createResourceBag({ capacity: 10 });
      bag.link('gold', gold);
      addResource(gold, 100);
      await nextTick();
      expect(bag.get('gold').eq(10)).toBe(true);
      await nextTick();
      expect(new Decimal(gold.value).eq(10)).toBe(true);
    });

    it('cleanup stops sync', async () => {
      beginPersistentContext('test-link-cleanup');
      const gold = createResource(bn(10), { id: 'Gold', displayName: 'Gold' });
      endPersistentContext();
      const bag = createResourceBag();
      const cleanup = bag.link('gold', gold);
      cleanup();
      bag.set('gold', 999);
      await nextTick();
      expect(new Decimal(gold.value).eq(10)).toBe(true);
    });

    it('re-linking same typeId replaces previous link', async () => {
      beginPersistentContext('test-link-replace-1');
      const gold1 = createResource(bn(10), { id: 'Gold1', displayName: 'Gold1' });
      endPersistentContext();
      beginPersistentContext('test-link-replace-2');
      const gold2 = createResource(bn(20), { id: 'Gold2', displayName: 'Gold2' });
      endPersistentContext();
      const bag = createResourceBag();
      bag.link('gold', gold1);
      expect(bag.get('gold').eq(10)).toBe(true);
      bag.link('gold', gold2);
      expect(bag.get('gold').eq(20)).toBe(true);
      bag.set('gold', 99);
      await nextTick();
      expect(new Decimal(gold1.value).eq(10)).toBe(true);
      expect(new Decimal(gold2.value).eq(99)).toBe(true);
    });

    it('gain the cap destroys counts toward neither cumulative nor best', () => {
      beginPersistentContext('test-link-trackers');
      const wood = createResource<DecimalSource>(0, { id: 'wood' });
      endPersistentContext();
      const bag = createResourceBag({ capacityPerType: { wood: 10 } });
      bag.link('wood', wood);
      for (let i = 0; i < 15; i++) addResource(wood, 1);
      expect(new Decimal(wood.value).toNumber()).toBe(10);
      expect(new Decimal(wood.cumulative!.value).toNumber()).toBe(10);
      expect(new Decimal(wood.best!.value).toNumber()).toBe(10);
    });

    it('a total cap shared with another type clamps tracker gain the same way', () => {
      beginPersistentContext('test-link-trackers-total');
      const wood = createResource<DecimalSource>(0, { id: 'wood' });
      endPersistentContext();
      const bag = createResourceBag({ capacity: 10, initial: { stone: 4 } });
      bag.link('wood', wood);
      addResource(wood, 9);
      expect(new Decimal(wood.value).toNumber()).toBe(6);
      expect(new Decimal(wood.cumulative!.value).toNumber()).toBe(6);
      expect(new Decimal(wood.best!.value).toNumber()).toBe(6);
    });

    it('gain counts in full again once the link is cleaned up', () => {
      beginPersistentContext('test-link-trackers-unlink');
      const wood = createResource<DecimalSource>(0, { id: 'wood' });
      endPersistentContext();
      const bag = createResourceBag({ capacityPerType: { wood: 10 } });
      const unlink = bag.link('wood', wood);
      addResource(wood, 15);
      unlink();
      addResource(wood, 15);
      expect(new Decimal(wood.value).toNumber()).toBe(25);
      expect(new Decimal(wood.cumulative!.value).toNumber()).toBe(25);
      expect(new Decimal(wood.best!.value).toNumber()).toBe(25);
    });

    it('re-linking the same resource to the same type keeps one clamp', () => {
      beginPersistentContext('test-link-trackers-relink');
      const wood = createResource<DecimalSource>(0, { id: 'wood' });
      endPersistentContext();
      const bag = createResourceBag({ capacityPerType: { wood: 10 } });
      bag.link('wood', wood);
      bag.link('wood', wood);
      addResource(wood, 15);
      expect(new Decimal(wood.cumulative!.value).toNumber()).toBe(10);
    });

    it('linking a resource into a second bag throws', () => {
      beginPersistentContext('test-link-two-bags');
      const wood = createResource<DecimalSource>(0, { id: 'wood' });
      endPersistentContext();
      createResourceBag({ capacity: 10 }).link('wood', wood);
      expect(() => createResourceBag({ capacity: 5 }).link('wood', wood)).toThrow(/already linked/);
    });

    it("a superseded link's cleanup leaves the link that replaced it alone", () => {
      beginPersistentContext('test-link-stale-cleanup');
      const a = createResource<DecimalSource>(0, { id: 'a' });
      const b = createResource<DecimalSource>(0, { id: 'b' });
      const c = createResource<DecimalSource>(0, { id: 'c' });
      endPersistentContext();
      const bag = createResourceBag({ capacity: 10 });
      const unlinkA = bag.link('slot', a);
      bag.link('slot', b);
      unlinkA();
      bag.link('slot', c);
      // Linking c over b releases b, even after a's stale cleanup ran.
      expect(() => createResourceBag().link('slot', b)).not.toThrow();
    });

    it('a save load restores every linked slot under a shared cap', () => {
      // Slots load one at a time; clamping each against the others' pre-load
      // amounts would trim a valid save that moved its holdings between slots.
      const mgr = createSaveManager({ gameId: 'bag-load', storageAdapter: createMemoryStorage() });
      beginPersistentContext('bag-load');
      const wood = createResource<DecimalSource>(0, { id: 'wood' });
      const stone = createResource<DecimalSource>(0, { id: 'stone' });
      endPersistentContext();
      const bag = createResourceBag({ capacity: 50 });
      bag.link('wood', wood);
      bag.link('stone', stone);

      bag.set('wood', 50);
      const snapshot = mgr.exportSave();
      bag.set('wood', 0);
      bag.set('stone', 50);

      expect(mgr.importSave(snapshot).success).toBe(true);
      expect(new Decimal(wood.value).toNumber()).toBe(50);
      expect(new Decimal(stone.value).toNumber()).toBe(0);
      expect(bag.get('wood').toNumber()).toBe(50);
      expect(bag.total().toNumber()).toBe(50);
    });

    it('a save load does not clamp against a capacity that reads later-loaded state', () => {
      const mgr = createSaveManager({ gameId: 'bag-cap', storageAdapter: createMemoryStorage() });
      beginPersistentContext('bag-cap-items');
      const wood = createResource<DecimalSource>(0, { id: 'wood' });
      endPersistentContext();
      beginPersistentContext('bag-cap-bonus');
      const capBonus = persistent<number>(0, { name: 'bonus' });
      endPersistentContext();
      const bag = createResourceBag({ capacity: () => 10 + capBonus.value });
      bag.link('wood', wood);

      capBonus.value = 90;
      bag.set('wood', 80);
      const snapshot = mgr.exportSave();
      capBonus.value = 0;
      bag.set('wood', 0);

      expect(mgr.importSave(snapshot).success).toBe(true);
      expect(capBonus.value).toBe(90);
      expect(new Decimal(wood.value).toNumber()).toBe(80);
      expect(bag.get('wood').toNumber()).toBe(80);
    });
  });

  describe('reactivity', () => {
    it('computed reacts to tracked type change', async () => {
      const bag = createResourceBag({ initial: { wood: 10 } });
      let computeCount = 0;
      const woodAmount = computed(() => {
        computeCount++;
        return bag.get('wood');
      });
      expect(woodAmount.value.eq(10)).toBe(true);
      const initialCount = computeCount;

      bag.set('wood', 20);
      await nextTick();
      expect(woodAmount.value.eq(20)).toBe(true);
      expect(computeCount).toBeGreaterThan(initialCount);
    });

    it('computed does NOT react to unrelated type change', async () => {
      const bag = createResourceBag({ initial: { wood: 10, iron: 5 } });
      let computeCount = 0;
      const woodAmount = computed(() => {
        computeCount++;
        return bag.get('wood');
      });
      void woodAmount.value;
      const countAfterInit = computeCount;

      bag.set('iron', 99);
      await nextTick();
      void woodAmount.value;
      expect(computeCount).toBe(countAfterInit);
    });

    it('computeds over total and remaining capacity follow every mutation', () => {
      const bag = createResourceBag({ capacity: 100 });
      const total = computed(() => bag.total().toNumber());
      const remaining = computed(() => bag.remainingCapacity().toNumber());
      const read = () => [total.value, remaining.value];
      expect(read()).toEqual([0, 100]);
      bag.add('wood', 10);
      expect(read()).toEqual([10, 90]);
      bag.subtract('wood', 4);
      expect(read()).toEqual([6, 94]);
      bag.set('stone', 20);
      expect(read()).toEqual([26, 74]);
      bag.clear();
      expect(read()).toEqual([0, 100]);
      bag.restore({ wood: '30' });
      expect(read()).toEqual([30, 70]);
    });

    it("a computed over one type's remaining capacity follows another type under a total cap", () => {
      const bag = createResourceBag({ capacity: 100, capacityPerType: { wood: 80 } });
      const woodRoom = computed(() => bag.remainingCapacityForType('wood').toNumber());
      expect(woodRoom.value).toBe(80);
      bag.add('stone', 50);
      expect(woodRoom.value).toBe(50);
      bag.clear();
      expect(woodRoom.value).toBe(80);
      bag.restore({ stone: '90' });
      expect(woodRoom.value).toBe(10);
    });

    it('a sync watch on a linked resource reads the new total', () => {
      beginPersistentContext('test-bag-sync-total');
      const wood = createResource<DecimalSource>(0, { id: 'wood' });
      endPersistentContext();
      // Capped, so each add reads the total first and leaves the cache clean.
      const bag = createResourceBag({ capacity: 100, initial: { stone: 5 } });
      bag.link('wood', wood);
      const seen: number[] = [];
      watch(wood, () => seen.push(bag.total().toNumber()), { flush: 'sync' });
      bag.add('wood', 3);
      bag.subtract('wood', 3);
      expect(seen).toEqual([8, 5]);
      expect(bag.total().toNumber()).toBe(5);
    });

    it('a sync watch on the total sees each write', () => {
      const bag = createResourceBag();
      const seen: number[] = [];
      watch(
        () => bag.total().toNumber(),
        (total) => seen.push(total),
        { flush: 'sync' },
      );
      bag.add('wood', 3);
      bag.add('stone', 4);
      bag.clear();
      expect(seen).toEqual([3, 7, 0]);
    });
  });

  describe('persistence', () => {
    it('serializes to record of strings', () => {
      const bag = createResourceBag({ initial: { wood: 10, iron: 5 } });
      const serialized = bag.serialize();
      expect(serialized).toEqual({ wood: '10', iron: '5' });
    });

    it('omits zero-valued types from serialization', () => {
      const bag = createResourceBag({ initial: { wood: 10, iron: 0 } });
      const serialized = bag.serialize();
      expect(serialized).toEqual({ wood: '10' });
      expect('iron' in serialized).toBe(false);
    });

    it('restores from a record of strings', () => {
      const bag = createResourceBag();
      bag.restore({ wood: '10', iron: '5' });
      expect(bag.get('wood').eq(10)).toBe(true);
      expect(bag.get('iron').eq(5)).toBe(true);
    });

    it('restore clears types not in save data', () => {
      const bag = createResourceBag({ initial: { wood: 10, iron: 5 } });
      bag.restore({ gold: '99' });
      expect(bag.get('wood').eq(0)).toBe(true);
      expect(bag.get('iron').eq(0)).toBe(true);
      expect(bag.get('gold').eq(99)).toBe(true);
    });

    it('round-trip serialize/restore preserves state', () => {
      const bag = createResourceBag({ initial: { wood: 10, iron: 5, gold: 0 } });
      bag.add('gold', 3);
      const serialized = bag.serialize();

      const bag2 = createResourceBag();
      bag2.restore(serialized);
      expect(bag2.get('wood').eq(10)).toBe(true);
      expect(bag2.get('iron').eq(5)).toBe(true);
      expect(bag2.get('gold').eq(3)).toBe(true);
    });
  });

  describe('running total invariant', () => {
    it('total() matches sum after adds and subtracts', () => {
      const bag = createResourceBag({ initial: { a: 10, b: 20 } });
      expect(bag.total().eq(30)).toBe(true);
      bag.add('a', 5);
      expect(bag.total().eq(35)).toBe(true);
      bag.subtract('b', 7);
      expect(bag.total().eq(28)).toBe(true);
      bag.set('c', 12);
      expect(bag.total().eq(40)).toBe(true);
    });

    it('total() resets to zero after clear()', () => {
      const bag = createResourceBag({ initial: { a: 10, b: 20 } });
      bag.clear();
      expect(bag.total().eq(0)).toBe(true);
      bag.add('a', 3);
      expect(bag.total().eq(3)).toBe(true);
    });

    it('total() is correct after restore() replaces contents', () => {
      const bag = createResourceBag({ initial: { a: 10, b: 20 } });
      bag.restore({ x: '100', y: '50' });
      expect(bag.total().eq(150)).toBe(true);
      bag.add('x', 5);
      expect(bag.total().eq(155)).toBe(true);
    });

    it('total() tracks allowNegative subtract past zero', () => {
      const bag = createResourceBag({ initial: { a: 10 } });
      bag.subtract('a', 15, true);
      expect(bag.get('a').eq(-5)).toBe(true);
      expect(bag.total().eq(-5)).toBe(true);
      bag.add('b', 10);
      expect(bag.total().eq(5)).toBe(true);
    });

    it('capacity respected after many mutations (clamp uses running total)', () => {
      const bag = createResourceBag({ capacity: 100, overflow: 'discard' });
      for (let i = 0; i < 50; i++) bag.add('x', 1);
      for (let i = 0; i < 50; i++) bag.add('y', 1);
      expect(bag.total().eq(100)).toBe(true);
      expect(bag.remainingCapacity().eq(0)).toBe(true);
      // Further adds should fail (no room)
      const added = bag.add('z', 1);
      expect(added.eq(0)).toBe(true);
      expect(bag.total().eq(100)).toBe(true);
    });

    it('subtract then re-add preserves total precisely', () => {
      const bag = createResourceBag({ initial: { a: 100 } });
      bag.subtract('a', 100);
      expect(bag.total().eq(0)).toBe(true);
      expect(bag.isEmpty()).toBe(true);
      bag.add('a', 42);
      expect(bag.total().eq(42)).toBe(true);
    });

    it('total() is exactly zero once fractional churn empties the bag', () => {
      const bag = createResourceBag({ capacity: 1 });
      bag.set('a', 0.1);
      bag.set('b', 0.2);
      bag.set('a', 0);
      bag.set('b', 0);
      expect(bag.isEmpty()).toBe(true);
      expect(bag.total().toNumber()).toBe(0);
      expect(bag.remainingCapacity().toNumber()).toBe(1);
      expect(bag.add('z', 1).toNumber()).toBe(1);
    });

    it('total() keeps a small slot once a much larger one leaves', () => {
      const bag = createResourceBag({ capacity: 1e20 });
      bag.set('a', 1e17);
      bag.set('b', 1);
      bag.set('a', 0);
      expect(bag.total().toNumber()).toBe(1);
      expect(bag.remainingCapacity().toNumber()).toBe(1e20 - 1);
    });
  });
});
