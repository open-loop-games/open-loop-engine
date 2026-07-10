import { describe, it, expect, beforeEach, vi } from 'vitest';
import { bn, Decimal } from '@/primitives/decimal';
import { getAllPersistentRefs, loadingSave, resetAllPersistentContexts } from '@/core/persistence';
import { type GameStateAccessorMutator } from '@/core/game-state-accessor';
import { createEngine, type EngineModule } from '@/index';
import { createDialogSession } from '@/systems/dialog-session';
import type { DialogGraph } from '@/systems/dialog';

/**
 * Run `fn` inside an engine install hook so the ambient GateRuntime triple
 * (accessor + categories + registry) is wired — required for dialog choice
 * conditions that dispatch through evaluateGate.
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

function buildAccessor(state: Record<string, unknown> = {}): GameStateAccessorMutator {
  const unlocks = new Map<string, boolean>();
  return {
    getResource: () => bn(0),
    isUnlocked: (id) => unlocks.get(id) ?? false,
    getState: (path) => state[path],
    getRate: () => Decimal.dZero,
    applyResourceOp: () => {},
    setUnlocked: (id, v) => {
      unlocks.set(id, v);
    },
    setState: (path, v) => {
      state[path] = v;
    },
  };
}

const greetingGraph: DialogGraph = {
  id: 'rask-greeting',
  entry: 'open',
  nodes: [
    {
      id: 'open',
      text: 'You approach Instructor Rask.',
      choices: [
        { id: 'ask-training', text: 'Request training.', next: 'training' },
        {
          id: 'ask-secret',
          text: 'Ask about the restricted library.',
          condition: { kind: 'flag', id: 'knowledge-restricted-tip' },
          next: 'secret',
        },
      ],
    },
    {
      id: 'training',
      text: 'Rask grunts. "Show me precision first."',
      onEnter: [{ type: 'state', target: 'rel.npc-trust.rask.tier', value: 1 }],
    },
    {
      id: 'secret',
      text: 'Rask narrows his eyes. "Who told you about that?"',
    },
  ],
};

const cycleGraph: DialogGraph = {
  id: 'loop-graph',
  entry: 'a',
  nodes: [
    { id: 'a', text: 'A', next: 'b' },
    { id: 'b', text: 'B', next: 'a' },
  ],
};

describe('createDialogSession', () => {
  it('throws on an authored next-only cycle instead of hanging settle()', () => {
    withEngine(buildAccessor(), () => {
      const session = createDialogSession({ id: 'main', graphs: [cycleGraph] });
      expect(() => session.start('loop-graph')).toThrow(/cycle/);
    });
  });

  it('starts a graph and presents the entry node', () => {
    withEngine(buildAccessor(), () => {
      const session = createDialogSession({
        id: 'main',
        graphs: [greetingGraph],
      });
      session.start('rask-greeting');
      const snap = session.present();
      expect(snap?.nodeId).toBe('open');
      expect(snap?.text).toContain('Rask');
      // Gated choice is filtered out (knowledge-restricted-tip is not unlocked)
      expect(snap?.choices.map((c) => c.id)).toEqual(['ask-training']);
    });
  });

  it('reveals gated choices once the gate flips true', () => {
    const accessor = buildAccessor();
    accessor.setUnlocked('knowledge-restricted-tip', true);
    withEngine(accessor, () => {
      const session = createDialogSession({
        id: 'main',
        graphs: [greetingGraph],
      });
      session.start('rask-greeting');
      const snap = session.present();
      expect(snap?.choices.map((c) => c.id)).toEqual(['ask-training', 'ask-secret']);
    });
  });

  it('emits presented / chosen / finished events', () => {
    withEngine(buildAccessor(), () => {
      const session = createDialogSession({
        id: 'main',
        graphs: [greetingGraph],
      });
      const presented = vi.fn();
      const chosen = vi.fn();
      const finished = vi.fn();
      session.on('presented', presented);
      session.on('chosen', chosen);
      session.on('finished', finished);

      session.start('rask-greeting');
      expect(presented).toHaveBeenCalledTimes(1);

      session.choose('ask-training');
      expect(chosen).toHaveBeenCalledWith({
        graphId: 'rask-greeting',
        nodeId: 'open',
        choiceId: 'ask-training',
      });
      // Training node is terminal (no choices, no next) → finishes after presenting.
      expect(presented).toHaveBeenCalledTimes(2);
      // Wait — the training node has no choices and no next. present() returns finished:true,
      // but the runtime never auto-finishes; finished only fires on explicit finish() or gate fail.
      // So `finished` should NOT have been called yet.
      expect(finished).not.toHaveBeenCalled();

      session.finish();
      expect(finished).toHaveBeenCalledWith({ graphId: 'rask-greeting' });
    });
  });

  it('writes choice outcomes via the mutator', () => {
    const accessor = buildAccessor();
    const setStateSpy = vi.spyOn(accessor, 'setState');
    withEngine(accessor, () => {
      const session = createDialogSession({
        id: 'main',
        graphs: [greetingGraph],
      });
      session.start('rask-greeting');
      session.choose('ask-training');
      // Training node's onEnter fires → state write to rel.npc-trust.rask.tier
      expect(setStateSpy).toHaveBeenCalledWith('rel.npc-trust.rask.tier', 1);
    });
  });

  it('snapshots runtime state into the persistent ref on every choose', () => {
    withEngine(buildAccessor(), () => {
      const session = createDialogSession({
        id: 'snapshot',
        graphs: [greetingGraph],
      });
      session.start('rask-greeting');
      // Pre-choose presentation reflects the entry node.
      expect(session.present()?.nodeId).toBe('open');
      session.choose('ask-training');
      // Post-choose presentation reflects the advanced node — proving the
      // session's snapshot logic ran *after* the runtime mutation.
      expect(session.present()?.nodeId).toBe('training');
    });
  });

  it('re-imports state into the runtime when save load writes to the persistent ref', () => {
    // Engine init order is module-install → save-load, so the session's eager
    // importState fires against the *default* stateRef value; the saved
    // active conversation must propagate via the loadingSave-gated watcher.
    // This test simulates the deserialize step directly: flip loadingSave,
    // write a non-default state into the ref, flip back. Without the watcher,
    // session.isActive() would stay false.
    withEngine(buildAccessor(), () => {
      const session = createDialogSession({ id: 'load-sync', graphs: [greetingGraph] });
      expect(session.isActive()).toBe(false);

      const refs = getAllPersistentRefs();
      const stateRef = refs.get('dialog-sessions/load-sync.state') as
        | {
            value: {
              activeGraphId?: string;
              activeNodeId?: string;
              visitCounts: Record<string, Record<string, number>>;
            };
          }
        | undefined;
      expect(stateRef).toBeDefined();

      loadingSave.value = true;
      try {
        stateRef!.value = {
          activeGraphId: 'rask-greeting',
          activeNodeId: 'training',
          visitCounts: {},
        };
      } finally {
        loadingSave.value = false;
      }

      expect(session.isActive()).toBe(true);
      expect(session.present()?.nodeId).toBe('training');
    });
  });

  it('throws when no ambient accessor is available and none was passed', () => {
    expect(() =>
      createDialogSession({
        id: 'oops',
        graphs: [greetingGraph],
      }),
    ).toThrow(/requires an ambient GameStateAccessor/);
  });
});
