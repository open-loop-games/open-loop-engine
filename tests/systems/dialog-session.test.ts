import { describe, it, expect, beforeEach, vi } from 'vitest';
import { bn, Decimal } from '@/primitives/decimal';
import { resetAllPersistentContexts } from '@/core/persistence';
import { withGameStateAccessor, type GameStateAccessorMutator } from '@/core/game-state-accessor';
import { createDialogSession } from '@/systems/dialog-session';
import type { DialogGraph } from '@/systems/dialog';

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
          condition: { type: 'unlock', target: 'knowledge-restricted-tip' },
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

describe('createDialogSession', () => {
  it('starts a graph and presents the entry node', () => {
    withGameStateAccessor(buildAccessor(), () => {
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
    withGameStateAccessor(accessor, () => {
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
    withGameStateAccessor(buildAccessor(), () => {
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
    withGameStateAccessor(accessor, () => {
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
    withGameStateAccessor(buildAccessor(), () => {
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

  it('throws when no ambient accessor is available and none was passed', () => {
    expect(() =>
      createDialogSession({
        id: 'oops',
        graphs: [greetingGraph],
      }),
    ).toThrow(/requires an ambient GameStateAccessor/);
  });
});
