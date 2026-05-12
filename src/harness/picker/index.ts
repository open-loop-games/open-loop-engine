/**
 * Picker — walk engine state to enumerate addressable choices for solvers
 * and UIs. `createPickerSnapshot` runs the discovery walkers (content,
 * chain-registry, tunables), dedupes modifier entries by `Modifier`
 * identity, and exposes the result grouped by discovery layer.
 */

export type {
  PickerSource,
  PickerAddress,
  ModifierPickerAddress,
  TunablePickerAddress,
  PickerEntry,
  ModifierPickerEntry,
  TunablePickerEntry,
  PickerSnapshot,
} from './types';
export { walkChainRegistry } from './walk-chain-registry';
export { walkContent } from './walk-content';
export { walkTunables } from './walk-tunables';
export { createPickerSnapshot } from './merge';
