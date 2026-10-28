import { describe, it, expect, beforeEach } from 'vitest';
import { toRef } from 'vue';
import {
  AccessorMethods,
  Decimal,
  FlagRegistryKey,
  GameStateAccessorKey,
  createEngine,
  createFlag,
  createGateRequirement,
  createProducerCategory,
  createResource,
  type EngineModule,
  type EngineOptions,
  type GameStateAccessorMutator,
} from '@/index';
import { getCurrentGameStateAccessor } from '@/core/game-state-accessor';
import { resetAllPersistentContexts } from '@/core/persistence';

beforeEach(() => {
  resetAllPersistentContexts();
});

let ns = 0;
function engineWith(gameId: string, accessor?: EngineOptions['accessor']) {
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
    install(ctx) {
      const gold = createResource(amount, { id: 'gold' });
      createProducerCategory<{ id: string }>({
        id: 'mines',
        mapProducer: () => ({ resource: gold, baseRate: 2, trigger: 'continuous' }),
        registerTick: ctx.onTick,
      }).register({ id: 'mine' });
      install?.();
    },
  };
}

describe('the engine-built accessor', () => {
  it('without an accessor option, serves amounts, rates and flags from the registries', () => {
    let ambient: GameStateAccessorMutator | undefined;
    const engine = engineWith('accessor-default');
    engine.use(
      goldModule(5, () => {
        createFlag({ id: 'seen-shop' }).value = true;
        ambient = getCurrentGameStateAccessor();
      }),
    );
    engine.start();
    const accessor = engine.tryInject(GameStateAccessorKey)!;
    expect(ambient).toBe(accessor);
    expect(Decimal.eq(accessor.getAmount('gold'), 5)).toBe(true);
    expect(Decimal.eq(accessor.getRate('gold'), 2)).toBe(true);
    expect(Decimal.eq(accessor.getInflowRate!('gold'), 2)).toBe(true);
    expect(accessor.getFlag('seen-shop')).toBe(true);
    expect(accessor[AccessorMethods]!.has('getStateAt')).toBe(false);
    engine.stop();
  });

  it("two engines' accessors never see each other's resources", () => {
    const build = (amount: number) => {
      const engine = engineWith('accessor-isolation');
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

  it("a flag Gate reads the engine's flag registry", () => {
    const engine = engineWith('accessor-flag');
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

  it('a state Gate without getStateAt fails at construction, naming it', () => {
    const engine = engineWith('accessor-state-missing');
    engine.use(
      goldModule(0, () => {
        createGateRequirement({
          gate: { kind: 'state', path: 'phase', operator: 'eq', value: 'late' },
        });
      }),
    );
    expect(() => engine.start()).toThrow(/reads the accessor's getStateAt/);
  });
});

describe('EngineOptions.accessor — options and wrap', () => {
  it('the options build the default: state paths and allowNegative', () => {
    const state: Record<string, unknown> = { phase: 'late' };
    let late: { value: unknown } | undefined;
    const engine = engineWith('accessor-options', {
      getStateAt: (path) => state[path],
      setStateAt: (path, value) => {
        state[path] = value;
      },
      allowNegative: true,
    });
    engine.use(
      goldModule(1, () => {
        late = toRef(
          createGateRequirement({
            gate: { kind: 'state', path: 'phase', operator: 'eq', value: 'late' },
          }).met,
        );
      }),
    );
    engine.start();
    const accessor = engine.tryInject(GameStateAccessorKey)!;
    expect(late!.value).toBe(true);
    accessor.applyResourceOp('gold', 'subtract', 3);
    expect(Decimal.eq(accessor.getAmount('gold'), -2)).toBe(true);
    engine.stop();
  });

  it('wrap decorates the built default, and its result is the engine accessor', () => {
    const seen: string[] = [];
    let built: GameStateAccessorMutator | undefined;
    const engine = engineWith('accessor-wrap', {
      getStateAt: () => 'late',
      wrap: (default_) => {
        built = default_;
        return {
          ...default_,
          applyResourceOp(id, op, value) {
            seen.push(`${op} ${id}`);
            default_.applyResourceOp(id, op, value);
          },
        };
      },
    });
    engine.use(goldModule(1));
    engine.start();
    const accessor = engine.tryInject(GameStateAccessorKey)!;
    expect(accessor).not.toBe(built);
    // The spread keeps the built record, so the state path still counts as implemented.
    expect(accessor[AccessorMethods]!.has('getStateAt')).toBe(true);
    accessor.applyResourceOp('gold', 'add', 4);
    expect(seen).toEqual(['add gold']);
    expect(Decimal.eq(accessor.getAmount('gold'), 5)).toBe(true);
    engine.stop();
  });
});

describe('EngineOptions.accessor — the 0.9 forms', () => {
  it('a factory or a built accessor throws at createEngine, naming the new shape', () => {
    const factory = (() => ({})) as unknown as EngineOptions['accessor'];
    expect(() => engineWith('accessor-old-factory', factory)).toThrow(
      /accessor takes options plus wrap.*wrap: \(built\) =>/,
    );
    const object = {
      getAmount: () => 0,
      getFlag: () => false,
    } as unknown as EngineOptions['accessor'];
    expect(() => engineWith('accessor-old-object', object)).toThrow(/getAmount, getFlag/);
  });
});

describe('the flag registry', () => {
  it("flags a module creates register into that engine's flag registry", () => {
    const engine = engineWith('flag-registry');
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
