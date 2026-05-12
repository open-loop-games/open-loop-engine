/**
 * Balance-sim enumeration validation — proves that the EffectSystemRegistry +
 * ChainRegistry pair provides full modifier attribution for external tools.
 *
 * Validates the convention: bind modifiers through persistent-effect systems,
 * not raw chain.add(), so every modifier is traceable to its source effect.
 */

import { describe, it, expect } from 'vitest';
import { ref, nextTick } from 'vue';
import { createPersistentEffectSystem } from '@/systems/persistent-effect';
import {
  createModifierChain,
  createMultiplicativeModifier,
  createAdditiveModifier,
} from '@/core/modifier';
import { createEffectSystemRegistry, withEffectSystemRegistry } from '@/core/registries';
import { createChainRegistry, withChainRegistry } from '@/core/registries';
import type { EffectModifierBinding } from '@/systems/effect-modifier-binding';

// ============================================================================
// Helpers
// ============================================================================

/** Run `fn` under both registries so chains and effect systems auto-register. */
function withRegistries<T>(
  chainReg: ReturnType<typeof createChainRegistry>,
  effectReg: ReturnType<typeof createEffectSystemRegistry>,
  fn: () => T,
): T {
  return withChainRegistry(chainReg, () => withEffectSystemRegistry(effectReg, fn));
}

// ============================================================================
// Full attribution via EffectSystemRegistry
// ============================================================================

describe('balance-sim enumeration', () => {
  it('EffectSystemRegistry provides full modifier → source attribution', () => {
    const chainReg = createChainRegistry();
    const effectReg = createEffectSystemRegistry();

    withRegistries(chainReg, effectReg, () => {
      // Surface-wide chains shared across modules
      const progressChain = createModifierChain('progress');
      const rewardChain = createModifierChain('reward');

      // Three "actions" binding modifiers via persistent-effect systems
      const system = createPersistentEffectSystem({ id: 'action-effects' });

      system.register([
        {
          id: 'affected-by:wander:glasses',
          active: ref(true),
          modifiers: [
            {
              chain: progressChain,
              modifier: () =>
                createMultiplicativeModifier({ multiplier: 1.5, description: 'Glasses speed' }),
            },
          ],
        },
        {
          id: 'affected-by:mine:pickaxe',
          active: ref(true),
          modifiers: [
            {
              chain: rewardChain,
              modifier: () =>
                createMultiplicativeModifier({ multiplier: 2, description: 'Pickaxe yield' }),
            },
            {
              chain: progressChain,
              modifier: () =>
                createAdditiveModifier({ addend: 5, description: 'Pickaxe speed bonus' }),
            },
          ],
        },
        {
          id: 'affected-by:fish:bait',
          active: ref(false), // inactive — should not appear in modifier counts
          modifiers: [
            {
              chain: rewardChain,
              modifier: () =>
                createMultiplicativeModifier({ multiplier: 3, description: 'Bait bonus' }),
            },
          ],
        },
      ]);

      // ── Path 1: Effect-centric enumeration ──────────────────────────────
      // Walk effectReg → systems → allDefs() → modifiers → { chain, modifier }
      const systems = effectReg.all();
      expect(systems).toHaveLength(1);
      expect(systems[0].id).toBe('action-effects');

      const defs = systems[0].allDefs();
      expect(defs).toHaveLength(3);

      // Build the full attribution graph: effectId → chain targets
      const attribution = new Map<string, string[]>();

      for (const def of defs) {
        const bindings = def.modifiers as EffectModifierBinding[] | undefined;
        if (!bindings) continue;
        attribution.set(
          def.id,
          bindings.map((b) => b.chain.id),
        );
      }

      // Glasses → progress chain only
      expect(attribution.get('affected-by:wander:glasses')).toEqual(['progress']);

      // Pickaxe → reward + progress chains
      expect(attribution.get('affected-by:mine:pickaxe')).toEqual(['reward', 'progress']);

      // Bait → reward chain (definition exists even though inactive)
      expect(attribution.get('affected-by:fish:bait')).toEqual(['reward']);

      // ── Path 2: Chain-centric enumeration ───────────────────────────────
      // Walk chainReg → chains → chain.modifiers (only currently-applied)
      const chains = chainReg.all();
      expect(chains).toHaveLength(2);
      expect(chains.map((c) => c.id).sort()).toEqual(['progress', 'reward']);

      const progressModifiers = chainReg.get('progress')!.modifiers;
      const rewardModifiers = chainReg.get('reward')!.modifiers;

      // Only active defs have applied modifiers:
      // progress: glasses (×1.5) + pickaxe (+5) = 2 modifiers
      // reward: pickaxe (×2) = 1 modifier (bait is inactive)
      expect(progressModifiers).toHaveLength(2);
      expect(rewardModifiers).toHaveLength(1);

      // ── Cross-check: both paths agree ───────────────────────────────────
      // Count modifiers reachable via effect-system path (active defs only)
      let effectPathCount = 0;
      for (const def of defs) {
        const bindings = def.modifiers as EffectModifierBinding[] | undefined;
        if (!bindings) continue;
        // Only count if the def is active (has applied modifiers on chains)
        const isActive = system.isActive(def.id).value;
        if (isActive) effectPathCount += bindings.length;
      }

      // Count modifiers reachable via chain path
      let chainPathCount = 0;
      for (const chain of chains) {
        chainPathCount += chain.modifiers.length;
      }

      // Both paths see the same number of live modifiers
      expect(effectPathCount).toBe(3); // glasses:1 + pickaxe:2
      expect(chainPathCount).toBe(3); // progress:2 + reward:1
      expect(effectPathCount).toBe(chainPathCount);
    });
  });

  it('multiple effect systems are independently enumerable', () => {
    const chainReg = createChainRegistry();
    const effectReg = createEffectSystemRegistry();

    withRegistries(chainReg, effectReg, () => {
      const chain = createModifierChain('output');

      const equipmentEffects = createPersistentEffectSystem({ id: 'equipment' });
      const skillEffects = createPersistentEffectSystem({ id: 'skills' });

      equipmentEffects.register({
        id: 'sword-dmg',
        active: ref(true),
        modifiers: [{ chain, modifier: () => createMultiplicativeModifier({ multiplier: 2 }) }],
      });

      skillEffects.register({
        id: 'power-strike',
        active: ref(true),
        modifiers: [{ chain, modifier: () => createAdditiveModifier({ addend: 10 }) }],
      });

      // Registry sees both systems
      expect(effectReg.all()).toHaveLength(2);
      expect(
        effectReg
          .all()
          .map((s) => s.id)
          .sort(),
      ).toEqual(['equipment', 'skills']);

      // Each system's defs are independently enumerable
      expect(effectReg.get('equipment')!.allDefs()).toHaveLength(1);
      expect(effectReg.get('skills')!.allDefs()).toHaveLength(1);

      // Chain sees both modifiers applied
      expect(chain.modifiers).toHaveLength(2);

      // Full attribution across systems
      const allBindings: { systemId: string; defId: string; chainId: string }[] = [];
      for (const sys of effectReg.all()) {
        for (const def of sys.allDefs()) {
          const bindings = def.modifiers as EffectModifierBinding[] | undefined;
          if (!bindings) continue;
          for (const b of bindings) {
            allBindings.push({ systemId: sys.id, defId: def.id, chainId: b.chain.id });
          }
        }
      }

      expect(allBindings).toEqual([
        { systemId: 'equipment', defId: 'sword-dmg', chainId: 'output' },
        { systemId: 'skills', defId: 'power-strike', chainId: 'output' },
      ]);
    });
  });

  it('attribution remains correct after activation state changes', async () => {
    const chainReg = createChainRegistry();
    const effectReg = createEffectSystemRegistry();
    const active = ref(true);

    // Setup must be synchronous so ambient registries are active
    const { chain } = withRegistries(chainReg, effectReg, () => {
      const chain = createModifierChain('speed');
      const system = createPersistentEffectSystem({ id: 'buffs' });

      system.register({
        id: 'haste',
        active,
        modifiers: [{ chain, modifier: () => createMultiplicativeModifier({ multiplier: 1.5 }) }],
      });

      return { chain };
    });

    // Initially active — chain has the modifier
    expect(chain.modifiers).toHaveLength(1);

    // Deactivate — chain is empty, but def is still enumerable
    active.value = false;
    await nextTick();

    expect(chain.modifiers).toHaveLength(0);
    expect(effectReg.get('buffs')!.allDefs()).toHaveLength(1);
    expect((effectReg.get('buffs')!.allDefs()[0].modifiers as EffectModifierBinding[]).length).toBe(
      1,
    );

    // Effect-system path still shows the binding definition
    // (attribution is "what could modify this" not just "what is active now")
    const def = effectReg.get('buffs')!.allDefs()[0];
    const bindings = def.modifiers as EffectModifierBinding[];
    expect(bindings[0].chain.id).toBe('speed');

    // Re-activate — chain picks it back up
    active.value = true;
    await nextTick();
    expect(chain.modifiers).toHaveLength(1);
  });
});
