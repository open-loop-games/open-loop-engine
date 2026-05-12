/**
 * Feature system - base types and utilities for game features
 *
 * Features are the building blocks of incremental games: upgrades, achievements,
 * buyables, etc. This module provides:
 * - Unique ID generation for DOM/canvas elements
 * - Visibility states and utilities
 * - Type guards for feature identification
 * - Feature traversal utilities
 */

import { Decimal } from '@/primitives/decimal';
import { processGetter, type Computable } from './computed';
import { computed, isRef, unref, type ComputedRef, type MaybeRef } from 'vue';

// === UNIQUE ID GENERATION ===
let id = 0;

/**
 * Gets a unique ID for a feature.
 * Used for any system that needs to identify elements in the DOM/canvas
 * rather than references to the feature itself (e.g., edges between nodes).
 *
 * IDs are guaranteed unique within a session, but NOT persistent across
 * page reloads or updates.
 *
 * @param prefix - String to prepend to make IDs more readable in dev tools
 * @returns A unique string ID
 */
export function getUniqueID(prefix = 'feature-'): string {
  return prefix + id++;
}

/**
 * Reset the ID counter. Only use for testing.
 */
export function resetUniqueID(): void {
  id = 0;
}

// === VISIBILITY ===
/**
 * Visibility states for features and components.
 * Controls whether and how elements are rendered.
 */
export enum Visibility {
  /** The feature should be visible and interactive */
  Visible = 0,
  /** The feature should be invisible but still take up space (useful for layout) */
  Hidden = 1,
  /** The feature should not be rendered at all */
  None = 2,
}

/** Internal: true when a Visibility/boolean value should keep the feature in the layout. */
function isVisible(visibility: MaybeRef<Visibility | boolean>): boolean {
  const currVisibility = unref(visibility);
  return currVisibility !== Visibility.None && currVisibility !== false;
}

// === FEATURE TYPE GUARDS ===
/**
 * Check if an object is a specific type of feature.
 * Features are identified by a unique symbol in their "type" property.
 *
 * @param object - The object to check
 * @param type - The symbol identifying the feature type
 * @returns Type predicate indicating if object is the specified feature type
 *
 * @example
 * ```ts
 * const UpgradeType = Symbol('Upgrade')
 * if (isType(feature, UpgradeType)) {
 *   // feature is typed as { type: typeof UpgradeType }
 * }
 * ```
 */
export function isType<T extends symbol>(object: unknown, type: T): object is { type: T } {
  return object != null && typeof object === 'object' && 'type' in object && object.type === type;
}

/**
 * Traverse an object recursively and collect all features of the specified types.
 * Features are identified by having a "type" property with a symbol value
 * matching one of the provided types.
 *
 * @param obj - The object to traverse
 * @param types - Feature type symbols to search for
 * @returns Array of found features
 *
 * @example
 * ```ts
 * const upgrades = findFeatures(layer, UpgradeType)
 * const buyablesAndUpgrades = findFeatures(layer, BuyableType, UpgradeType)
 * ```
 */
export function findFeatures(obj: object, ...types: symbol[]): unknown[] {
  const objects: unknown[] = [];

  const handleObject = (obj: object) => {
    Object.keys(obj).forEach((key) => {
      const value: unknown = obj[key as keyof typeof obj];
      if (value != null && typeof value === 'object') {
        // Skip Vue VNodes
        if ((value as Record<string, unknown>).__v_isVNode === true) {
          return;
        }

        const valueType = (value as Record<string, unknown>).type;
        if (typeof valueType === 'symbol' && types.includes(valueType)) {
          objects.push(value);
        } else if (!(value instanceof Decimal) && !isRef(value)) {
          // Recurse into plain objects (not Decimals or refs)
          handleObject(value as Record<string, unknown>);
        }
      }
    });
  };

  handleObject(obj);
  return objects;
}

/**
 * Traverse an object recursively and collect all features that are NOT
 * of the specified types. Useful for getting "everything else" after
 * extracting specific feature types.
 *
 * @param obj - The object to traverse
 * @param types - Feature type symbols to exclude
 * @returns Array of features not matching any of the provided types
 */
export function excludeFeatures(obj: Record<string, unknown>, ...types: symbol[]): unknown[] {
  const objects: unknown[] = [];

  const handleObject = (obj: Record<string, unknown>) => {
    Object.keys(obj).forEach((key) => {
      const value = obj[key];
      if (value != null && typeof value === 'object') {
        // Skip Vue VNodes
        if ((value as Record<string, unknown>).__v_isVNode === true) {
          return;
        }

        const type = (value as Record<string, unknown>).type;
        if (typeof type === 'symbol') {
          if (!types.includes(type)) {
            objects.push(value);
          }
        } else if (!(value instanceof Decimal) && !isRef(value)) {
          // Recurse into plain objects (not Decimals or refs)
          handleObject(value as Record<string, unknown>);
        }
      }
    });
  };

  handleObject(obj);
  return objects;
}

// === BASE FEATURE TYPES ===
/**
 * Base options that all features can have
 */
export interface BaseFeatureOptions {
  /** Whether this feature should be visible */
  visibility?: Computable<Visibility | boolean>;
  // TODO(expansion): widen visibility to also accept `Gate` once OL-844 lands. Cross-cutting
  // — every category-typed feature inherits this; defer until a consumer asks.
  // Ref: docs/candidate-primitives.md `Gate` core primitive entry.
}

/**
 * Base properties that all features have after creation
 */
export interface BaseFeature {
  /** Unique identifier for this feature instance */
  id: string;
  /** The type symbol identifying what kind of feature this is */
  type: symbol;
  /** Whether this feature is currently visible */
  visibility?: MaybeRef<Visibility | boolean>;
}

/**
 * Create base feature properties from options.
 * Call this at the start of any createXxx feature factory.
 *
 * @param featureName - Name prefix for the generated ID
 * @param type - Symbol identifying the feature type
 * @param options - Feature options
 * @returns Base feature properties
 */
export function createBaseFeature<T extends BaseFeatureOptions>(
  featureName: string,
  type: symbol,
  options: T,
): BaseFeature {
  return {
    id: getUniqueID(featureName + '-'),
    type,
    visibility: options.visibility != null ? processGetter(options.visibility) : undefined,
  };
}

// === FEATURE COLLECTIONS ===
/**
 * Result of filtering features with getFirstFeature
 */
export interface FirstFeatureResult<T> {
  /** The first feature passing the filter */
  firstFeature: ComputedRef<T | undefined>;
  /** Remaining features after the first */
  remainingFeatures: ComputedRef<T[]>;
  /** Whether there are any remaining features */
  hasRemaining: ComputedRef<boolean>;
}

/**
 * Filter features and get access to the first one separately.
 * Useful for UI patterns where you show one feature prominently
 * and collapse the rest.
 *
 * @param features - Array of features to filter
 * @param filter - Predicate to determine which features to include
 * @returns Object with firstFeature, remainingFeatures, and hasRemaining
 *
 * @example
 * ```ts
 * const { firstFeature, remainingFeatures, hasRemaining } = getFirstFeature(
 *   upgrades,
 *   u => !u.active.value
 * )
 * // Show firstFeature prominently
 * // Show remainingFeatures in a collapsible section if hasRemaining
 * ```
 */
export function getFirstFeature<T extends { visibility?: MaybeRef<Visibility | boolean> }>(
  features: T[],
  filter: (feature: T) => boolean,
): FirstFeatureResult<T> {
  const filteredFeatures = computed(() =>
    features.filter((feature) => isVisible(feature.visibility ?? true) && filter(feature)),
  );

  return {
    firstFeature: computed(() => filteredFeatures.value[0]),
    remainingFeatures: computed(() => filteredFeatures.value.slice(1)),
    hasRemaining: computed(() => filteredFeatures.value.length > 1),
  };
}

// === FEATURE STATE UTILITIES ===
/**
 * Create a computed boolean indicating if a feature is visible.
 * Handles the various visibility representations (enum, boolean, ref).
 *
 * @param visibility - The visibility value to check
 * @returns Computed ref that's true when the feature should be visible
 */
export function computeVisibility(
  visibility: Computable<Visibility | boolean> | undefined,
): ComputedRef<boolean> {
  if (visibility === undefined) {
    return computed(() => true);
  }
  const processed = processGetter(visibility);
  return computed(() => isVisible(processed));
}

/**
 * Create a computed boolean indicating if a feature meets some condition.
 * Convenience wrapper for creating computed predicates.
 *
 * @param condition - The condition to check
 * @returns Computed ref with the boolean result
 */
export function computeCondition(condition: Computable<boolean>): ComputedRef<boolean> {
  const processed = processGetter(condition);
  return computed(() => unref(processed));
}

// === GENERIC FEATURE FACTORY HELPERS ===
/**
 * Check if something is a feature (has a symbol type property)
 */
export function isFeature(value: unknown): value is BaseFeature {
  return (
    value != null &&
    typeof value === 'object' &&
    'type' in value &&
    typeof (value as Record<string, unknown>).type === 'symbol'
  );
}

/**
 * Generic feature with visibility that can be required or optional.
 * Use this as a base for extending feature types.
 */
export type GenericFeature = BaseFeature & {
  [key: string]: unknown;
};

/**
 * Make certain properties of a type required.
 * Useful for narrowing feature types based on provided options.
 */
export type WithRequired<T, K extends keyof T> = T & { [P in K]-?: T[P] };
