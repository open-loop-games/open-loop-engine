/**
 * Ambient game-state-accessor context — one of the cross-cutting ambient scopes
 * `createEngine` sets around `install()` / `connect()`, alongside the chain,
 * effect-system, resource and tuning registries, the engine categories, and
 * the persistence namespace.
 *
 * Problem it solves: `GameStateAccessor` (and its write-side partner
 * `GameStateMutator`) were previously threaded explicitly via options on
 * category factories (e.g., `createChallengeCategory`). Every new category
 * factory had to remember to wire the accessor through, and closure-timing
 * bugs were structurally possible when the accessor wasn't yet available
 * at category-creation time.
 *
 * Mechanism: {@link createEngine} accepts a consumer-supplied accessor in its
 * config and wraps `install()` / `connect()` in {@link withGameStateAccessor}.
 * Category factories read the ambient via {@link getCurrentGameStateAccessor}
 * as a fallback when no per-category option is provided.
 *
 * The accessor is a stateless vtable of forwards: its methods close over
 * module-exported functions and call them lazily. Construction has zero side
 * effects and reads zero module state, so it can be constructed before any
 * module installs.
 */

import type { GameStateAccessor } from '@/primitives/types';
import type { GameStateMutator } from './effects';

/** Combined accessor + mutator — every consumer unifies these into one object. */
export type GameStateAccessorMutator = GameStateAccessor & GameStateMutator;

// === AMBIENT CURRENT-ACCESSOR CONTEXT ===
let _current: GameStateAccessorMutator | undefined;

/**
 * Run `fn` with `accessor` set as the ambient game-state accessor. Category
 * factories called inside `fn` can read it via
 * {@link getCurrentGameStateAccessor}.
 *
 * Used by {@link createEngine} to scope accessor availability to the current
 * engine during its `install()` / `connect()` phases. Nested calls save and
 * restore the previous ambient so multiple engines starting concurrently
 * don't stomp each other.
 *
 * Accepts `undefined` for engines that don't use an accessor (tests, engine-
 * only workbenches). In that case `getCurrentGameStateAccessor()` returns
 * `undefined` inside `fn`, and the previous ambient is restored on exit.
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
