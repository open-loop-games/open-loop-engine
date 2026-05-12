import { describe, it, expect } from 'vitest';
import { ref, nextTick } from 'vue';
import {
  createAutomationTiers,
  isAutomationTiers,
  AutomationTiersType,
} from '@/systems/automation';

const TIERS = [
  { id: 'manual', name: 'Manual', order: 0 },
  { id: 'basic', name: 'Basic Auto', order: 1 },
  { id: 'conditional', name: 'Conditionals', order: 2 },
  { id: 'priority', name: 'Priorities', order: 3 },
];

describe('AutomationTiers', () => {
  // --- Factory ---

  it('creates with tiers sorted by order', () => {
    const at = createAutomationTiers({
      tiers: [
        { id: 'c', name: 'C', order: 2 },
        { id: 'a', name: 'A', order: 0 },
        { id: 'b', name: 'B', order: 1 },
      ],
    });
    expect(at.tiers.map((t) => t.id)).toEqual(['a', 'b', 'c']);
    expect(at.type).toBe(AutomationTiersType);
  });

  it('defaults lowest-order tier as initially unlocked', () => {
    const at = createAutomationTiers({ tiers: TIERS });
    expect(at.unlocked.value).toEqual(['manual']);
    expect(at.currentTierId.value).toBe('manual');
    expect(at.currentTierOrder.value).toBe(0);
  });

  it('respects explicit initiallyUnlocked', () => {
    const at = createAutomationTiers({
      tiers: TIERS,
      initiallyUnlocked: ['manual', 'basic'],
    });
    expect(at.unlocked.value).toEqual(['manual', 'basic']);
    expect(at.currentTierId.value).toBe('basic');
    expect(at.currentTierOrder.value).toBe(1);
  });

  it('handles empty tiers list', () => {
    const at = createAutomationTiers({ tiers: [] });
    expect(at.tiers).toEqual([]);
    expect(at.currentTierId.value).toBe('');
    expect(at.currentTierOrder.value).toBe(0);
    expect(at.unlocked.value).toEqual([]);
  });

  // --- unlock ---

  it('unlocks a tier', () => {
    const at = createAutomationTiers({ tiers: TIERS });
    expect(at.isTierUnlocked('basic')).toBe(false);
    at.unlock('basic');
    expect(at.isTierUnlocked('basic')).toBe(true);
    expect(at.unlocked.value).toContain('basic');
  });

  it('unlock updates currentTierId and currentTierOrder', () => {
    const at = createAutomationTiers({ tiers: TIERS });
    at.unlock('conditional');
    expect(at.currentTierId.value).toBe('conditional');
    expect(at.currentTierOrder.value).toBe(2);
  });

  it('unlock is idempotent', () => {
    const at = createAutomationTiers({ tiers: TIERS });
    at.unlock('basic');
    at.unlock('basic');
    expect(at.unlocked.value.filter((id) => id === 'basic')).toHaveLength(1);
  });

  it('unlock with unknown ID is a no-op', () => {
    const at = createAutomationTiers({ tiers: TIERS });
    at.unlock('nonexistent');
    expect(at.unlocked.value).toEqual(['manual']);
  });

  it('emits unlock event', () => {
    const at = createAutomationTiers({ tiers: TIERS });
    const events: [string, number][] = [];
    at.on('unlock', (id, order) => events.push([id, order]));

    at.unlock('basic');
    expect(events).toEqual([['basic', 1]]);

    // No event for idempotent unlock
    at.unlock('basic');
    expect(events).toEqual([['basic', 1]]);
  });

  // --- hasReached ---

  it('hasReached returns true for unlocked tiers at or below current', () => {
    const at = createAutomationTiers({ tiers: TIERS });
    at.unlock('conditional'); // order 2

    expect(at.hasReached('manual')).toBe(true); // order 0
    expect(at.hasReached('basic')).toBe(true); // order 1
    expect(at.hasReached('conditional')).toBe(true); // order 2
    expect(at.hasReached('priority')).toBe(false); // order 3
  });

  it('hasReached returns false for unknown tier ID', () => {
    const at = createAutomationTiers({ tiers: TIERS });
    expect(at.hasReached('nonexistent')).toBe(false);
  });

  // --- resetUnlocks ---

  it('resets unlocked tiers to initial set', () => {
    const at = createAutomationTiers({ tiers: TIERS });
    at.unlock('basic');
    at.unlock('conditional');
    expect(at.unlocked.value).toEqual(['manual', 'basic', 'conditional']);

    at.resetUnlocks();
    expect(at.unlocked.value).toEqual(['manual']);
    expect(at.currentTierId.value).toBe('manual');
    expect(at.currentTierOrder.value).toBe(0);
  });

  it('resetUnlocks with explicit initial set restores that set', () => {
    const at = createAutomationTiers({
      tiers: TIERS,
      initiallyUnlocked: ['manual', 'basic'],
    });
    at.unlock('priority');
    at.resetUnlocks();
    expect(at.unlocked.value).toEqual(['manual', 'basic']);
    expect(at.currentTierId.value).toBe('basic');
  });

  // --- Auto-unlock via requirement ---

  it('auto-unlocks tier when requirement is immediately true', () => {
    const at = createAutomationTiers({
      tiers: [
        { id: 'manual', name: 'Manual', order: 0 },
        { id: 'basic', name: 'Basic', order: 1, requirement: () => true },
      ],
    });
    expect(at.isTierUnlocked('basic')).toBe(true);
    expect(at.currentTierId.value).toBe('basic');
  });

  it('auto-unlocks tier when reactive requirement becomes true', async () => {
    const flag = ref(false);
    const at = createAutomationTiers({
      tiers: [
        { id: 'manual', name: 'Manual', order: 0 },
        { id: 'basic', name: 'Basic', order: 1, requirement: flag },
      ],
    });
    expect(at.isTierUnlocked('basic')).toBe(false);

    flag.value = true;
    await nextTick();
    expect(at.isTierUnlocked('basic')).toBe(true);
    expect(at.currentTierId.value).toBe('basic');
  });

  it('auto-unlock emits unlock event', async () => {
    const flag = ref(false);
    const at = createAutomationTiers({
      tiers: [
        { id: 'manual', name: 'Manual', order: 0 },
        { id: 'basic', name: 'Basic', order: 1, requirement: flag },
      ],
    });
    const events: string[] = [];
    at.on('unlock', (id) => events.push(id));

    flag.value = true;
    await nextTick();
    expect(events).toEqual(['basic']);
  });

  // --- Dispose ---

  it('dispose stops auto-unlock on subsequent requirement changes', async () => {
    const flag = ref(false);
    const at = createAutomationTiers({
      tiers: [
        { id: 'manual', name: 'Manual', order: 0 },
        { id: 'basic', name: 'Basic', order: 1, requirement: flag },
      ],
    });
    expect(at.isTierUnlocked('basic')).toBe(false);

    at.dispose();

    flag.value = true;
    await nextTick();
    expect(at.isTierUnlocked('basic')).toBe(false);
  });

  // --- Type guard ---

  it('isAutomationTiers identifies instances', () => {
    const at = createAutomationTiers({ tiers: TIERS });
    expect(isAutomationTiers(at)).toBe(true);
    expect(isAutomationTiers({})).toBe(false);
    expect(isAutomationTiers(null)).toBe(false);
  });
});
