/**
 * Zone system — named content groupings with progressive unlock
 *
 * Zones are the universal "area/town/chapter/era" concept found in loop
 * incrementals. Each zone groups related content (actions, resources, etc.)
 * and unlocks through progression.
 *
 * Composes a {@link ContentRegistry} with persistent unlock/selection state.
 * The registry is exposed for mods to add or patch zone definitions.
 *
 * - {@link createZoneSystem} — the sole factory
 *
 * Navigation-agnostic: the system tracks which zones are unlocked and which
 * is selected. Whether the UI shows a zone picker (Idle Loops) or auto-advances
 * (Increlution chapters) is a consumer decision.
 *
 * @example
 * ```ts
 * const zones = createZoneSystem({
 *   zones: [
 *     { id: 'village', name: 'Village', order: 0 },
 *     { id: 'forest', name: 'Forest', order: 1 },
 *     { id: 'caves', name: 'Deep Caves', order: 2 },
 *   ],
 *   initiallyUnlocked: ['village'],
 * });
 *
 * zones.unlock('forest');
 * zones.select('forest');
 * zones.getOrdered(); // all zones sorted by order
 * ```
 */

import { computed, type ComputedRef } from 'vue';
import {
  persistent,
  type Persistent,
  withPersistentContext,
  resolveSystemContextId,
} from '@/core/persistence';
import { createEmitHandle, type Emittable } from '@/core/events';
import { createContentRegistry, type ContentRegistry } from './content-registry';

// === TYPES ===

/** Definition for a zone in the content registry */
export interface ZoneDef {
  id: string;
  /** Display name */
  name: string;
  /** Sort order for display (lower = first). Defaults to registration order. */
  order?: number;
}

/** Events emitted by a {@link ZoneSystem} instance */
export interface ZoneSystemEvents {
  /** Fired when a zone is unlocked */
  unlock: (zoneId: string) => void;
  /** Fired when the selected zone changes */
  select: (zoneId: string, previousId: string) => void;
}

/** Options for {@link createZoneSystem} */
export interface ZoneSystemOptions {
  /**
   * Save context. Defaults to `${module}/zone` inside a module; pass one
   * when a module builds more than one.
   */
  id?: string;
  /** Initial zone definitions to register */
  zones?: ZoneDef[];
  /**
   * Zone IDs that start unlocked (defaults to the first registered zone).
   * Must reference zones that are registered via `zones` or added before use.
   */
  initiallyUnlocked?: string[];
}

/**
 * A zone system instance — the returned object from {@link createZoneSystem}.
 *
 * Manages zone definitions, unlock state, and current selection.
 * Exposes the content registry for mod extension.
 */
export interface ZoneSystem {
  /** Content registry — mods inject this to add/patch zones */
  readonly registry: ContentRegistry<ZoneDef>;

  /** Currently selected zone ID (persistent) */
  readonly current: Persistent<string>;

  /** Set of unlocked zone IDs (persistent) */
  readonly unlocked: Persistent<string[]>;

  /** All zones sorted by order, then registration order (reactive) */
  readonly ordered: ComputedRef<ZoneDef[]>;

  /** Unlock a zone by ID. No-op if already unlocked. */
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

let zoneCounter = 0;

/**
 * Create a zone system — content groupings with progressive unlock.
 *
 * @param options - Zone definitions, initially unlocked set, persistence ID
 * @returns A {@link ZoneSystem} with registry, unlock tracking, and selection
 *
 * @example
 * ```ts
 * const zones = createZoneSystem({
 *   zones: [
 *     { id: 'town', name: 'Starting Town', order: 0 },
 *     { id: 'wilderness', name: 'Wilderness', order: 1 },
 *   ],
 *   initiallyUnlocked: ['town'],
 * });
 *
 * // Mod extends it:
 * zones.registry.register({ id: 'volcano', name: 'Volcano', order: 10 });
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
  const contextId = resolveSystemContextId(id, 'zone', () => `zone_${zoneCounter++}`);
  const { unlocked, current } = withPersistentContext(contextId, () => ({
    unlocked: persistent<string[]>([...defaultUnlocked], { name: 'unlocked' }),
    current: persistent<string>(defaultUnlocked[0] ?? '', { name: 'current' }),
  }));

  const handle = createEmitHandle<ZoneSystemEvents>();

  // --- Computed ordered list ---
  const ordered = computed(() => {
    const all = registry.getAll();
    return all.slice().sort((a, b) => (a.order ?? Infinity) - (b.order ?? Infinity));
  });

  const zoneSystem: ZoneSystem = {
    registry,
    current,
    unlocked,
    ordered,

    unlock(zoneId: string): void {
      if (unlocked.value.includes(zoneId)) return;
      unlocked.value = [...unlocked.value, zoneId];
      handle.emit('unlock', zoneId);
    },

    isUnlocked(zoneId: string): boolean {
      return unlocked.value.includes(zoneId);
    },

    select(zoneId: string): boolean {
      if (!unlocked.value.includes(zoneId)) return false;
      const prev = current.value;
      if (prev === zoneId) return true;
      current.value = zoneId;
      handle.emit('select', zoneId, prev);
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

  return zoneSystem;
}
