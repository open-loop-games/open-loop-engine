import { describe, it, expect } from 'vitest';
import { bn, Decimal } from '@/primitives/decimal';
import type { IEffect, IEffectInternal, GameStateAccessor } from '@/primitives/types';
import {
  resolveEffect,
  applyEffect,
  assertEffectMethods,
  collectEffectMethods,
  E,
  type GameStateMutator,
} from '@/core/effects';
import { AccessorMethods, type GameStateAccessorMutator } from '@/core/game-state-accessor';

function mockAccessor(): GameStateAccessor {
  return {
    getAmount: (id) => (id === 'gold' ? bn(100) : bn(0)),
    getFlag: () => false,
    getStateAt: () => undefined,
    getRate: () => Decimal.dZero,
  };
}

describe('resolveEffect', () => {
  it('resolves resource add', () => {
    const r = resolveEffect(
      { kind: 'resource', target: 'gold', operation: 'add', value: 50 },
      mockAccessor(),
    );
    expect(r).toHaveLength(1);
    expect(r[0].target).toBe('gold');
    expect(new Decimal(r[0].value as number).eq(50)).toBe(true);
  });
  it('resolves composite into flat list', () => {
    const e: IEffect = {
      kind: 'composite',
      effects: [
        { kind: 'resource', target: 'gold', operation: 'add', value: 10 },
        { kind: 'flag', target: 'x', value: true },
      ],
    };
    expect(resolveEffect(e, mockAccessor())).toHaveLength(2);
  });
  it('conditional true branch', () => {
    const e: IEffectInternal = {
      kind: 'branch',
      condition: { kind: 'resource', target: 'gold', operator: 'gte', value: 50 },
      then: { kind: 'resource', target: 'gems', operation: 'add', value: 1 },
      else: { kind: 'resource', target: 'dust', operation: 'add', value: 1 },
    };
    expect(resolveEffect(e, mockAccessor())[0].target).toBe('gems');
  });
  it('conditional false branch', () => {
    const e: IEffectInternal = {
      kind: 'branch',
      condition: { kind: 'resource', target: 'gold', operator: 'gte', value: 999 },
      then: { kind: 'resource', target: 'gems', operation: 'add', value: 1 },
      else: { kind: 'resource', target: 'dust', operation: 'add', value: 1 },
    };
    expect(resolveEffect(e, mockAccessor())[0].target).toBe('dust');
  });
  it('conditional no else returns empty', () => {
    const e: IEffectInternal = {
      kind: 'branch',
      condition: { kind: 'resource', target: 'gold', operator: 'gte', value: 999 },
      then: { kind: 'resource', target: 'gems', operation: 'add', value: 1 },
    };
    expect(resolveEffect(e, mockAccessor())).toHaveLength(0);
  });

  it('evaluates formula values to concrete DecimalSource', () => {
    const formula = { evaluate: () => bn(42) };
    const r = resolveEffect(
      { kind: 'resource', target: 'gold', operation: 'add', value: formula },
      mockAccessor(),
    );
    expect(r).toHaveLength(1);
    expect(new Decimal(r[0].value as number).eq(42)).toBe(true);
  });

  it('passes through plain DecimalSource unchanged', () => {
    const r = resolveEffect(
      { kind: 'resource', target: 'gold', operation: 'add', value: 77 },
      mockAccessor(),
    );
    expect(new Decimal(r[0].value as number).eq(77)).toBe(true);
  });
});

// ============================================================================
// applyEffect
// ============================================================================

function mockMutator(): GameStateMutator & { calls: Array<{ method: string; args: unknown[] }> } {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  return {
    calls,
    applyResourceOp(id, op, value) {
      calls.push({ method: 'applyResourceOp', args: [id, op, value] });
    },
    setFlag(id, value) {
      calls.push({ method: 'setFlag', args: [id, value] });
    },
    setStateAt(path, value) {
      calls.push({ method: 'setStateAt', args: [path, value] });
    },
  };
}

describe('applyEffect', () => {
  it('calls applyResourceOp for resource effects', () => {
    const mutator = mockMutator();
    applyEffect(
      { kind: 'resource', target: 'gold', operation: 'add', value: 100 },
      mockAccessor(),
      mutator,
    );
    expect(mutator.calls).toHaveLength(1);
    expect(mutator.calls[0].method).toBe('applyResourceOp');
    expect(mutator.calls[0].args[0]).toBe('gold');
    expect(mutator.calls[0].args[1]).toBe('add');
    expect(new Decimal(mutator.calls[0].args[2] as number).eq(100)).toBe(true);
  });

  it('calls setFlag for unlock effects', () => {
    const mutator = mockMutator();
    applyEffect({ kind: 'flag', target: 'forest', value: true }, mockAccessor(), mutator);
    expect(mutator.calls).toHaveLength(1);
    expect(mutator.calls[0].method).toBe('setFlag');
    expect(mutator.calls[0].args).toEqual(['forest', true]);
  });

  it('calls setStateAt for state effects', () => {
    const mutator = mockMutator();
    applyEffect({ kind: 'state', path: 'quest:main', value: 'complete' }, mockAccessor(), mutator);
    expect(mutator.calls).toHaveLength(1);
    expect(mutator.calls[0].method).toBe('setStateAt');
    expect(mutator.calls[0].args).toEqual(['quest:main', 'complete']);
  });

  it('handles composite effects', () => {
    const mutator = mockMutator();
    applyEffect(
      {
        kind: 'composite',
        effects: [
          { kind: 'resource', target: 'gold', operation: 'add', value: 10 },
          { kind: 'flag', target: 'x', value: true },
          { kind: 'state', path: 'flag', value: 1 },
        ],
      },
      mockAccessor(),
      mutator,
    );
    expect(mutator.calls).toHaveLength(3);
    expect(mutator.calls[0].method).toBe('applyResourceOp');
    expect(mutator.calls[1].method).toBe('setFlag');
    expect(mutator.calls[2].method).toBe('setStateAt');
  });

  it('handles conditional effects', () => {
    const mutator = mockMutator();
    applyEffect(
      {
        kind: 'branch',
        condition: { kind: 'resource', target: 'gold', operator: 'gte', value: 50 },
        then: { kind: 'resource', target: 'gems', operation: 'add', value: 1 },
        else: { kind: 'resource', target: 'dust', operation: 'add', value: 1 },
      },
      mockAccessor(),
      mutator,
    );
    expect(mutator.calls).toHaveLength(1);
    expect(mutator.calls[0].args[0]).toBe('gems');
  });

  it('a composite step sees the state the steps before it wrote', () => {
    const gold = { amount: bn(0) };
    const unlocked = new Set<string>();
    const accessor: GameStateAccessor = {
      getAmount: (id) => (id === 'gold' ? gold.amount : bn(0)),
      getFlag: (id) => unlocked.has(id),
      getStateAt: () => undefined,
      getRate: () => Decimal.dZero,
    };
    const mutator: GameStateMutator = {
      applyResourceOp: (_id, _op, value) => {
        gold.amount = gold.amount.add(value);
      },
      setFlag: (id) => unlocked.add(id),
      setStateAt: () => {},
    };
    applyEffect(
      E.composite(
        E.resource('gold', 'add', 100),
        E.branch({ kind: 'resource-gte', resource: 'gold', value: 100 }, E.flag('rich')),
      ),
      accessor,
      mutator,
    );
    expect(unlocked.has('rich')).toBe(true);
  });

  it('evaluates formula values before applying', () => {
    const mutator = mockMutator();
    const formula = { evaluate: () => bn(99) };
    applyEffect(
      { kind: 'resource', target: 'gold', operation: 'add', value: formula },
      mockAccessor(),
      mutator,
    );
    expect(mutator.calls).toHaveLength(1);
    expect(new Decimal(mutator.calls[0].args[2] as number).eq(99)).toBe(true);
  });
});

describe('collectEffectMethods', () => {
  it('maps each leaf kind to the mutator method that applies it', () => {
    const { reads, writes } = collectEffectMethods([
      E.resource('gold', 'add', 1),
      E.composite(E.flag('door'), E.state('player.phase', 'late')),
    ]);
    expect(reads.size).toBe(0);
    expect([...writes].sort()).toEqual(['applyResourceOp', 'setFlag', 'setStateAt']);
  });

  it("adds a branch condition's reads and walks both arms", () => {
    const branch: IEffectInternal = {
      kind: 'branch',
      condition: {
        kind: 'all',
        conditions: [
          { kind: 'flag', target: 'met-rask' },
          {
            kind: 'not',
            condition: { kind: 'state', path: 'mood', operator: 'eq', value: 'angry' },
          },
        ],
      },
      then: E.resource('gold', 'add', 5),
      else: E.flag('snubbed'),
    };
    const { reads, writes } = collectEffectMethods([branch]);
    expect([...reads].sort()).toEqual(['getFlag', 'getStateAt']);
    expect([...writes].sort()).toEqual(['applyResourceOp', 'setFlag']);
  });
});

describe('assertEffectMethods', () => {
  const full: GameStateAccessorMutator = {
    ...mockAccessor(),
    applyResourceOp: () => {},
    setFlag: () => {},
    setStateAt: () => {},
  };

  it('checks reads against the accessor and writes against the mutator', () => {
    const readsOnly = { ...full, [AccessorMethods]: new Set(['getAmount', 'getFlag'] as const) };
    const effects: IEffectInternal[] = [
      { kind: 'branch', condition: { kind: 'flag', target: 'f' }, then: E.flag('g') },
    ];
    // Reads served by the accessor, writes by a separate full mutator: passes.
    expect(() => assertEffectMethods(effects, readsOnly, full, 'x')).not.toThrow();
    // The same partial object as the mutator: setFlag is missing.
    expect(() => assertEffectMethods(effects, readsOnly, readsOnly, 'x')).toThrow(/needs setFlag/);
  });
});
