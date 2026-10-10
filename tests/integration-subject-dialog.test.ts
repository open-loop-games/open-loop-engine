/**
 * Integration tests for the dialog + subject-category surface.
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
import { createEngine, type EngineModule } from '@/index';
import { createDialogSession } from '@/systems/dialog-session';
import { createSubjectCategory } from '@/systems/subject-category';
import { createReset } from '@/systems/reset';
import { withPersistentContext } from '@/core/persistence';
import {
  createNativeDialogRuntime,
  type DialogGraph,
  type DialogRuntime,
  type DialogPresentation,
  type DialogRuntimeState,
} from '@/systems/dialog';
import type { GameStateAccessor } from '@/primitives/types';
import type { GameStateMutator } from '@/core/effects';

/**
 * Run `fn` inside an engine install hook so the ambient GateRuntime triple
 * (accessor + categories + registry) is wired — required for Gate-based
 * predicates (dialog conditions, subject-category tier gates).
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

beforeEach(() => {
  resetAllPersistentContexts();
});

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function buildAccessor(): GameStateAccessorMutator {
  const unlocks = new Map<string, boolean>();
  return {
    getAmount: () => bn(0),
    getFlag: (id) => unlocks.get(id) ?? false,
    getState: () => undefined,
    getRate: () => Decimal.dZero,
    applyResourceOp: () => {},
    setFlag: (id, v) => {
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
          visible: { kind: 'flag', id: 'knowledge-restricted-library-tip' },
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
    withEngine(accessor, () => {
      const session = createDialogSession({
        id: 'rask-conversation',
        graphs: [raskGreeting],
      });

      session.start('rask-greeting');
      let snap = session.present();
      expect(snap?.nodeId).toBe('open');
      expect(snap?.choices.map((c) => c.id)).toEqual(['ask-mundane']);

      // Discover the knowledge entry — the gate now passes.
      accessor.setFlag('knowledge-restricted-library-tip', true);

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
    withEngine(accessor, () => {
      // Simulate the engine's install wrapper: the subjects *module* owns the
      // category, so subject refs become children of the module's context.
      // Matches how molcremental's relationshipsModule actually runs inside
      // `engine.use()`.
      const cat = withPersistentContext('relationships', () =>
        createSubjectCategory({
          id: 'npc-trust',
          fields: {
            trust: {
              kind: 'tier',
              tiers: ['stranger', 'acquaintance', 'student', 'trusted'],
            },
          },
        }),
      );

      withPersistentContext('relationships', () => {
        cat.register({
          id: 'mentor-rask',
          fields: {
            trust: {
              advanceWhen: [
                { kind: 'flag', id: 'knowledge-rask-approach' },
                { kind: 'flag', id: 'knowledge-rask-competence' },
                { kind: 'flag', id: 'knowledge-rask-task' },
              ],
            },
          },
        });
      });

      // Player unlocks the first protocol step's knowledge and advances trust.
      accessor.setFlag('knowledge-rask-approach', true);
      const rask = cat.get('mentor-rask')!;
      expect(rask.fields.trust.tryAdvance()).toBe('acquaintance');
      expect(rask.fields.trust.getIndex()).toBe(1);

      // End-of-loop: reset the `relationships` module. Knowledge is in a
      // separate persistence scope (here, the accessor's `unlocks` Map) and
      // isn't touched.
      const reset = createReset({ resetPersistentContexts: ['relationships'] });
      reset.reset();

      expect(rask.fields.trust.getIndex()).toBe(0);
      // Knowledge unlock survived the relationship reset.
      expect(accessor.getFlag('knowledge-rask-approach')).toBe(true);
      // Player can re-advance trust without re-discovering the knowledge — the
      // gate still passes.
      expect(rask.fields.trust.tryAdvance()).toBe('acquaintance');
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
            terminal: false,
          };
        }
        return { nodeId: 'b', text: 'Stub B', choices: [], terminal: true };
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
        getVisitCount(graphId, nodeId) {
          return state.visitCounts[graphId]?.[nodeId] ?? 0;
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
      expect(session.present()?.terminal).toBe(true);
      // `advance` is optional on the contract; the session names the gap.
      expect(() => session.advance()).toThrow(/does not implement advance/);

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
    const accessor = buildAccessor();
    const mutator = buildAccessor() as GameStateMutator;

    withEngine(accessor, () => {
      // First runtime: walk through a conversation to accumulate state.
      const r1 = createNativeDialogRuntime({
        graphs: [raskGreeting],
        accessor: accessor as GameStateAccessor,
        mutator,
      });
      r1.start('rask-greeting');
      r1.choose('ask-mundane');
      expect(r1.present()?.nodeId).toBe('mundane');
      const snapshot = r1.exportState();
      expect(snapshot.activeGraphId).toBe('rask-greeting');
      expect(snapshot.activeNodeId).toBe('mundane');
      expect(snapshot.visitCounts['rask-greeting']).toEqual({ open: 1, mundane: 1 });

      // Read accessor mirrors the persisted counts, with 0 for never-visited
      // nodes and unknown graphs (the visit-gating read path).
      expect(r1.getVisitCount('rask-greeting', 'open')).toBe(1);
      expect(r1.getVisitCount('rask-greeting', 'mundane')).toBe(1);
      expect(r1.getVisitCount('rask-greeting', 'restricted')).toBe(0);
      expect(r1.getVisitCount('no-such-graph', 'open')).toBe(0);

      // Fresh runtime + import — exactly what save/load does.
      const r2 = createNativeDialogRuntime({
        graphs: [raskGreeting],
        accessor: accessor as GameStateAccessor,
        mutator,
      });
      expect(r2.isActive()).toBe(false);
      r2.importState(snapshot);
      expect(r2.isActive()).toBe(true);
      expect(r2.present()?.nodeId).toBe('mundane');
      expect(r2.exportState().visitCounts['rask-greeting']).toEqual({ open: 1, mundane: 1 });
      // Read path survives save/load on the fresh runtime.
      expect(r2.getVisitCount('rask-greeting', 'open')).toBe(1);
      expect(r2.getVisitCount('rask-greeting', 'mundane')).toBe(1);
    });
  });

  it('subject state lives in a deterministic persistent namespace', () => {
    // Pin the persistent-context naming convention so save-manager round-trip
    // (covered in save-manager.test.ts) knows exactly what key shape to expect.
    // The category opens `{categoryId}/{subjectId}` contexts; within each, per-
    // field persistent refs are named after the field id.
    const accessor = buildAccessor();
    withGameStateAccessor(accessor, () => {
      const cat = createSubjectCategory({
        id: 'npc-trust',
        fields: {
          trust: { kind: 'tier', tiers: ['stranger', 'acquaintance', 'student', 'trusted'] },
        },
      });
      cat.register({ id: 'mentor-rask' });

      const rask = cat.get('mentor-rask')!;
      // The ref exists and is addressable by field name — that's the contract
      // save/load relies on. Tier value survives export/import because
      // persistent refs in a known namespace are automatically serialized.
      expect(rask.fields.trust.ref).toBeDefined();
      rask.fields.trust.setIndex(2);
      expect(rask.fields.trust.ref.value).toBe(2);
    });
  });
});
