/**
 * Category Base — shared skeleton for batch-registration categories
 *
 * Provides the common structure: ContentRegistry, entry Map, persistent
 * context wrapping, and accessor methods. Per-system categories
 * (createSkillCategory, createProducerCategory, etc.) wrap this and add
 * domain-specific logic; consumers whose definitions don't fit any
 * built-in shape can use it directly with `Instance = void` (omit
 * `buildInstance`) for pure per-def state.
 *
 * `setupDeclarativeBindings` and `setupCategoryTick` remain `@internal` —
 * they're tied to specific category-system idioms (grants wiring, tick
 * loop integration) and not part of the public surface.
 */

import { computed, unref, type ComputedRef, type MaybeRef } from 'vue';
import type { DecimalSource } from '@/primitives/decimal';
import {
  withPersistentContext,
  isPersistent,
  setPersistentName,
  PersistentName,
} from '@/core/persistence';
import {
  createAdditiveModifier,
  createExponentialModifier,
  createMultiplicativeModifier,
  type Grant,
  type Modifier,
  type ModifierDescription,
} from '@/core/modifier';
import { processGetter } from '@/core/computed';
import { profile } from '@/core/profiler';
import type { RegisterTick } from '@/core/sequencer';
import { createContentRegistry, type ContentRegistry } from './content-registry';
import { Resettable, type ResettableObject } from './resettable';

// === TYPES ===

/**
 * Uniform per-entry introspection axes — the engine's cohesive cross-cut over
 * heterogeneous category types. Every per-system category factory derives a
 * `CategoryEntrySignals` view from its instance refs, so a single helper
 * (`findCategoryEntrySignals`) can address any entry by `(categoryId, entityId)`
 * without consumer-side path conventions.
 *
 * Mapping per category type:
 * - Achievement → `{ unlock: earned, count: earned ? 1 : 0 }`
 * - Purchasable → `{ unlock: active, count: amount }`
 * - Producer    → `{ unlock: count > 0, count: ownedCount + extraCount }`
 * - Skill       → `{ unlock: level > 0, count: level }`
 * - Challenge   → `{ unlock: completed (completions > 0), count: completions }`
 *
 * Producer / Skill `unlock` derives from `count > 0` / `level > 0` — naive but
 * matches the pattern Gate's `unlock` services across the other categories.
 * Consumers that want to distinguish "addressable" from "advanced" expose a
 * separate unlock ref via a future expansion or use a `state` Gate kind.
 */
export interface CategoryEntrySignals {
  /** "Is this entity active / owned / earned / unlocked?" */
  readonly unlock: ComputedRef<boolean>;
  /** "How many / what level / how complete?" */
  readonly count: ComputedRef<DecimalSource>;
}

/**
 * A registered entry in a category: definition + instance + optional state +
 * optional signals.
 *
 * `instance` is `undefined` when the category was created with `Instance = void`
 * and no `buildInstance` was supplied. `signals` is `undefined` when the
 * category factory did not provide a `buildSignals` callback (e.g. raw
 * `createCategoryBase` uses with custom shapes); per-system factories
 * (`createSkillCategory`, etc.) always populate it.
 */
export interface CategoryEntry<Def extends { id: string }, Instance, State = void> {
  readonly def: Def;
  readonly instance: Instance;
  readonly state: State;
  readonly signals?: CategoryEntrySignals;
}

/** Options for {@link createCategoryBase}. */
export interface CategoryBaseOptions<Def extends { id: string }, Instance, State = void> {
  /** Persistence context prefix. Each definition gets `{id}/{def.id}`. */
  id: string;

  /**
   * Create the domain-specific instance from a definition.
   * Called inside a persistent context scoped to `{id}/{def.id}`.
   *
   * Omit (with `Instance = void`) for pure per-def state categories — the
   * entry's `instance` slot will be `undefined`.
   */
  buildInstance?: (def: Def) => Instance;

  /**
   * Create per-instance state alongside the instance.
   * Called inside the same persistent context as buildInstance.
   * Omit if no extra state is needed.
   */
  buildState?: (def: Def, instance: Instance) => State;

  /**
   * Derive {@link CategoryEntrySignals} from the entry's instance + state.
   * Per-system category factories (`createAchievementCategory`, etc.) pass
   * one to expose uniform unlock/count introspection through
   * `findCategoryEntrySignals`. Raw consumers may omit it — the entry's
   * `signals` slot will be `undefined`.
   */
  buildSignals?: (def: Def, instance: Instance, state: State) => CategoryEntrySignals;
}

/**
 * The shared base returned by {@link createCategoryBase}.
 * Per-system categories wrap this and add domain-specific accessors.
 */
export interface CategoryBase<
  Def extends { id: string },
  Instance,
  State = void,
> extends ResettableObject {
  /** Persistence context id this category was constructed under. */
  readonly id: string;
  /** The content registry — mods can call `registry.register()` or `registry.patch()` */
  readonly registry: ContentRegistry<Def>;

  /**
   * Register definitions: validate via registry, then build instances.
   * Can be called multiple times (base game + mods).
   */
  register(defs: Def | Def[]): void;

  /** Get the definition for an ID (delegates to registry.get) */
  getDef(id: string): Def | undefined;

  /** Get the full entry (def + instance + state) */
  getEntry(id: string): CategoryEntry<Def, Instance, State> | undefined;

  /** All entries in registration order */
  getAll(): CategoryEntry<Def, Instance, State>[];

  /** Number of registered entries */
  readonly size: number;
}

// === FACTORIES ===

/**
 * Create the shared category base — registry + entry map + persistent context.
 *
 * Used by per-system category factories (createSkillCategory etc.) and by
 * consumers whose definitions don't fit any built-in category shape — pass
 * `Instance = void` and omit `buildInstance` for pure per-def state.
 *
 * @example
 * ```ts
 * // Bare per-def state, no behavior instance
 * const actionStates = createCategoryBase<ActionDef, void, ActionState>({
 *   id: 'actions/basic',
 *   buildState: () => ({
 *     progress: persistent<DecimalSource>(0),
 *     timesCompleted: persistent<DecimalSource>(0),
 *   }),
 * });
 * actionStates.register(ACTIONS.filter((d) => d.type === 'basic'));
 * const state = actionStates.getEntry('chop')?.state;
 * ```
 */
export function createCategoryBase<Def extends { id: string }, Instance, State = void>(
  options: CategoryBaseOptions<Def, Instance, State>,
): CategoryBase<Def, Instance, State> {
  const { id: categoryId, buildInstance, buildState, buildSignals } = options;

  const registry = createContentRegistry<Def>(categoryId);
  const entries = new Map<string, CategoryEntry<Def, Instance, State>>();

  function registerOne(def: Def): void {
    // withPersistentContext guarantees the context is popped even if a builder
    // throws — a leaked context silently mis-scopes the save keys of every
    // persistent ref created afterward.
    const { instance, state, signals } = withPersistentContext(`${categoryId}/${def.id}`, () => {
      const instance = buildInstance ? buildInstance(def) : (undefined as Instance);
      const state = buildState ? buildState(def, instance) : (undefined as State);

      // Auto-name persistent fields on the returned state object so save keys
      // are stable across field reorders. Each definition lives in its own
      // context (`${categoryId}/${def.id}`), so the field name alone is unique.
      if (state !== null && typeof state === 'object') {
        for (const [fieldName, value] of Object.entries(state as Record<string, unknown>)) {
          if (isPersistent(value) && value[PersistentName] === undefined) {
            setPersistentName(value, fieldName);
          }
        }
      }

      const signals = buildSignals?.(def, instance, state);
      return { instance, state, signals };
    });

    entries.set(def.id, { def, instance, state, signals });
  }

  return {
    id: categoryId,
    registry,

    register(defs: Def | Def[]): void {
      const arr = Array.isArray(defs) ? defs : [defs];
      // Register in content registry first (validates uniqueness)
      registry.register(arr);
      // Then build instances
      for (const def of arr) {
        registerOne(def);
      }
    },

    getDef(id: string): Def | undefined {
      return registry.get(id);
    },

    getEntry(id: string): CategoryEntry<Def, Instance, State> | undefined {
      return entries.get(id);
    },

    getAll(): CategoryEntry<Def, Instance, State>[] {
      return Array.from(entries.values());
    },

    get size(): number {
      return entries.size;
    },

    [Resettable](): Iterable<unknown> {
      const items: unknown[] = [];
      for (const entry of entries.values()) {
        items.push(entry.instance);
        if (entry.state !== undefined) items.push(entry.state);
      }
      return items;
    },
  };
}

// === DECLARATIVE BINDINGS ===

/**
 * Apply a list of {@link Grant} entries to their target chains with a shared
 * `active` predicate (typically sourced from the owning category item — e.g.
 * `item.active` for purchasables, `item.earned` for achievements).
 *
 * Each entry may target a single chain or an array of chains; an array is
 * lowered to one `chain.bind` call per chain, all sharing the same composed
 * predicate. The per-entry `when` predicate is AND-composed with the outer
 * `active` — the resulting binding is active iff both resolve to `true`.
 *
 * Intended to be invoked inside the persistent-context scope the category
 * opens for each definition (so `chain.bind` derives stable attribution ids
 * from the current context).
 *
 * @internal
 */
export function setupDeclarativeBindings(
  grants: Grant[] | undefined,
  active: MaybeRef<boolean>,
): void {
  if (grants == null || grants.length === 0) return;
  for (const grant of grants) {
    const chains = Array.isArray(grant.chain) ? grant.chain : [grant.chain];
    const composedActive =
      grant.when == null
        ? active
        : (() => {
            const when = processGetter(grant.when);
            return computed(() => unref(active) !== false && unref(when) !== false);
          })();
    const modifier = buildGrantModifier(grant);
    for (const chain of chains) chain.bind({ active: composedActive, modifier });
  }
}

// === TICK WALKER ===

/**
 * Options for {@link setupCategoryTick}.
 *
 * @internal
 */
export interface SetupCategoryTickOptions {
  /**
   * Profiler label for the per-tick walk. When set, the entire walk is wrapped
   * in {@link profile} so per-system tick cost shows up in
   * {@link getProfileReport}. Omit if the per-entry callback already records
   * its own labels.
   */
  profileLabel?: string;
}

/**
 * Register a single tick handler that walks every entry in a category once
 * per tick and invokes `perEntry` for each. Registers exactly one tick
 * callback regardless of how many entries the category holds.
 *
 * The walked list is cached on `base.size` — registration is additive, so
 * the cache invalidates only when new definitions are registered. No
 * allocation in the steady-state tick body.
 *
 * @param base - Category base whose entries to walk
 * @param registerTick - Tick registration (typically `ctx.onTick`)
 * @param perEntry - Called for each entry every tick. Filtering (e.g.
 *   skipping manual entries in a mixed continuous/manual category) is the
 *   callback's responsibility.
 * @param options - Optional profiler label
 * @returns Unsubscribe function from the underlying `registerTick` call
 *
 * @internal
 *
 * @example
 * ```ts
 * // producer-category's continuous-tick wiring
 * setupCategoryTick(base, ctx.registerTick, (entry, dt) => {
 *   const producer = entry.instance;
 *   if (producer.trigger !== 'continuous') return;
 *   const amount = Decimal.mul(producer.computedRate.value, producer.count.value).mul(dt);
 *   if (Decimal.gt(amount, 0)) addResource(producer.resource, amount);
 * }, { profileLabel: 'producer.continuous.tick' });
 * ```
 */
export function setupCategoryTick<Def extends { id: string }, Instance, State>(
  base: CategoryBase<Def, Instance, State>,
  registerTick: RegisterTick,
  perEntry: (entry: CategoryEntry<Def, Instance, State>, dt: number) => void,
  options: SetupCategoryTickOptions = {},
): () => void {
  const { profileLabel } = options;

  let cachedEntries: CategoryEntry<Def, Instance, State>[] = [];
  let cachedSize = -1;
  const getEntries = (): CategoryEntry<Def, Instance, State>[] => {
    if (base.size !== cachedSize) {
      cachedEntries = base.getAll();
      cachedSize = base.size;
    }
    return cachedEntries;
  };

  const walk = (dt: number): void => {
    for (const entry of getEntries()) perEntry(entry, dt);
  };

  return registerTick((dt: number) => {
    if (profileLabel) {
      profile(profileLabel, () => walk(dt));
    } else {
      walk(dt);
    }
  });
}

/** Build a Modifier from a Grant shorthand (mult/add/exp/modifier). */
function buildGrantModifier(grant: Grant): Modifier {
  if ('mult' in grant) {
    return createMultiplicativeModifier({ multiplier: grant.mult, description: grant.description });
  }
  if ('add' in grant) {
    return createAdditiveModifier({ addend: grant.add, description: grant.description });
  }
  if ('exp' in grant) {
    return createExponentialModifier({ exponent: grant.exp, description: grant.description });
  }
  const resolved = typeof grant.modifier === 'function' ? grant.modifier() : grant.modifier;
  // Overlay an inline description onto a modifier that doesn't already carry
  // one — keeps `chain.bind` auto-id derivation working for the escape-hatch
  // variant without forcing consumers to wrap the modifier themselves.
  if (grant.description != null && resolved.description == null) {
    const text = grant.description;
    return {
      ...resolved,
      description: (): ModifierDescription => ({ text, formattedValue: '' }),
    };
  }
  return resolved;
}
