/**
 * Zone system — named content groupings with progressive unlock
 *
 * Zones are the universal "area/town/chapter/era" concept found in games
 * built from repeated runs. Each zone groups related content (actions, resources, etc.)
 * and unlocks through progression.
 *
 * Composes a {@link ContentRegistry} with saved unlock and selection state.
 * The registry is exposed, so another module can add or patch zone defs.
 *
 * - {@link createZoneSystem} — the sole factory
 *
 * Navigation-agnostic: the system tracks which zones are unlocked and which
 * is selected. Whether the UI shows a zone picker or auto-advances is a
 * consumer decision.
 *
 * @example
 * ```ts
 * const zones = createZoneSystem({
 *   zones: [
 *     { id: 'village', displayName: 'Village', order: 0 },
 *     { id: 'forest', displayName: 'Forest', order: 1 },
 *     { id: 'caves', displayName: 'Deep Caves', order: 2 },
 *   ],
 *   initiallyUnlocked: ['village'],
 * });
 *
 * zones.unlock('forest');
 * zones.select('forest');
 * zones.ordered.value; // all zones sorted by order
 * ```
 */

import { computed, type ComputedRef } from 'vue';
import {
  persistent,
  type Persistent,
  withPersistentContext,
  resolveSystemPersistentContextId,
} from '@/core/persistence';
import { createEmitHandle, type Emittable } from '@/core/events';
import { attachPersistentContextReset } from '@/core/resettable';
import { createContentRegistry, type ContentRegistry } from './content-registry';

// === TYPES ===

/** A zone's def in the content registry */
export interface ZoneDef {
  id: string;
  displayName: string;
  /**
   * Sort order for display (lower = first). Zones without one sort after every
   * zone that has one; ties keep registration order.
   */
  order?: number;
}

/** Events emitted by a {@link ZoneSystem} instance */
export interface ZoneSystemEvents {
  /** Fired when a zone is unlocked */
  unlocked: (zoneId: string) => void;
  /** Fired when the selected zone changes */
  selected: (zoneId: string, previousId: string) => void;
}

/** Options for {@link createZoneSystem} */
export interface ZoneSystemOptions {
  /**
   * Persistent context id. Defaults to `${module}/zone` inside a module; pass
   * one when a module builds more than one.
   */
  id?: string;
  /** Initial zone defs to register */
  zones?: ZoneDef[];
  /**
   * Zone ids that start unlocked (defaults to the first registered zone).
   * Must reference zones that are registered via `zones` or added before use.
   */
  initiallyUnlocked?: string[];
}

/**
 * A zone system instance — the returned object from {@link createZoneSystem}.
 *
 * Manages zone defs, unlock state, and the current zone.
 * Exposes the content registry, so other modules can extend it.
 */
export interface ZoneSystem {
  /** Content registry — another module adds or patches zones through it */
  readonly registry: ContentRegistry<ZoneDef>;

  /** The current zone's id (saved) */
  readonly current: Persistent<string>;

  /** Unlocked zone ids (saved) */
  readonly unlocked: Persistent<string[]>;

  /** All zones sorted by order, then registration order (reactive) */
  readonly ordered: ComputedRef<ZoneDef[]>;

  /** Unlock a zone by id. No-op if already unlocked. */
  unlock(zoneId: string): void;
  // TODO(expansion): add `unlockGate?: Gate` to ZoneDef when a consumer wants declarative
  // auto-unlock instead of imperative `zones.unlock(id)` calls. Gate already exists
  // (src/systems/gate.ts); only consumer demand is pending.

  /** Check if a zone is unlocked */
  isUnlocked(zoneId: string): boolean;

  /** Switch to a zone (must be unlocked) */
  select(zoneId: string): boolean;

  /** Lock all zones except those in the initial set, reset selection to first unlocked */
  resetUnlocks(): void;

  /** Subscribe to zone lifecycle events */
  on: Emittable<ZoneSystemEvents>['on'];
}

// === FACTORIES ===

/**
 * Create a zone system — content groupings with progressive unlock.
 *
 * @param options - Zone defs, the initially unlocked set, and the persistent context id
 * @returns A {@link ZoneSystem} with registry, unlock tracking, and selection
 *
 * @example
 * ```ts
 * const zones = createZoneSystem({
 *   zones: [
 *     { id: 'town', displayName: 'Starting Town', order: 0 },
 *     { id: 'wilderness', displayName: 'Wilderness', order: 1 },
 *   ],
 *   initiallyUnlocked: ['town'],
 * });
 *
 * // Another module extends it:
 * zones.registry.register({ id: 'volcano', displayName: 'Volcano', order: 10 });
 * zones.unlock('volcano');
 * ```
 */
export function createZoneSystem(options: ZoneSystemOptions = {}): ZoneSystem {
  const { id, zones: initialZones = [], initiallyUnlocked } = options;

  // --- Registry ---
  const registry = createContentRegistry<ZoneDef>('zones');
  if (initialZones.length > 0) {
    registry.register(initialZones);
  }

  const defaultUnlocked =
    initiallyUnlocked ?? (initialZones.length > 0 ? [initialZones[0].id] : []);

  // --- Persistent state ---
  const contextId = resolveSystemPersistentContextId(id, 'zone');
  const { unlocked, current } = withPersistentContext(contextId, () => ({
    unlocked: persistent<string[]>([...defaultUnlocked], { id: 'unlocked' }),
    current: persistent<string>(defaultUnlocked[0] ?? '', { id: 'current' }),
  }));

  const handle = createEmitHandle<ZoneSystemEvents>();

  // --- Computed ordered list ---
  // `|| 0` keeps two order-less zones (Infinity - Infinity = NaN) a tie.
  const ordered = computed(() => {
    const all = registry.getAll();
    return all.sort((a, b) => (a.order ?? Infinity) - (b.order ?? Infinity) || 0);
  });

  const zoneSystem: ZoneSystem = {
    registry,
    current,
    unlocked,
    ordered,

    unlock(zoneId: string): void {
      if (unlocked.value.includes(zoneId)) return;
      unlocked.value = [...unlocked.value, zoneId];
      handle.emit('unlocked', zoneId);
    },

    isUnlocked(zoneId: string): boolean {
      return unlocked.value.includes(zoneId);
    },

    select(zoneId: string): boolean {
      if (!unlocked.value.includes(zoneId)) return false;
      const prev = current.value;
      if (prev === zoneId) return true;
      current.value = zoneId;
      handle.emit('selected', zoneId, prev);
      return true;
    },

    resetUnlocks(): void {
      unlocked.value = [...defaultUnlocked];
      if (!defaultUnlocked.includes(current.value)) {
        current.value = defaultUnlocked[0] ?? '';
      }
    },

    on: handle.on,
  };

  return attachPersistentContextReset(zoneSystem, contextId);
}
