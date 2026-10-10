import { describe, it, expect } from 'vitest';
import { ref } from 'vue';
import {
  createAdditiveModifier,
  createEngine,
  createModifierChain,
  createMultiplicativeModifier,
  createConditionalEffectSystem,
  createProducerCategory,
  createTemporaryEffectSystem,
  createTuningRegistry,
  Decimal,
  TuningRegistriesKey,
  tunable,
  type EngineModule,
} from '@/index';
import {
  createPickerSnapshot,
  walkChainRegistry,
  walkEffectSystemBindings,
  walkTunables,
} from '@/harness/picker';
import { applyPerturbation } from '@/harness/perturbation';
import { createResource } from '@/core/resource';
import { startEngine } from './helpers';

function num(v: unknown): number {
  return Decimal.fromValue(v as Decimal).toNumber();
}

/** `dmg` = [flat +5, mult ×2], each bound by a conditional effect gated on its own flag. */
function persistentDamage(gameId: string) {
  const on = { flat: ref(true), mult: ref(true) };
  const flat = createAdditiveModifier({ addend: 5 });
  let dmg!: ReturnType<typeof createModifierChain>;
  const engine = startEngine(gameId, {
    id: 'fx',
    install() {
      dmg = createModifierChain('dmg');
      const effects = createConditionalEffectSystem({ id: 'gear' });
      effects.register([
        { id: 'flat', active: () => on.flat.value, grants: [{ chain: dmg, modifier: flat }] },
        {
          id: 'mult',
          active: () => on.mult.value,
          grants: [{ chain: dmg, modifier: () => createMultiplicativeModifier({ multiplier: 2 }) }],
        },
      ]);
    },
  });
  const entry = (label: string) => walkEffectSystemBindings(engine).find((e) => e.label === label)!;
  return { engine, on, flat, dmg: () => dmg, entry };
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

  it('swaps a modifier in place, so order and value survive perturbation and cleanup', () => {
    const engine = startEngine('pert-cr-order', {
      id: 'economy',
      install() {
        const gain = createModifierChain('gain');
        gain.add(createAdditiveModifier({ addend: 5 }));
        gain.add(createMultiplicativeModifier({ multiplier: 2 }));
      },
    });
    const entry = walkChainRegistry(engine).find((e) => e.label === 'gain[0]')!;
    const { chain } = entry;
    const order = [...chain.modifiers];
    expect(num(chain.apply(1))).toBe(12);

    const identity = applyPerturbation(engine, entry, { kind: 'scalar-multiply', factor: 1 });
    expect(num(chain.apply(1))).toBe(12);
    expect(chain.modifiers[1]).toBe(order[1]);
    identity();
    expect(num(chain.apply(1))).toBe(12);
    expect(chain.modifiers).toEqual(order);

    // Re-applying the same entry wraps the same modifier: (1 + 5 + 100) × 2.
    const again = applyPerturbation(engine, entry, { kind: 'scalar-add', delta: 100 });
    expect(num(chain.apply(1))).toBe(212);
    again();
    expect(chain.modifiers).toEqual(order);
    engine.stop();
  });

  it('finds the discovered modifier after an earlier slot fills and shifts its index', () => {
    let dmg!: ReturnType<typeof createModifierChain>;
    let slot!: ReturnType<ReturnType<typeof createModifierChain>['reserve']>;
    const engine = startEngine('pert-cr-stale', {
      id: 'economy',
      install() {
        dmg = createModifierChain('dmg');
        slot = dmg.reserve();
        dmg.add(createMultiplicativeModifier({ multiplier: 2 }));
      },
    });
    const multEntry = walkChainRegistry(engine).find((e) => e.label === 'dmg[0]')!;
    slot.add(createAdditiveModifier({ addend: 5 }));

    // mult wrapped: (1 + 5) × 2 + 10; the modifier now at index 0 would give (1 + 5 + 10) × 2.
    const cleanup = applyPerturbation(engine, multEntry, { kind: 'scalar-add', delta: 10 });
    expect(num(dmg.apply(1))).toBe(22);
    cleanup();
    expect(num(dmg.apply(1))).toBe(12);
    engine.stop();
  });

  it('composes stacked perturbations of one modifier, unwinding in any order', () => {
    const engine = startEngine('pert-cr-stack', {
      id: 'economy',
      install() {
        const gain = createModifierChain('gain');
        gain.add(createAdditiveModifier({ addend: 5 }));
        gain.add(createMultiplicativeModifier({ multiplier: 2 }));
      },
    });
    const entry = walkChainRegistry(engine).find((e) => e.label === 'gain[0]')!;
    const order = [...entry.chain.modifiers];
    const times3 = applyPerturbation(engine, entry, { kind: 'scalar-multiply', factor: 3 });
    const plus4 = applyPerturbation(engine, entry, { kind: 'scalar-add', delta: 4 });
    // ((1 + 5) × 3 + 4) × 2
    expect(num(entry.chain.apply(1))).toBe(44);
    times3();
    expect(num(entry.chain.apply(1))).toBe(20);
    plus4();
    expect(entry.chain.modifiers).toEqual(order);
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
      install() {
        const cursorResource = createResource(Decimal.dZero, {
          id: 'cursor-gold',
          displayName: 'Cursor Gold',
        });
        const producers = createProducerCategory<ProducerDef>({
          id: 'producers',
          mapProducer: (def) => ({
            resource: cursorResource,
            baseRate: def.baseRate,
            trigger: 'continuous',
          }),
          registerTick: () => () => {},
        });
        producers.register([{ id: 'cursor', name: 'Cursor', baseRate: 1 }]);
        producers
          .getProducer('cursor')!
          .rateChain.add(createMultiplicativeModifier({ multiplier: 2 }));
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
          grants: [
            // Non-factory binding so the walker + applier resolve the same
            // instance.
            { chain: speedChain, modifier: createMultiplicativeModifier({ multiplier: 2 }) },
          ],
        });
        // Apply the effect so the binding's modifier lands in the chain.
        temp.activate('haste');
      },
    };
    const engine = createEngine({
      gameId: 'pert-content-1',
      persistence: false,
      persistenceNamespace: `pert-content-1-${Math.random().toString(36).slice(2)}`,
    });
    engine.use(mod);
    engine.start();

    const entry = walkEffectSystemBindings(engine).find((e) => e.label === 'buffs.haste[0]')!;
    expect(entry).toBeDefined();
    expect(entry.indexInChain).toBeGreaterThanOrEqual(0);
    expect(num(speedChain!.apply(10))).toBe(20);

    const cleanup = applyPerturbation(engine, entry, { kind: 'scalar-multiply', factor: 4 });
    expect(num(speedChain!.apply(10))).toBe(80);

    cleanup();
    expect(num(speedChain!.apply(10))).toBe(20);
    engine.stop();
  });

  it('perturbs every activation of the binding, in its place, until cleanup', () => {
    const { engine, on, flat, dmg, entry } = persistentDamage('pert-content-toggle');
    const cleanup = applyPerturbation(engine, entry('gear.flat[0]'), {
      kind: 'scalar-multiply',
      factor: 3,
    });
    expect(num(dmg().apply(1))).toBe(36);

    on.flat.value = false;
    expect(num(dmg().apply(1))).toBe(2);
    expect(dmg().modifiers).toHaveLength(1);

    on.flat.value = true;
    expect(num(dmg().apply(1))).toBe(36);
    expect(dmg().modifiers).toHaveLength(2);

    cleanup();
    expect(num(dmg().apply(1))).toBe(12);
    expect(dmg().modifiers[0]).toBe(flat);
    expect(dmg().modifiers).toHaveLength(2);
    engine.stop();
  });

  it('leaves an effect that deactivated while perturbed unbound after cleanup', () => {
    const { engine, on, dmg, entry } = persistentDamage('pert-content-off');
    const cleanup = applyPerturbation(engine, entry('gear.flat[0]'), {
      kind: 'scalar-add',
      delta: 10,
    });
    on.flat.value = false;
    cleanup();
    expect(num(dmg().apply(1))).toBe(2);
    expect(dmg().modifiers).toHaveLength(1);
    engine.stop();
  });

  it('perturbs a factory-form binding', () => {
    const { engine, on, dmg, entry } = persistentDamage('pert-content-factory');
    const cleanup = applyPerturbation(engine, entry('gear.mult[0]'), {
      kind: 'scalar-multiply',
      factor: 3,
    });
    expect(num(dmg().apply(1))).toBe(36);
    on.mult.value = false;
    on.mult.value = true;
    expect(num(dmg().apply(1))).toBe(36);
    cleanup();
    expect(num(dmg().apply(1))).toBe(12);
    engine.stop();
  });

  it('wraps the right binding from a snapshot taken before other effects churned', () => {
    const { engine, on, dmg, entry } = persistentDamage('pert-content-stale');
    on.flat.value = false;
    const multEntry = entry('gear.mult[0]');
    on.flat.value = true;

    // mult wrapped: (1 + 5) × 2 + 10; flat wrapped would give (1 + 5 + 10) × 2.
    const cleanup = applyPerturbation(engine, multEntry, { kind: 'scalar-add', delta: 10 });
    expect(num(dmg().apply(1))).toBe(22);
    cleanup();
    expect(num(dmg().apply(1))).toBe(12);
    engine.stop();
  });

  it('composes stacked perturbations of one binding, unwinding in any order', () => {
    const { engine, flat, dmg, entry } = persistentDamage('pert-content-stack');
    const times3 = applyPerturbation(engine, entry('gear.flat[0]'), {
      kind: 'scalar-multiply',
      factor: 3,
    });
    const plus4 = applyPerturbation(engine, entry('gear.flat[0]'), {
      kind: 'scalar-add',
      delta: 4,
    });
    // ((1 + 5) × 3 + 4) × 2
    expect(num(dmg().apply(1))).toBe(44);
    times3();
    expect(num(dmg().apply(1))).toBe(20);
    plus4();
    expect(num(dmg().apply(1))).toBe(12);
    expect(dmg().modifiers[0]).toBe(flat);
    engine.stop();
  });

  it('perturbs a temporary effect across expiry and re-application', () => {
    let tick!: (dt: number) => void;
    let dmg!: ReturnType<typeof createModifierChain>;
    let buffs!: ReturnType<typeof createTemporaryEffectSystem>;
    const engine = startEngine('pert-content-temp', {
      id: 'fx',
      install() {
        dmg = createModifierChain('dmg');
        buffs = createTemporaryEffectSystem({
          id: 'buffs',
          registerTick: (cb) => {
            tick = cb;
            return () => {};
          },
        });
        buffs.register({
          id: 'rage',
          duration: 2,
          grants: [{ chain: dmg, modifier: () => createAdditiveModifier({ addend: 5 }) }],
        });
        dmg.add(createMultiplicativeModifier({ multiplier: 2 }));
      },
    });
    const rage = walkEffectSystemBindings(engine).find((e) => e.label === 'buffs.rage[0]')!;
    buffs.activate('rage');
    expect(num(dmg.apply(1))).toBe(12);

    const cleanup = applyPerturbation(engine, rage, { kind: 'scalar-multiply', factor: 3 });
    expect(num(dmg.apply(1))).toBe(36);
    tick(2);
    expect(num(dmg.apply(1))).toBe(2);
    expect(dmg.modifiers).toHaveLength(1);
    buffs.activate('rage');
    expect(num(dmg.apply(1))).toBe(36);

    cleanup();
    expect(num(dmg.apply(1))).toBe(12);
    tick(2);
    expect(num(dmg.apply(1))).toBe(2);
    expect(dmg.modifiers).toHaveLength(1);
    engine.stop();
  });

  it('perturbs every live stack of a temporary effect, keeping stack order', () => {
    let tick!: (dt: number) => void;
    let dmg!: ReturnType<typeof createModifierChain>;
    let buffs!: ReturnType<typeof createTemporaryEffectSystem>;
    const engine = startEngine('pert-content-stacks', {
      id: 'fx',
      install() {
        dmg = createModifierChain('dmg');
        buffs = createTemporaryEffectSystem({
          id: 'buffs',
          registerTick: (cb) => {
            tick = cb;
            return () => {};
          },
        });
        buffs.register({
          id: 'rage',
          duration: 2,
          maxStacks: 2,
          grants: [{ chain: dmg, modifier: () => createAdditiveModifier({ addend: 5 }) }],
        });
        dmg.add(createMultiplicativeModifier({ multiplier: 2 }));
      },
    });
    const rage = walkEffectSystemBindings(engine).find((e) => e.label === 'buffs.rage[0]')!;
    buffs.activate('rage');
    tick(1);
    buffs.activate('rage');
    const stacks = [...dmg.modifiers];
    expect(num(dmg.apply(1))).toBe(22);

    // ((1 + 5) × 3 + 5) × 3 × 2
    const cleanup = applyPerturbation(engine, rage, { kind: 'scalar-multiply', factor: 3 });
    expect(num(dmg.apply(1))).toBe(138);
    tick(1);
    // (1 + 5) × 3 × 2, the older stack gone
    expect(num(dmg.apply(1))).toBe(36);
    expect(dmg.modifiers).toHaveLength(2);

    cleanup();
    expect(dmg.modifiers).toEqual([stacks[1], stacks[2]]);
    expect(num(dmg.apply(1))).toBe(12);
    engine.stop();
  });

  it('offers an effect modifier once, so perturbing the snapshot strands nothing when effects end', () => {
    const { engine, on, dmg } = persistentDamage('pert-content-owned');
    // Every per-modifier entry on the chain; the factory-built mult isn't the walk-time object.
    const entries = createPickerSnapshot(engine).all.filter(
      (e) => e.kind === 'modifier' && e.chain === dmg() && e.label !== 'dmg[*]',
    );
    expect(entries.map((e) => e.label)).toEqual(['gear.flat[0]', 'gear.mult[0]']);

    const cleanups = entries.map((e) =>
      applyPerturbation(engine, e, { kind: 'scalar-multiply', factor: 3 }),
    );
    on.flat.value = false;
    on.mult.value = false;
    expect(dmg().modifiers).toHaveLength(0);
    for (const cleanup of cleanups) cleanup();
    expect(dmg().modifiers).toHaveLength(0);
    expect(num(dmg().apply(1))).toBe(1);
    engine.stop();
  });

  it('refuses an index fallback that lands on a slot-bound effect modifier', () => {
    const on = ref(false);
    const plain = createAdditiveModifier({ addend: 1 });
    let dmg!: ReturnType<typeof createModifierChain>;
    const engine = startEngine('pert-slot-bound-fallback', {
      id: 'fx',
      install() {
        dmg = createModifierChain('dmg');
        dmg.add(plain);
        createConditionalEffectSystem({ id: 'gear' }).register([
          {
            id: 'flat',
            active: () => on.value,
            grants: [{ chain: dmg, modifier: createAdditiveModifier({ addend: 5 }) }],
          },
        ]);
      },
    });
    const stale = walkChainRegistry(engine).find((e) => e.label === 'dmg[0]')!;
    // The snapshot's modifier leaves, and the effect's seats at the index it recorded.
    dmg.remove(plain);
    on.value = true;
    expect(dmg.modifiers).toHaveLength(1);

    expect(() => applyPerturbation(engine, stale, { kind: 'scalar-multiply', factor: 3 })).toThrow(
      /binding slot/,
    );
    on.value = false;
    expect(dmg.modifiers).toHaveLength(0);
    engine.stop();
  });

  it('names the missing piece when an entry no longer resolves', () => {
    const { engine, entry } = persistentDamage('pert-content-missing');
    const flatEntry = entry('gear.flat[0]');
    // walkEffectSystemBindings always produces 'effect-system'-walker addresses; narrow away the
    // wider ModifierPickerAddress union so the override merges cleanly.
    const contentAddress = flatEntry.address as Extract<
      typeof flatEntry.address,
      { walker: 'effect-system' }
    >;
    const at = (address: Partial<typeof contentAddress>) => ({
      ...flatEntry,
      address: { ...contentAddress, ...address },
    });
    const times2 = { kind: 'scalar-multiply', factor: 2 } as const;
    expect(() => applyPerturbation(engine, at({ effectSystemId: 'nope' }), times2)).toThrow(
      /effect system "nope" not found/,
    );
    expect(() => applyPerturbation(engine, at({ defId: 'nope' }), times2)).toThrow(
      /effect def "nope" not found/,
    );
    expect(() => applyPerturbation(engine, at({ grantIndex: 3 }), times2)).toThrow(
      /no grant at index 3/,
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
      (r) => r.id === 'producer-tuning',
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

    const reg = [...engine.tryInject(TuningRegistriesKey)!].find((r) => r.id === 'balance-tuning')!;
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
    // Cross-engine safety check: TunablePickerAddress holds a registryId
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

    const liveReg = [...live.tryInject(TuningRegistriesKey)!].find((r) => r.id === 'iso-tuning')!;
    const scratchReg = [...scratch.tryInject(TuningRegistriesKey)!].find(
      (r) => r.id === 'iso-tuning',
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
