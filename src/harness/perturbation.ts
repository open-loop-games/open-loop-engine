/**
 * Perturbation applier — address→override mechanism for the balance workbench.
 *
 * Given a {@link PickerEntry} from the picker and a {@link Perturbation},
 * apply the transform via the mechanism appropriate to the entry's
 * `kind`, and return an idempotent cleanup that reverses it.
 *
 * Two perturbation mechanisms:
 *
 * - **Modifier entries** (`kind: 'modifier'`) — chain mutation:
 *   `chain.remove(old); chain.add(wrapped)`. The wrapper composes on top
 *   of the original (`wrapped.apply(g) = original.apply(g) * F` for
 *   scalar-multiply). Picker entries that cannot resolve to a live
 *   modifier (factory bindings whose `modifier` callable allocates a
 *   fresh instance per call, leaving the walker's snapshot un-locatable
 *   in the live chain) throw a plain `Error`.
 *
 * - **Tunable entries** (`kind: 'tunable'`) — registry scope push:
 *   capture the current resolved value at apply time, then
 *   `registry.pushScope('perturbation', { [key]: () => transformed })`.
 *   Cleanup is the scope's idempotent cleanup function. Registry lookup
 *   happens at apply time via `engine.inject(TuningRegistriesKey)` — the
 *   entry carries `registryName: string`, not a registry reference, so
 *   perturbing a scratch sensitivity-fork doesn't stomp the live engine.
 *
 * Both kinds return the same `() => void` idempotent cleanup signature,
 * so the workbench composable handles them uniformly.
 *
 * Composition note: a `tunable()` value that feeds a `ModifierChain` can
 * be perturbed via either path (workbench can choose). Stacking both
 * produces multiplicative composition — different from re-perturbing one
 * path twice. Workbench surfaces both paths so the designer can pick the
 * intended layer.
 *
 * Ordering caveat for modifier mutation: `chain.remove(old); chain.add(wrapped)`
 * appends to the end of the chain regardless of where `old` sat. For
 * sequential modifiers this changes composition order. Acceptable here —
 * the workbench uses perturbation for sensitivity deltas, not absolute
 * baselines.
 */

import type { Engine, Modifier, ModifierChain, DecimalSource } from '@/index';
import { ChainRegistryKey, Decimal, EffectSystemRegistryKey, TuningRegistriesKey } from '@/index';
import type { PickerEntry } from './picker';

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
 * Dispatches on `entry.kind`:
 * - `'modifier'` — chain mutation via `chain.remove` + `chain.add(wrapped)`.
 * - `'tunable'` — registry scope push capturing the current resolved value.
 *
 * @param engine - The engine to apply against. For modifier entries the
 *   chain is resolved via `ChainRegistryKey` or `EffectSystemRegistryKey`;
 *   for tunable entries the registry is resolved via
 *   `TuningRegistriesKey`. Cross-engine: the entry can be discovered
 *   against one engine and applied to another (e.g. live → scratch fork)
 *   because addresses are string-keyed, not object-keyed.
 * @param entry - The {@link PickerEntry} naming the surface to perturb.
 * @param perturbation - Scalar transform applied on top of the current
 *   value (multiply or add).
 * @returns Idempotent cleanup function — calling it once reverses the
 *   perturbation; subsequent calls are no-ops.
 * @throws {Error} when the entry cannot resolve to a live surface
 *   (factory bindings, missing registries, unknown chain ids, unknown
 *   tunable keys).
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
  const registry = [...registries].find((r) => r.name === entry.registryName);
  if (!registry) throw new Error(`tuning registry "${entry.registryName}" not found`);

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

  return registry.pushScope('perturbation', { [entry.key]: () => transformed });
}

function applyModifierPerturbation(
  engine: Engine,
  entry: Extract<PickerEntry, { kind: 'modifier' }>,
  perturbation: Perturbation,
): () => void {
  const { address } = entry;

  switch (address.source) {
    case 'chain-registry': {
      const registry = engine.tryInject(ChainRegistryKey);
      if (!registry) throw new Error('ChainRegistryKey not provided on engine');
      const chain = registry.get(address.chainId);
      if (!chain) throw new Error(`chain "${address.chainId}" not found`);
      if (address.variant === 'chain-apply') {
        return appendChainWrapper(chain, perturbation);
      }
      const old = chain.modifiers[address.modifierIndex];
      if (!old) {
        throw new Error(
          `chain "${address.chainId}" has no modifier at index ${address.modifierIndex}`,
        );
      }
      return mutateChain(chain, old, perturbation);
    }

    case 'content': {
      const registry = engine.tryInject(EffectSystemRegistryKey);
      if (!registry) throw new Error('EffectSystemRegistryKey not provided on engine');
      const system = registry.get(address.contentType);
      if (!system) throw new Error(`effect system "${address.contentType}" not found`);

      const defs = system.allDefs() as ReadonlyArray<{
        id: string;
        modifiers?: ReadonlyArray<unknown> | (() => ReadonlyArray<unknown>);
      }>;
      const def = defs.find((d) => d.id === address.contentId);
      if (!def) {
        throw new Error(
          `effect def "${address.contentId}" not found in system "${address.contentType}"`,
        );
      }
      const raw = def.modifiers;
      if (!raw) throw new Error(`def "${address.contentId}" has no modifier bindings`);
      const bindings = (typeof raw === 'function' ? raw() : raw) as ReadonlyArray<{
        chain: ModifierChain;
        modifier: Modifier | (() => Modifier);
      }>;
      const binding = bindings[address.bindingIndex];
      if (!binding) {
        throw new Error(
          `def "${address.contentId}" has no binding at index ${address.bindingIndex}`,
        );
      }

      // Factory bindings produce a fresh modifier per call — the walker's
      // snapshot cannot match the instance actually living in the chain.
      // indexInChain is -1 in that case (see walk-content.ts resolution).
      // TODO(expansion): a binding→chain-index map inside the effect systems
      // would let this case resolve to the live modifier; punted until a
      // consumer asks.
      if (entry.indexInChain < 0) {
        throw new Error(
          `content: binding "${address.contentType}.${address.contentId}[${address.bindingIndex}]` +
            `" uses a factory modifier and cannot be located in the live chain`,
        );
      }

      const chain = binding.chain;
      const old = chain.modifiers[entry.indexInChain];
      if (!old) {
        throw new Error(
          `content: live modifier missing at chain "${chain.id}" index ${entry.indexInChain}`,
        );
      }
      return mutateChain(chain, old, perturbation);
    }
  }
}

function mutateChain(
  chain: ModifierChain,
  original: Modifier,
  perturbation: Perturbation,
): () => void {
  const wrapped = wrapModifier(original, perturbation);
  chain.remove(original);
  chain.add(wrapped);

  let cleaned = false;
  return () => {
    if (cleaned) return;
    cleaned = true;
    chain.remove(wrapped);
    chain.add(original);
  };
}

/**
 * Chain-level perturbation: append a freestanding scalar modifier to the
 * chain's tail and return a cleanup that removes it. Unlike `mutateChain`
 * there's no "original" to swap with — the wrapper composes on whatever
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
