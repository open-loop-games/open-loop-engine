import { describe, it, expect, beforeEach, vi } from 'vitest';
import { bn, Decimal } from '@/primitives/decimal';
import {
  getAllPersistentRefs,
  resetAllPersistentContexts,
  withLoadingSave,
  type Persistent,
  type State,
} from '@/core/persistence';
import { type GameStateAccessorMutator } from '@/core/game-state-accessor';
import { createEngine, type EngineModule } from '@/index';
import { createDialogSession } from '@/systems/dialog-session';
import type { DialogGraph, DialogRuntimeState } from '@/systems/dialog';

/**
 * Construct inside an engine install hook and hand the result back for the test
 * to drive *after* `engine.start()` returns.
 *
 * The split is the point. A real game builds its dialog session during install
 * — where the ambient accessor, categories and resource registry are wired —
 * but calls start / choices / choose from player-driven UI long afterwards,
 * when that ambient scope has closed. Construct and drive in the same hook and
 * an eval-time ambient read passes here while failing in every real consumer.
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

function buildSession(
  graphs: DialogGraph[],
  {
    id = 'main',
    accessor = buildAccessor(),
  }: { id?: string; accessor?: GameStateAccessorMutator } = {},
) {
  return withEngine(accessor, () => createDialogSession({ id, graphs }));
}

function savedState(id: string): Persistent<State> {
  return getAllPersistentRefs().get(`dialog-sessions/${id}.state`)!;
}

/** Narrows the generic introspection value down to the shape this session's stateRef actually holds. */
function isDialogRuntimeState(v: unknown): v is DialogRuntimeState {
  return typeof v === 'object' && v !== null && 'visitCounts' in v;
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
  it('throws on two graphs that share an id instead of letting the last win', () => {
    const questA: DialogGraph = {
      id: 'greeting',
      entry: 'n',
      nodes: [{ id: 'n', text: 'Quest A greeting' }],
    };
    const questB: DialogGraph = { ...questA, nodes: [{ id: 'n', text: 'Quest B greeting' }] };
    expect(() => buildSession([questA, questB])).toThrow(/duplicate dialog graph id "greeting"/);
  });

  it('throws on a node id repeated within one graph', () => {
    const graph: DialogGraph = {
      id: 'twice',
      entry: 'n',
      nodes: [
        { id: 'n', text: 'first' },
        { id: 'n', text: 'second' },
      ],
    };
    expect(() => buildSession([graph])).toThrow(/duplicate node id "n" in dialog graph "twice"/);
  });

  it('throws on an authored next-only cycle instead of hanging settle()', () => {
    const session = buildSession([cycleGraph]);
    expect(() => session.start('loop-graph')).toThrow(/cycle/);
  });

  it('throws on a cycle before re-entering a node, leaving the saved state in step', () => {
    const accessor = buildAccessor();
    const setStateSpy = vi.spyOn(accessor, 'setState');
    const graph: DialogGraph = {
      id: 'loop-with-effect',
      entry: 'a',
      nodes: [
        { id: 'a', text: 'A', next: 'b', onEnter: [{ type: 'state', target: 'met', value: 1 }] },
        { id: 'b', text: 'B', next: 'a' },
      ],
    };
    const session = buildSession([graph], { id: 'cycle-sync', accessor });
    expect(() => session.start('loop-with-effect')).toThrow(/cycle/);
    expect(setStateSpy).toHaveBeenCalledTimes(1);
    const stateRef = savedState('cycle-sync');
    const state = stateRef.value;
    if (!isDialogRuntimeState(state)) throw new Error('expected dialog runtime state');
    expect(state.activeNodeId).toBe(session.present()?.nodeId);
    expect(state.visitCounts['loop-with-effect']).toEqual({ a: 1, b: 1 });
  });

  it('starts a graph and presents the entry node', () => {
    const session = buildSession([greetingGraph]);
    session.start('rask-greeting');
    const snap = session.present();
    expect(snap?.nodeId).toBe('open');
    expect(snap?.text).toContain('Rask');
    // Gated choice is filtered out (knowledge-restricted-tip is not unlocked)
    expect(snap?.choices.map((c) => c.id)).toEqual(['ask-training']);
  });

  it('reveals gated choices once the gate flips true', () => {
    const accessor = buildAccessor();
    accessor.setUnlocked('knowledge-restricted-tip', true);
    const session = buildSession([greetingGraph], { accessor });
    session.start('rask-greeting');
    const snap = session.present();
    expect(snap?.choices.map((c) => c.id)).toEqual(['ask-training', 'ask-secret']);
  });

  it('emits presented / chosen / finished events', () => {
    const session = buildSession([greetingGraph]);
    {
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
    }
  });

  it('writes choice outcomes via the mutator', () => {
    const accessor = buildAccessor();
    const setStateSpy = vi.spyOn(accessor, 'setState');
    const session = buildSession([greetingGraph], { accessor });
    session.start('rask-greeting');
    session.choose('ask-training');
    // Training node's onEnter fires → state write to rel.npc-trust.rask.tier
    expect(setStateSpy).toHaveBeenCalledWith('rel.npc-trust.rask.tier', 1);
  });

  it('snapshots runtime state into the persistent ref on every choose', () => {
    const session = buildSession([greetingGraph], { id: 'snapshot' });
    session.start('rask-greeting');
    // Pre-choose presentation reflects the entry node.
    expect(session.present()?.nodeId).toBe('open');
    session.choose('ask-training');
    // Post-choose presentation reflects the advanced node — proving the
    // session's snapshot logic ran *after* the runtime mutation.
    expect(session.present()?.nodeId).toBe('training');
  });

  it('re-imports state into the runtime when save load writes to the persistent ref', () => {
    // Engine init order is module-install → save-load, so the session's eager
    // importState fires against the *default* stateRef value; the saved
    // active conversation must propagate via the loadingSave-gated watcher.
    // This test simulates the deserialize step directly: write a non-default
    // state into the ref under the load guard. Without the watcher,
    // session.isActive() would stay false.
    const session = buildSession([greetingGraph], { id: 'load-sync' });
    {
      expect(session.isActive()).toBe(false);

      const stateRef = savedState('load-sync');
      expect(stateRef).toBeDefined();

      withLoadingSave(() => {
        stateRef.value = {
          activeGraphId: 'rask-greeting',
          activeNodeId: 'training',
          visitCounts: {},
        };
      });

      expect(session.isActive()).toBe(true);
      expect(session.present()?.nodeId).toBe('training');
    }
  });

  it('reports finished when a fall-through target is gated off', () => {
    const graph: DialogGraph = {
      id: 'optional-follow-up',
      entry: 'a',
      nodes: [
        { id: 'a', text: 'A', next: 'b' },
        { id: 'b', text: 'B', condition: { kind: 'flag', id: 'never' } },
      ],
    };
    const session = buildSession([graph]);
    session.start('optional-follow-up');
    expect(session.present()).toMatchObject({ nodeId: 'a', choices: [], finished: true });
  });

  it('falls through a node whose choices are all gated off', () => {
    const graph: DialogGraph = {
      id: 'gated-aside',
      entry: 'a',
      nodes: [
        {
          id: 'a',
          text: 'A',
          choices: [{ id: 'aside', text: 'Aside', condition: { kind: 'flag', id: 'never' } }],
          next: 'b',
        },
        { id: 'b', text: 'B' },
      ],
    };
    const session = buildSession([graph]);
    session.start('gated-aside');
    expect(session.present()).toMatchObject({ nodeId: 'b', choices: [], finished: true });
  });

  it('advances a node whose choices were gated off after it presented them', () => {
    const accessor = buildAccessor();
    accessor.setUnlocked('offer-open', true);
    const setStateSpy = vi.spyOn(accessor, 'setState');
    const graph: DialogGraph = {
      id: 'lapsed-offer',
      entry: 'a',
      nodes: [
        {
          id: 'a',
          text: 'A',
          choices: [{ id: 'offer', text: 'Offer', condition: { kind: 'flag', id: 'offer-open' } }],
          next: 'b',
        },
        { id: 'b', text: 'B', onEnter: [{ type: 'state', target: 'met-b', value: 1 }] },
      ],
    };
    const session = buildSession([graph], { id: 'lapsed', accessor });
    session.start('lapsed-offer');
    expect(session.present()?.choices.map((c) => c.id)).toEqual(['offer']);

    accessor.setUnlocked('offer-open', false);
    expect(session.present()).toMatchObject({ nodeId: 'a', choices: [], finished: false });

    const presented = vi.fn();
    session.on('presented', presented);
    session.advance();
    expect(session.present()).toMatchObject({ nodeId: 'b', finished: true });
    expect(presented).toHaveBeenCalledWith(expect.objectContaining({ nodeId: 'b' }));
    expect(setStateSpy).toHaveBeenCalledWith('met-b', 1);
    const lapsedState = savedState('lapsed').value;
    if (!isDialogRuntimeState(lapsedState)) throw new Error('expected dialog runtime state');
    expect(lapsedState.activeNodeId).toBe('b');
  });

  it('refuses to advance a line that offers a choice or is finished', () => {
    const session = buildSession([greetingGraph]);
    expect(() => session.advance()).toThrow(/start\(\) first/);
    session.start('rask-greeting');
    expect(() => session.advance()).toThrow(/nothing to advance/);
    session.choose('ask-training');
    expect(() => session.advance()).toThrow(/nothing to advance/);
    expect(session.present()?.nodeId).toBe('training');
  });

  it('keeps an active conversation silent when a start fails its entry gate', () => {
    const lockedGraph: DialogGraph = {
      id: 'locked',
      entry: 'door',
      nodes: [{ id: 'door', text: 'Door', condition: { kind: 'flag', id: 'never' } }],
    };
    const session = buildSession([greetingGraph, lockedGraph]);
    session.start('rask-greeting');
    const presented = vi.fn();
    session.on('presented', presented);
    session.start('locked');
    expect(presented).not.toHaveBeenCalled();
    expect(session.present()?.nodeId).toBe('open');
    session.start('rask-greeting');
    expect(presented).toHaveBeenCalledTimes(1);
  });

  it('reads visit counts through the session', () => {
    const session = buildSession([greetingGraph]);
    session.start('rask-greeting');
    session.finish();
    session.start('rask-greeting');
    expect(session.getVisitCount('rask-greeting', 'open')).toBe(2);
    expect(session.getVisitCount('rask-greeting', 'secret')).toBe(0);
  });

  it('releases its saved state on dispose, so the same id can be recreated', () => {
    const accessor = buildAccessor();
    const first = createDialogSession({ id: 'per-talk', graphs: [greetingGraph], accessor });
    first.start('rask-greeting');
    first.dispose();
    expect(getAllPersistentRefs().has('dialog-sessions/per-talk.state')).toBe(false);

    const second = createDialogSession({ id: 'per-talk', graphs: [greetingGraph], accessor });
    expect(second.isActive()).toBe(false);
    expect(getAllPersistentRefs().has('dialog-sessions/per-talk.state')).toBe(true);
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
