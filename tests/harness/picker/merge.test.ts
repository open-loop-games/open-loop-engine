import { describe, it, expect } from 'vitest';
import {
  createEngine,
  createModifierChain,
  createMultiplicativeModifier,
  createTemporaryEffectSystem,
  createTuningRegistry,
  tunable,
  type EngineModule,
  type Modifier,
} from '@/index';
import { createPickerSnapshot } from '@/harness/picker';

describe('createPickerSnapshot', () => {
  it('runs both walkers and returns a grouped snapshot', () => {
    const mod: EngineModule = {
      id: 'all',
      install(ctx) {
        // Source 1: content — temporary effect with a binding on a fresh chain.
        const damage = createModifierChain('damage');
        const temp = createTemporaryEffectSystem({
          id: 'buffs',
          registerTick: (cb) => ctx.onTick(cb),
        });
        temp.register({
          id: 'crit',
          duration: 5,
          modifiers: [{ chain: damage, modifier: createMultiplicativeModifier({ multiplier: 2 }) }],
        });

        // Source 2: chain registry — a standalone chain with 2 modifiers that
        // NO content entry touches. These are reachable only through the
        // chain-registry walker.
        const standalone = createModifierChain('spellPotency');
        standalone.add(createMultiplicativeModifier({ multiplier: 1.1 }));
        standalone.add(createMultiplicativeModifier({ multiplier: 1.05 }));
      },
    };
    const engine = createEngine({
      gameId: 'pk-1',
      persistence: false,
      persistenceNamespace: `pk-1-${Math.random().toString(36).slice(2)}`,
    });
    engine.use(mod);
    engine.start();

    const snap = createPickerSnapshot(engine);

    // Layers:
    //   content:     buffs.crit[0]                            (1 entry)
    //   chain:       damage[*], spellPotency[*],
    //                spellPotency[0], spellPotency[1]         (4 entries)
    expect(snap.all).toHaveLength(5);
    expect(snap.content).toHaveLength(1);
    expect(snap.chains).toHaveLength(4);

    expect(snap.content[0].label).toBe('buffs.crit[0]');
    expect(snap.chains.map((e) => e.label)).toEqual([
      'damage[*]',
      'spellPotency[*]',
      'spellPotency[0]',
      'spellPotency[1]',
    ]);

    engine.stop();
  });

  it('dedups when the same Modifier is reachable via content + chain registry', () => {
    // A content binding's chain is auto-registered in the chain registry
    // (createModifierChain during install auto-registers). So the modifier
    // added by the binding is walkable via both:
    //   content walker: buffs.rageBinding[0]
    //   chain walker:   damage[0]
    // The merger must keep only the content entry.
    let sharedModifier: Modifier | null = null;
    const mod: EngineModule = {
      id: 'dedup',
      install(ctx) {
        const damage = createModifierChain('damage');
        sharedModifier = createMultiplicativeModifier({ multiplier: 2 });

        const temp = createTemporaryEffectSystem({
          id: 'buffs',
          registerTick: (cb) => ctx.onTick(cb),
        });
        temp.register({
          id: 'rage',
          duration: 5,
          modifiers: [{ chain: damage, modifier: sharedModifier }],
        });

        // Pre-seed the chain with the modifier so both paths reach it.
        damage.add(sharedModifier);
      },
    };
    const engine = createEngine({
      gameId: 'pk-dedup',
      persistence: false,
      persistenceNamespace: `pk-dedup-${Math.random().toString(36).slice(2)}`,
    });
    engine.use(mod);
    engine.start();

    const snap = createPickerSnapshot(engine);

    // damage chain has exactly 1 modifier (sharedModifier, added once).
    // That one modifier is reachable via:
    //   - content walker (via the binding on `rage`)
    //   - chain-registry walker (via damage[0])
    // After dedup, the sharedModifier appears once, canonical source = content.
    // The chain-registry walker also emits a chain-apply entry (damage[*])
    // which is a fresh marker with no content equivalent, so it stays.
    expect(snap.all).toHaveLength(2);
    expect(snap.content).toHaveLength(1);
    expect(snap.content[0].modifier).toBe(sharedModifier);
    expect(snap.content[0].address.source).toBe('content');
    expect(snap.chains).toHaveLength(1);
    expect(snap.chains[0].label).toBe('damage[*]');

    engine.stop();
  });

  it('gracefully handles an engine with no discovery sources', () => {
    const engine = createEngine({
      gameId: 'pk-empty',
      persistence: false,
      persistenceNamespace: `pk-empty-${Math.random().toString(36).slice(2)}`,
    });
    engine.use({ id: 'noop', install() {} });
    engine.start();

    const snap = createPickerSnapshot(engine);
    expect(snap.all).toEqual([]);
    expect(snap.content).toEqual([]);
    expect(snap.chains).toEqual([]);
    expect(snap.tunables).toEqual([]);

    engine.stop();
  });

  it('emits a tunables group from registered TuningRegistry instances', () => {
    const mod: EngineModule = {
      id: 'tuning-host',
      install() {
        const a = createTuningRegistry('archetype-a');
        tunable(a, 'foo/cost', () => 10);
        tunable(a, 'foo/multiplier', () => 1.25);

        const b = createTuningRegistry('archetype-b');
        tunable(b, 'bar/threshold', () => 100);

        // A chain so we exercise the no-collision property between modifier
        // and tunable entries.
        const chain = createModifierChain('damage');
        chain.add(createMultiplicativeModifier({ multiplier: 2 }));
      },
    };
    const engine = createEngine({
      gameId: 'pk-tun',
      persistence: false,
      persistenceNamespace: `pk-tun-${Math.random().toString(36).slice(2)}`,
    });
    engine.use(mod);
    engine.start();

    const snap = createPickerSnapshot(engine);

    expect(snap.tunables).toHaveLength(3);
    expect(snap.tunables.map((e) => e.label).sort()).toEqual([
      'archetype-a/foo/cost',
      'archetype-a/foo/multiplier',
      'archetype-b/bar/threshold',
    ]);

    // Modifier entries: damage[*] (chain-apply) + damage[0] (the modifier).
    expect(snap.chains).toHaveLength(2);

    // No tunable entry collides with a modifier entry.
    expect(snap.all.length).toBe(snap.chains.length + snap.tunables.length);

    for (const e of snap.tunables) expect(e.kind).toBe('tunable');
    for (const e of snap.chains) expect(e.kind).toBe('modifier');

    engine.stop();
  });
});
