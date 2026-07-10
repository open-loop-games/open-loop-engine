import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ref } from 'vue';
import { createSlot } from '@/systems/slot';
import {
  beginPersistentContext,
  endPersistentContext,
  resetAllPersistentContexts,
  deserializePersistents,
  getAllPersistentRefs,
} from '@/core/persistence';

beforeEach(() => {
  resetAllPersistentContexts();
});

/** Wrap slot creation in a persistence context for tests */
function createTestSlot(...args: Parameters<typeof createSlot>) {
  beginPersistentContext('test');
  const slot = createSlot(...args);
  endPersistentContext();
  return slot;
}

// ============================================================================
// Single-Select Mode
// ============================================================================

describe('single-select mode', () => {
  it('select sets current and selected', () => {
    const slot = createTestSlot({ id: 's', mode: 'single' });
    expect(slot.select('a')).toBe(true);
    expect(slot.current.value).toBe('a');
    expect(slot.selected.value).toEqual(['a']);
  });

  it('select auto-deselects previous item', () => {
    const slot = createTestSlot({ id: 's', mode: 'single' });
    slot.select('a');
    slot.select('b');
    expect(slot.current.value).toBe('b');
    expect(slot.selected.value).toEqual(['b']);
    expect(slot.isSelected('a')).toBe(false);
  });

  it('fires deselected then selected on auto-replace', () => {
    const slot = createTestSlot({ id: 's', mode: 'single' });
    slot.select('a');

    const events: string[] = [];
    slot.on('deselected', (id) => events.push(`deselected:${id}`));
    slot.on('selected', (id) => events.push(`selected:${id}`));

    slot.select('b');
    expect(events).toEqual(['deselected:a', 'selected:b']);
  });

  it('returns false for duplicate selection', () => {
    const slot = createTestSlot({ id: 's', mode: 'single' });
    slot.select('a');
    expect(slot.select('a')).toBe(false);
  });

  it('returns false for item not in pool', () => {
    const slot = createTestSlot({ id: 's', mode: 'single', pool: ['a', 'b'] });
    expect(slot.select('c')).toBe(false);
    expect(slot.current.value).toBeNull();
  });

  it('deselect clears to null', () => {
    const slot = createTestSlot({ id: 's', mode: 'single' });
    slot.select('a');
    expect(slot.deselect('a')).toBe(true);
    expect(slot.current.value).toBeNull();
    expect(slot.selected.value).toEqual([]);
  });

  it('toggle selects then deselects', () => {
    const slot = createTestSlot({ id: 's', mode: 'single' });
    expect(slot.toggle('a')).toBe(true);
    expect(slot.isSelected('a')).toBe(true);
    expect(slot.toggle('a')).toBe(false);
    expect(slot.isSelected('a')).toBe(false);
  });

  it('isFull tracks correctly', () => {
    const slot = createTestSlot({ id: 's', mode: 'single' });
    expect(slot.isFull.value).toBe(false);
    slot.select('a');
    expect(slot.isFull.value).toBe(true);
    slot.deselect('a');
    expect(slot.isFull.value).toBe(false);
  });
});

// ============================================================================
// Multi-Select Mode
// ============================================================================

describe('multi-select mode', () => {
  it('selects up to maxSelections', () => {
    const slot = createTestSlot({ id: 'm', mode: 'multi', maxSelections: 2 });
    expect(slot.select('a')).toBe(true);
    expect(slot.select('b')).toBe(true);
    expect(slot.select('c')).toBe(false);
    expect(slot.count.value).toBe(2);
  });

  it('select returns false at capacity', () => {
    const slot = createTestSlot({ id: 'm', mode: 'multi', maxSelections: 1 });
    slot.select('a');
    expect(slot.select('b')).toBe(false);
    expect(slot.isFull.value).toBe(true);
  });

  it('isFull toggles correctly', () => {
    const slot = createTestSlot({ id: 'm', mode: 'multi', maxSelections: 2 });
    expect(slot.isFull.value).toBe(false);
    slot.select('a');
    expect(slot.isFull.value).toBe(false);
    slot.select('b');
    expect(slot.isFull.value).toBe(true);
    slot.deselect('a');
    expect(slot.isFull.value).toBe(false);
  });

  it('preserves insertion order', () => {
    const slot = createTestSlot({ id: 'm', mode: 'multi', maxSelections: 4 });
    slot.select('c');
    slot.select('a');
    slot.select('b');
    expect(slot.selected.value).toEqual(['c', 'a', 'b']);
  });

  it('deselect removes targeted item only, preserves order', () => {
    const slot = createTestSlot({ id: 'm', mode: 'multi', maxSelections: 4 });
    slot.select('a');
    slot.select('b');
    slot.select('c');
    slot.deselect('b');
    expect(slot.selected.value).toEqual(['a', 'c']);
  });

  it('count is reactive', () => {
    const slot = createTestSlot({ id: 'm', mode: 'multi', maxSelections: 5 });
    expect(slot.count.value).toBe(0);
    slot.select('a');
    expect(slot.count.value).toBe(1);
    slot.select('b');
    expect(slot.count.value).toBe(2);
    slot.deselect('a');
    expect(slot.count.value).toBe(1);
  });

  it('defaults to unlimited when maxSelections omitted', () => {
    const slot = createTestSlot({ id: 'm', mode: 'multi' });
    for (let i = 0; i < 20; i++) {
      expect(slot.select(`item${i}`)).toBe(true);
    }
    expect(slot.count.value).toBe(20);
  });
});

// ============================================================================
// Reactive maxSelections
// ============================================================================

describe('reactive maxSelections', () => {
  it('increasing max unblocks select', () => {
    const max = ref(2);
    const slot = createTestSlot({ id: 'r', mode: 'multi', maxSelections: max });
    slot.select('a');
    slot.select('b');
    expect(slot.select('c')).toBe(false);

    max.value = 3;
    expect(slot.select('c')).toBe(true);
    expect(slot.count.value).toBe(3);
  });

  it('decreasing max below current count blocks new selects but keeps existing', () => {
    const max = ref(3);
    const slot = createTestSlot({ id: 'r', mode: 'multi', maxSelections: max });
    slot.select('a');
    slot.select('b');
    slot.select('c');

    max.value = 1;
    expect(slot.isFull.value).toBe(true);
    expect(slot.select('d')).toBe(false);
    // Existing selections are preserved (soft cap behavior)
    expect(slot.selected.value).toEqual(['a', 'b', 'c']);
    expect(slot.count.value).toBe(3);
  });
});

// ============================================================================
// Pool Validation
// ============================================================================

describe('pool validation', () => {
  it('canSelect returns false for non-pool items', () => {
    const slot = createTestSlot({ id: 'p', mode: 'multi', pool: ['a', 'b'] });
    expect(slot.canSelect('a')).toBe(true);
    expect(slot.canSelect('c')).toBe(false);
  });

  it('select returns false for non-pool items', () => {
    const slot = createTestSlot({ id: 'p', mode: 'single', pool: ['a', 'b'] });
    expect(slot.select('c')).toBe(false);
    expect(slot.current.value).toBeNull();
  });

  it('reactive pool change: existing selections persist, new selects gated', () => {
    const pool = ref(['a', 'b', 'c']);
    const slot = createTestSlot({ id: 'p', mode: 'multi', pool, maxSelections: 5 });
    slot.select('a');
    slot.select('b');

    // Shrink pool to exclude 'b' — existing selection of 'b' stays
    pool.value = ['a', 'c'];
    expect(slot.isSelected('b')).toBe(true);
    // But can't select 'b' again after deselecting
    slot.deselect('b');
    expect(slot.select('b')).toBe(false);
    // Can select items still in pool
    expect(slot.select('c')).toBe(true);
  });

  it('no pool: any ID accepted', () => {
    const slot = createTestSlot({ id: 'p', mode: 'multi', maxSelections: 5 });
    expect(slot.select('anything')).toBe(true);
    expect(slot.select('goes')).toBe(true);
    expect(slot.canSelect('here')).toBe(true);
  });
});

// ============================================================================
// canSelect Predicate
// ============================================================================

describe('canSelect predicate', () => {
  it('predicate gates selection', () => {
    const slot = createTestSlot({
      id: 'c',
      mode: 'multi',
      maxSelections: 5,
      canSelect: (id) => id !== 'blocked',
    });
    expect(slot.select('ok')).toBe(true);
    expect(slot.select('blocked')).toBe(false);
    expect(slot.canSelect('blocked')).toBe(false);
  });

  it('predicate is checked after pool and capacity', () => {
    const predicateCalls: string[] = [];
    const slot = createTestSlot({
      id: 'c',
      mode: 'multi',
      maxSelections: 1,
      pool: ['a', 'b'],
      canSelect: (id) => {
        predicateCalls.push(id);
        return true;
      },
    });

    // Not in pool — predicate should not be called
    slot.select('z');
    expect(predicateCalls).toEqual([]);

    // In pool, has capacity — predicate called
    slot.select('a');
    expect(predicateCalls).toEqual(['a']);

    // At capacity — predicate should not be called
    predicateCalls.length = 0;
    slot.select('b');
    expect(predicateCalls).toEqual([]);
  });
});

// ============================================================================
// deselectAll
// ============================================================================

describe('deselectAll', () => {
  it('fires deselected per item then cleared', () => {
    const slot = createTestSlot({ id: 'd', mode: 'multi', maxSelections: 5 });
    slot.select('a');
    slot.select('b');
    slot.select('c');

    const events: string[] = [];
    slot.on('deselected', (id) => events.push(`deselected:${id}`));
    slot.on('cleared', () => events.push('cleared'));

    slot.deselectAll();
    expect(events).toEqual(['deselected:a', 'deselected:b', 'deselected:c', 'cleared']);
    expect(slot.selected.value).toEqual([]);
  });

  it('no-ops when empty', () => {
    const slot = createTestSlot({ id: 'd', mode: 'multi' });
    const cleared = vi.fn();
    slot.on('cleared', cleared);

    slot.deselectAll();
    expect(cleared).not.toHaveBeenCalled();
  });
});

// ============================================================================
// Callbacks
// ============================================================================

describe('callbacks', () => {
  it('onSelect fires after successful selection', () => {
    const onSelect = vi.fn();
    const slot = createTestSlot({ id: 'cb', mode: 'multi', maxSelections: 5, onSelect });
    slot.select('a');
    expect(onSelect).toHaveBeenCalledWith('a');
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it('onDeselect fires after successful deselection', () => {
    const onDeselect = vi.fn();
    const slot = createTestSlot({ id: 'cb', mode: 'multi', maxSelections: 5, onDeselect });
    slot.select('a');
    slot.deselect('a');
    expect(onDeselect).toHaveBeenCalledWith('a');
    expect(onDeselect).toHaveBeenCalledTimes(1);
  });

  it('callbacks do NOT fire on restore', () => {
    const onSelect = vi.fn();
    const onDeselect = vi.fn();
    const slot = createTestSlot({
      id: 'cb',
      mode: 'multi',
      maxSelections: 5,
      onSelect,
      onDeselect,
    });
    slot.select('a');
    onSelect.mockClear();
    onDeselect.mockClear();

    slot.restore(['b', 'c']);
    expect(onSelect).not.toHaveBeenCalled();
    expect(onDeselect).not.toHaveBeenCalled();
  });
});

// ============================================================================
// resync — re-establish onSelect side effects after a save loads
// ============================================================================

describe('resync', () => {
  it('re-invokes onSelect for the rehydrated selection after a save loads', () => {
    const onSelect = vi.fn();
    resetAllPersistentContexts();
    const slot = createSlot({ id: 'hz', mode: 'single', onSelect });

    // Load a save the way the engine does: the persistent selection rehydrates
    // directly through the save-restore path, bypassing select() — so onSelect
    // never fires and side effects wired through it (enabled modifiers) are lost.
    deserializePersistents(getAllPersistentRefs(), { 'slot:hz': { selected: ['cabin'] } });
    expect(slot.selected.value).toEqual(['cabin']);
    expect(onSelect).not.toHaveBeenCalled();

    slot.resync();
    expect(onSelect).toHaveBeenCalledWith('cabin');
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it('fires no selected events on resync', () => {
    const onSelected = vi.fn();
    resetAllPersistentContexts();
    const slot = createSlot({ id: 'ev', mode: 'multi', maxSelections: 5, onSelect: vi.fn() });
    slot.on('selected', onSelected);

    deserializePersistents(getAllPersistentRefs(), { 'slot:ev': { selected: ['a', 'b'] } });
    slot.resync();
    expect(onSelected).not.toHaveBeenCalled();
  });

  it('is a no-op when no onSelect is configured', () => {
    resetAllPersistentContexts();
    const slot = createSlot({ id: 'noop', mode: 'single' });
    deserializePersistents(getAllPersistentRefs(), { 'slot:noop': { selected: ['x'] } });
    expect(() => slot.resync()).not.toThrow();
    expect(slot.selected.value).toEqual(['x']);
  });
});

// ============================================================================
// Persistence / Restore
// ============================================================================

describe('persistence / restore', () => {
  it('restore replaces selections', () => {
    const slot = createTestSlot({ id: 'pr', mode: 'multi', maxSelections: 5 });
    slot.select('a');
    slot.restore(['x', 'y']);
    expect(slot.selected.value).toEqual(['x', 'y']);
    expect(slot.isSelected('a')).toBe(false);
  });

  it('restore skips invalid IDs when pool is set', () => {
    const slot = createTestSlot({
      id: 'pr',
      mode: 'multi',
      maxSelections: 5,
      pool: ['a', 'b', 'c'],
    });
    slot.restore(['a', 'invalid', 'b']);
    expect(slot.selected.value).toEqual(['a', 'b']);
  });

  it('restore truncates to maxSelections', () => {
    const slot = createTestSlot({ id: 'pr', mode: 'multi', maxSelections: 2 });
    slot.restore(['a', 'b', 'c', 'd']);
    expect(slot.selected.value).toEqual(['a', 'b']);
  });

  it('snapshot returns independent copy', () => {
    const slot = createTestSlot({ id: 'pr', mode: 'multi', maxSelections: 5 });
    slot.select('a');
    slot.select('b');
    const snap = slot.snapshot();
    expect(snap).toEqual(['a', 'b']);

    // Mutating snapshot does not affect slot
    snap.push('c');
    expect(slot.selected.value).toEqual(['a', 'b']);
  });
});

// ============================================================================
// Events
// ============================================================================

describe('events', () => {
  it('on("selected") fires with correct itemId', () => {
    const slot = createTestSlot({ id: 'e', mode: 'multi', maxSelections: 5 });
    const handler = vi.fn();
    slot.on('selected', handler);

    slot.select('a');
    expect(handler).toHaveBeenCalledWith('a');
  });

  it('on("deselected") fires with correct itemId', () => {
    const slot = createTestSlot({ id: 'e', mode: 'multi', maxSelections: 5 });
    slot.select('a');

    const handler = vi.fn();
    slot.on('deselected', handler);

    slot.deselect('a');
    expect(handler).toHaveBeenCalledWith('a');
  });

  it('unsubscribe works', () => {
    const slot = createTestSlot({ id: 'e', mode: 'multi', maxSelections: 5 });
    const handler = vi.fn();
    const unsub = slot.on('selected', handler);

    slot.select('a');
    expect(handler).toHaveBeenCalledTimes(1);

    unsub();
    slot.select('b');
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
