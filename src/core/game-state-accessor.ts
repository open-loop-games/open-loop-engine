/**
 * Ambient game-state accessor — one of the cross-cutting ambient values
 * `createEngine` sets around `install()` / `connect()`. The others are the
 * chain, effect-system, resource and tuning registries, the engine categories,
 * and the persistence namespace.
 *
 * Why it is ambient: threading `GameStateAccessor` (and its write-side partner
 * `GameStateMutator`) through each category factory's options (e.g.
 * `createChallengeCategory`) makes every factory wire it through. It also
 * allows closure-timing bugs when the accessor isn't available yet at
 * category creation.
 *
 * Mechanism: {@link createEngine} accepts a consumer-supplied accessor in its
 * options and wraps `install()` / `connect()` in {@link withGameStateAccessor}.
 * Category factories read the ambient value via {@link getCurrentGameStateAccessor}
 * as a fallback when no per-category option is provided.
 *
 * The accessor is a stateless vtable of forwards: its methods close over
 * exported functions and call them lazily. Construction has no side effects
 * and reads no file-level state, so it can be built before any module installs.
 */

import type { GameStateAccessor } from '@/primitives/types';
import type { GameStateMutator } from './effects';

/** Combined accessor + mutator — every consumer unifies these into one object. */
export type GameStateAccessorMutator = GameStateAccessor & GameStateMutator;

// === AMBIENT ACCESSOR ===
let _current: GameStateAccessorMutator | undefined;

/**
 * Run `fn` with `accessor` set as the ambient game-state accessor. Category
 * factories called inside `fn` can read it via
 * {@link getCurrentGameStateAccessor}.
 *
 * Used by {@link createEngine} to limit the accessor to that engine during its
 * `install()` / `connect()` phases. Nested calls save and restore the previous
 * ambient value, so engines starting concurrently don't overwrite each other's.
 *
 * Accepts `undefined` for engines that don't use an accessor (tests, engine-
 * only workbenches). In that case `getCurrentGameStateAccessor()` returns
 * `undefined` inside `fn`, and the previous ambient value is restored on exit.
 */
export function withGameStateAccessor<T>(
  accessor: GameStateAccessorMutator | undefined,
  fn: () => T,
): T {
  const prev = _current;
  _current = accessor;
  try {
    return fn();
  } finally {
    _current = prev;
  }
}

/**
 * Read the current ambient game-state accessor, if any. Returns `undefined`
 * when called outside a `withGameStateAccessor` block (e.g., tests that
 * construct categories in isolation).
 */
export function getCurrentGameStateAccessor(): GameStateAccessorMutator | undefined {
  return _current;
}
