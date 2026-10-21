import { describe, it, expect, beforeEach } from 'vitest';
import { Decimal } from '@/primitives/decimal';
import { createResource } from '@/core/resource';
import { createResourceRegistry, withResourceRegistry } from '@/core/registries';
import { resetAllPersistentContexts, withPersistentContext } from '@/core/persistence';
import {
  AccessorMethods,
  createGameStateAccessor,
  implementsAccessorMethod,
  assertAccessorMethods,
  type GameStateAccessorMutator,
} from '@/core/game-state-accessor';

beforeEach(() => {
  resetAllPersistentContexts();
});

function registryWith(amounts: Record<string, number>) {
  const resourceRegistry = createResourceRegistry();
  const resources = withResourceRegistry(resourceRegistry, () =>
    withPersistentContext('accessor-test', () =>
      Object.fromEntries(
        Object.entries(amounts).map(([id, amount]) => [id, createResource(amount, { id })]),
      ),
    ),
  );
  return { services: { resourceRegistry }, resources };
}

describe('createGameStateAccessor — amounts', () => {
  it('getAmount reads the registered resource', () => {
    const { services, resources } = registryWith({ gold: 5 });
    const accessor = createGameStateAccessor(services);
    expect(Decimal.eq(accessor.getAmount('gold'), 5)).toBe(true);
    resources.gold!.value = 12;
    expect(Decimal.eq(accessor.getAmount('gold'), 12)).toBe(true);
  });

  it('an id the registry lacks throws, naming it', () => {
    const { services } = registryWith({});
    const accessor = createGameStateAccessor(services);
    expect(() => accessor.getAmount('mana')).toThrow(/no resource 'mana'/);
    expect(() => accessor.applyResourceOp('mana', 'add', 1)).toThrow(/no resource 'mana'/);
  });

  it('reads a resource registered after it was built', () => {
    const { services } = registryWith({});
    const accessor = createGameStateAccessor(services);
    withResourceRegistry(services.resourceRegistry, () => createResource(3, { id: 'late' }));
    expect(Decimal.eq(accessor.getAmount('late'), 3)).toBe(true);
  });
});

describe('createGameStateAccessor — resource writes', () => {
  it('applies add, subtract, multiply and set', () => {
    const { services, resources } = registryWith({ gold: 10 });
    const accessor = createGameStateAccessor(services);
    accessor.applyResourceOp('gold', 'add', 5);
    expect(Decimal.eq(resources.gold!.value, 15)).toBe(true);
    accessor.applyResourceOp('gold', 'subtract', 3);
    expect(Decimal.eq(resources.gold!.value, 12)).toBe(true);
    accessor.applyResourceOp('gold', 'multiply', 2);
    expect(Decimal.eq(resources.gold!.value, 24)).toBe(true);
    accessor.applyResourceOp('gold', 'set', 7);
    expect(Decimal.eq(resources.gold!.value, 7)).toBe(true);
  });

  it('a set or multiply that raises the amount counts toward the lifetime total', () => {
    const { services, resources } = registryWith({ gold: 10 });
    const accessor = createGameStateAccessor(services);
    const before = new Decimal(resources.gold!.cumulative!.value);
    accessor.applyResourceOp('gold', 'set', 15);
    accessor.applyResourceOp('gold', 'multiply', 2);
    expect(Decimal.eq(Decimal.sub(resources.gold!.cumulative!.value, before), 20)).toBe(true);
  });

  it('a subtract below zero throws and writes nothing', () => {
    const { services, resources } = registryWith({ gold: 2 });
    const accessor = createGameStateAccessor(services);
    expect(() => accessor.applyResourceOp('gold', 'subtract', 5)).toThrow(/below zero/);
    expect(Decimal.eq(resources.gold!.value, 2)).toBe(true);
  });

  it('allowNegative lets a subtract go below zero', () => {
    const { services, resources } = registryWith({ gold: 2 });
    const accessor = createGameStateAccessor(services, { allowNegative: true });
    accessor.applyResourceOp('gold', 'subtract', 5);
    expect(Decimal.eq(resources.gold!.value, -3)).toBe(true);
  });
});

describe('createGameStateAccessor — supplied and omitted methods', () => {
  it('forwards a supplied method', () => {
    const { services } = registryWith({});
    const flags: Record<string, boolean> = {};
    const accessor = createGameStateAccessor(services, {
      getFlag: (id) => flags[id] ?? false,
      setFlag: (id, value) => {
        flags[id] = value;
      },
    });
    accessor.setFlag('gate-open', true);
    expect(accessor.getFlag('gate-open')).toBe(true);
  });

  it('an omitted method throws, naming the kind that called it', () => {
    const { services } = registryWith({});
    const accessor = createGameStateAccessor(services);
    expect(() => accessor.getFlag('x')).toThrow(/'flag' Gate or condition called getFlag/);
    expect(() => accessor.setStateAt('a.b', 1)).toThrow(/'state' effect called setStateAt/);
    expect(() => accessor.getRate('gold')).toThrow(/timeUntilGateFlip/);
  });

  it('the record lists the registry methods plus exactly the supplied ones', () => {
    const { services } = registryWith({});
    const accessor = createGameStateAccessor(services, {
      getFlag: () => false,
      getRate: () => Decimal.dZero,
    });
    expect([...accessor[AccessorMethods]!].sort()).toEqual(
      ['applyResourceOp', 'getAmount', 'getFlag', 'getRate'].sort(),
    );
  });

  it('leaves getInflowRate absent unless supplied', () => {
    const { services } = registryWith({});
    expect(createGameStateAccessor(services).getInflowRate).toBeUndefined();
    const withInflow = createGameStateAccessor(services, { getInflowRate: () => Decimal.dOne });
    expect(withInflow.getInflowRate).toBeDefined();
    expect(withInflow[AccessorMethods]!.has('getInflowRate')).toBe(true);
  });
});

describe('AccessorMethods record', () => {
  const handRolled: GameStateAccessorMutator = {
    getAmount: () => Decimal.dZero,
    getRate: () => Decimal.dZero,
    getFlag: () => false,
    getStateAt: () => undefined,
    applyResourceOp: () => {},
    setFlag: () => {},
    setStateAt: () => {},
  };

  it('an accessor without a record implements every method', () => {
    expect(implementsAccessorMethod(handRolled, 'setStateAt')).toBe(true);
    expect(() => assertAccessorMethods(handRolled, ['getFlag', 'setFlag'], 'x')).not.toThrow();
  });

  it('a hand-rolled partial accessor declares what it implements', () => {
    const partial: GameStateAccessorMutator = {
      ...handRolled,
      [AccessorMethods]: new Set(['getAmount', 'getRate']),
    };
    expect(implementsAccessorMethod(partial, 'getRate')).toBe(true);
    expect(() =>
      assertAccessorMethods(partial, ['getAmount', 'setFlag'], "challenge 'c1'"),
    ).toThrow(/challenge 'c1': needs setFlag, which the accessor does not implement/);
  });
});
