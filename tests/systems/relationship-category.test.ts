import { describe, it, expect, beforeEach, vi } from 'vitest';
import { bn, Decimal } from '@/primitives/decimal';
import { resetAllPersistentContexts } from '@/core/persistence';
import { withGameStateAccessor, type GameStateAccessorMutator } from '@/core/game-state-accessor';
import { createEngine, type EngineModule } from '@/index';
import { createRelationshipCategory } from '@/systems/relationship';
import type {
  ScalarRelationshipDef,
  TieredRelationshipDef,
  VectorRelationshipDef,
  FactionRelationshipDef,
  FlagRelationshipDef,
  RelationshipDef,
} from '@/systems/relationship-defs';

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
 * Run `fn` inside an engine install hook so the ambient GateRuntime triple
 * (accessor + categories + registry) is wired — required for tryAdvance to
 * evaluate Gate-typed `gates[]`.
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

describe('createRelationshipCategory', () => {
  describe('scalar variant', () => {
    it('creates per-actor persistent refs and clamps writes', () => {
      const cat = createRelationshipCategory<ScalarRelationshipDef>({ id: 'bonds' });
      cat.register({
        id: 'creature-bond',
        kind: 'scalar',
        actors: ['fluffy', 'rocky'],
        initial: 25,
        min: 0,
        max: 100,
      });

      const inst = cat.getInstance<'scalar'>('creature-bond');
      expect(inst?.kind).toBe('scalar');
      expect(inst?.get('fluffy')).toBe(25);

      inst?.add('fluffy', 80); // 25 + 80 = 105 → clamped to 100
      expect(inst?.get('fluffy')).toBe(100);

      inst?.add('rocky', -50); // 25 - 50 = -25 → clamped to 0
      expect(inst?.get('rocky')).toBe(0);
    });

    it('emits change events on writes', () => {
      const cat = createRelationshipCategory<ScalarRelationshipDef>({ id: 'bonds' });
      cat.register({
        id: 'creature-bond',
        kind: 'scalar',
        actors: ['fluffy'],
        initial: 0,
      });
      const inst = cat.getInstance<'scalar'>('creature-bond')!;
      const handler = vi.fn();
      inst.on('change', handler);
      inst.set('fluffy', 5);
      expect(handler).toHaveBeenCalledWith({ actor: 'fluffy', old: 0, next: 5 });
      // No-op write doesn't fire.
      inst.set('fluffy', 5);
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('honors derive() for derived-on-read scalars (Level13 trust shape)', () => {
      const cat = createRelationshipCategory<ScalarRelationshipDef>({ id: 'trust' });
      cat.register({
        id: 'explorer-trust',
        kind: 'scalar',
        actors: ['fights', 'steps', 'dialogues'], // input slots, not actor names per se
        initial: 0,
        derive: (inputs) =>
          Math.max(
            Math.min(10, (inputs.fights ?? 0) / 100),
            Math.min(10, (inputs.steps ?? 0) / 3000),
            Math.min(10, (inputs.dialogues ?? 0) / 100),
          ),
      });
      const inst = cat.getInstance<'scalar'>('explorer-trust')!;
      inst.set('fights', 200);
      inst.set('steps', 0);
      inst.set('dialogues', 0);
      // max(2, 0, 0) = 2 — fights branch wins
      expect(inst.read('fights')).toBe(2);
      inst.set('dialogues', 500);
      // max(2, 0, 5) = 5 — dialogues branch wins now
      expect(inst.read('fights')).toBe(5);
    });
  });

  describe('tiered variant (molcremental shape)', () => {
    it('advances through tiers when gates pass', () => {
      const accessor = buildAccessor();
      withEngine(accessor, () => {
        const cat = createRelationshipCategory<TieredRelationshipDef>({ id: 'npc-trust' });
        cat.register({
          id: 'mentor-rask',
          kind: 'tiered',
          actors: ['mentor-rask'],
          tiers: ['stranger', 'acquaintance', 'student', 'trusted'],
          gates: [
            { kind: 'flag', id: 'knowledge-rask-approach' },
            { kind: 'flag', id: 'knowledge-rask-competence' },
            { kind: 'flag', id: 'knowledge-rask-task' },
          ],
        });
        const inst = cat.getInstance<'tiered'>('mentor-rask')!;
        expect(inst.getTier('mentor-rask')).toBe('stranger');

        // Gate not satisfied — advance is blocked.
        expect(inst.tryAdvance('mentor-rask')).toBeNull();
        expect(inst.getTier('mentor-rask')).toBe('stranger');

        // Satisfy first gate, advance to acquaintance.
        accessor.setUnlocked('knowledge-rask-approach', true);
        expect(inst.tryAdvance('mentor-rask')).toBe('acquaintance');

        // Second gate not yet satisfied.
        expect(inst.tryAdvance('mentor-rask')).toBeNull();

        // Satisfy second + third gates, advance twice more.
        accessor.setUnlocked('knowledge-rask-competence', true);
        accessor.setUnlocked('knowledge-rask-task', true);
        expect(inst.tryAdvance('mentor-rask')).toBe('student');
        expect(inst.tryAdvance('mentor-rask')).toBe('trusted');

        // Already at max — no further advance.
        expect(inst.tryAdvance('mentor-rask')).toBeNull();
      });
    });

    it('emits advance events with from/to indices', () => {
      withGameStateAccessor(buildAccessor(), () => {
        const cat = createRelationshipCategory<TieredRelationshipDef>({ id: 'rank' });
        cat.register({
          id: 'guild-rank',
          kind: 'tiered',
          actors: ['mages-guild'],
          tiers: ['novice', 'apprentice', 'master'],
        });
        const inst = cat.getInstance<'tiered'>('guild-rank')!;
        const handler = vi.fn();
        inst.on('advance', handler);
        inst.setIndex('mages-guild', 2);
        expect(handler).toHaveBeenCalledWith({
          actor: 'mages-guild',
          from: 0,
          to: 2,
        });
      });
    });

    it('setIndex bypasses gates (for resets / migrations)', () => {
      withGameStateAccessor(buildAccessor(), () => {
        const cat = createRelationshipCategory<TieredRelationshipDef>({ id: 'rank' });
        cat.register({
          id: 'guild-rank',
          kind: 'tiered',
          actors: ['mages-guild'],
          tiers: ['novice', 'apprentice', 'master'],
          gates: [
            { kind: 'flag', id: 'never' },
            { kind: 'flag', id: 'never' },
          ],
        });
        const inst = cat.getInstance<'tiered'>('guild-rank')!;
        // tryAdvance would be blocked, but setIndex bypasses
        inst.setIndex('mages-guild', 2);
        expect(inst.getTier('mages-guild')).toBe('master');
      });
    });
  });

  describe('vector variant', () => {
    it('tracks N independent dimensions per actor with per-dim clamps', () => {
      const cat = createRelationshipCategory<VectorRelationshipDef>({ id: 'opinion' });
      cat.register({
        id: 'cdda-opinion',
        kind: 'vector',
        actors: ['npc-1'],
        dimensions: ['trust', 'fear', 'value', 'anger'],
        dimensionConfig: {
          fear: { min: 0, max: 100 },
        },
      });
      const inst = cat.getInstance<'vector'>('cdda-opinion')!;
      inst.set('npc-1', 'trust', -10);
      inst.set('npc-1', 'fear', -5); // clamped to 0
      inst.add('npc-1', 'anger', 7);
      expect(inst.get('npc-1', 'trust')).toBe(-10);
      expect(inst.get('npc-1', 'fear')).toBe(0);
      expect(inst.get('npc-1', 'anger')).toBe(7);
      expect(inst.get('npc-1', 'value')).toBe(0);
    });
  });

  describe('faction variant', () => {
    it('propagates writes across the attitude matrix above the weight floor', () => {
      const cat = createRelationshipCategory<FactionRelationshipDef>({ id: 'pol' });
      cat.register({
        id: 'governments',
        kind: 'faction',
        factions: ['empire', 'rebels', 'merchants'],
        // Empire ↔ Rebels = -1 enemy; Empire ↔ Merchants = 0.3 friendly;
        // Merchants ↔ Rebels = 0.02 (below floor — propagation suppressed).
        attitude: {
          empire: { rebels: -1, merchants: 0.3 },
          rebels: { empire: -1 },
          merchants: { empire: 0.3, rebels: 0.02 },
        },
        weightFloor: 0.05,
      });
      const inst = cat.getInstance<'faction'>('governments')!;
      // Apply +10 to empire — propagates to rebels (-10) and merchants (+3).
      inst.applyTo('empire', 10);
      expect(inst.get('empire')).toBe(10); // diagonal default 1 still propagates self
      expect(inst.get('rebels')).toBe(-10);
      expect(inst.get('merchants')).toBe(3);
      // Apply +5 to merchants — Rebels weight 0.02 is below floor, no propagation.
      inst.applyTo('merchants', 5);
      expect(inst.get('rebels')).toBe(-10); // unchanged
      expect(inst.get('empire')).toBe(11.5); // 10 + 5*0.3 = 11.5
    });
  });

  describe('flag variant', () => {
    it('stores per-actor named booleans', () => {
      const cat = createRelationshipCategory<FlagRelationshipDef>({ id: 'flags' });
      cat.register({
        id: 'gordon-flags',
        kind: 'flag',
        actors: ['gordon'],
        flags: ['met', 'hired', 'betrayed'],
      });
      const inst = cat.getInstance<'flag'>('gordon-flags')!;
      expect(inst.get('gordon', 'met')).toBe(false);
      inst.set('gordon', 'met', true);
      inst.set('gordon', 'hired', true);
      expect(inst.get('gordon', 'met')).toBe(true);
      expect(inst.get('gordon', 'hired')).toBe(true);
      expect(inst.get('gordon', 'betrayed')).toBe(false);
    });
  });

  describe('category dispatch', () => {
    it('switches on def.kind to build the right variant', () => {
      const cat = createRelationshipCategory<RelationshipDef>({ id: 'mixed' });
      cat.register([
        { id: 'a', kind: 'scalar', actors: ['x'] },
        { id: 'b', kind: 'tiered', actors: ['y'], tiers: ['low', 'high'] },
        { id: 'c', kind: 'flag', actors: ['z'], flags: ['on'] },
      ]);
      expect(cat.getInstance('a')?.kind).toBe('scalar');
      expect(cat.getInstance('b')?.kind).toBe('tiered');
      expect(cat.getInstance('c')?.kind).toBe('flag');
      expect(cat.size).toBe(3);
    });
  });
});
