import { describe, it, expect, beforeEach } from 'vitest';
import { toRef } from 'vue';
import {
  Decimal,
  FlagRegistryKey,
  GameStateAccessorKey,
  ResourceRegistryKey,
  createEngine,
  createFlag,
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
    expect(calls[0]!.flagRegistry).toBe(engine.tryInject(FlagRegistryKey));
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

  it("a flag Gate over a built accessor reads the engine's flag registry", () => {
    const engine = engineWith('accessor-flag', (services) => createGameStateAccessor(services));
    let met: { value: unknown } | undefined;
    let unknown: { value: unknown } | undefined;
    engine.use(
      goldModule(0, () => {
        const flag = createFlag({ id: 'met-rask' });
        met = toRef(createGateRequirement({ gate: { kind: 'flag', id: 'met-rask' } }).met);
        unknown = toRef(createGateRequirement({ gate: { kind: 'flag', id: 'met-nobody' } }).met);
        flag.value = true;
      }),
    );
    engine.start();
    expect(met!.value).toBe(true);
    // An unknown flag id throws at evaluation, as an unknown resource id does.
    expect(() => unknown!.value).toThrow(/no flag 'met-nobody'/);
    engine.stop();
  });

  it('a plain accessor object is published under GameStateAccessorKey too', () => {
    const accessor = createGameStateAccessor({ resourceRegistry: createResourceRegistry() });
    const engine = engineWith('accessor-plain', accessor);
    engine.start();
    expect(engine.tryInject(GameStateAccessorKey)).toBe(accessor);
    engine.stop();
  });
});

describe('the flag registry', () => {
  it("flags a module creates register into that engine's flag registry", () => {
    const engine = engineWith('flag-registry', undefined);
    engine.use({
      id: 'story',
      install() {
        createFlag({ id: 'seen-shop' });
      },
    });
    engine.start();
    const flags = engine.tryInject(FlagRegistryKey)!;
    expect(flags.all().map((f) => f.id)).toEqual(['seen-shop']);
    engine.stop();
  });
});
