/**
 * Inventory system — game-dev-friendly wrapper over ResourceBag
 *
 * Provides per-item capacity via modifier chains, with intuitive
 * vocabulary (add/subtract/canFit/isFull) instead of raw bag operations.
 */

import { computed, unref, type ComputedRef } from 'vue';
import { toMaybeRef, type Computable } from '@/core/computed';
import { Decimal } from '@/primitives/decimal';
import type { DecimalSource } from '@/primitives/decimal';
import { createResourceBag, type ResourceBag } from '@/core/resource-bag';
import { createPersistentContextScopedResource, type Resource } from '@/core/resource';
import { withPersistentContext } from '@/core/persistence';
import { attachPersistentContextReset } from '@/core/resettable';
import { createModifierChain, type Modifier } from '@/core/modifier';

// === TYPES ===

/** Options for {@link createInventory} — capacity, overflow behavior, and the initial item list. */
export interface InventoryOptions {
  id: string;
  /** Per-item capacity before the capacity chain. Can be a ref or getter, for a tunable or an upgradeable capacity. */
  baseCapacity: Computable<DecimalSource>;
  /** What happens when adding beyond capacity (default: 'block') */
  overflow?: 'block' | 'discard';
  /** Optional total capacity across all items, like a weight limit. Can be a ref or getter. */
  totalCapacity?: Computable<DecimalSource>;
  /** Display name for UI */
  displayName?: string;
  /** Initial item amounts */
  initial?: Record<string, DecimalSource>;
  /**
   * Known item ids for automatic persistence.
   * When provided, creates a persistent Resource ref per item, linked into
   * the bag, so the engine's persistence saves and loads the inventory.
   * Each saves under its item id in the inventory's persistent context and
   * registers as `${inventoryId}/${itemId}`, so inventories sharing item ids
   * coexist.
   */
  items?: string[];
}

/**
 * Inventory instance created by {@link createInventory}. Wraps a
 * {@link ResourceBag} with capacity-aware add/subtract operations, item
 * accessors, and optional automatic persistence for known item ids.
 */
export interface Inventory {
  readonly id: string;
  /** Underlying ResourceBag, for advanced use */
  readonly bag: ResourceBag;

  // --- Item operations ---
  get(itemId: string): Decimal;
  /** Add up to the item's room. Returns the amount added, or `0` when none was. */
  add(itemId: string, amount: DecimalSource): Decimal | 0;
  /** Returns the amount subtracted, or `0` when none was. */
  subtract(itemId: string, amount: DecimalSource): Decimal | 0;
  has(itemId: string, amount: DecimalSource): boolean;
  hasAll(requirements: Record<string, DecimalSource>): boolean;
  canFit(itemId: string, amount: DecimalSource): boolean;
  items(): string[];
  isEmpty(): boolean;
  clear(): void;

  // --- Capacity ---
  /** Current evaluated per-item capacity (reactive) */
  capacity: ComputedRef<Decimal>;
  /** Add a modifier to the per-item capacity chain; returns its cleanup. */
  addCapacityModifier(modifier: Modifier): () => void;
  /** How much more of this item can fit */
  remainingSpace(itemId: string): Decimal;
  /** Is the inventory full for a specific item, or overall if no itemId */
  isFull(itemId?: string): boolean;

  // --- Persistence ---
  /**
   * When `items` was provided, the underlying persistent Resource refs
   * keyed by item id. Persistence saves them. Each resource's `id` (the id
   * Gates, analyzers and the resource registry use) is
   * `${inventoryId}/${itemId}`; its `displayName` is the item id.
   */
  readonly resources: ReadonlyMap<string, Resource<DecimalSource>>;
  /** Manual serialization — only needed when NOT using items-based persistence */
  serialize(): Record<string, string>;
  /** Write back a {@link serialize} record — only needed when NOT using items-based persistence */
  restore(data: Record<string, string>): void;
}

// === FACTORIES ===

/**
 * Creates a game inventory with per-item capacity driven by modifier chains,
 * backed by a ResourceBag with optional automatic persistence.
 *
 * @param options - Inventory options: base capacity, overflow behavior,
 *   and an optional `items` array that creates a persistent Resource ref per item type
 * @returns An inventory with add/subtract/has/canFit operations, reactive capacity via
 *   `addCapacityModifier()`, and access to linked Resource refs for UI binding
 *
 * @example
 * ```ts
 * const inv = createInventory({
 *   id: 'backpack',
 *   baseCapacity: 50,
 *   items: ['wood', 'stone', 'iron'],
 * });
 * inv.add('wood', 10);
 * inv.addCapacityModifier(createAdditiveModifier({ addend: 20 }));
 * ```
 */
export function createInventory(options: InventoryOptions): Inventory {
  const {
    id,
    baseCapacity,
    overflow = 'block',
    totalCapacity,
    displayName = id,
    initial = {},
    items,
  } = options;

  // --- Capacity modifier chain ---
  // A named `{id}/capacity` chain rather than a hand-rolled reactive array:
  // it registers in the chain registry (so the balance harness and devtools
  // can attribute each capacity modifier), composes reactively, and returns
  // a cleanup on add. Matches Producer/Skill chain wiring.
  const capacityChain = createModifierChain(`${id}/capacity`);

  const processedBaseCapacity = toMaybeRef(baseCapacity);
  const capacity: ComputedRef<Decimal> = computed(() =>
    Decimal.fromValue(capacityChain.apply(unref(processedBaseCapacity))),
  );

  // --- Underlying bag with reactive per-item cap ---
  const bag = createResourceBag({
    initial,
    capacity: totalCapacity,
    overflow,
    displayName,
  });

  // --- Auto-persistence via linked Resource refs ---
  const linkedResources = new Map<string, Resource<DecimalSource>>();
  if (items) {
    withPersistentContext(id, () => {
      for (const itemId of items) {
        const initialCount = initial[itemId] ?? 0;
        // Saved as the bare item id inside the inventory's persistent context; the
        // engine-unique id is qualified so inventories can share item ids.
        const resource = createPersistentContextScopedResource<DecimalSource>(
          initialCount,
          { id: `${id}/${itemId}`, displayName: itemId },
          itemId,
        );
        bag.link(itemId, resource);
        linkedResources.set(itemId, resource);
      }
    });
  }

  function remainingForItem(itemId: string): Decimal {
    const current = bag.get(itemId);
    const perItemRemaining = Decimal.max(Decimal.sub(capacity.value, current), 0);
    const totalRemaining = bag.remainingCapacity();
    return new Decimal(Decimal.min(perItemRemaining, totalRemaining));
  }

  const inventory: Inventory = {
    id,
    bag,

    get(itemId: string): Decimal {
      return bag.get(itemId);
    },

    add(itemId: string, amount: DecimalSource): Decimal | 0 {
      const toAdd = new Decimal(amount);
      const room = remainingForItem(itemId);

      if (overflow === 'block') {
        if (toAdd.gt(room)) return 0;
        return bag.add(itemId, toAdd);
      } else {
        const actual = Decimal.min(toAdd, room);
        if (!Decimal.gt(actual, 0)) return 0;
        return bag.add(itemId, actual);
      }
    },

    subtract(itemId: string, amount: DecimalSource): Decimal | 0 {
      return bag.subtract(itemId, amount);
    },

    has(itemId: string, amount: DecimalSource): boolean {
      return bag.has(itemId, amount);
    },

    hasAll(requirements: Record<string, DecimalSource>): boolean {
      return bag.hasAll(requirements);
    },

    canFit(itemId: string, amount: DecimalSource): boolean {
      const toAdd = new Decimal(amount);
      return remainingForItem(itemId).gte(toAdd);
    },

    items(): string[] {
      return bag.types();
    },

    isEmpty(): boolean {
      return bag.isEmpty();
    },

    clear(): void {
      bag.clear();
    },

    capacity,
    resources: linkedResources,

    addCapacityModifier(modifier: Modifier): () => void {
      return capacityChain.add(modifier);
    },

    remainingSpace(itemId: string): Decimal {
      return remainingForItem(itemId);
    },

    isFull(itemId?: string): boolean {
      // `!gt(0)` keeps an indeterminate remaining capacity reading as *full*,
      // which is the direction that refuses the add rather than admitting one
      // it can't size.
      if (itemId != null) {
        return !remainingForItem(itemId).gt(0);
      }
      return !bag.remainingCapacity().gt(0);
    },

    serialize(): Record<string, string> {
      return bag.serialize();
    },

    restore(data: Record<string, string>): void {
      bag.restore(data);
    },
  };

  // Only known items persist, under the inventory's own persistent context.
  return items ? attachPersistentContextReset(inventory, id) : inventory;
}
