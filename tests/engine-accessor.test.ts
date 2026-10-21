import { describe, it, expect, beforeEach } from 'vitest';
import {
  Decimal,
  GameStateAccessorKey,
  ResourceRegistryKey,
  createEngine,
  createGameStateAccessor,
  createGateRequirement,
  createResource,
  type AccessorServices,
  type EngineModule,
  type EngineOptions,
  type GameStateAccessorMutator,
} from '@/index';
import { getCurrentGameStateAccessor } from '@/core/game-state-accessor';
import { resetAllPersistentContexts } from '@/core/persistence';
import { createResourceRegistry } from '@/core/registries';

beforeEach(() => {
  resetAllPersistentContexts();
});

let ns = 0;
function engineWith(gameId: string, accessor: EngineOptions['accessor']) {
  return createEngine({
    gameId,
    persistence: false,
    persistenceNamespace: `accessor-${ns++}`,
    accessor,
  });
}

function goldModule(amount: number, install?: () => void): EngineModule {
  return {
    id: 'gold-mod',
    install() {
      createResource(amount, { id: 'gold' });
      install?.();
    },
  };
}

describe('EngineOptions.accessor — the factory form', () => {
  it("is called once, before install, with the engine's resource registry", () => {
    const calls: AccessorServices[] = [];
    let ambient: GameStateAccessorMutator | undefined;
    let built: GameStateAccessorMutator | undefined;
    const engine = engineWith('accessor-factory', (services) => {
      calls.push(services);
      return (built = createGameStateAccessor(services));
    });
    engine.use(
      goldModule(5, () => {
        ambient = getCurrentGameStateAccessor();
      }),
    );
    engine.start();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.resourceRegistry).toBe(engine.tryInject(ResourceRegistryKey));
    expect(ambient).toBe(built);
    expect(engine.tryInject(GameStateAccessorKey)).toBe(built);
    expect(Decimal.eq(built!.getAmount('gold'), 5)).toBe(true);
    engine.stop();
  });

  it("two engines' built accessors never see each other's resources", () => {
    const build = (amount: number) => {
      const engine = engineWith('accessor-isolation', (services) =>
        createGameStateAccessor(services),
      );
      engine.use(goldModule(amount));
      engine.start();
      return engine;
    };
    const a = build(3);
    const b = build(7);
    expect(Decimal.eq(a.tryInject(GameStateAccessorKey)!.getAmount('gold'), 3)).toBe(true);
    expect(Decimal.eq(b.tryInject(GameStateAccessorKey)!.getAmount('gold'), 7)).toBe(true);
    a.stop();
    b.stop();
  });

  it('a flag Gate over a built accessor without getFlag fails at construction', () => {
    const engine = engineWith('accessor-flag', (services) => createGameStateAccessor(services));
    engine.use(
      goldModule(0, () => {
        createGateRequirement({ gate: { kind: 'flag', id: 'met-rask' } });
      }),
    );
    expect(() => engine.start()).toThrow(
      /createGateRequirement: this Gate reads the accessor's getFlag,/,
    );
  });

  it('a plain accessor object is published under GameStateAccessorKey too', () => {
    const accessor = createGameStateAccessor({ resourceRegistry: createResourceRegistry() });
    const engine = engineWith('accessor-plain', accessor);
    engine.start();
    expect(engine.tryInject(GameStateAccessorKey)).toBe(accessor);
    engine.stop();
  });
});
