/**
 * Notation — re-exports eternal_notations as the engine's number notations.
 *
 * Eternal Notations provides many notation classes and presets covering the
 * full break_eternity.js range (up to 10^^10^308). The engine re-exports the
 * key types and presets so consumers can import from `@open-loop/engine` directly.
 *
 * @see https://github.com/MathCookie17/Eternal-Notations
 */

import { Notation as _Notation } from 'eternal_notations';

/**
 * Abstract base class for notations — re-exported from
 * `eternal_notations`. Implementing classes (Standard, Scientific, Engineering,
 * and many others) plug into {@link NotationManager} via `register(name, instance)`.
 */
export const Notation = _Notation;
/** Instance type of {@link Notation}. */
export type Notation = InstanceType<typeof _Notation>;

export { Presets, HTMLPresets } from 'eternal_notations';
