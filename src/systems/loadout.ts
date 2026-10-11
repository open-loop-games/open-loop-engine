/**
 * Loadout system — constrained persistent selection from a pool
 *
 * Manages "pick N from M" selection mechanics: equipped gear, prepared spells,
 * a chosen home, a set of passive modifiers. Each loadout tracks which items are
 * selected, enforces capacity and pool constraints, and saves the selection.
 *
 * Key features:
 * - Single-select (radio-button) and multi-select modes
 * - Optional pool constraint with reactive updates
 * - Custom `canSelect` predicate for extra blocking rules (exclusions across loadouts, unlock conditions)
 * - `onSelect`/`onDeselect` option callbacks for wiring modifiers, VFX, or side effects
 * - Insertion-order preservation (matters for queue-ordered systems)
 * - Snapshot/restore for saving a loadout
 * - Restores, loads and resets revalidate the selection and bring the option callbacks in line
 *
 * The loadout manages **selection state only**. It does not know what the selected
 * items *are* — consumers map item ids to defs, modifiers, and effects.
 *
 * @example
 * ```ts
 * // Single-select: one chosen home
 * const housing = createLoadout({
 *   id: 'housing',
 *   mode: 'single',
 *   pool: ['tent', 'cabin', 'apartment', 'penthouse'],
 *   onSelect: (id) => housingModifiers.get(id)!.enable(),
 *   onDeselect: (id) => housingModifiers.get(id)!.disable(),
 * });
 * housing.select('cabin'); // auto-deselects previous
 *
 * // Multi-select: support spells with growing capacity
 * const support = createLoadout({
 *   id: 'support',
 *   mode: 'multi',
 *   maxSelections: () => 2 + purchasedCapacity.value,
 *   pool: () => unlockedSpells.value,
 * });
 * support.select('fireball');
 * support.select('iceShield');
 * ```
 */

import { computed, unref, type ComputedRef } from 'vue';
import { Decimal, type DecimalSource } from '@/primitives/decimal';
import { toMaybeRef, type Computable } from '@/core/computed';
import { onHydrated, persistent, withPersistentContext } from '@/core/persistence';
import { createEmitHandle, type Emittable } from '@/core/events';
import { attachPersistentContextReset } from '@/core/resettable';

// === TYPES ===

/** Options for {@link createLoadout}. */
export interface LoadoutOptions {
  /** Unique id; the persistent context id is `loadout:${id}` */
  id: string;
  /**
   * Selection behavior.
   * - `'single'`: at most one item selected; selecting a new item auto-deselects the previous
   * - `'multi'`: multiple items up to `maxSelections`
   */
  mode: 'single' | 'multi';
  /**
   * Maximum concurrent selections for multi-select mode.
   * Ignored for single mode (always 1). Can be a ref or getter for dynamic capacity
   * (e.g., growing via purchases). Default: `Infinity`.
   */
  maxSelections?: Computable<DecimalSource>;
  /**
   * Valid item ids for this loadout. Can be a ref or getter for dynamic pools
   * (e.g., unlockable items). If omitted, any string id is accepted.
   */
  pool?: Computable<string[]>;
  /** Additional constraint beyond pool membership and capacity */
  canSelect?: (itemId: string) => boolean;
  /**
   * Called after an item is successfully selected. Use for ephemeral side
   * effects: modifier wiring, VFX. It is also called once a load or reset
   * settles, and after {@link Loadout.restore}, for each selected item whose
   * side effect isn't applied yet. So it must not grant game state.
   */
  onSelect?: (itemId: string) => void;
  /**
   * Called after an item is successfully deselected, and for an applied item
   * a load, reset or restore removed. Use to remove the modifier wiring.
   */
  onDeselect?: (itemId: string) => void;
}

/** Events emitted by a {@link Loadout}. */
export interface LoadoutEvents {
  /** Fired after an item is selected */
  selected: (itemId: string) => void;
  /** Fired after an item is deselected (including auto-deselect in single mode) */
  deselected: (itemId: string) => void;
  /** Fired after all items are deselected via {@link Loadout.deselectAll} */
  cleared: () => void;
}

/**
 * A constrained persistent selection from a pool, created by {@link createLoadout}.
 *
 * Tracks which items are selected, enforces capacity and pool constraints,
 * emits events on selection changes, and saves the selection.
 */
export interface Loadout {
  readonly id: string;
  readonly mode: 'single' | 'multi';

  /** Selected item ids in insertion order (saved) */
  readonly selected: ComputedRef<readonly string[]>;
  /** Number of selected items */
  readonly count: ComputedRef<number>;
  /** Whether the loadout is at capacity */
  readonly isFull: ComputedRef<boolean>;
  /** First selected item, or null. The main read for single-select mode. */
  readonly current: ComputedRef<string | null>;

  /** Check if an item is currently selected. Reactive when called inside computed/watch. */
  isSelected(itemId: string): boolean;
  /** Check if an item can be selected (pool + capacity + predicate). */
  canSelect(itemId: string): boolean;

  /**
   * Select an item. In single mode, auto-deselects the current item first.
   * @returns `true` if the item was selected, `false` if validation failed
   */
  select(itemId: string): boolean;
  /**
   * Deselect an item.
   * @returns `true` if the item was deselected, `false` if it wasn't selected
   */
  deselect(itemId: string): boolean;
  /** Deselect all items. Fires `deselected` per item, then `cleared`. */
  deselectAll(): void;
  /**
   * Toggle an item: select if not selected, deselect if selected.
   * @returns the new isSelected state
   */
  toggle(itemId: string): boolean;

  /** Copy of current selections for loadout saving */
  snapshot(): string[];
  /**
   * Bulk-replace selections from a {@link snapshot}. Silently skips invalid
   * ids and keeps only as many as the capacity allows. Then it brings the
   * option callbacks in line. It calls `onDeselect` for each applied item not
   * selected after the restore, then `onSelect` for each selected item not yet
   * applied. It emits no events: a restored loadout is state, not a player
   * action.
   * Loads and resets do the same on their own.
   */
  restore(ids: string[]): void;

  on: Emittable<LoadoutEvents>['on'];
}

// === FACTORIES ===

/**
 * Creates a loadout — a constrained persistent selection from a pool.
 *
 * @param options - Loadout options: mode, capacity, pool, constraints, and option callbacks
 * @returns A {@link Loadout} with reactive state, validation, mutation methods,
 *   snapshot/restore for loadout saving, and events for side-effect wiring
 *
 * @example
 * ```ts
 * const focus = createLoadout({ id: 'focus', mode: 'single', pool: allSpells });
 * focus.select('fireball');
 * focus.current.value; // 'fireball'
 *
 * const support = createLoadout({ id: 'support', mode: 'multi', maxSelections: 3 });
 * support.select('heal');
 * support.select('shield');
 * support.count.value; // 2
 * ```
 */
export function createLoadout(options: LoadoutOptions): Loadout {
  const { id, mode } = options;

  // --- Resolve reactive options ---
  const processedMax = mode === 'single' ? 1 : toMaybeRef(options.maxSelections ?? Decimal.dInf);
  const processedPool = options.pool != null ? toMaybeRef(options.pool) : undefined;

  // --- Persistence ---
  const contextId = `loadout:${id}`;
  const _selected = withPersistentContext(contextId, () =>
    persistent<string[]>([], { id: 'selected' }),
  );

  // --- Events ---
  const handle = createEmitHandle<LoadoutEvents>();

  // --- Internal helpers ---

  function resolvedMax(): number {
    if (mode === 'single') return 1;
    return new Decimal(unref(processedMax)).toNumber();
  }

  function resolvedPool(): string[] | undefined {
    return processedPool != null ? unref(processedPool) : undefined;
  }

  function isInPool(itemId: string): boolean {
    const pool = resolvedPool();
    return pool == null || pool.includes(itemId);
  }

  // Items whose onSelect side effect is in place, so resync can undo exactly
  // those a load, reset or restore removed.
  const applied = new Set<string>();

  function internalDeselect(itemId: string): boolean {
    const idx = _selected.value.indexOf(itemId);
    if (idx === -1) return false;
    const next = [..._selected.value];
    next.splice(idx, 1);
    _selected.value = next;
    applied.delete(itemId);
    options.onDeselect?.(itemId);
    handle.emit('deselected', itemId);
    return true;
  }

  // --- Computed derivations ---

  const selected = computed(() => _selected.value as readonly string[]);
  const count = computed(() => _selected.value.length);
  const isFull = computed(() => _selected.value.length >= resolvedMax());
  const current = computed(() => _selected.value[0] ?? null);

  // --- Public API ---

  function isSelected(itemId: string): boolean {
    return _selected.value.includes(itemId);
  }

  function canSelectItem(itemId: string): boolean {
    if (isSelected(itemId)) return false;
    if (!isInPool(itemId)) return false;
    // Single mode auto-replaces, so capacity doesn't block it
    if (mode === 'multi' && count.value >= resolvedMax()) return false;
    if (options.canSelect && !options.canSelect(itemId)) return false;
    return true;
  }

  function selectItem(itemId: string): boolean {
    if (mode === 'single') {
      if (isSelected(itemId)) return false;
      if (!isInPool(itemId)) return false;
      if (options.canSelect && !options.canSelect(itemId)) return false;
      if (_selected.value.length > 0) {
        internalDeselect(_selected.value[0]);
      }
    } else {
      if (!canSelectItem(itemId)) return false;
    }

    _selected.value = [..._selected.value, itemId];
    applied.add(itemId);
    options.onSelect?.(itemId);
    handle.emit('selected', itemId);
    return true;
  }

  function deselectItem(itemId: string): boolean {
    return internalDeselect(itemId);
  }

  function deselectAll(): void {
    if (_selected.value.length === 0) return;
    const old = [..._selected.value];
    _selected.value = [];
    for (const itemId of old) {
      applied.delete(itemId);
      options.onDeselect?.(itemId);
      handle.emit('deselected', itemId);
    }
    handle.emit('cleared');
  }

  function toggle(itemId: string): boolean {
    if (isSelected(itemId)) {
      deselectItem(itemId);
      return false;
    } else {
      return selectItem(itemId);
    }
  }

  function snapshot(): string[] {
    return [..._selected.value];
  }

  function validSelection(ids: readonly string[]): string[] {
    const pool = resolvedPool();
    const valid = pool != null ? ids.filter((id) => pool.includes(id)) : [...ids];
    return valid.slice(0, resolvedMax());
  }

  function restore(ids: string[]): void {
    _selected.value = validSelection(ids);
    resync();
  }

  /** Run the hooks that bring the applied side effects in line with the selection. */
  function resync(): void {
    for (const itemId of [...applied]) {
      if (_selected.value.includes(itemId)) continue;
      applied.delete(itemId);
      options.onDeselect?.(itemId);
    }
    for (const itemId of _selected.value) {
      if (applied.has(itemId)) continue;
      applied.add(itemId);
      options.onSelect?.(itemId);
    }
  }

  // A load writes the selection straight into the ref, past the pool and
  // capacity checks; a reset clears it past onDeselect.
  onHydrated(() => {
    const valid = validSelection(_selected.value);
    if (valid.length !== _selected.value.length) _selected.value = valid;
    resync();
  });

  const loadout: Loadout = {
    id,
    mode,
    selected,
    count,
    isFull,
    current,
    isSelected,
    canSelect: canSelectItem,
    select: selectItem,
    deselect: deselectItem,
    deselectAll,
    toggle,
    snapshot,
    restore,
    on: handle.on,
  };
  return attachPersistentContextReset(loadout, contextId);
}
