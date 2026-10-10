/**
 * Inventory system — game-dev-friendly wrapper over ResourceBag
 *
 * Provides per-item capacity via modifier chains, with intuitive
 * vocabulary (add/remove/canFit/isFull) instead of raw bag operations.
 */

import { computed, type ComputedRef } from 'vue';
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
  /** Unique identifier */
  id: string;
  /** Starting per-item capacity */
  baseCapacity: DecimalSource;
  /** What happens when adding beyond capacity (default: 'block') */
  overflow?: 'block' | 'discard';
  /** Optional total weight-style limit across all items */
  totalCapacity?: DecimalSource;
  /** Display name for UI */
  displayName?: string;
  /** Initial item amounts */
  initial?: Record<string, DecimalSource>;
  /**
   * Known item IDs for auto-persistence.
   * When provided, creates a persistent Resource ref per item, linked into
   * the bag, so inventory state is automatically saved/loaded by the
   * engine's persistence system. Each saves under its item id in the
   * inventory's context and registers as `${inventoryId}/${itemId}`, so
   * inventories sharing item ids coexist.
   */
  items?: string[];
}

/**
 * Inventory instance created by {@link createInventory}. Wraps a
 * {@link ResourceBag} with capacity-aware add/remove operations, item
 * accessors, and an optional auto-persistence layer for known item ids.
 */
export interface Inventory {
  readonly id: string;
  /** Underlying ResourceBag — escape hatch for advanced use */
  readonly bag: ResourceBag;

  // --- Item operations ---
  get(itemId: string): Decimal;
  add(itemId: string, amount: DecimalSource): Decimal;
  remove(itemId: string, amount: DecimalSource): Decimal;
  has(itemId: string, amount: DecimalSource): boolean;
  hasAll(requirements: Record<string, DecimalSource>): boolean;
  canFit(itemId: string, amount: DecimalSource): boolean;
  items(): string[];
  isEmpty(): boolean;
  clear(): void;

  // --- Capacity ---
  /** Current evaluated per-item cap (reactive) */
  capacity: ComputedRef<Decimal>;
  /** Add a modifier to the per-item capacity chain; returns a remover. */
  addCapacityModifier(mod: Modifier): () => void;
  /** How much more of this item can fit */
  remainingSpace(itemId: string): Decimal;
  /** Is the inventory full for a specific item, or overall if no itemId */
  isFull(itemId?: string): boolean;

  // --- Persistence ---
  /**
   * When `items` was provided, the underlying persistent Resource refs
   * keyed by item ID. These are auto-saved by the persistence system. Each
   * resource's `id` — the key for Gates, trackers and the resource registry —
   * is `${inventoryId}/${itemId}`; its `displayName` is the item id.
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
 * backed by a ResourceBag with optional auto-persistence.
 *
 * @param options - Inventory configuration including base capacity, overflow behavior,
 *   and optional `items` array to auto-create persistent Resource refs per item type
 * @returns An inventory with add/remove/has/canFit operations, reactive capacity via
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
  // it auto-registers under ChainRegistry (so balance-sim / devtools can
  // attribute each capacity contribution), composes reactively, and hands
  // back a removal function on add. Matches Producer/Skill chain wiring.
  const capacityChain = createModifierChain(`${id}/capacity`);

  const capacity: ComputedRef<Decimal> = computed(() =>
    Decimal.fromValue(capacityChain.apply(baseCapacity)),
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
        const initialAmount = initial[itemId] ?? 0;
        // Saved as the bare item id inside the inventory's context; the
        // engine-unique id is qualified so inventories can share item ids.
        const resource = createPersistentContextScopedResource<DecimalSource>(
          initialAmount,
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

    add(itemId: string, amount: DecimalSource): Decimal {
      const toAdd = new Decimal(amount);
      const room = remainingForItem(itemId);

      if (overflow === 'block') {
        if (toAdd.gt(room)) return Decimal.dZero;
        return bag.add(itemId, toAdd);
      } else {
        const actual = Decimal.min(toAdd, room);
        if (!Decimal.gt(actual, 0)) return Decimal.dZero;
        return bag.add(itemId, actual);
      }
    },

    remove(itemId: string, amount: DecimalSource): Decimal {
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

    addCapacityModifier(mod: Modifier): () => void {
      return capacityChain.add(mod);
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

  // Only known items persist, under the inventory's own context.
  return items ? attachPersistentContextReset(inventory, id) : inventory;
}
