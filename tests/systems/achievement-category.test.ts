import { describe, it, expect, beforeEach } from 'vitest';
import { ref, nextTick } from 'vue';
import {
  persistent,
  beginPersistentContext,
  endPersistentContext,
  resetAllPersistentContexts,
  type Persistent,
} from '@/core/persistence';
import { createAchievementCategory } from '@/systems/achievement-category';
import { createModifierChain } from '@/core/modifier';
import { Decimal } from '@/primitives/decimal';
import { createEngine } from '@/engine';

beforeEach(() => {
  resetAllPersistentContexts();
});

// ============================================================================
// Types for tests
// ============================================================================

interface TestDef {
  id: string;
  name: string;
  threshold: number;
}

interface TestState {
  notes: Persistent<string>;
}

// ============================================================================
// createAchievementCategory
// ============================================================================

describe('createAchievementCategory', () => {
  it('registers definitions and creates Achievement instances', () => {
    const category = createAchievementCategory<TestDef>({
      id: 'test1',
      mapAchievement: (def) => ({
        display: { title: def.name },
      }),
    });

    category.register([
      { id: 'first', name: 'First Steps', threshold: 10 },
      { id: 'veteran', name: 'Veteran', threshold: 100 },
    ]);

    expect(category.size).toBe(2);
    expect(category.getAchievement('first')).toBeDefined();
    expect(category.getAchievement('veteran')).toBeDefined();
    expect(category.getAchievement('unknown')).toBeUndefined();
  });

  it('two categories sharing a def id do not collide (category id namespaces the save)', () => {
    // Each achievement's earned/earnedAt must be scoped under {categoryId}/{defId}
    // like every other category. A flat achievement:{defId} context drops the
    // category id, so a second category reusing a def id collides at register().
    const catA = createAchievementCategory<TestDef>({
      id: 'cat-a',
      mapAchievement: (def) => ({ display: { title: def.name } }),
    });
    const catB = createAchievementCategory<TestDef>({
      id: 'cat-b',
      mapAchievement: (def) => ({ display: { title: def.name } }),
    });

    catA.register({ id: 'first', name: 'First Steps', threshold: 10 });
    expect(() => catB.register({ id: 'first', name: 'First Steps', threshold: 10 })).not.toThrow();

    catA.getAchievement('first')!.earned.value = true;
    expect(catB.getAchievement('first')!.earned.value).toBe(false);
  });

  it('achievements start unearned', () => {
    const category = createAchievementCategory<TestDef>({
      id: 'test2',
      mapAchievement: (def) => ({
        display: { title: def.name },
      }),
    });

    category.register({ id: 'first', name: 'First Steps', threshold: 10 });

    const achievement = category.getAchievement('first')!;
    expect(achievement.earned.value).toBe(false);
  });

  it('getDef returns the definition from the registry', () => {
    const category = createAchievementCategory<TestDef>({
      id: 'test3',
      mapAchievement: (def) => ({
        display: { title: def.name },
      }),
    });

    const def = { id: 'first', name: 'First Steps', threshold: 10 };
    category.register(def);

    expect(category.getDef('first')).toBe(def);
  });

  it('creates per-instance state via mapState', () => {
    beginPersistentContext('test-state');

    const category = createAchievementCategory<TestDef, TestState>({
      id: 'test4',
      mapAchievement: (def) => ({
        display: { title: def.name },
      }),
      mapState: () => ({
        notes: persistent(''),
      }),
    });

    category.register([
      { id: 'a', name: 'A', threshold: 1 },
      { id: 'b', name: 'B', threshold: 2 },
    ]);

    endPersistentContext();

    const stateA = category.getState('a')!;
    const stateB = category.getState('b')!;
    expect(stateA.notes.value).toBe('');

    // States are independent
    stateA.notes.value = 'earned early';
    expect(stateB.notes.value).toBe('');
  });

  it('getAll returns entries in registration order', () => {
    const category = createAchievementCategory<TestDef>({
      id: 'test5',
      mapAchievement: (def) => ({
        display: { title: def.name },
      }),
    });

    category.register([
      { id: 'b', name: 'B', threshold: 2 },
      { id: 'a', name: 'A', threshold: 1 },
      { id: 'c', name: 'C', threshold: 3 },
    ]);

    const ids = category.getAll().map((e) => e.def.id);
    expect(ids).toEqual(['b', 'a', 'c']);
  });

  it('getEntry returns full tuple', () => {
    beginPersistentContext('test-entry');

    const category = createAchievementCategory<TestDef, TestState>({
      id: 'test6',
      mapAchievement: (def) => ({
        display: { title: def.name },
      }),
      mapState: () => ({
        notes: persistent(''),
      }),
    });

    category.register({ id: 'first', name: 'First Steps', threshold: 10 });

    endPersistentContext();

    const entry = category.getEntry('first')!;
    expect(entry.def.id).toBe('first');
    expect(entry.achievement).toBeDefined();
    expect(entry.achievement.earned.value).toBe(false);
    expect(entry.state.notes.value).toBe('');
  });

  it('supports incremental registration (base + mod)', () => {
    const category = createAchievementCategory<TestDef>({
      id: 'test7',
      mapAchievement: (def) => ({
        display: { title: def.name },
      }),
    });

    category.register([{ id: 'base', name: 'Base', threshold: 10 }]);
    expect(category.size).toBe(1);

    category.register([{ id: 'mod', name: 'Mod Achievement', threshold: 50 }]);
    expect(category.size).toBe(2);
    expect(category.getAchievement('mod')).toBeDefined();
  });

  it('throws on duplicate registration', () => {
    const category = createAchievementCategory<TestDef>({
      id: 'test8',
      mapAchievement: (def) => ({
        display: { title: def.name },
      }),
    });

    category.register({ id: 'first', name: 'First Steps', threshold: 10 });

    expect(() => {
      category.register({ id: 'first', name: 'Duplicate', threshold: 20 });
    }).toThrow(/Duplicate/);
  });

  it('exposes registry for mod patching', () => {
    const category = createAchievementCategory<TestDef>({
      id: 'test9',
      mapAchievement: (def) => ({
        display: { title: def.name },
      }),
    });

    category.register({ id: 'first', name: 'First Steps', threshold: 10 });

    category.registry.patch('first', { threshold: 5 });
    expect(category.getDef('first')!.threshold).toBe(5);
  });

  // ==========================================================================
  // Auto-complete via requirement watch
  // ==========================================================================

  it('auto-completes when requirement becomes true', async () => {
    const condition = ref(false);

    const category = createAchievementCategory<TestDef>({
      id: 'test10',
      mapAchievement: (def) => ({
        display: { title: def.name },
        goal: condition,
      }),
    });

    category.register({ id: 'auto', name: 'Auto', threshold: 10 });

    const achievement = category.getAchievement('auto')!;
    expect(achievement.earned.value).toBe(false);

    condition.value = true;
    await nextTick();

    expect(achievement.earned.value).toBe(true);
  });

  it('fires onComplete callback on auto-complete', async () => {
    const condition = ref(false);
    let completed = false;

    const category = createAchievementCategory<TestDef>({
      id: 'test11',
      mapAchievement: (def) => ({
        display: { title: def.name },
        goal: condition,
        onComplete: () => {
          completed = true;
        },
      }),
    });

    category.register({ id: 'callback', name: 'Callback', threshold: 10 });

    condition.value = true;
    await nextTick();

    expect(completed).toBe(true);
  });

  it('manual complete works without requirement', () => {
    const category = createAchievementCategory<TestDef>({
      id: 'test12',
      mapAchievement: (def) => ({
        display: { title: def.name },
      }),
    });

    category.register({ id: 'manual', name: 'Manual', threshold: 10 });

    const achievement = category.getAchievement('manual')!;
    achievement.complete();
    expect(achievement.earned.value).toBe(true);
  });

  // ==========================================================================
  // Aggregate tracking
  // ==========================================================================

  it('earnedCount tracks earned achievements reactively', () => {
    const category = createAchievementCategory<TestDef>({
      id: 'test13',
      mapAchievement: (def) => ({
        display: { title: def.name },
      }),
    });

    category.register([
      { id: 'a', name: 'A', threshold: 1 },
      { id: 'b', name: 'B', threshold: 2 },
      { id: 'c', name: 'C', threshold: 3 },
    ]);

    expect(category.earnedCount.value).toBe(0);
    expect(category.size).toBe(3);
    expect(category.allEarned.value).toBe(false);

    category.getAchievement('a')!.complete();
    expect(category.earnedCount.value).toBe(1);
    expect(category.allEarned.value).toBe(false);

    category.getAchievement('b')!.complete();
    category.getAchievement('c')!.complete();
    expect(category.earnedCount.value).toBe(3);
    expect(category.allEarned.value).toBe(true);
  });

  it('size updates with incremental registration', () => {
    const category = createAchievementCategory<TestDef>({
      id: 'test14',
      mapAchievement: (def) => ({
        display: { title: def.name },
      }),
    });

    expect(category.size).toBe(0);

    category.register({ id: 'a', name: 'A', threshold: 1 });
    expect(category.size).toBe(1);

    category.register([
      { id: 'b', name: 'B', threshold: 2 },
      { id: 'c', name: 'C', threshold: 3 },
    ]);
    expect(category.size).toBe(3);
  });

  it('allEarned is false for empty category', () => {
    const category = createAchievementCategory<TestDef>({
      id: 'test15',
      mapAchievement: (def) => ({
        display: { title: def.name },
      }),
    });

    expect(category.allEarned.value).toBe(false);
  });
});

describe('createAchievementCategory grants', () => {
  it('binds modifiers to chains gated on the earned predicate', () => {
    const chain = createModifierChain('ach-grants-chain');
    const category = createAchievementCategory<TestDef>({
      id: 'ach-grants1',
      mapAchievement: (def) => ({
        display: { title: def.name },
        grants: [{ chain, mult: 1.5, description: `from:${def.id}` }],
      }),
    });

    category.register([{ id: 'first', name: 'First', threshold: 10 }]);

    expect(Decimal.eq(chain.apply(100), 100)).toBe(true);
    category.getAchievement('first')!.complete();
    expect(Decimal.eq(chain.apply(100), 150)).toBe(true);

    const recs = chain.bindings();
    expect(recs).toHaveLength(1);
    expect(recs[0].id).toBe('ach-grants1/first/from:first');
  });
});

describe('createAchievementCategory — teardown', () => {
  it('an achievement registered after start() stops with engine.dispose()', () => {
    const flag = ref(false);
    const fired: string[] = [];
    let category!: ReturnType<typeof createAchievementCategory<{ id: string }>>;
    const engine = createEngine({ gameId: 'test', persistence: false });
    engine.use({
      id: 'milestones',
      install() {
        category = createAchievementCategory<{ id: string }>({
          id: 'milestones',
          mapAchievement: (def) => ({
            display: { title: def.id },
            goal: () => flag.value,
            onComplete: () => fired.push(def.id),
          }),
        });
        category.register({ id: 'early' });
      },
    });
    engine.start();
    category.register({ id: 'late' });
    engine.dispose();

    flag.value = true;
    expect(fired).toEqual([]);
  });
});
