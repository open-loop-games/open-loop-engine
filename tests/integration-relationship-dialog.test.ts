/**
 * Integration tests for the Phase 3 dialog + relationship surface.
 *
 * Covers four acceptance scenarios:
 *   1. One NPC, one knowledge-gated conversation.
 *   2. Multi-loop trust persistence (trust resets, knowledge survives).
 *   3. Adapter contract is implementable by a non-native runtime.
 *   4. Save round-trip via the runtime's import/export contract.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { bn, Decimal } from '@/primitives/decimal';
import { resetAllPersistentContexts } from '@/core/persistence';
import { withGameStateAccessor, type GameStateAccessorMutator } from '@/core/game-state-accessor';
import { C } from '@/core/conditions';
import { createDialogSession } from '@/systems/dialog-session';
import { createRelationshipCategory } from '@/systems/relationship';
import { createReset } from '@/systems/reset';
import { withPersistentContext } from '@/core/persistence';
import {
  createNativeDialogRuntime,
  type DialogGraph,
  type DialogRuntime,
  type DialogPresentation,
  type DialogRuntimeState,
} from '@/systems/dialog';
import type { TieredRelationshipDef } from '@/primitives/relationship';
import type { GameStateAccessor } from '@/primitives/types';
import type { GameStateMutator } from '@/core/effects';

beforeEach(() => {
  resetAllPersistentContexts();
});

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

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

const raskGreeting: DialogGraph = {
  id: 'rask-greeting',
  entry: 'open',
  nodes: [
    {
      id: 'open',
      text: 'You approach Instructor Rask.',
      choices: [
        {
          id: 'ask-restricted',
          text: 'Ask about the restricted library.',
          condition: { type: 'unlock', target: 'knowledge-restricted-library-tip' },
          next: 'restricted',
        },
        { id: 'ask-mundane', text: 'Pleasantries.', next: 'mundane' },
      ],
    },
    {
      id: 'restricted',
      text: '"Who told you about that?"',
    },
    {
      id: 'mundane',
      text: 'Rask grunts.',
    },
  ],
};

// ---------------------------------------------------------------------------
// Scenario 1 — Knowledge-gated conversation
// ---------------------------------------------------------------------------

describe('Scenario 1 — knowledge-gated conversation', () => {
  it('hides a gated choice until the knowledge is discovered, then reveals it', () => {
    const accessor = buildAccessor();
    withGameStateAccessor(accessor, () => {
      const session = createDialogSession({
        id: 'rask-conversation',
        graphs: [raskGreeting],
      });

      session.start('rask-greeting');
      let snap = session.present();
      expect(snap?.nodeId).toBe('open');
      expect(snap?.choices.map((c) => c.id)).toEqual(['ask-mundane']);

      // Discover the knowledge entry — the gate now passes.
      accessor.setUnlocked('knowledge-restricted-library-tip', true);

      session.start('rask-greeting');
      snap = session.present();
      expect(snap?.choices.map((c) => c.id)).toEqual(['ask-restricted', 'ask-mundane']);

      const chosen = vi.fn();
      session.on('chosen', chosen);
      session.choose('ask-restricted');
      expect(chosen).toHaveBeenCalledWith({
        graphId: 'rask-greeting',
        nodeId: 'open',
        choiceId: 'ask-restricted',
      });
      expect(session.present()?.nodeId).toBe('restricted');
    });
  });
});

// ---------------------------------------------------------------------------
// Scenario 2 — Multi-loop trust persistence
// ---------------------------------------------------------------------------

describe('Scenario 2 — multi-loop persistence', () => {
  it('resets trust per loop while knowledge unlocks survive', () => {
    const accessor = buildAccessor();
    withGameStateAccessor(accessor, () => {
      // Simulate the engine's install wrapper: the relationships *module*
      // owns the category, so category refs become children of the module's
      // context. Matches how molcremental's relationshipsModule actually
      // runs inside `engine.use()`.
      const cat = withPersistentContext('relationships', () => {
        const c = createRelationshipCategory<TieredRelationshipDef>({ id: 'npc-trust' });
        c.register({
          id: 'mentor-rask',
          kind: 'tiered',
          actors: ['mentor-rask'],
          tiers: ['stranger', 'acquaintance', 'student', 'trusted'],
          gates: [
            C.unlock('knowledge-rask-approach'),
            C.unlock('knowledge-rask-competence'),
            C.unlock('knowledge-rask-task'),
          ],
        });
        return c;
      });

      // Player unlocks the first protocol step's knowledge and advances trust.
      accessor.setUnlocked('knowledge-rask-approach', true);
      const trust = cat.getInstance<'tiered'>('mentor-rask')!;
      expect(trust.tryAdvance('mentor-rask')).toBe('acquaintance');
      expect(trust.getIndex('mentor-rask')).toBe(1);

      // End-of-loop: reset the `relationships` module. Knowledge is in a
      // separate persistence scope (here, the accessor's `unlocks` Map) and
      // isn't touched.
      const reset = createReset({ resetModules: ['relationships'] });
      reset.reset();

      expect(trust.getIndex('mentor-rask')).toBe(0);
      // Knowledge unlock survived the relationship reset.
      expect(accessor.isUnlocked('knowledge-rask-approach')).toBe(true);
      // Player can re-advance trust without re-discovering the knowledge — the
      // gate still passes.
      expect(trust.tryAdvance('mentor-rask')).toBe('acquaintance');
    });
  });
});

// ---------------------------------------------------------------------------
// Scenario 3 — Adapter contract implementability
// ---------------------------------------------------------------------------

describe('Scenario 3 — DialogRuntime adapter contract', () => {
  it('a non-native runtime stub conforms to the contract and drives a session', () => {
    /**
     * In-memory state-machine adapter — does not use DialogGraph at all.
     * Has two nodes: 'a' → 'b' on choice 'next', then terminal.
     * Proves that `DialogRuntime` is the only contract an adapter must
     * satisfy — engine internals (graphs, conditions, effects) are optional.
     */
    function createStubRuntime(): DialogRuntime {
      const state: DialogRuntimeState = {
        activeGraphId: undefined,
        activeNodeId: undefined,
        visitCounts: {},
      };
      function present(): DialogPresentation | null {
        if (!state.activeNodeId) return null;
        if (state.activeNodeId === 'a') {
          return {
            nodeId: 'a',
            text: 'Stub A',
            choices: [{ id: 'next', text: 'Continue' }],
            finished: false,
          };
        }
        return { nodeId: 'b', text: 'Stub B', choices: [], finished: true };
      }
      return {
        start(graphId, entryNode) {
          state.activeGraphId = graphId;
          state.activeNodeId = entryNode ?? 'a';
        },
        present,
        choose(choiceId) {
          if (state.activeNodeId === 'a' && choiceId === 'next') {
            state.activeNodeId = 'b';
          }
        },
        finish() {
          state.activeGraphId = undefined;
          state.activeNodeId = undefined;
        },
        isActive() {
          return state.activeNodeId !== undefined;
        },
        exportState() {
          return { ...state };
        },
        importState(snapshot) {
          state.activeGraphId = snapshot.activeGraphId;
          state.activeNodeId = snapshot.activeNodeId;
          state.visitCounts = snapshot.visitCounts;
        },
      };
    }

    withGameStateAccessor(buildAccessor(), () => {
      const session = createDialogSession({
        id: 'stub-session',
        graphs: [], // Stub runtime ignores graphs entirely.
        runtimeFactory: () => createStubRuntime(),
      });

      session.start('any-graph-id');
      expect(session.present()?.nodeId).toBe('a');
      expect(session.present()?.choices).toHaveLength(1);

      session.choose('next');
      expect(session.present()?.nodeId).toBe('b');
      expect(session.present()?.finished).toBe(true);

      session.finish();
      expect(session.isActive()).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// Scenario 4 — Save round-trip via runtime import/export
// ---------------------------------------------------------------------------

describe('Scenario 4 — save round-trip', () => {
  it('a fresh native runtime restores active node + visit counts from a snapshot', () => {
    const accessor = buildAccessor() as GameStateAccessor;
    const mutator = buildAccessor() as GameStateMutator;

    // First runtime: walk through a conversation to accumulate state.
    const r1 = createNativeDialogRuntime({ graphs: [raskGreeting], accessor, mutator });
    r1.start('rask-greeting');
    r1.choose('ask-mundane');
    expect(r1.present()?.nodeId).toBe('mundane');
    const snapshot = r1.exportState();
    expect(snapshot.activeGraphId).toBe('rask-greeting');
    expect(snapshot.activeNodeId).toBe('mundane');
    expect(snapshot.visitCounts['rask-greeting']).toEqual({ open: 1, mundane: 1 });

    // Fresh runtime + import — exactly what save/load does.
    const r2 = createNativeDialogRuntime({ graphs: [raskGreeting], accessor, mutator });
    expect(r2.isActive()).toBe(false);
    r2.importState(snapshot);
    expect(r2.isActive()).toBe(true);
    expect(r2.present()?.nodeId).toBe('mundane');
    expect(r2.exportState().visitCounts['rask-greeting']).toEqual({ open: 1, mundane: 1 });
  });

  it('relationship state lives in a deterministic persistent namespace', () => {
    // Pin the persistent-context naming convention so save-manager round-trip
    // (covered in save-manager.test.ts) knows exactly what key shape to expect.
    // The category opens `{categoryId}/{def.id}` contexts; within each, per-
    // actor persistent refs are named after the actor id.
    const accessor = buildAccessor();
    withGameStateAccessor(accessor, () => {
      const cat = createRelationshipCategory<TieredRelationshipDef>({ id: 'npc-trust' });
      cat.register({
        id: 'mentor-rask',
        kind: 'tiered',
        actors: ['mentor-rask'],
        tiers: ['stranger', 'acquaintance', 'student', 'trusted'],
      });
      const trust = cat.getInstance<'tiered'>('mentor-rask')!;
      // The ref exists and is addressable by actor id — that's the contract
      // save/load relies on. Tier value survives export/import because
      // persistent refs in a known namespace are automatically serialized.
      expect(trust.refs.get('mentor-rask')).toBeDefined();
      trust.setIndex('mentor-rask', 2);
      expect(trust.refs.get('mentor-rask')?.value).toBe(2);
    });
  });
});
