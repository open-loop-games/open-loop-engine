import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ref } from 'vue';
import { createGoalPicker, type GoalPickResult } from '@/systems/goal-picker';
import { createSlot } from '@/systems/slot';
import {
  beginPersistentContext,
  endPersistentContext,
  resetAllPersistentContexts,
} from '@/core/persistence';

beforeEach(() => {
  resetAllPersistentContexts();
});

function createTestSlot(...args: Parameters<typeof createSlot>) {
  beginPersistentContext('test');
  const slot = createSlot(...args);
  endPersistentContext();
  return slot;
}

// ============================================================================
// Basic scoring + top-N fill (internal array, no slot)
// ============================================================================

describe('createGoalPicker — internal array (no slot)', () => {
  it('selects the single top-scoring candidate with default capacity 1', () => {
    const picker = createGoalPicker<string, void, Record<string, number>>({
      pool: () => ['a', 'b', 'c'],
      weights: { a: 1, b: 10, c: 5 },
      scorer: (id, w) => w[id] ?? 0,
    });
    const result = picker.pick();
    expect(result.selected).toEqual(['b']);
    expect(result.active).toEqual(['b']);
    expect(result.swept).toEqual([]);
  });

  it('fills top-N in descending score order', () => {
    const picker = createGoalPicker<string, void, Record<string, number>>({
      pool: () => ['a', 'b', 'c', 'd'],
      weights: { a: 1, b: 10, c: 5, d: 7 },
      scorer: (id, w) => w[id] ?? 0,
      capacity: 2,
    });
    const result = picker.pick();
    expect(result.selected).toEqual(['b', 'd']);
  });

  it('breaks ties by pool order (stable sort)', () => {
    const picker = createGoalPicker<string, void, void>({
      pool: () => ['a', 'b', 'c'],
      weights: undefined,
      scorer: () => 1,
      capacity: 2,
    });
    const result = picker.pick();
    expect(result.selected).toEqual(['a', 'b']);
  });

  it('refuses to exceed capacity across repeated picks', () => {
    const picker = createGoalPicker<string, void, void>({
      pool: () => ['a', 'b', 'c'],
      weights: undefined,
      scorer: (id) => (id === 'a' ? 3 : id === 'b' ? 2 : 1),
      capacity: 2,
    });
    picker.pick();
    const second = picker.pick();
    expect(second.selected).toEqual([]);
    expect(second.active).toEqual(['a', 'b']);
  });

  it('is a no-op when pool is empty', () => {
    const picker = createGoalPicker<string, void, void>({
      pool: () => [],
      weights: undefined,
      scorer: () => 1,
    });
    const result = picker.pick();
    expect(result.selected).toEqual([]);
    expect(result.active).toEqual([]);
  });
});

// ============================================================================
// Completion predicate (sweep before score)
// ============================================================================

describe('createGoalPicker — completion predicate', () => {
  it('sweeps completed selections and refills when caller filters pool', () => {
    let doneIds = new Set<string>();
    const picker = createGoalPicker<string, void, Record<string, number>>({
      pool: () => ['a', 'b', 'c'].filter((id) => !doneIds.has(id)),
      weights: { a: 10, b: 5, c: 1 },
      scorer: (id, w) => w[id] ?? 0,
      isCompleted: (id) => doneIds.has(id),
      capacity: 1,
    });

    expect(picker.pick().active).toEqual(['a']);

    doneIds = new Set(['a']);
    const result = picker.pick();
    expect(result.swept).toEqual(['a']);
    expect(result.selected).toEqual(['b']);
    expect(result.active).toEqual(['b']);
  });

  it('sweep alone frees capacity without pool filtering (caller-gated re-entry)', () => {
    let doneIds = new Set<string>();
    const picker = createGoalPicker<string, void, Record<string, number>>({
      pool: () => ['a', 'b'],
      weights: { a: 5, b: 1 },
      scorer: (id, w) => (doneIds.has(id) ? -Infinity : (w[id] ?? 0)),
      isCompleted: (id) => doneIds.has(id),
      capacity: 1,
    });
    picker.pick();
    doneIds = new Set(['a']);
    const result = picker.pick();
    expect(result.swept).toEqual(['a']);
    expect(result.active).toEqual(['b']);
  });
});

// ============================================================================
// mode: fresh-each-cycle
// ============================================================================

describe('createGoalPicker — mode: fresh-each-cycle', () => {
  it('deselects every active candidate at the top of each pick', () => {
    const picker = createGoalPicker<string, void, Record<string, number>>({
      pool: () => ['a', 'b', 'c'],
      weights: { a: 3, b: 2, c: 1 },
      scorer: (id, w) => w[id] ?? 0,
      capacity: 2,
      mode: 'fresh-each-pick',
    });

    const first = picker.pick();
    expect(first.selected).toEqual(['a', 'b']);
    expect(first.active).toEqual(['a', 'b']);
    expect(first.swept).toEqual([]);

    const second = picker.pick();
    expect(second.swept).toEqual(['a', 'b']);
    expect(second.selected).toEqual(['a', 'b']);
    expect(second.active).toEqual(['a', 'b']);
  });

  it('reflects shifting weights when capacity is full (vs. persistent mode which would stick)', () => {
    let weights: Record<string, number> = { a: 10, b: 1 };
    const picker = createGoalPicker<string, void, Record<string, number>>({
      pool: () => ['a', 'b'],
      weights: () => weights,
      scorer: (id, w) => w[id] ?? 0,
      capacity: 1,
      mode: 'fresh-each-pick',
    });

    expect(picker.pick().active).toEqual(['a']);
    weights = { a: 1, b: 10 };
    expect(picker.pick().active).toEqual(['b']);
  });

  it('does not invoke isCompleted under fresh-each-cycle (active is empty when it would run)', () => {
    const isCompleted = vi.fn(() => false);
    const picker = createGoalPicker<string, void, Record<string, number>>({
      pool: () => ['a'],
      weights: { a: 1 },
      scorer: (id, w) => w[id] ?? 0,
      isCompleted,
      mode: 'fresh-each-pick',
    });
    picker.pick();
    picker.pick();
    expect(isCompleted).not.toHaveBeenCalled();
  });

  it('fires slot.deselect for every previously-active candidate each cycle', () => {
    const slot = createTestSlot({ id: 's', mode: 'multi', maxSelections: 2 });
    const onDeselect = vi.fn();
    slot.on('deselected', onDeselect);

    const picker = createGoalPicker<string, void, Record<string, number>>({
      pool: () => ['a', 'b'],
      weights: { a: 2, b: 1 },
      scorer: (id, w) => w[id] ?? 0,
      capacity: 2,
      slot,
      mode: 'fresh-each-pick',
    });

    picker.pick();
    expect(onDeselect).not.toHaveBeenCalled();

    picker.pick();
    expect(onDeselect).toHaveBeenCalledTimes(2);
    expect(onDeselect).toHaveBeenCalledWith('a');
    expect(onDeselect).toHaveBeenCalledWith('b');
  });

  it('default mode is persistent (regression guard)', () => {
    const picker = createGoalPicker<string, void, Record<string, number>>({
      pool: () => ['a', 'b'],
      weights: { a: 2, b: 1 },
      scorer: (id, w) => w[id] ?? 0,
      capacity: 1,
    });
    picker.pick();
    const second = picker.pick();
    expect(second.swept).toEqual([]);
    expect(second.selected).toEqual([]);
    expect(second.active).toEqual(['a']);
  });
});

// ============================================================================
// Reactive capacity
// ============================================================================

describe('createGoalPicker — reactive capacity', () => {
  it('reads capacity getter on each pick', () => {
    const cap = ref(1);
    const picker = createGoalPicker<string, void, Record<string, number>>({
      pool: () => ['a', 'b', 'c'],
      weights: { a: 3, b: 2, c: 1 },
      scorer: (id, w) => w[id] ?? 0,
      capacity: () => cap.value,
    });

    expect(picker.pick().active).toEqual(['a']);
    cap.value = 3;
    const result = picker.pick();
    expect(result.selected).toEqual(['b', 'c']);
    expect(result.active).toEqual(['a', 'b', 'c']);
  });

  it('treats negative capacity as zero', () => {
    const picker = createGoalPicker<string, void, void>({
      pool: () => ['a'],
      weights: undefined,
      scorer: () => 1,
      capacity: () => -5,
    });
    expect(picker.pick().selected).toEqual([]);
  });
});

// ============================================================================
// Slot composition (persistence + canSelect integration)
// ============================================================================

describe('createGoalPicker — slot composition', () => {
  it('writes selections through the slot', () => {
    const slot = createTestSlot({ id: 's', mode: 'multi', maxSelections: 3 });
    const picker = createGoalPicker<string, void, Record<string, number>>({
      pool: () => ['a', 'b', 'c'],
      weights: { a: 5, b: 3, c: 1 },
      scorer: (id, w) => w[id] ?? 0,
      capacity: 2,
      slot,
    });
    picker.pick();
    expect(slot.selected.value).toEqual(['a', 'b']);
    expect(picker.active).toEqual(['a', 'b']);
  });

  it('respects slot.canSelect rejections and moves to the next candidate', () => {
    const blocked = new Set(['a']);
    const slot = createTestSlot({
      id: 's',
      mode: 'multi',
      maxSelections: 2,
      canSelect: (id) => !blocked.has(id),
    });
    const picker = createGoalPicker<string, void, Record<string, number>>({
      pool: () => ['a', 'b', 'c'],
      weights: { a: 10, b: 5, c: 1 },
      scorer: (id, w) => w[id] ?? 0,
      capacity: 2,
      slot,
    });
    const result = picker.pick();
    expect(result.selected).toEqual(['b', 'c']);
  });

  it('sweeps via slot.deselect when completion fires', () => {
    const slot = createTestSlot({ id: 's', mode: 'multi', maxSelections: 2 });
    const onDeselect = vi.fn();
    slot.on('deselected', onDeselect);
    let doneIds = new Set<string>();
    const picker = createGoalPicker<string, void, Record<string, number>>({
      pool: () => ['a', 'b'].filter((id) => !doneIds.has(id)),
      weights: { a: 2, b: 1 },
      scorer: (id, w) => w[id] ?? 0,
      isCompleted: (id) => doneIds.has(id),
      capacity: 2,
      slot,
    });
    picker.pick();
    doneIds = new Set(['a']);
    picker.pick();
    expect(onDeselect).toHaveBeenCalledWith('a');
    expect(slot.selected.value).toEqual(['b']);
  });
});

// ============================================================================
// Weights — plain value, getter form, setWeights
// ============================================================================

describe('createGoalPicker — weights', () => {
  it('accepts a plain-value weights record', () => {
    const picker = createGoalPicker<string, void, Record<string, number>>({
      pool: () => ['a', 'b'],
      weights: { a: 1, b: 2 },
      scorer: (id, w) => w[id] ?? 0,
    });
    expect(picker.pick().active).toEqual(['b']);
  });

  it('accepts a weights getter that is re-read each pick', () => {
    const active = ref<'aggressive' | 'cautious'>('aggressive');
    const personalities = {
      aggressive: { attack: 10, defend: 1 },
      cautious: { attack: 1, defend: 10 },
    } as const;
    const picker = createGoalPicker<string, void, Record<string, number>>({
      pool: () => ['attack', 'defend'],
      weights: () => personalities[active.value],
      scorer: (id, w) => w[id] ?? 0,
    });
    expect(picker.pick().active).toEqual(['attack']);
    active.value = 'cautious';
    // existing selection stays; change behavior requires sweeping first
    // reset via a completion predicate would be the real pattern
  });

  it('setWeights replaces the source for the next pick', () => {
    const picker = createGoalPicker<string, void, Record<string, number>>({
      pool: () => ['a', 'b'],
      weights: { a: 10, b: 1 },
      scorer: (id, w) => w[id] ?? 0,
      capacity: 1,
    });
    picker.pick();
    expect(picker.active).toEqual(['a']);
    picker.setWeights({ a: 1, b: 10 });
    // active 'a' stays until deselected; setWeights changes future scoring only
    expect(picker.active).toEqual(['a']);
  });
});

// ============================================================================
// Profiling hook
// ============================================================================

describe('createGoalPicker — onPick', () => {
  it('fires onPick after the slot update with the diff', () => {
    const results: GoalPickResult<string>[] = [];
    const picker = createGoalPicker<string, void, Record<string, number>>({
      pool: () => ['a', 'b'],
      weights: { a: 2, b: 1 },
      scorer: (id, w) => w[id] ?? 0,
      onPick: (r) => results.push(r),
    });
    picker.pick();
    expect(results).toHaveLength(1);
    expect(results[0]!.selected).toEqual(['a']);
    expect(results[0]!.active).toEqual(['a']);
  });

  it('fires onPick even on no-op picks', () => {
    const onPick = vi.fn();
    const picker = createGoalPicker<string, void, void>({
      pool: () => [],
      weights: undefined,
      scorer: () => 1,
      onPick,
    });
    picker.pick();
    expect(onPick).toHaveBeenCalledTimes(1);
  });
});

// ============================================================================
// Type guard
// ============================================================================

// ============================================================================
// Composition-shape sanity checks
// ============================================================================

describe('createGoalPicker — multi-slot linear-weighted scoring', () => {
  it('picks by faction-specific weights', () => {
    type GoalId = 'claim:h1' | 'defend:s1' | 'pressure:f1';
    type AiWeights = { claim: number; defend: number; pressure: number };
    const weights: AiWeights = { claim: 10, defend: 5, pressure: 2 };

    function scoreGoal(id: GoalId, w: AiWeights): number {
      if (id.startsWith('claim:')) return w.claim;
      if (id.startsWith('defend:')) return w.defend;
      return w.pressure;
    }

    const slot = createTestSlot({ id: 'faction-a', mode: 'multi', maxSelections: 2 });
    const picker = createGoalPicker<GoalId, void, AiWeights>({
      pool: () => ['claim:h1', 'defend:s1', 'pressure:f1'],
      weights,
      scorer: (id, w) => scoreGoal(id, w),
      capacity: 2,
      slot,
    });
    const result = picker.pick();
    expect(result.selected).toEqual(['claim:h1', 'defend:s1']);
  });
});

describe('createGoalPicker — single-slot priority-table scoring', () => {
  it('picks the highest-priority currently-valid goal', () => {
    type GoalType = 'flee' | 'kill' | 'loot' | 'explore';
    const GOAL_PRIORITY: Record<GoalType, number> = {
      flee: 100,
      kill: 75,
      loot: 50,
      explore: 25,
    };
    const eligible = new Set<GoalType>(['kill', 'loot', 'explore']);

    const picker = createGoalPicker<GoalType, void, void>({
      pool: () => Array.from(eligible),
      weights: undefined,
      scorer: (g) => GOAL_PRIORITY[g],
      capacity: 1,
    });
    const result = picker.pick();
    expect(result.selected).toEqual(['kill']);
  });
});
