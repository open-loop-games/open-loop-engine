/**
 * Picker — walk engine state to enumerate addressable choices for solvers
 * and UIs. `createPickerSnapshot` runs the discovery walkers (effect-system,
 * chain-registry, tunables), dedupes modifier entries by `Modifier`
 * identity, and exposes the result grouped by discovery layer.
 */

export type {
  PickerWalker,
  PickerAddress,
  ModifierPickerAddress,
  TunablePickerAddress,
  PickerEntry,
  ModifierPickerEntry,
  TunablePickerEntry,
  PickerSnapshot,
} from './types';
export { walkChainRegistry } from './walk-chain-registry';
export { walkEffectSystemBindings } from './walk-effect-system-bindings';
export { walkTunables } from './walk-tunables';
export { createPickerSnapshot } from './merge';
