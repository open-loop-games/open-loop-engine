/**
 * Binding slots — fixed chain positions for one effect definition's bindings
 *
 * Both effect systems bind a definition's modifiers when it activates and
 * unbind them when it ends. Appending on every activation would make a
 * chain's value depend on activation history; routing each binding through a
 * slot reserved on its chain keeps it where the definition first claimed it.
 *
 * @cluster effects
 */

import type { ModifierChain, ModifierChainSlot } from '@/core/modifier';

/** One definition's reserved chain positions, keyed by binding index and chain. */
export interface BindingSlots {
  /** The slot for binding `index` on `chain`, reserved on first request. */
  slotFor(index: number, chain: ModifierChain): ModifierChainSlot;
  /** Release every slot this definition reserved. */
  release(): void;
}

/** Create the slot table for one effect definition. */
export function createBindingSlots(): BindingSlots {
  // A factory-form binding list can aim one index at different chains across
  // activations, so each (index, chain) pair keeps its own slot.
  const byIndex = new Map<number, Map<ModifierChain, ModifierChainSlot>>();
  return {
    slotFor(index, chain) {
      let byChain = byIndex.get(index);
      if (byChain == null) {
        byChain = new Map();
        byIndex.set(index, byChain);
      }
      let slot = byChain.get(chain);
      if (slot == null) {
        slot = chain.reserve();
        byChain.set(chain, slot);
      }
      return slot;
    },
    release() {
      for (const byChain of byIndex.values()) for (const slot of byChain.values()) slot.release();
      byIndex.clear();
    },
  };
}
