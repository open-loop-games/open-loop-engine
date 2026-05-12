import { describe, it, expect } from 'vitest';
import { nextTick } from 'vue';
import { createInventory } from '@/systems/inventory';
import { createAdditiveModifier, createMultiplicativeModifier } from '@/core/modifier';
import type { Modifier } from '@/core/modifier';

describe('Inventory', () => {
  describe('basic operations', () => {
    it('creates empty inventory with id and capacity', () => {
      const inv = createInventory({ id: 'backpack', baseCapacity: 20 });
      expect(inv.id).toBe('backpack');
      expect(inv.isEmpty()).toBe(true);
      expect(inv.capacity.value.eq(20)).toBe(true);
    });

    it('creates inventory with initial items', () => {
      const inv = createInventory({
        id: 'inv',
        baseCapacity: 100,
        initial: { wood: 10, iron: 5 },
      });
      expect(inv.get('wood').eq(10)).toBe(true);
      expect(inv.get('iron').eq(5)).toBe(true);
      expect(inv.isEmpty()).toBe(false);
    });

    it('add returns amount added', () => {
      const inv = createInventory({ id: 'inv', baseCapacity: 100 });
      const added = inv.add('wood', 15);
      expect(added.eq(15)).toBe(true);
      expect(inv.get('wood').eq(15)).toBe(true);
    });

    it('remove returns amount removed', () => {
      const inv = createInventory({
        id: 'inv',
        baseCapacity: 100,
        initial: { wood: 20 },
      });
      const removed = inv.remove('wood', 8);
      expect(removed.eq(8)).toBe(true);
      expect(inv.get('wood').eq(12)).toBe(true);
    });

    it('remove clamps to available amount', () => {
      const inv = createInventory({
        id: 'inv',
        baseCapacity: 100,
        initial: { wood: 5 },
      });
      const removed = inv.remove('wood', 20);
      expect(removed.eq(5)).toBe(true);
      expect(inv.get('wood').eq(0)).toBe(true);
    });

    it('has checks if enough of an item exists', () => {
      const inv = createInventory({
        id: 'inv',
        baseCapacity: 100,
        initial: { wood: 10 },
      });
      expect(inv.has('wood', 5)).toBe(true);
      expect(inv.has('wood', 15)).toBe(false);
    });

    it('hasAll checks multiple items', () => {
      const inv = createInventory({
        id: 'inv',
        baseCapacity: 100,
        initial: { wood: 10, iron: 5 },
      });
      expect(inv.hasAll({ wood: 5, iron: 3 })).toBe(true);
      expect(inv.hasAll({ wood: 5, iron: 10 })).toBe(false);
    });

    it('items returns non-zero item types', () => {
      const inv = createInventory({
        id: 'inv',
        baseCapacity: 100,
        initial: { wood: 10, iron: 0, gold: 3 },
      });
      const items = inv.items();
      expect(items).toContain('wood');
      expect(items).toContain('gold');
      expect(items).not.toContain('iron');
    });

    it('clear removes all items', () => {
      const inv = createInventory({
        id: 'inv',
        baseCapacity: 100,
        initial: { wood: 10, iron: 5 },
      });
      inv.clear();
      expect(inv.isEmpty()).toBe(true);
    });
  });

  describe('per-item capacity', () => {
    it('block overflow: rejects add beyond per-item cap', () => {
      const inv = createInventory({ id: 'inv', baseCapacity: 10 });
      inv.add('wood', 8);
      const added = inv.add('wood', 5); // would exceed 10
      expect(added.eq(0)).toBe(true);
      expect(inv.get('wood').eq(8)).toBe(true);
    });

    it('block overflow: allows add within per-item cap', () => {
      const inv = createInventory({ id: 'inv', baseCapacity: 10 });
      inv.add('wood', 3);
      const added = inv.add('wood', 5); // 3 + 5 = 8 <= 10
      expect(added.eq(5)).toBe(true);
      expect(inv.get('wood').eq(8)).toBe(true);
    });

    it('destroy overflow: adds partial amount up to cap', () => {
      const inv = createInventory({ id: 'inv', baseCapacity: 10, overflow: 'destroy' });
      inv.add('wood', 8);
      const added = inv.add('wood', 5); // only 2 fits
      expect(added.eq(2)).toBe(true);
      expect(inv.get('wood').eq(10)).toBe(true);
    });

    it('per-item cap applies independently per item type', () => {
      const inv = createInventory({ id: 'inv', baseCapacity: 10 });
      inv.add('wood', 10);
      const added = inv.add('iron', 10); // different type, separate cap
      expect(added.eq(10)).toBe(true);
      expect(inv.get('iron').eq(10)).toBe(true);
    });

    it('canFit returns true when amount fits', () => {
      const inv = createInventory({ id: 'inv', baseCapacity: 10 });
      inv.add('wood', 6);
      expect(inv.canFit('wood', 4)).toBe(true);
      expect(inv.canFit('wood', 5)).toBe(false);
    });

    it('isFull returns true when item type is at cap', () => {
      const inv = createInventory({ id: 'inv', baseCapacity: 10 });
      inv.add('wood', 10);
      expect(inv.isFull('wood')).toBe(true);
      expect(inv.isFull('iron')).toBe(false);
    });

    it('remainingSpace returns correct value', () => {
      const inv = createInventory({ id: 'inv', baseCapacity: 20 });
      inv.add('wood', 13);
      expect(inv.remainingSpace('wood').eq(7)).toBe(true);
    });
  });

  describe('total capacity', () => {
    it('isFull with no arg checks total capacity', () => {
      const inv = createInventory({
        id: 'inv',
        baseCapacity: 100,
        totalCapacity: 15,
      });
      inv.add('wood', 10);
      inv.add('iron', 5);
      expect(inv.isFull()).toBe(true);
    });

    it('total capacity limits add across types', () => {
      const inv = createInventory({
        id: 'inv',
        baseCapacity: 100,
        totalCapacity: 15,
      });
      inv.add('wood', 10);
      // 5 remaining total, per-item cap is 100
      const added = inv.add('iron', 8); // only 5 fits (total)
      expect(added.eq(0)).toBe(true); // block mode — all or nothing
    });

    it('isFull without totalCapacity is false when items have space', () => {
      const inv = createInventory({ id: 'inv', baseCapacity: 100 });
      inv.add('wood', 50);
      expect(inv.isFull()).toBe(false);
    });
  });

  describe('modifier chain', () => {
    it('addCapacityModifier increases per-item cap', async () => {
      const inv = createInventory({ id: 'inv', baseCapacity: 10 });
      inv.add('wood', 10);
      expect(inv.isFull('wood')).toBe(true);

      inv.addCapacityModifier(
        createAdditiveModifier({
          addend: 5,
          description: 'Upgrade +5',
        }) as Modifier,
      );

      await nextTick();
      expect(inv.capacity.value.eq(15)).toBe(true);
      expect(inv.isFull('wood')).toBe(false);
      expect(inv.remainingSpace('wood').eq(5)).toBe(true);

      const added = inv.add('wood', 5);
      expect(added.eq(5)).toBe(true);
      expect(inv.get('wood').eq(15)).toBe(true);
    });

    it('multiplicative modifier scales capacity', async () => {
      const inv = createInventory({ id: 'inv', baseCapacity: 10 });

      inv.addCapacityModifier(
        createMultiplicativeModifier({
          multiplier: 3,
          description: '×3 storage',
        }) as Modifier,
      );

      await nextTick();
      expect(inv.capacity.value.eq(30)).toBe(true);
    });

    it('multiple modifiers stack correctly', async () => {
      const inv = createInventory({ id: 'inv', baseCapacity: 10 });

      inv.addCapacityModifier(
        createAdditiveModifier({
          addend: 10,
          description: '+10',
        }) as Modifier,
      );

      inv.addCapacityModifier(
        createMultiplicativeModifier({
          multiplier: 2,
          description: '×2',
        }) as Modifier,
      );

      await nextTick();
      // (10 + 10) × 2 = 40
      expect(inv.capacity.value.eq(40)).toBe(true);
    });
  });

  describe('persistence', () => {
    it('serialize and deserialize round-trips', () => {
      const inv = createInventory({
        id: 'inv',
        baseCapacity: 100,
        initial: { wood: 42, iron: 7 },
      });
      const data = inv.serialize();
      expect(data.wood).toBe('42');
      expect(data.iron).toBe('7');

      const inv2 = createInventory({ id: 'inv2', baseCapacity: 100 });
      inv2.deserialize(data);
      expect(inv2.get('wood').eq(42)).toBe(true);
      expect(inv2.get('iron').eq(7)).toBe(true);
    });
  });

  describe('bag escape hatch', () => {
    it('exposes underlying ResourceBag', () => {
      const inv = createInventory({ id: 'inv', baseCapacity: 50 });
      expect(inv.bag).toBeDefined();
      inv.bag.add('raw', 10);
      expect(inv.bag.get('raw').eq(10)).toBe(true);
    });
  });
});
