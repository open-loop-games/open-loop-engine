/**
 * Notation system — re-exports eternal_notations as the engine's notation layer.
 *
 * Eternal Notations provides 65+ notation classes and 144 presets covering the
 * full break_eternity.js range (up to 10^^10^308). The engine re-exports the
 * key types and presets so consumers can import from `open-loop-engine` directly.
 *
 * @see https://github.com/MathCookie17/Eternal-Notations
 */

import { Notation as _Notation } from 'eternal_notations';

/**
 * Abstract base class for notation formats — re-exported from
 * `eternal_notations`. Implementing classes (Standard, Scientific, Engineering,
 * and 60+ others) plug into {@link NotationManager} via `register(name, instance)`.
 */
export const Notation = _Notation;
/** Instance type of {@link Notation}. */
export type Notation = InstanceType<typeof _Notation>;

export { Presets, HTMLPresets } from 'eternal_notations';
