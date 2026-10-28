/**
 * Flags — the game's named booleans, which a `flag` Gate, condition and effect
 * read and write.
 *
 * - {@link createFlag} with `{ id }` makes a saved flag: a boolean the game
 *   sets, saved under the enclosing persistent context. No reset clears it.
 *   A flag that should reset is a derived flag over state that resets.
 * - {@link createFlag} with `{ id, value }` makes a derived flag: read-only,
 *   over game state. A `flag` effect on it throws.
 *
 * Both register into the engine's flag registry, where the default game-state
 * accessor and the `flag` Gate read them. Flag ids are unique per engine.
 */

import { computed, unref } from 'vue';
import { toMaybeRef, type Computable } from './computed';
import { persistent } from './persistence';
import { getCurrentFlagRegistry } from './registries';

// === TYPES ===

/** A named boolean in the engine's flag registry. */
export interface Flag {
  readonly id: string;
  /** Whether the flag is set. Reactive. */
  readonly value: boolean;
  /** True for a flag derived from game state, which no `flag` effect can set. */
  readonly derived: boolean;
}

/** A flag the game sets, saved. */
export interface SavedFlag extends Flag {
  value: boolean;
  readonly derived: false;
}

/** A read-only flag over game state. */
export interface DerivedFlag extends Flag {
  readonly derived: true;
}

/** Options for a saved flag. */
export interface SavedFlagOptions {
  /** The flag id, unique per engine, and the save key under the enclosing persistent context. */
  id: string;
}

/** Options for a derived flag. */
export interface DerivedFlagOptions {
  /** The flag id, unique per engine. */
  id: string;
  /** Whether the flag holds. Can be a ref or a getter, for a reactive value. */
  value: Computable<boolean>;
}

// === FACTORY ===

/**
 * Create a flag: a named boolean that `flag` Gates, conditions and effects
 * reach by id through the engine's flag registry.
 *
 * @param options `{ id }` for a saved flag the game sets, or `{ id, value }`
 *   for a read-only flag derived from game state.
 * @returns the flag, also registered into the ambient flag registry. A saved
 *   flag's `value` is settable.
 *
 * @example
 * ```ts
 * install() {
 *   const seenShop = createFlag({ id: 'seen-shop' });
 *   createFlag({ id: 'rich', value: () => Decimal.gte(gold.value, 1000) });
 *   // a Gate elsewhere: { kind: 'flag', id: 'rich' }
 *   seenShop.value = true;
 * }
 * ```
 */
export function createFlag(options: SavedFlagOptions): SavedFlag;
export function createFlag(options: DerivedFlagOptions): DerivedFlag;
export function createFlag(
  options: SavedFlagOptions | DerivedFlagOptions,
): SavedFlag | DerivedFlag {
  const flag = 'value' in options ? buildDerivedFlag(options) : buildSavedFlag(options);
  getCurrentFlagRegistry()?.register(flag);
  return flag;
}

// === PRIVATE BUILDERS ===

function buildSavedFlag({ id }: SavedFlagOptions): SavedFlag {
  // Lifetime, so a reset of the persistent context leaves it set.
  const saved = persistent<boolean>(false, { id, lifetime: true });
  return {
    id,
    derived: false,
    get value() {
      return saved.value;
    },
    set value(next: boolean) {
      saved.value = next;
    },
  };
}

function buildDerivedFlag({ id, value }: DerivedFlagOptions): DerivedFlag {
  const source = toMaybeRef(value);
  const holds = computed(() => unref(source));
  return {
    id,
    derived: true,
    get value() {
      return holds.value;
    },
  };
}
