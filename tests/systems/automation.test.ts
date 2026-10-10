import { describe, it, expect } from 'vitest';
import { ref, nextTick } from 'vue';
import { createAutomationTiers } from '@/systems/automation';
import {
  deserializePersistents,
  getAllPersistentRefs,
  persistent,
  withPersistentContext,
} from '@/core/persistence';
import { saveAndClear } from '../helpers/save-roundtrip';

const TIERS = [
  { id: 'manual', displayName: 'Manual', order: 0 },
  { id: 'basic', displayName: 'Basic Auto', order: 1 },
  { id: 'conditional', displayName: 'Conditionals', order: 2 },
  { id: 'priority', displayName: 'Priorities', order: 3 },
];

describe('AutomationTiers', () => {
  // --- Factory ---

  it('built outside any module, saves under a context named for its kind', () => {
    createAutomationTiers({ tiers: TIERS });
    expect([...getAllPersistentRefs().keys()]).toContainEqual(
      expect.stringMatching(/^automation_\d+\.unlocked$/),
    );
  });

  it('creates with tiers sorted by order', () => {
    const at = createAutomationTiers({
      tiers: [
        { id: 'c', displayName: 'C', order: 2 },
        { id: 'a', displayName: 'A', order: 0 },
        { id: 'b', displayName: 'B', order: 1 },
      ],
    });
    expect(at.tiers.map((t) => t.id)).toEqual(['a', 'b', 'c']);
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

  it('a repeated tier id throws', () => {
    expect(() =>
      createAutomationTiers({
        tiers: [
          { id: 'basic', displayName: 'Basic', order: 0 },
          { id: 'basic', displayName: 'Basic II', order: 1 },
        ],
      }),
    ).toThrow(/duplicate automation tier id "basic"/);
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
    expect(at.isUnlocked('basic')).toBe(false);
    at.unlock('basic');
    expect(at.isUnlocked('basic')).toBe(true);
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

  it('emits unlocked event', () => {
    const at = createAutomationTiers({ tiers: TIERS });
    const events: [string, number][] = [];
    at.on('unlocked', (id, order) => events.push([id, order]));

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
        { id: 'manual', displayName: 'Manual', order: 0 },
        { id: 'basic', displayName: 'Basic', order: 1, unlockWhen: () => true },
      ],
    });
    expect(at.isUnlocked('basic')).toBe(true);
    expect(at.currentTierId.value).toBe('basic');
  });

  it('auto-unlocks tier when reactive requirement becomes true', async () => {
    const flag = ref(false);
    const at = createAutomationTiers({
      tiers: [
        { id: 'manual', displayName: 'Manual', order: 0 },
        { id: 'basic', displayName: 'Basic', order: 1, unlockWhen: flag },
      ],
    });
    expect(at.isUnlocked('basic')).toBe(false);

    flag.value = true;
    await nextTick();
    expect(at.isUnlocked('basic')).toBe(true);
    expect(at.currentTierId.value).toBe('basic');
  });

  it('auto-unlock emits unlocked event', async () => {
    const flag = ref(false);
    const at = createAutomationTiers({
      tiers: [
        { id: 'manual', displayName: 'Manual', order: 0 },
        { id: 'basic', displayName: 'Basic', order: 1, unlockWhen: flag },
      ],
    });
    const events: string[] = [];
    at.on('unlocked', (id) => events.push(id));

    flag.value = true;
    await nextTick();
    expect(events).toEqual(['basic']);
  });

  // --- Dispose ---

  it('dispose stops auto-unlock on subsequent requirement changes', async () => {
    const flag = ref(false);
    const at = createAutomationTiers({
      tiers: [
        { id: 'manual', displayName: 'Manual', order: 0 },
        { id: 'basic', displayName: 'Basic', order: 1, unlockWhen: flag },
      ],
    });
    expect(at.isUnlocked('basic')).toBe(false);

    at.dispose();

    flag.value = true;
    await nextTick();
    expect(at.isUnlocked('basic')).toBe(false);
  });

  // --- Type guard ---
});

describe('AutomationTiers — a met requirement is a level, not an edge', () => {
  const BASIC = { id: 'basic', displayName: 'Basic', order: 1 };
  const EXTRA = { id: 'extra', displayName: 'Extra', order: 2 };

  /** One session: gold registers before the tiers, as a module's resources do. */
  function buildSession(tierDefs: { id: string; displayName: string; order: number }[]) {
    const events: string[] = [];
    return withPersistentContext('m', () => {
      const gold = persistent<number>(0, { id: 'gold' });
      const tiers = createAutomationTiers({
        tiers: [
          { id: 'manual', displayName: 'Manual', order: 0 },
          ...tierDefs.map((t) => ({ ...t, unlockWhen: () => gold.value >= 10 })),
        ],
      });
      tiers.on('unlocked', (id) => events.push(id));
      return { gold, tiers, events };
    });
  }

  function saveSession(gold: { value: number }): Record<string, unknown> {
    gold.value = 20;
    return saveAndClear();
  }

  it('a load emits no unlock for a tier the save already holds', () => {
    const save = saveSession(buildSession([BASIC]).gold);

    const { tiers, events } = buildSession([BASIC]);
    deserializePersistents(getAllPersistentRefs(), save);

    expect(tiers.unlocked.value).toEqual(['manual', 'basic']);
    expect(events).toEqual([]);
  });

  it('a load unlocks a tier added since the save whose requirement holds', () => {
    const save = saveSession(buildSession([BASIC]).gold);

    const { tiers, events } = buildSession([BASIC, EXTRA]);
    deserializePersistents(getAllPersistentRefs(), save);

    expect(tiers.hasReached('extra')).toBe(true);
    expect(events).toEqual(['extra']);
  });

  it('resetUnlocks keeps a tier whose requirement still holds, without an event', () => {
    const { gold, tiers, events } = buildSession([BASIC]);
    gold.value = 20;
    events.length = 0;

    tiers.resetUnlocks();

    expect(tiers.unlocked.value).toEqual(['manual', 'basic']);
    expect(events).toEqual([]);
  });
});
