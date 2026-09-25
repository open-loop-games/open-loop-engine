import { describe, it, expect } from 'vitest';
import { bn, Decimal } from '@/primitives/decimal';
import type { IEffect, IEffectInternal, GameStateAccessor } from '@/primitives/types';
import { resolveEffect, applyEffect, E, type GameStateMutator } from '@/core/effects';

function mockAccessor(): GameStateAccessor {
  return {
    getResource: (id) => (id === 'gold' ? bn(100) : bn(0)),
    isUnlocked: () => false,
    getState: () => undefined,
    getRate: () => Decimal.dZero,
  };
}

describe('resolveEffect', () => {
  it('resolves resource add', () => {
    const r = resolveEffect(
      { type: 'resource', target: 'gold', operation: 'add', value: 50 },
      mockAccessor(),
    );
    expect(r).toHaveLength(1);
    expect(r[0].target).toBe('gold');
    expect(new Decimal(r[0].value as number).eq(50)).toBe(true);
  });
  it('resolves composite into flat list', () => {
    const e: IEffect = {
      type: 'composite',
      effects: [
        { type: 'resource', target: 'gold', operation: 'add', value: 10 },
        { type: 'unlock', target: 'x', value: true },
      ],
    };
    expect(resolveEffect(e, mockAccessor())).toHaveLength(2);
  });
  it('conditional true branch', () => {
    const e: IEffectInternal = {
      type: 'conditional',
      condition: { type: 'resource', target: 'gold', operator: 'gte', value: 50 },
      then: { type: 'resource', target: 'gems', operation: 'add', value: 1 },
      else: { type: 'resource', target: 'dust', operation: 'add', value: 1 },
    };
    expect(resolveEffect(e, mockAccessor())[0].target).toBe('gems');
  });
  it('conditional false branch', () => {
    const e: IEffectInternal = {
      type: 'conditional',
      condition: { type: 'resource', target: 'gold', operator: 'gte', value: 999 },
      then: { type: 'resource', target: 'gems', operation: 'add', value: 1 },
      else: { type: 'resource', target: 'dust', operation: 'add', value: 1 },
    };
    expect(resolveEffect(e, mockAccessor())[0].target).toBe('dust');
  });
  it('conditional no else returns empty', () => {
    const e: IEffectInternal = {
      type: 'conditional',
      condition: { type: 'resource', target: 'gold', operator: 'gte', value: 999 },
      then: { type: 'resource', target: 'gems', operation: 'add', value: 1 },
    };
    expect(resolveEffect(e, mockAccessor())).toHaveLength(0);
  });

  it('evaluates formula values to concrete DecimalSource', () => {
    const formula = { evaluate: () => bn(42) };
    const r = resolveEffect(
      { type: 'resource', target: 'gold', operation: 'add', value: formula },
      mockAccessor(),
    );
    expect(r).toHaveLength(1);
    expect(new Decimal(r[0].value as number).eq(42)).toBe(true);
  });

  it('passes through plain DecimalSource unchanged', () => {
    const r = resolveEffect(
      { type: 'resource', target: 'gold', operation: 'add', value: 77 },
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
    setUnlocked(id, value) {
      calls.push({ method: 'setUnlocked', args: [id, value] });
    },
    setState(path, value) {
      calls.push({ method: 'setState', args: [path, value] });
    },
  };
}

describe('applyEffect', () => {
  it('calls applyResourceOp for resource effects', () => {
    const mutator = mockMutator();
    applyEffect(
      { type: 'resource', target: 'gold', operation: 'add', value: 100 },
      mockAccessor(),
      mutator,
    );
    expect(mutator.calls).toHaveLength(1);
    expect(mutator.calls[0].method).toBe('applyResourceOp');
    expect(mutator.calls[0].args[0]).toBe('gold');
    expect(mutator.calls[0].args[1]).toBe('add');
    expect(new Decimal(mutator.calls[0].args[2] as number).eq(100)).toBe(true);
  });

  it('calls setUnlocked for unlock effects', () => {
    const mutator = mockMutator();
    applyEffect({ type: 'unlock', target: 'forest', value: true }, mockAccessor(), mutator);
    expect(mutator.calls).toHaveLength(1);
    expect(mutator.calls[0].method).toBe('setUnlocked');
    expect(mutator.calls[0].args).toEqual(['forest', true]);
  });

  it('calls setState for state effects', () => {
    const mutator = mockMutator();
    applyEffect(
      { type: 'state', target: 'quest:main', value: 'complete' },
      mockAccessor(),
      mutator,
    );
    expect(mutator.calls).toHaveLength(1);
    expect(mutator.calls[0].method).toBe('setState');
    expect(mutator.calls[0].args).toEqual(['quest:main', 'complete']);
  });

  it('handles composite effects', () => {
    const mutator = mockMutator();
    applyEffect(
      {
        type: 'composite',
        effects: [
          { type: 'resource', target: 'gold', operation: 'add', value: 10 },
          { type: 'unlock', target: 'x', value: true },
          { type: 'state', target: 'flag', value: 1 },
        ],
      },
      mockAccessor(),
      mutator,
    );
    expect(mutator.calls).toHaveLength(3);
    expect(mutator.calls[0].method).toBe('applyResourceOp');
    expect(mutator.calls[1].method).toBe('setUnlocked');
    expect(mutator.calls[2].method).toBe('setState');
  });

  it('handles conditional effects', () => {
    const mutator = mockMutator();
    applyEffect(
      {
        type: 'conditional',
        condition: { type: 'resource', target: 'gold', operator: 'gte', value: 50 },
        then: { type: 'resource', target: 'gems', operation: 'add', value: 1 },
        else: { type: 'resource', target: 'dust', operation: 'add', value: 1 },
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
      getResource: (id) => (id === 'gold' ? gold.amount : bn(0)),
      isUnlocked: (id) => unlocked.has(id),
      getState: () => undefined,
      getRate: () => Decimal.dZero,
    };
    const mutator: GameStateMutator = {
      applyResourceOp: (_id, _op, value) => {
        gold.amount = gold.amount.add(value);
      },
      setUnlocked: (id) => unlocked.add(id),
      setState: () => {},
    };
    applyEffect(
      E.composite(
        E.resource('gold', 'add', 100),
        E.conditional({ kind: 'resource-gte', resource: 'gold', value: 100 }, E.unlock('rich')),
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
      { type: 'resource', target: 'gold', operation: 'add', value: formula },
      mockAccessor(),
      mutator,
    );
    expect(mutator.calls).toHaveLength(1);
    expect(new Decimal(mutator.calls[0].args[2] as number).eq(99)).toBe(true);
  });
});
