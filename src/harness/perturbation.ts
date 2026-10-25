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
 *   the effect system wraps the def's lowered grant in every activation while
 *   the perturbation is active. A live activation is swapped in place, a
 *   later one binds wrapped, expiry removes whatever is live, and cleanup
 *   swaps the originals back in place. Factory-form grants are covered,
 *   because the wrap applies to whatever the grant resolves to.
 *
 * - **Chain-registry entries** (`address.walker: 'chain-registry'`) —
 *   in-place swap: `chain.replace(target, wrapped)`, and cleanup swaps
 *   the target back while the wrapper is still in the chain. A
 *   `modifier-index` entry resolves its target by identity when the
 *   discovered modifier is in the chain, else by its recorded index. A
 *   `chain-apply` entry appends a freestanding scalar modifier instead.
 *
 * - **Tunable entries** (`kind: 'tunable'`) — scoped override:
 *   capture the current resolved value at apply time, then
 *   `registry.pushOverrides('perturbation', { [key]: () => transformed })`.
 *   Cleanup is the scoped override's idempotent cleanup. The tuning registry
 *   is looked up at apply time via `engine.tryInject(TuningRegistriesKey)`.
 *   The entry holds `registryId: string`, not a tuning registry reference,
 *   so perturbing a scratch engine leaves the live engine unchanged.
 *
 * The modifier wrapper composes on top of the original
 * (`wrapped.apply(g) = original.apply(g) * F` for scalar-multiply), and
 * perturbing an already-perturbed address composes on top of the active
 * perturbation; cleanups unwind in any order. Every kind returns the same
 * `() => void` idempotent cleanup, so a balance workbench handles
 * them uniformly.
 *
 * Composition note: a `tunable()` value that feeds a `ModifierChain` can
 * be perturbed via either path. Applying both composes multiplicatively,
 * which differs from perturbing one path twice. A balance workbench can
 * show both paths, so the designer picks the intended one.
 */

import type { Engine } from '@/engine';
import type { Modifier, ModifierChain } from '@/core/modifier';
import {
  createWrapStack,
  isSlotBound,
  wrapBinding,
  type ModifierWrap,
  type WrapStack,
} from '@/systems/binding-slots';
import { Decimal, type DecimalSource } from '@/primitives/decimal';
import { ChainRegistryKey, EffectSystemRegistryKey } from '@/core/registries';
import { TuningRegistriesKey } from '@/core/override-registry';
import type { PickerEntry } from './picker';
import { effectDefGrants } from './walk';

/** Scalar transform applied on top of an existing modifier or tunable value. */
export type Perturbation =
  | { kind: 'scalar-multiply'; factor: DecimalSource }
  | { kind: 'scalar-add'; delta: DecimalSource };

/**
 * Apply `perturbation` to the address identified by `entry` and return an
 * idempotent cleanup that reverses the mutation. A balance workbench
 * calls this on every sensitivity headless run (against its scratch engine)
 * and on commit (against the live engine).
 *
 * Dispatches on the entry's address:
 * - `'effect-system'` — wraps the effect def's grant, live and future
 *   activations alike, each in its own chain position.
 * - `'chain-registry'` — swaps the addressed modifier for its wrapper in
 *   place (`modifier-index`), or appends a scalar modifier (`chain-apply`).
 * - `'tunable'` — a scoped override that captures the current resolved value.
 *
 * Perturbing a perturbed address composes on top of the active
 * perturbation. Cleanup restores the exact value and chain order, and
 * leaves a lowered grant whose effect ended meanwhile out of its chain.
 *
 * @param engine - The engine to apply against. For modifier entries the
 *   target is resolved via `ChainRegistryKey` or `EffectSystemRegistryKey`;
 *   for tunable entries the tuning registry is resolved via
 *   `TuningRegistriesKey`. Cross-engine: the entry can be discovered
 *   against one engine and applied to another (e.g. live → scratch engine),
 *   because addresses are string-keyed, not object-keyed. A
 *   `modifier-index` entry applied across engines, or after its chain
 *   changed shape, falls back to its recorded index. Refresh the snapshot
 *   when the chain changes.
 * @param entry - The {@link PickerEntry} naming the address to perturb.
 * @param perturbation - Scalar transform applied on top of the current
 *   value (multiply or add).
 * @returns Idempotent cleanup function — calling it once reverses the
 *   perturbation; subsequent calls are no-ops.
 * @throws {Error} when the entry cannot resolve on `engine` (missing
 *   registries, unknown chain or effect-system ids, a def or grant index
 *   that does not exist, no modifier at a chain index, unknown tunable
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

  // Capture baseline at apply time — reads through whatever scoped overrides
  // are active, so re-perturbing while a perturbation is already active
  // composes on top of the active override's value (consistent with
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
      return wrapChainModifier(chain, target, (m) => wrapModifier(m, perturbation));
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
      if (address.grantIndex >= effectDefGrants(def).length) {
        throw new Error(`def "${address.defId}" has no grant at index ${address.grantIndex}`);
      }
      return wrapBinding(system, address.defId, address.grantIndex, (m) =>
        wrapModifier(m, perturbation),
      );
    }
  }
}

/**
 * The modifier a `modifier-index` entry names in `chain`: the discovered
 * object itself while it is still there, else whatever is at the recorded
 * index — the only reference a cross-engine apply has. Refuses a slot-bound
 * modifier there, as the picker does: its effect would strand the wrapper.
 */
function resolveChainTarget(chain: ModifierChain, discovered: Modifier, index: number): Modifier {
  if (chain.modifiers.includes(discovered)) return discovered;
  const atIndex = chain.modifiers[index];
  if (!atIndex) throw new Error(`chain "${chain.id}" has no modifier at index ${index}`);
  if (isSlotBound(atIndex)) {
    throw new Error(
      `chain "${chain.id}" index ${index} now holds a modifier in a binding slot; perturb it through its effect-system picker entry`,
    );
  }
  return atIndex;
}

/** One chain modifier's active perturbations. */
interface ChainWrap {
  original: Modifier;
  wraps: WrapStack;
  /** The object currently standing in the chain for `original`. */
  live: Modifier;
}

/** Live wrapper → its chain wrap, so perturbing a perturbed modifier composes on the same stack. */
const chainWraps = new WeakMap<Modifier, ChainWrap>();

/** Swap `target` for its wrapped modifier in place; the cleanup swaps back while the wrapper is still there. */
function wrapChainModifier(chain: ModifierChain, target: Modifier, wrap: ModifierWrap): () => void {
  let chainWrap = chainWraps.get(target);
  if (chainWrap == null) {
    const created: ChainWrap = {
      original: target,
      wraps: createWrapStack(() => reseatChainWrap(chain, created)),
      live: target,
    };
    chainWrap = created;
  }
  return chainWrap.wraps.push(wrap);
}

/** Swap the chain wrap's live object for its current composition, in place; a no-op once it has left the chain. */
function reseatChainWrap(chain: ModifierChain, chainWrap: ChainWrap): void {
  const next = chainWrap.wraps.compose(chainWrap.original);
  if (!chain.replace(chainWrap.live, next)) return;
  chainWraps.delete(chainWrap.live);
  chainWrap.live = next;
  if (chainWrap.wraps.size > 0) chainWraps.set(next, chainWrap);
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
      apply: (value: DecimalSource) => Decimal.times(value, factor),
      invert: (value: DecimalSource) => Decimal.div(value, factor),
    };
  }
  const { delta } = perturbation;
  return {
    apply: (value: DecimalSource) => Decimal.add(value, delta),
    invert: (value: DecimalSource) => Decimal.sub(value, delta),
  };
}

function wrapModifier(original: Modifier, perturbation: Perturbation): Modifier {
  if (perturbation.kind === 'scalar-multiply') {
    const { factor } = perturbation;
    return {
      apply: (value: DecimalSource) => Decimal.times(original.apply(value), factor),
      invert: original.invert
        ? (value: DecimalSource) => original.invert!(Decimal.div(value, factor))
        : undefined,
      enabled: original.enabled,
      description: original.description,
    };
  }

  const { delta } = perturbation;
  return {
    apply: (value: DecimalSource) => Decimal.add(original.apply(value), delta),
    invert: original.invert
      ? (value: DecimalSource) => original.invert!(Decimal.sub(value, delta))
      : undefined,
    enabled: original.enabled,
    description: original.description,
  };
}
