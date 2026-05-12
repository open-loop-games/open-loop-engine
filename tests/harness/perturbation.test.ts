import { describe, it, expect } from 'vitest';
import {
  CategoriesKey,
  createEngine,
  createModifierChain,
  createMultiplicativeModifier,
  createProducerCategory,
  createTemporaryEffectSystem,
  createTuningRegistry,
  Decimal,
  TuningRegistriesKey,
  tunable,
  type EngineCategories,
  type EngineModule,
} from '@/index';
import { walkChainRegistry, walkContent, walkTunables } from '@/harness/picker';
import { applyPerturbation } from '@/harness/perturbation';

function num(v: unknown): number {
  return Decimal.fromValue(v as Decimal).toNumber();
}

describe('applyPerturbation — chain-registry source', () => {
  it('scalar-multiply wraps the targeted modifier and cleanup restores it', () => {
    const mod: EngineModule = {
      id: 'economy',
      install() {
        const speed = createModifierChain('speed');
        speed.add(createMultiplicativeModifier({ multiplier: 2 }));
      },
    };
    const engine = createEngine({
      gameId: 'pert-cr-1',
      persistence: false,
      persistenceNamespace: `pert-cr-1-${Math.random().toString(36).slice(2)}`,
    });
    engine.use(mod);
    engine.start();

    const entry = walkChainRegistry(engine).find((e) => e.label === 'speed[0]')!;
    expect(entry).toBeDefined();

    // Baseline: chain applies ×2 → 10 * 2 = 20.
    const chain = entry.chain;
    expect(num(chain.apply(10))).toBe(20);

    const cleanup = applyPerturbation(engine, entry, { kind: 'scalar-multiply', factor: 3 });
    // Wrapped modifier: original (×2) composed with ×3 on top → 10 * 2 * 3 = 60.
    expect(num(chain.apply(10))).toBe(60);
    // Chain still has exactly one modifier (the wrapped one).
    expect(chain.modifiers).toHaveLength(1);

    cleanup();
    expect(num(chain.apply(10))).toBe(20);
    expect(chain.modifiers).toHaveLength(1);

    // Idempotent: second call is a no-op.
    cleanup();
    expect(num(chain.apply(10))).toBe(20);
    expect(chain.modifiers).toHaveLength(1);

    engine.stop();
  });

  it('scalar-add on a chain-registry entry layers additive on top', () => {
    const mod: EngineModule = {
      id: 'economy',
      install() {
        const bonus = createModifierChain('bonus');
        bonus.add(createMultiplicativeModifier({ multiplier: 2 }));
      },
    };
    const engine = createEngine({
      gameId: 'pert-cr-2',
      persistence: false,
      persistenceNamespace: `pert-cr-2-${Math.random().toString(36).slice(2)}`,
    });
    engine.use(mod);
    engine.start();

    const entry = walkChainRegistry(engine).find((e) => e.label === 'bonus[0]')!;
    const chain = entry.chain;
    expect(num(chain.apply(10))).toBe(20);

    const cleanup = applyPerturbation(engine, entry, { kind: 'scalar-add', delta: 5 });
    // original.apply(10) = 20; wrapped = 20 + 5 = 25.
    expect(num(chain.apply(10))).toBe(25);

    cleanup();
    expect(num(chain.apply(10))).toBe(20);

    engine.stop();
  });

  it('chain-apply variant wraps an initially-empty chain and cleanup removes the wrapper', () => {
    const mod: EngineModule = {
      id: 'economy',
      install() {
        // Chain registered empty — no contributors yet. The common case for
        // consumers that register 16 attack/defense chains up front and
        // populate them via purchases/binds.
        createModifierChain('attack');
      },
    };
    const engine = createEngine({
      gameId: 'pert-cr-3',
      persistence: false,
      persistenceNamespace: `pert-cr-3-${Math.random().toString(36).slice(2)}`,
    });
    engine.use(mod);
    engine.start();

    const entry = walkChainRegistry(engine).find((e) => e.label === 'attack[*]')!;
    expect(entry).toBeDefined();
    expect(entry.chain.modifiers).toHaveLength(0);

    // Empty chain is an identity: apply(10) = 10.
    expect(num(entry.chain.apply(10))).toBe(10);

    const cleanup = applyPerturbation(engine, entry, { kind: 'scalar-multiply', factor: 3 });
    expect(num(entry.chain.apply(10))).toBe(30);
    expect(entry.chain.modifiers).toHaveLength(1);

    cleanup();
    expect(num(entry.chain.apply(10))).toBe(10);
    expect(entry.chain.modifiers).toHaveLength(0);

    // Idempotent.
    cleanup();
    expect(entry.chain.modifiers).toHaveLength(0);

    engine.stop();
  });

  it('chain-apply variant layers additive on top of a populated chain', () => {
    const mod: EngineModule = {
      id: 'economy',
      install() {
        const yield_ = createModifierChain('yield');
        yield_.add(createMultiplicativeModifier({ multiplier: 2 }));
      },
    };
    const engine = createEngine({
      gameId: 'pert-cr-4',
      persistence: false,
      persistenceNamespace: `pert-cr-4-${Math.random().toString(36).slice(2)}`,
    });
    engine.use(mod);
    engine.start();

    const entry = walkChainRegistry(engine).find((e) => e.label === 'yield[*]')!;
    expect(entry).toBeDefined();
    expect(num(entry.chain.apply(10))).toBe(20);

    const cleanup = applyPerturbation(engine, entry, { kind: 'scalar-add', delta: 7 });
    // Chain runs sequentially: (10 * 2) + 7 = 27.
    expect(num(entry.chain.apply(10))).toBe(27);
    expect(entry.chain.modifiers).toHaveLength(2);

    cleanup();
    expect(num(entry.chain.apply(10))).toBe(20);
    expect(entry.chain.modifiers).toHaveLength(1);

    engine.stop();
  });

  it('producer rate-chain entries resolve via auto-registered chain id', () => {
    // Producer rate chains auto-register under `${categoryId}/${def.id}/rate`,
    // so they reach the picker through walkChainRegistry — no category-specific
    // walker required.
    interface ProducerDef {
      id: string;
      name: string;
      baseRate: number;
    }
    const mod: EngineModule = {
      id: 'producers-mod',
      install(ctx) {
        const producers = createProducerCategory<ProducerDef>({
          id: 'producers',
          mapProducer: (def) => ({ baseRate: def.baseRate }),
          registerTick: () => () => {},
        });
        producers.register([{ id: 'cursor', name: 'Cursor', baseRate: 1 }]);
        producers
          .getProducer('cursor')!
          .rateChain.add(createMultiplicativeModifier({ multiplier: 2 }));
        ctx.provide(CategoriesKey, { producers: [producers] } as EngineCategories);
      },
    };
    const engine = createEngine({
      gameId: 'pert-prod-1',
      persistence: false,
      persistenceNamespace: `pert-prod-1-${Math.random().toString(36).slice(2)}`,
    });
    engine.use(mod);
    engine.start();

    const entry = walkChainRegistry(engine).find((e) => e.label === 'producers/cursor/rate[0]')!;
    expect(entry).toBeDefined();

    const chain = entry.chain;
    expect(num(chain.apply(5))).toBe(10);

    const cleanup = applyPerturbation(engine, entry, { kind: 'scalar-multiply', factor: 3 });
    expect(num(chain.apply(5))).toBe(30);

    cleanup();
    expect(num(chain.apply(5))).toBe(10);
    engine.stop();
  });
});

describe('applyPerturbation — content source', () => {
  it('resolves the live modifier through the effect-system registry', () => {
    let speedChain: ReturnType<typeof createModifierChain>;
    const mod: EngineModule = {
      id: 'fx',
      install(ctx) {
        speedChain = createModifierChain('speed');
        const temp = createTemporaryEffectSystem({
          id: 'buffs',
          registerTick: (cb) => ctx.onTick(cb),
        });
        temp.register({
          id: 'haste',
          duration: 5,
          modifiers: [
            // Non-factory binding so the walker + applier resolve the same
            // instance.
            { chain: speedChain, modifier: createMultiplicativeModifier({ multiplier: 2 }) },
          ],
        });
        // Apply the effect so the binding's modifier lands in the chain.
        temp.apply('haste');
      },
    };
    const engine = createEngine({
      gameId: 'pert-content-1',
      persistence: false,
      persistenceNamespace: `pert-content-1-${Math.random().toString(36).slice(2)}`,
    });
    engine.use(mod);
    engine.start();

    const entry = walkContent(engine).find((e) => e.label === 'buffs.haste[0]')!;
    expect(entry).toBeDefined();
    expect(entry.indexInChain).toBeGreaterThanOrEqual(0);
    expect(num(speedChain!.apply(10))).toBe(20);

    const cleanup = applyPerturbation(engine, entry, { kind: 'scalar-multiply', factor: 4 });
    expect(num(speedChain!.apply(10))).toBe(80);

    cleanup();
    expect(num(speedChain!.apply(10))).toBe(20);
    engine.stop();
  });

  it('throws on factory bindings that cannot resolve a live modifier', () => {
    const mod: EngineModule = {
      id: 'fx',
      install(ctx) {
        const chain = createModifierChain('maxHealth');
        const temp = createTemporaryEffectSystem({
          id: 'buffs',
          registerTick: (cb) => ctx.onTick(cb),
        });
        temp.register({
          id: 'shield',
          duration: 5,
          modifiers: [{ chain, modifier: () => createMultiplicativeModifier({ multiplier: 3 }) }],
        });
      },
    };
    const engine = createEngine({
      gameId: 'pert-content-2',
      persistence: false,
      persistenceNamespace: `pert-content-2-${Math.random().toString(36).slice(2)}`,
    });
    engine.use(mod);
    engine.start();

    const entry = walkContent(engine).find((e) => e.label === 'buffs.shield[0]')!;
    expect(entry).toBeDefined();
    // Walker couldn't locate the factory-produced instance in the chain.
    expect(entry.indexInChain).toBe(-1);

    expect(() => applyPerturbation(engine, entry, { kind: 'scalar-multiply', factor: 2 })).toThrow(
      /factory modifier/,
    );

    engine.stop();
  });
});

describe('applyPerturbation — tunable source', () => {
  it('scalar-multiply wraps the tunable value via scope push; cleanup restores baseline', () => {
    const mod: EngineModule = {
      id: 'tuning-host',
      install() {
        const reg = createTuningRegistry('producer-tuning');
        tunable(reg, 'upgrades/foo/cost', () => 100);
      },
    };
    const engine = createEngine({
      gameId: 'pert-tun-1',
      persistence: false,
      persistenceNamespace: `pert-tun-1-${Math.random().toString(36).slice(2)}`,
    });
    engine.use(mod);
    engine.start();

    const reg = [...engine.tryInject(TuningRegistriesKey)!].find(
      (r) => r.name === 'producer-tuning',
    )!;
    const read = () => reg.get('upgrades/foo/cost')();

    const entry = walkTunables(engine).find((e) => e.key === 'upgrades/foo/cost')!;
    expect(entry).toBeDefined();

    expect(num(read())).toBe(100);

    const cleanup = applyPerturbation(engine, entry, { kind: 'scalar-multiply', factor: 3 });
    expect(num(read())).toBe(300);

    cleanup();
    expect(num(read())).toBe(100);

    // Idempotent.
    cleanup();
    expect(num(read())).toBe(100);

    engine.stop();
  });

  it('scalar-add layers additive on top of tunable baseline', () => {
    const mod: EngineModule = {
      id: 'tuning-host',
      install() {
        const reg = createTuningRegistry('balance-tuning');
        tunable(reg, 'threshold', () => 50);
      },
    };
    const engine = createEngine({
      gameId: 'pert-tun-2',
      persistence: false,
      persistenceNamespace: `pert-tun-2-${Math.random().toString(36).slice(2)}`,
    });
    engine.use(mod);
    engine.start();

    const reg = [...engine.tryInject(TuningRegistriesKey)!].find(
      (r) => r.name === 'balance-tuning',
    )!;
    const read = () => reg.get('threshold')();
    const entry = walkTunables(engine).find((e) => e.key === 'threshold')!;

    expect(num(read())).toBe(50);
    const cleanup = applyPerturbation(engine, entry, { kind: 'scalar-add', delta: 25 });
    expect(num(read())).toBe(75);
    cleanup();
    expect(num(read())).toBe(50);

    engine.stop();
  });

  it('perturbing a scratch engine does not stomp the live engine', () => {
    // Cross-engine safety check: TunablePickerAddress holds a registryName
    // string (not a registry reference). applyPerturbation resolves the
    // registry against whichever engine it's called on. Live registry stays
    // untouched when the scratch fork is perturbed.
    function makeMod(): EngineModule {
      return {
        id: 'tuning-host',
        install() {
          const reg = createTuningRegistry('iso-tuning');
          tunable(reg, 'foo', () => 10);
        },
      };
    }

    const live = createEngine({
      gameId: 'pert-iso-live',
      persistence: false,
      persistenceNamespace: `pert-iso-live-${Math.random().toString(36).slice(2)}`,
    });
    live.use(makeMod());
    live.start();

    const scratch = createEngine({
      gameId: 'pert-iso-scratch',
      persistence: false,
      persistenceNamespace: `pert-iso-scratch-${Math.random().toString(36).slice(2)}`,
    });
    scratch.use(makeMod());
    scratch.start();

    // Discover against live.
    const entry = walkTunables(live).find((e) => e.key === 'foo')!;
    expect(entry).toBeDefined();

    const liveReg = [...live.tryInject(TuningRegistriesKey)!].find((r) => r.name === 'iso-tuning')!;
    const scratchReg = [...scratch.tryInject(TuningRegistriesKey)!].find(
      (r) => r.name === 'iso-tuning',
    )!;
    expect(liveReg).not.toBe(scratchReg);
    const readLive = () => liveReg.get('foo')();
    const readScratch = () => scratchReg.get('foo')();

    expect(num(readLive())).toBe(10);
    expect(num(readScratch())).toBe(10);

    // Apply against scratch.
    const cleanup = applyPerturbation(scratch, entry, { kind: 'scalar-multiply', factor: 5 });

    expect(num(readScratch())).toBe(50);
    // Live untouched.
    expect(num(readLive())).toBe(10);

    cleanup();
    expect(num(readScratch())).toBe(10);
    expect(num(readLive())).toBe(10);

    live.stop();
    scratch.stop();
  });

  it('throws when the named tuning registry is absent on the target engine', () => {
    const live = createEngine({
      gameId: 'pert-tun-missing-live',
      persistence: false,
      persistenceNamespace: `pert-tun-missing-live-${Math.random().toString(36).slice(2)}`,
    });
    live.use({
      id: 'tuning-host',
      install() {
        const reg = createTuningRegistry('only-here');
        tunable(reg, 'foo', () => 1);
      },
    });
    live.start();

    const entry = walkTunables(live).find((e) => e.key === 'foo')!;

    // Apply against an engine that doesn't have the named registry.
    const bare = createEngine({
      gameId: 'pert-tun-missing-bare',
      persistence: false,
      persistenceNamespace: `pert-tun-missing-bare-${Math.random().toString(36).slice(2)}`,
    });
    bare.use({ id: 'noop', install() {} });
    bare.start();

    expect(() => applyPerturbation(bare, entry, { kind: 'scalar-multiply', factor: 2 })).toThrow(
      /only-here/,
    );

    live.stop();
    bare.stop();
  });
});
