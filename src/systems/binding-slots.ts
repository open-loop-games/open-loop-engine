/**
 * Binding slots — fixed chain positions for one effect definition's bindings
 *
 * Both effect systems bind a definition's modifiers when it activates and
 * unbind them when it ends. Appending on every activation would make a
 * chain's value depend on activation history; routing each binding through a
 * slot reserved on its chain keeps it where the definition first claimed it.
 *
 * A binding can also carry overlays — wraps applied to whatever it resolves
 * to, on the live activations and on every later one until removed. The
 * balance harness perturbs effect content through them, reaching a
 * definition's slots by its system and id via {@link overlayBinding}, and
 * tells an effect's modifiers from a chain's own via {@link isSlotBound}.
 *
 * @cluster effects
 */

import type { Grant, Modifier, ModifierChain, ModifierChainSlot } from '@/core/modifier';
import type { PredicateResolver } from './gate';
import { lowerGrants } from './modifier-binding';

// === TYPES ===

/** A transform over the modifier a binding resolves to. */
export type ModifierWrap = (modifier: Modifier) => Modifier;

/** One definition's reserved chain positions and live bindings. */
export interface BindingSlots {
  /**
   * Bind one activation's modifiers at their positions.
   *
   * @returns A function that unbinds exactly this activation's modifiers.
   */
  bind(): () => void;
  /**
   * Wrap binding `index` in every activation, live and later, until the
   * returned cleanup runs. Overlays stack: each wraps the ones before it.
   */
  overlay(index: number, wrap: ModifierWrap): () => void;
  /** Release every slot this definition reserved. */
  release(): void;
}

/** One modifier an activation holds in a slot. */
interface LiveBinding {
  index: number;
  slot: ModifierChainSlot;
  /** What the binding resolved to, before overlays. */
  resolved: Modifier;
  /** Removes the object actually standing in the slot. */
  remove: () => void;
}

// === FACTORIES ===

/**
 * How many live bindings each object stands in, across every definition — a
 * static modifier can stand in several activations at once.
 */
const seated = new WeakMap<Modifier, number>();

/**
 * Create the slot table for one effect definition's `modifiers`.
 *
 * A static list lowers here and claims its chain positions at once, so each
 * binding evaluates at the same place whenever the effect activates. A
 * factory lowers on every `bind` and claims each position on first use.
 *
 * @param predicates - adopts each grant's `when`
 * @param owner - names the definition in a `when` Gate's error
 */
export function createBindingSlots(
  modifiers: readonly Grant[] | (() => readonly Grant[]) | undefined,
  predicates: PredicateResolver,
  owner: string,
): BindingSlots {
  // A factory-form binding list can aim one index at different chains across
  // activations, so each (index, chain) pair keeps its own slot.
  const byIndex = new Map<number, Map<ModifierChain, ModifierChainSlot>>();
  const overlays = new Map<number, ModifierWrap[]>();
  // In bind order, which is also each slot's member order.
  const live: LiveBinding[] = [];

  function slotFor(index: number, chain: ModifierChain): ModifierChainSlot {
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
  }

  const fixed =
    typeof modifiers === 'function' ? [] : lowerGrants(modifiers ?? [], predicates, owner);
  for (const [index, binding] of fixed.entries()) slotFor(index, binding.chain);

  function seat(binding: LiveBinding): void {
    const wraps = overlays.get(binding.index) ?? [];
    const standing = wraps.reduce((m, wrap) => wrap(m), binding.resolved);
    seated.set(standing, (seated.get(standing) ?? 0) + 1);
    const remove = binding.slot.add(standing);
    binding.remove = () => {
      remove();
      const count = (seated.get(standing) ?? 1) - 1;
      if (count > 0) seated.set(standing, count);
      else seated.delete(standing);
    };
  }

  /** Re-seat binding `index`'s live modifiers under the current overlays, keeping slot order. */
  function reseat(index: number): void {
    const affected = live.filter((binding) => binding.index === index);
    for (const binding of affected) binding.remove();
    for (const binding of affected) seat(binding);
  }

  return {
    bind() {
      const bindings =
        typeof modifiers === 'function' ? lowerGrants(modifiers(), predicates, owner) : fixed;
      const bound: LiveBinding[] = [];
      for (const [index, binding] of bindings.entries()) {
        const entry: LiveBinding = {
          index,
          slot: slotFor(index, binding.chain),
          resolved: binding.modifier(),
          remove: () => {},
        };
        seat(entry);
        live.push(entry);
        bound.push(entry);
      }
      return () => {
        for (const entry of bound) {
          const at = live.indexOf(entry);
          if (at < 0) continue;
          live.splice(at, 1);
          entry.remove();
        }
      };
    },
    overlay(index, wrap) {
      let wraps = overlays.get(index);
      if (wraps == null) {
        wraps = [];
        overlays.set(index, wraps);
      }
      // A fresh token per call, so one wrap function overlaid twice unwinds once per cleanup.
      const token: ModifierWrap = (m) => wrap(m);
      wraps.push(token);
      reseat(index);
      let removed = false;
      return () => {
        if (removed) return;
        removed = true;
        wraps.splice(wraps.indexOf(token), 1);
        reseat(index);
      };
    },
    release() {
      for (const binding of live) binding.remove();
      for (const byChain of byIndex.values()) for (const slot of byChain.values()) slot.release();
      byIndex.clear();
      live.length = 0;
    },
  };
}

// === HARNESS ACCESS ===

/** Effect system → its definitions' slot tables, by def id. */
const slotsBySystem = new WeakMap<object, (defId: string) => BindingSlots | undefined>();

/**
 * Make `system`'s definitions reachable by {@link overlayBinding}.
 *
 * @internal Called once by each effect-system factory.
 */
export function registerBindingSlots(
  system: object,
  lookup: (defId: string) => BindingSlots | undefined,
): void {
  slotsBySystem.set(system, lookup);
}

/**
 * Overlay binding `index` of definition `defId` in `system`; see
 * {@link BindingSlots.overlay}.
 *
 * @internal The balance harness's content perturbation.
 * @throws {Error} when `system` doesn't bind through slots or has no such definition.
 */
export function overlayBinding(
  system: object,
  defId: string,
  index: number,
  wrap: ModifierWrap,
): () => void {
  const lookup = slotsBySystem.get(system);
  if (!lookup) throw new Error('effect system does not bind its modifiers through binding slots');
  const slots = lookup(defId);
  if (!slots) throw new Error(`effect def "${defId}" has no binding slots`);
  return slots.overlay(index, wrap);
}

/**
 * Whether `modifier` stands in a binding slot: an effect activation put it
 * in its chain and removes it when the effect ends, so only the effect's own
 * binding can perturb it without stranding a wrapper there.
 *
 * @internal The balance harness's picker.
 */
export function isSlotBound(modifier: Modifier): boolean {
  return seated.has(modifier);
}
