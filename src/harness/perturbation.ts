/**
 * Perturbation applier — address→override mechanism for the balance workbench.
 *
 * Given a {@link PickerEntry} from the picker and a {@link Perturbation},
 * apply the transform via the mechanism appropriate to the entry's
 * address, and return an idempotent cleanup that reverses it.
 *
 * Three perturbation mechanisms:
 *
 * - **Effect-system entries** (`address.walker: 'effect-system'`) — grant wrap:
 *   the effect system wraps the def's binding in every activation while
 *   the perturbation is active. A live activation is swapped in place, a
 *   later one binds wrapped, expiry removes whatever is live, and cleanup
 *   swaps the originals back in place. Factory-form bindings are covered,
 *   since the wrap applies to whatever the binding resolves to.
 *
 * - **Chain-registry entries** (`address.walker: 'chain-registry'`) —
 *   in-place swap: `chain.replace(target, wrapped)`, and cleanup swaps
 *   the target back while the wrapper is still in the chain. A
 *   `modifier-index` entry resolves its target by identity when the
 *   discovered modifier is in the chain, else by its recorded index. A
 *   `chain-apply` entry appends a freestanding scalar modifier instead.
 *
 * - **Tunable entries** (`kind: 'tunable'`) — registry scope push:
 *   capture the current resolved value at apply time, then
 *   `registry.pushOverrides('perturbation', { [key]: () => transformed })`.
 *   Cleanup is the scope's idempotent cleanup function. Registry lookup
 *   happens at apply time via `engine.tryInject(TuningRegistriesKey)` — the
 *   entry carries `registryId: string`, not a registry reference, so
 *   perturbing a scratch sensitivity-fork doesn't stomp the live engine.
 *
 * The modifier wrapper composes on top of the original
 * (`wrapped.apply(g) = original.apply(g) * F` for scalar-multiply), and
 * perturbing an already-perturbed surface composes on top of the active
 * one; cleanups unwind in any order. Every kind returns the same
 * `() => void` idempotent cleanup, so the workbench composable handles
 * them uniformly.
 *
 * Composition note: a `tunable()` value that feeds a `ModifierChain` can
 * be perturbed via either path (workbench can choose). Stacking both
 * produces multiplicative composition — different from re-perturbing one
 * path twice. Workbench surfaces both paths so the designer can pick the
 * intended layer.
 */

import type { Engine } from '@/engine';
import type { Modifier, ModifierChain } from '@/core/modifier';
import {
  createWrapStack,
  isSlotBound,
  overlayBinding,
  type ModifierWrap,
  type WrapStack,
} from '@/systems/binding-slots';
import { Decimal, type DecimalSource } from '@/primitives/decimal';
import { ChainRegistryKey, EffectSystemRegistryKey } from '@/core/registries';
import { TuningRegistriesKey } from '@/core/override-registry';
import type { PickerEntry } from './picker';
import { effectDefBindings } from './walk';

/** Scalar transform applied on top of an existing modifier or tunable value. */
export type Perturbation =
  | { kind: 'scalar-multiply'; factor: DecimalSource }
  | { kind: 'scalar-add'; delta: DecimalSource };

/**
 * Apply `perturbation` to the surface identified by `entry` and return an
 * idempotent cleanup that reverses the mutation. The workbench composable
 * calls this on every sensitivity run (against the per-run scratch engine)
 * and on commit (against the live engine).
 *
 * Dispatches on the entry's address:
 * - `'content'` — overlays the effect def's binding, live and future
 *   activations alike, each in its own chain position.
 * - `'chain-registry'` — swaps the addressed modifier for its wrapper in
 *   place (`modifier-index`), or appends a scalar modifier (`chain-apply`).
 * - `'tunable'` — registry scope push capturing the current resolved value.
 *
 * Perturbing a perturbed surface composes on top of the active
 * perturbation. Cleanup restores the exact value and chain order, and
 * leaves a binding whose effect ended meanwhile unbound.
 *
 * @param engine - The engine to apply against. For modifier entries the
 *   target is resolved via `ChainRegistryKey` or `EffectSystemRegistryKey`;
 *   for tunable entries the registry is resolved via
 *   `TuningRegistriesKey`. Cross-engine: the entry can be discovered
 *   against one engine and applied to another (e.g. live → scratch fork)
 *   because addresses are string-keyed, not object-keyed. A
 *   `modifier-index` entry applied across engines, or after its chain
 *   changed shape, falls back to its recorded index — refresh the snapshot
 *   when the chain changes.
 * @param entry - The {@link PickerEntry} naming the surface to perturb.
 * @param perturbation - Scalar transform applied on top of the current
 *   value (multiply or add).
 * @returns Idempotent cleanup function — calling it once reverses the
 *   perturbation; subsequent calls are no-ops.
 * @throws {Error} when the entry cannot resolve on `engine` (missing
 *   registries, unknown chain or effect-system ids, a def or binding index
 *   that no longer exists, no modifier at a chain index, unknown tunable
 *   keys).
 *
 * @example
 * ```ts
 * const cleanup = applyPerturbation(engine, entry, { kind: 'scalar-multiply', factor: 1.25 });
 * try {
 *   runSimulation(engine);
 * } finally {
 *   cleanup();
 * }
 * ```
 */
export function applyPerturbation(
  engine: Engine,
  entry: PickerEntry,
  perturbation: Perturbation,
): () => void {
  if (entry.kind === 'tunable') {
    return applyTunablePerturbation(engine, entry, perturbation);
  }
  return applyModifierPerturbation(engine, entry, perturbation);
}

function applyTunablePerturbation(
  engine: Engine,
  entry: Extract<PickerEntry, { kind: 'tunable' }>,
  perturbation: Perturbation,
): () => void {
  const registries = engine.tryInject(TuningRegistriesKey);
  if (!registries) throw new Error('TuningRegistriesKey not provided on engine');
  const registry = [...registries].find((r) => r.id === entry.registryId);
  if (!registry) throw new Error(`tuning registry "${entry.registryId}" not found`);

  // Capture baseline at apply time — reads through whatever scopes are
  // currently active so re-perturbing while a perturbation is already
  // active composes on top of the active scope's value (consistent with
  // modifier-perturbation composition).
  const reader = registry.get(entry.key);
  const baseline = reader();

  const transformed: DecimalSource =
    perturbation.kind === 'scalar-multiply'
      ? Decimal.times(baseline, perturbation.factor)
      : Decimal.add(baseline, perturbation.delta);

  return registry.pushOverrides('perturbation', { [entry.key]: () => transformed });
}

function applyModifierPerturbation(
  engine: Engine,
  entry: Extract<PickerEntry, { kind: 'modifier' }>,
  perturbation: Perturbation,
): () => void {
  const { address } = entry;

  switch (address.walker) {
    case 'chain-registry': {
      const registry = engine.tryInject(ChainRegistryKey);
      if (!registry) throw new Error('ChainRegistryKey not provided on engine');
      const chain = registry.get(address.chainId);
      if (!chain) throw new Error(`chain "${address.chainId}" not found`);
      if (address.kind === 'chain-apply') {
        return appendChainWrapper(chain, perturbation);
      }
      const target = resolveChainTarget(chain, entry.modifier, address.modifierIndex);
      return overlayChainModifier(chain, target, (m) => wrapModifier(m, perturbation));
    }

    case 'effect-system': {
      const registry = engine.tryInject(EffectSystemRegistryKey);
      if (!registry) throw new Error('EffectSystemRegistryKey not provided on engine');
      const system = registry.get(address.effectSystemId);
      if (!system) throw new Error(`effect system "${address.effectSystemId}" not found`);

      const def = system.allDefs().find((d) => d.id === address.defId);
      if (!def) {
        throw new Error(
          `effect def "${address.defId}" not found in system "${address.effectSystemId}"`,
        );
      }
      if (address.grantIndex >= effectDefBindings(def).length) {
        throw new Error(`def "${address.defId}" has no grant at index ${address.grantIndex}`);
      }
      return overlayBinding(system, address.defId, address.grantIndex, (m) =>
        wrapModifier(m, perturbation),
      );
    }
  }
}

/**
 * The modifier a `modifier-index` entry names in `chain`: the discovered
 * object itself while it is still there, else whatever sits at the recorded
 * index — the only handle a cross-engine apply has. Refuses a slot-bound
 * modifier there, as the picker does: its effect would strand the wrapper.
 */
function resolveChainTarget(chain: ModifierChain, discovered: Modifier, index: number): Modifier {
  if (chain.modifiers.includes(discovered)) return discovered;
  const atIndex = chain.modifiers[index];
  if (!atIndex) throw new Error(`chain "${chain.id}" has no modifier at index ${index}`);
  if (isSlotBound(atIndex)) {
    throw new Error(
      `chain "${chain.id}" index ${index} now holds a modifier in a binding slot; perturb it through its effect's content entry`,
    );
  }
  return atIndex;
}

/** One chain modifier's active perturbations. */
interface ChainOverlay {
  original: Modifier;
  wraps: WrapStack;
  /** The object currently standing in the chain for `original`. */
  live: Modifier;
}

/** Live wrapper → its overlay, so perturbing a perturbed modifier composes on the same stack. */
const chainOverlays = new WeakMap<Modifier, ChainOverlay>();

/** Swap `target` for its wrapped form in place; the cleanup swaps back while the wrapper is still there. */
function overlayChainModifier(
  chain: ModifierChain,
  target: Modifier,
  wrap: ModifierWrap,
): () => void {
  let overlay = chainOverlays.get(target);
  if (overlay == null) {
    const created: ChainOverlay = {
      original: target,
      wraps: createWrapStack(() => reseatChainOverlay(chain, created)),
      live: target,
    };
    overlay = created;
  }
  return overlay.wraps.push(wrap);
}

/** Swap the overlay's live object for its current composition, in place; a no-op once it has left the chain. */
function reseatChainOverlay(chain: ModifierChain, overlay: ChainOverlay): void {
  const next = overlay.wraps.compose(overlay.original);
  if (!chain.replace(overlay.live, next)) return;
  chainOverlays.delete(overlay.live);
  overlay.live = next;
  if (overlay.wraps.size > 0) chainOverlays.set(next, overlay);
}

/**
 * Chain-level perturbation: append a freestanding scalar modifier to the
 * chain's tail and return a cleanup that removes it. Unlike a
 * `modifier-index` entry there's no original to swap with — the wrapper composes on whatever
 * the chain already holds (including nothing, for auto-registered empty
 * chains).
 */
function appendChainWrapper(chain: ModifierChain, perturbation: Perturbation): () => void {
  const wrapper = buildScalarModifier(perturbation);
  chain.add(wrapper);
  let cleaned = false;
  return () => {
    if (cleaned) return;
    cleaned = true;
    chain.remove(wrapper);
  };
}

function buildScalarModifier(perturbation: Perturbation): Modifier {
  if (perturbation.kind === 'scalar-multiply') {
    const { factor } = perturbation;
    return {
      apply: (gain: DecimalSource) => Decimal.times(gain, factor),
      invert: (gain: DecimalSource) => Decimal.div(gain, factor),
    };
  }
  const { delta } = perturbation;
  return {
    apply: (gain: DecimalSource) => Decimal.add(gain, delta),
    invert: (gain: DecimalSource) => Decimal.sub(gain, delta),
  };
}

function wrapModifier(original: Modifier, perturbation: Perturbation): Modifier {
  if (perturbation.kind === 'scalar-multiply') {
    const { factor } = perturbation;
    return {
      apply: (gain: DecimalSource) => Decimal.times(original.apply(gain), factor),
      invert: original.invert
        ? (gain: DecimalSource) => original.invert!(Decimal.div(gain, factor))
        : undefined,
      enabled: original.enabled,
      description: original.description,
    };
  }

  const { delta } = perturbation;
  return {
    apply: (gain: DecimalSource) => Decimal.add(original.apply(gain), delta),
    invert: original.invert
      ? (gain: DecimalSource) => original.invert!(Decimal.sub(gain, delta))
      : undefined,
    enabled: original.enabled,
    description: original.description,
  };
}
