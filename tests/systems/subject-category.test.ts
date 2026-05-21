import { describe, it, expect, beforeEach, vi } from 'vitest';
import { bn, Decimal } from '@/primitives/decimal';
import { resetAllPersistentContexts } from '@/core/persistence';
import { withGameStateAccessor, type GameStateAccessorMutator } from '@/core/game-state-accessor';
import { createEngine, type EngineModule } from '@/index';
import { createSubjectCategory } from '@/systems/subject-category';
import { CategoriesKey } from '@/systems/engine-categories';

beforeEach(() => {
  resetAllPersistentContexts();
});

function buildAccessor(): GameStateAccessorMutator {
  const unlocks = new Map<string, boolean>();
  return {
    getResource: () => bn(0),
    isUnlocked: (id) => unlocks.get(id) ?? false,
    getState: () => undefined,
    getRate: () => Decimal.dZero,
    applyResourceOp: () => {},
    setUnlocked: (id, v) => {
      unlocks.set(id, v);
    },
    setState: () => {},
  };
}

/**
 * Run `fn` inside an engine install hook so the ambient GateRuntime triple is
 * wired — required for tier-field tryAdvance to evaluate Gate predicates.
 */
function withEngine<T>(accessor: GameStateAccessorMutator, fn: () => T): T {
  let result: T;
  const mod: EngineModule = {
    id: 'test',
    install() {
      result = fn();
    },
  };
  const engine = createEngine({ gameId: 'test', persistence: false, accessor });
  engine.use(mod);
  engine.start();
  engine.stop();
  return result!;
}

describe('createSubjectCategory', () => {
  describe('scalar field', () => {
    it('clamps writes to min/max and reflects initial', () => {
      const cat = createSubjectCategory({
        id: 'bonds',
        fields: { bond: { kind: 'scalar', initial: 25, min: 0, max: 100 } },
      });
      cat.register([{ id: 'fluffy' }, { id: 'rocky' }]);

      const fluffy = cat.get('fluffy')!;
      expect(fluffy.fields.bond.get()).toBe(25);
      fluffy.fields.bond.add(80); // 25 + 80 = 105 → clamped to 100
      expect(fluffy.fields.bond.get()).toBe(100);

      const rocky = cat.get('rocky')!;
      rocky.fields.bond.add(-50); // 25 - 50 = -25 → clamped to 0
      expect(rocky.fields.bond.get()).toBe(0);
    });

    it('emits change events on writes (and skips no-ops)', () => {
      const cat = createSubjectCategory({
        id: 'bonds',
        fields: { bond: { kind: 'scalar', initial: 0 } },
      });
      cat.register({ id: 'fluffy' });
      const fluffy = cat.get('fluffy')!;
      const handler = vi.fn();
      fluffy.fields.bond.on('change', handler);
      fluffy.fields.bond.set(5);
      expect(handler).toHaveBeenCalledWith({ old: 0, next: 5 });
      // No-op write doesn't fire.
      fluffy.fields.bond.set(5);
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('honors derive() for derived-on-read scalars', () => {
      const cat = createSubjectCategory({
        id: 'trust',
        fields: {
          // Trivial derive: cap at 10.
          score: { kind: 'scalar', initial: 0, derive: (raw) => Math.min(10, raw) },
        },
      });
      cat.register({ id: 'explorer' });
      const e = cat.get('explorer')!;
      e.fields.score.set(7);
      expect(e.fields.score.read()).toBe(7);
      e.fields.score.set(50);
      expect(e.fields.score.read()).toBe(10); // capped via derive
      // Raw stored value still reflects the write.
      expect(e.fields.score.get()).toBe(50);
    });

    it('per-subject override replaces initial value', () => {
      const cat = createSubjectCategory({
        id: 'bonds',
        fields: { bond: { kind: 'scalar', initial: 0, min: 0, max: 100 } },
      });
      cat.register([{ id: 'fluffy' }, { id: 'rocky', fields: { bond: { initial: 75 } } }]);
      expect(cat.get('fluffy')!.fields.bond.get()).toBe(0);
      expect(cat.get('rocky')!.fields.bond.get()).toBe(75);
    });
  });

  describe('vector field', () => {
    it('tracks N independent dimensions per subject with per-dim clamps', () => {
      const cat = createSubjectCategory({
        id: 'opinion',
        fields: {
          opinion: {
            kind: 'vector',
            dimensions: ['trust', 'fear', 'value', 'anger'] as const,
            dimensionConfig: { fear: { min: 0, max: 100 } },
          },
        },
      });
      cat.register({ id: 'npc-1' });
      const npc = cat.get('npc-1')!;
      npc.fields.opinion.set('trust', -10);
      npc.fields.opinion.set('fear', -5); // clamped to 0
      npc.fields.opinion.add('anger', 7);
      expect(npc.fields.opinion.get('trust')).toBe(-10);
      expect(npc.fields.opinion.get('fear')).toBe(0);
      expect(npc.fields.opinion.get('anger')).toBe(7);
      expect(npc.fields.opinion.get('value')).toBe(0);
    });
  });

  describe('tier field (molcremental shape)', () => {
    it('advances through tiers when gates pass', () => {
      const accessor = buildAccessor();
      withEngine(accessor, () => {
        const cat = createSubjectCategory({
          id: 'npc-trust',
          fields: {
            trust: { kind: 'tier', tiers: ['stranger', 'acquaintance', 'student', 'trusted'] },
          },
        });
        cat.register({
          id: 'mentor-rask',
          fields: {
            trust: {
              gates: [
                { kind: 'flag', id: 'knowledge-rask-approach' },
                { kind: 'flag', id: 'knowledge-rask-competence' },
                { kind: 'flag', id: 'knowledge-rask-task' },
              ],
            },
          },
        });
        const rask = cat.get('mentor-rask')!;
        expect(rask.fields.trust.getTier()).toBe('stranger');

        // Gate not satisfied — advance is blocked.
        expect(rask.fields.trust.tryAdvance()).toBeNull();
        expect(rask.fields.trust.getTier()).toBe('stranger');

        // Satisfy first gate, advance to acquaintance.
        accessor.setUnlocked('knowledge-rask-approach', true);
        expect(rask.fields.trust.tryAdvance()).toBe('acquaintance');

        // Second gate not yet satisfied.
        expect(rask.fields.trust.tryAdvance()).toBeNull();

        // Satisfy second + third gates, advance twice more.
        accessor.setUnlocked('knowledge-rask-competence', true);
        accessor.setUnlocked('knowledge-rask-task', true);
        expect(rask.fields.trust.tryAdvance()).toBe('student');
        expect(rask.fields.trust.tryAdvance()).toBe('trusted');

        // Already at max — no further advance.
        expect(rask.fields.trust.tryAdvance()).toBeNull();
      });
    });

    it('emits advance events with from/to indices', () => {
      withGameStateAccessor(buildAccessor(), () => {
        const cat = createSubjectCategory({
          id: 'rank',
          fields: { rank: { kind: 'tier', tiers: ['novice', 'apprentice', 'master'] } },
        });
        cat.register({ id: 'mages-guild' });
        const g = cat.get('mages-guild')!;
        const handler = vi.fn();
        g.fields.rank.on('advance', handler);
        g.fields.rank.setIndex(2);
        expect(handler).toHaveBeenCalledWith({ from: 0, to: 2 });
      });
    });

    it('setIndex bypasses gates (for resets / migrations)', () => {
      withGameStateAccessor(buildAccessor(), () => {
        const cat = createSubjectCategory({
          id: 'rank',
          fields: { rank: { kind: 'tier', tiers: ['novice', 'apprentice', 'master'] } },
        });
        cat.register({
          id: 'mages-guild',
          fields: {
            rank: {
              gates: [
                { kind: 'flag', id: 'never' },
                { kind: 'flag', id: 'never' },
              ],
            },
          },
        });
        const g = cat.get('mages-guild')!;
        // tryAdvance would be blocked, but setIndex bypasses
        g.fields.rank.setIndex(2);
        expect(g.fields.rank.getTier()).toBe('master');
      });
    });
  });

  describe('flag field', () => {
    it('round-trips boolean state and emits change', () => {
      const cat = createSubjectCategory({
        id: 'flags',
        fields: { met: { kind: 'flag' }, hired: { kind: 'flag', initial: true } },
      });
      cat.register({ id: 'gordon' });
      const g = cat.get('gordon')!;
      expect(g.fields.met.get()).toBe(false);
      expect(g.fields.hired.get()).toBe(true);

      const handler = vi.fn();
      g.fields.met.on('change', handler);
      g.fields.met.set(true);
      g.fields.met.toggle();
      expect(handler).toHaveBeenCalledTimes(2);
      expect(g.fields.met.get()).toBe(false);
    });
  });

  describe('enum field (maldacena pathLocked shape)', () => {
    it('round-trips nullable enum state and rejects out-of-range writes', () => {
      const cat = createSubjectCategory({
        id: 'entity',
        fields: {
          pathLocked: { kind: 'enum', values: ['scientific', 'cooperative'] as const },
        },
      });
      cat.register({ id: 'the-entity' });
      const e = cat.get('the-entity')!;
      expect(e.fields.pathLocked.get()).toBeNull();

      const handler = vi.fn();
      e.fields.pathLocked.on('change', handler);
      e.fields.pathLocked.set('scientific');
      expect(handler).toHaveBeenCalledWith({ old: null, next: 'scientific' });
      expect(e.fields.pathLocked.get()).toBe('scientific');

      // Out-of-range write throws — protects save-format stability.
      expect(() =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        e.fields.pathLocked.set('hostile' as any),
      ).toThrow(/not in declared values/);

      // Setting back to null is allowed (uncommitted state).
      e.fields.pathLocked.set(null);
      expect(e.fields.pathLocked.get()).toBeNull();
    });

    it('per-subject override sets initial enum value', () => {
      const cat = createSubjectCategory({
        id: 'entity',
        fields: { pathLocked: { kind: 'enum', values: ['a', 'b'] as const } },
      });
      cat.register({ id: 'preset', fields: { pathLocked: { initial: 'b' } } });
      expect(cat.get('preset')!.fields.pathLocked.get()).toBe('b');
    });
  });

  describe('category surface', () => {
    it('register accepts batch + single, preserves insertion order, reports size', () => {
      const cat = createSubjectCategory({
        id: 'mixed',
        fields: { trust: { kind: 'scalar' } },
      });
      cat.register([{ id: 'a' }, { id: 'b' }]);
      cat.register({ id: 'c' });
      expect(cat.size).toBe(3);
      expect(cat.getAll().map((e) => e.def.id)).toEqual(['a', 'b', 'c']);
      expect(cat.getDef('b')?.id).toBe('b');
      expect(cat.getEntry('c')?.instance.id).toBe('c');
    });

    it('signals project unlock = any non-default, count = non-default-field count', () => {
      const cat = createSubjectCategory({
        id: 'entity',
        fields: {
          trust: { kind: 'scalar', initial: 0 },
          met: { kind: 'flag', initial: false },
        },
      });
      cat.register({ id: 'the-entity' });
      const entry = cat.getEntry('the-entity')!;
      expect(entry.signals?.unlock.value).toBe(false);
      expect(Decimal.fromValue(entry.signals!.count.value).toNumber()).toBe(0);

      cat.get('the-entity')!.fields.met.set(true);
      expect(entry.signals?.unlock.value).toBe(true);
      expect(Decimal.fromValue(entry.signals!.count.value).toNumber()).toBe(1);

      cat.get('the-entity')!.fields.trust.set(5);
      expect(Decimal.fromValue(entry.signals!.count.value).toNumber()).toBe(2);
    });

    it('auto-registers into EngineCategories.subjects when constructed inside an engine', () => {
      const accessor = buildAccessor();
      const engine = createEngine({ gameId: 'test', persistence: false, accessor });
      let categoryId: string | undefined;
      engine.use({
        id: 'test',
        install() {
          const cat = createSubjectCategory({
            id: 'npcs',
            fields: { trust: { kind: 'scalar' } },
          });
          categoryId = cat.id;
        },
      });
      engine.start();
      const categories = engine.tryInject(CategoriesKey)!;
      expect(categories.subjects).toBeDefined();
      expect(categories.subjects!.map((c) => c.id)).toContain(categoryId);
      engine.stop();
    });
  });
});
