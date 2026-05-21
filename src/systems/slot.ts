/**
 * Slot system — constrained persistent selection from a pool
 *
 * Manages "pick N from M" selection mechanics: equipment slots, spell slots,
 * dragon auras, housing choices, policy picks. Each slot tracks which items
 * are selected, enforces capacity and pool constraints, and persists state
 * across saves.
 *
 * Key features:
 * - Single-select (radio-button) and multi-select modes
 * - Optional pool constraint with reactive updates
 * - Custom `canSelect` predicate for complex gating (cross-slot exclusions, unlock conditions)
 * - `onSelect`/`onDeselect` hooks for wiring modifiers, VFX, or side effects
 * - Insertion-order preservation (matters for queue-ordered systems)
 * - Snapshot/restore for loadout saving
 *
 * The slot manages **selection state only**. It does not know what the selected
 * items *are* — consumers map item IDs to definitions, modifiers, and effects.
 *
 * @example
 * ```ts
 * // Single-select: one active housing property
 * const housing = createSlot({
 *   id: 'housing',
 *   mode: 'single',
 *   pool: ['tent', 'cabin', 'apartment', 'penthouse'],
 *   onSelect: (id) => housingModifiers.get(id)!.enable(),
 *   onDeselect: (id) => housingModifiers.get(id)!.disable(),
 * });
 * housing.select('cabin'); // auto-deselects previous
 *
 * // Multi-select: support spell slots with growing capacity
 * const supportSlots = createSlot({
 *   id: 'support',
 *   mode: 'multi',
 *   maxSelections: () => 2 + purchasedSlots.value,
 *   pool: () => unlockedSpells.value,
 * });
 * supportSlots.select('fireball');
 * supportSlots.select('iceShield');
 * ```
 */

import { computed, unref, type ComputedRef } from 'vue';
import { Decimal, type DecimalSource } from '@/primitives/decimal';
import { processGetter, type Computable } from '@/core/computed';
import { persistent, withPersistentContext } from '@/core/persistence';
import { createEmitHandle, type Emittable } from '@/core/events';

// === TYPES ===

/** Configuration for {@link createSlot}. */
export interface SlotOptions {
  /** Unique identifier, used as persistence context key */
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
   * Valid item IDs for this slot. Can be a ref or getter for dynamic pools
   * (e.g., unlockable items). If omitted, any string ID is accepted.
   */
  pool?: Computable<string[]>;
  /** Additional constraint beyond pool membership and capacity */
  canSelect?: (itemId: string) => boolean;
  /** Called after an item is successfully selected. Use for modifier wiring, VFX, etc. */
  onSelect?: (itemId: string) => void;
  /** Called after an item is successfully deselected. Use for modifier teardown. */
  onDeselect?: (itemId: string) => void;
}

/** Events emitted by a {@link Slot}. */
export interface SlotEvents {
  /** Fired after an item is selected */
  selected: (itemId: string) => void;
  /** Fired after an item is deselected (including auto-deselect in single mode) */
  deselected: (itemId: string) => void;
  /** Fired after all items are deselected via {@link Slot.deselectAll} */
  cleared: () => void;
}

/**
 * A constrained persistent selection from a pool, created by {@link createSlot}.
 *
 * Tracks which items are selected, enforces capacity and pool constraints,
 * emits events on state changes, and persists across saves.
 */
export interface Slot {
  readonly id: string;
  readonly mode: 'single' | 'multi';

  /** Currently selected item IDs in insertion order (persistent underneath) */
  readonly selected: ComputedRef<readonly string[]>;
  /** Number of currently selected items */
  readonly count: ComputedRef<number>;
  /** Whether the slot is at capacity */
  readonly isFull: ComputedRef<boolean>;
  /** First selected item, or null. Primary accessor for single-select mode. */
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
  /** Bulk-replace selections from a save. Silently skips invalid IDs and truncates to capacity. No events fired. */
  restore(ids: string[]): void;

  on: Emittable<SlotEvents>['on'];
}

// === FACTORIES ===

/**
 * Creates a slot — a constrained persistent selection from a pool.
 *
 * @param options - Slot configuration: mode, capacity, pool, constraints, and hooks
 * @returns A {@link Slot} with reactive state, validation, mutation methods,
 *   snapshot/restore for loadout saving, and events for side-effect wiring
 *
 * @example
 * ```ts
 * const focus = createSlot({ id: 'focus', mode: 'single', pool: allSpells });
 * focus.select('fireball');
 * focus.current.value; // 'fireball'
 *
 * const support = createSlot({ id: 'support', mode: 'multi', maxSelections: 3 });
 * support.select('heal');
 * support.select('shield');
 * support.count.value; // 2
 * ```
 */
export function createSlot(options: SlotOptions): Slot {
  const { id, mode } = options;

  // --- Resolve reactive options ---
  const processedMax = mode === 'single' ? 1 : processGetter(options.maxSelections ?? Decimal.dInf);
  const processedPool = options.pool != null ? processGetter(options.pool) : undefined;

  // --- Persistence ---
  const _selected = withPersistentContext(`slot:${id}`, () =>
    persistent<string[]>([], { name: 'selected' }),
  );

  // --- Events ---
  const handle = createEmitHandle<SlotEvents>();

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

  function internalDeselect(itemId: string): boolean {
    const idx = _selected.value.indexOf(itemId);
    if (idx === -1) return false;
    const next = [..._selected.value];
    next.splice(idx, 1);
    _selected.value = next;
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
    // Single mode auto-replaces, so capacity isn't a gate
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
        internalDeselect(_selected.value[0]!);
      }
    } else {
      if (!canSelectItem(itemId)) return false;
    }

    _selected.value = [..._selected.value, itemId];
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
    for (const itemId of old) {
      options.onDeselect?.(itemId);
      handle.emit('deselected', itemId);
    }
    _selected.value = [];
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

  function restore(ids: string[]): void {
    const pool = resolvedPool();
    const max = resolvedMax();
    const valid = pool != null ? ids.filter((id) => pool.includes(id)) : [...ids];
    _selected.value = valid.slice(0, max);
  }

  return {
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
}

// === TYPE GUARDS ===
