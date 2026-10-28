/**
 * Game-state accessor — the builder over the engine's registries, the record
 * of the methods an accessor implements, and the ambient accessor
 * `createEngine` sets around `install()` / `connect()`.
 *
 * - {@link createGameStateAccessor} builds a `GameStateAccessorMutator` whose
 *   amounts, resource writes and rates come from the resource registry, and
 *   whose flags come from the flag registry. The game supplies state paths.
 *   `createEngine` always builds one. A method with no source throws, naming
 *   the kind that called it.
 * - {@link AccessorMethods} keys the record of methods an accessor
 *   implements. Construction checks read it, so a `state` Gate over an accessor
 *   without `getStateAt` fails where it is registered, not inside a `computed`.
 *   An accessor without the record counts as implementing every method.
 * - The ambient accessor is one of the cross-cutting ambient values. The
 *   others are the chain, effect-system, resource and tuning registries, the
 *   engine categories, and the persistence namespace. Category factories read
 *   it via {@link getCurrentGameStateAccessor} when no per-category option is
 *   provided, so no factory threads it through its options.
 */

import { Decimal, type DecimalSource } from '@/primitives/decimal';
import type { GameStateAccessor, InjectionKey, ResourceEffect } from '@/primitives/types';
import type { GameStateMutator } from './effects';
import type { FlagRegistry, ResourceRegistry } from './registries';
import { addResource, subtractResource, type Resource } from './resource';
import { getInflowRate, getRate, hasRateSources } from './rate-source';
import type { Flag, SavedFlag } from './flag';

// === TYPES ===

/** A method name of {@link GameStateAccessor} or {@link GameStateMutator}. */
export type GameStateAccessorMethod = keyof GameStateAccessor | keyof GameStateMutator;

/**
 * Keys the record of the methods an accessor implements, a
 * `ReadonlySet<GameStateAccessorMethod>`. {@link createGameStateAccessor} sets
 * it. A hand-written accessor that implements only some methods sets it too,
 * so construction checks fail early for the rest.
 *
 * @example
 * ```ts
 * const accessor: GameStateAccessorMutator = {
 *   ...amountsAndRates,
 *   [AccessorMethods]: new Set(['getAmount', 'getRate']),
 * };
 * ```
 */
export const AccessorMethods: unique symbol = Symbol('AccessorMethods');

/**
 * An object that may carry an {@link AccessorMethods} record.
 *
 * @internal
 */
export interface WithAccessorMethods {
  /** The methods this accessor implements; absent means every method. */
  readonly [AccessorMethods]?: ReadonlySet<GameStateAccessorMethod>;
}

/** Combined accessor + mutator — every consumer unifies these into one object. */
export type GameStateAccessorMutator = GameStateAccessor & GameStateMutator & WithAccessorMethods;

/** The registries {@link createGameStateAccessor} reads. `createEngine` passes its own. */
export interface AccessorServices {
  resourceRegistry: ResourceRegistry;
  /** Serves `getFlag` and `setFlag`; without it, the accessor implements neither. */
  flagRegistry?: FlagRegistry;
}

/** What the game supplies to the accessor beyond its registries: state paths and the subtract policy. */
export interface GameStateAccessorOptions {
  getStateAt?: GameStateAccessor['getStateAt'];
  setStateAt?: GameStateMutator['setStateAt'];
  /** Let a `subtract` take a resource below zero. Default `false`: such a subtract throws. */
  allowNegative?: boolean;
}

/**
 * Injection key for the accessor `createEngine` built. Every started engine
 * has one. Read it with `engine.tryInject` after `start()`, from UI code or a
 * balance tool.
 */
export const GameStateAccessorKey: InjectionKey<GameStateAccessorMutator> =
  Symbol('GameStateAccessor');

// === CONSTANTS ===

/** What calls each method that may get a throwing stub, and how to supply it, for the error it throws. */
const MISSING = {
  getFlag: ["a 'flag' Gate or condition", 'Pass a flagRegistry in its services.'],
  setFlag: ["a 'flag' effect", 'Pass a flagRegistry in its services.'],
  getStateAt: [
    "a 'state' Gate or condition",
    'Pass getStateAt in its options: createEngine({ accessor: { getStateAt } }).',
  ],
  setStateAt: [
    "a 'state' effect",
    'Pass setStateAt in its options: createEngine({ accessor: { setStateAt } }).',
  ],
} as const satisfies Partial<Record<GameStateAccessorMethod, readonly [string, string]>>;

// === RECORD ===

/**
 * How to fix a method an accessor does not implement, for the errors.
 *
 * @internal
 */
export const ACCESSOR_METHOD_REMEDY =
  "Supply it in createEngine's accessor options, or add it in a wrap and to the accessor's AccessorMethods record.";

/**
 * Whether `accessor` implements `method`. True for an accessor without an
 * {@link AccessorMethods} record.
 *
 * @internal
 */
export function implementsAccessorMethod(
  accessor: Partial<GameStateAccessorMutator>,
  method: GameStateAccessorMethod,
): boolean {
  return accessor[AccessorMethods]?.has(method) ?? true;
}

/**
 * Throw unless `accessor` implements every method in `methods`.
 *
 * @param label prefix for the error, normally the def or field being checked.
 * @internal
 */
export function assertAccessorMethods(
  accessor: Partial<GameStateAccessorMutator>,
  methods: Iterable<GameStateAccessorMethod>,
  label: string,
): void {
  const missing = [...methods].filter((m) => !implementsAccessorMethod(accessor, m));
  if (missing.length === 0) return;
  throw new Error(
    `${label}: needs ${missing.join(', ')}, which the accessor does not implement. ` +
      ACCESSOR_METHOD_REMEDY,
  );
}

// === BUILDER ===

/**
 * Build a game-state accessor and mutator over an engine's registries. The
 * engine builds its own with this at `start()`; call it directly for a test
 * or a tool without an engine. Amounts, resource writes and rates come from
 * the resource registry, rates as each resource's rate sources. Flags come
 * from the flag registry. State paths come from `options`.
 *
 * Every read is at call time, so the registries may still be empty when this
 * runs. A resource or flag id the registries lack throws. `getRate` throws for
 * a resource with no rate sources, so a Gate prediction over one fails loudly;
 * a display reads the core `getRate(resource)`, which reads zero. A method
 * with no source throws, naming the kind that called it, and is missing from
 * the {@link AccessorMethods} record, so construction checks fail first.
 *
 * @param services the registries to read; inside an engine, read them with
 *   `ResourceRegistryKey` and `FlagRegistryKey`.
 * @param options the state paths the registries cannot answer, and the
 *   subtract policy.
 * @returns a `GameStateAccessorMutator` with an {@link AccessorMethods} record.
 *
 * @example
 * ```ts
 * // A test without an engine:
 * const resourceRegistry = createResourceRegistry();
 * withResourceRegistry(resourceRegistry, () => createResource(10, { id: 'gold' }));
 * const accessor = createGameStateAccessor({ resourceRegistry }, { allowNegative: true });
 * accessor.applyResourceOp('gold', 'subtract', 15); // gold is now -5
 * ```
 */
export function createGameStateAccessor(
  services: AccessorServices,
  options: GameStateAccessorOptions = {},
): GameStateAccessorMutator {
  const { allowNegative = false, getStateAt, setStateAt } = options;
  const { resourceRegistry, flagRegistry } = services;

  function resourceFor(id: string): Resource {
    const resource = resourceRegistry.findById(id);
    if (!resource) throw new Error(`createGameStateAccessor: no resource '${id}' registered`);
    return resource;
  }

  function missing(method: keyof typeof MISSING): never {
    const [caller, remedy] = MISSING[method];
    throw new Error(
      `createGameStateAccessor: ${caller} called ${method}, which this accessor was not given. ${remedy}`,
    );
  }

  function applyResourceOp(id: string, op: ResourceEffect['operation'], value: DecimalSource) {
    const resource = resourceFor(id);
    switch (op) {
      case 'add':
        addResource(resource, value);
        return;
      case 'subtract':
        if (!subtractResource(resource, value, { allowNegative })) {
          throw new Error(
            `createGameStateAccessor: subtracting ${new Decimal(value).toString()} from '${id}' ` +
              `(${new Decimal(resource.value).toString()}) would go below zero. Pass allowNegative to permit it.`,
          );
        }
        return;
      case 'multiply':
        resource.value = Decimal.mul(resource.value, value);
        return;
      case 'set':
        resource.value = new Decimal(value);
        return;
    }
  }

  const flags = flagRegistry && buildFlagMethods(flagRegistry);
  const rates = buildRateMethods(resourceFor);

  const methods = new Set<GameStateAccessorMethod>([
    'getAmount',
    'applyResourceOp',
    'getRate',
    'getInflowRate',
  ]);
  if (flags) methods.add('getFlag').add('setFlag');
  if (getStateAt) methods.add('getStateAt');
  if (setStateAt) methods.add('setStateAt');

  return {
    getAmount: (id) => {
      // Read per Gate evaluation, so skip the copy when the value is already a Decimal.
      const { value } = resourceFor(id);
      return value instanceof Decimal ? value : new Decimal(value);
    },
    applyResourceOp,
    getFlag: flags?.getFlag ?? (() => missing('getFlag')),
    setFlag: flags?.setFlag ?? (() => missing('setFlag')),
    getStateAt: getStateAt ?? (() => missing('getStateAt')),
    setStateAt: setStateAt ?? (() => missing('setStateAt')),
    ...rates,
    [AccessorMethods]: methods,
  };
}

/** The flag reads and writes, over the flag registry. */
function buildFlagMethods(
  flagRegistry: FlagRegistry,
): Pick<GameStateAccessorMutator, 'getFlag' | 'setFlag'> {
  const flagFor = (id: string): Flag => {
    const flag = flagRegistry.get(id);
    if (!flag) throw new Error(`createGameStateAccessor: no flag '${id}' registered`);
    return flag;
  };
  return {
    getFlag: (id) => flagFor(id).value,
    setFlag: (id, value) => {
      const flag = flagFor(id);
      if (flag.derived) {
        throw new Error(
          `createGameStateAccessor: a 'flag' effect set '${id}', a derived flag, which reads game state and cannot be set.`,
        );
      }
      (flag as SavedFlag).value = value;
    },
  };
}

/** The rate reads, over each resource's rate sources; a resource with none throws. */
function buildRateMethods(
  resourceFor: (id: string) => Resource,
): Pick<GameStateAccessorMutator, 'getRate'> &
  Required<Pick<GameStateAccessorMutator, 'getInflowRate'>> {
  const flowingResource = (id: string): Resource => {
    const resource = resourceFor(id);
    if (!hasRateSources(resource)) {
      throw new Error(
        `createGameStateAccessor: resource '${id}' has no rate sources, so no rate predicts it. ` +
          'Add one with addRateSource, or produce it from a producer category.',
      );
    }
    return resource;
  };
  return {
    getRate: (id) => getRate(flowingResource(id)),
    getInflowRate: (id) => getInflowRate(flowingResource(id)),
  };
}

// === AMBIENT ACCESSOR ===
let _current: GameStateAccessorMutator | undefined;

/**
 * Run `fn` with `accessor` set as the ambient game-state accessor. Category
 * factories called inside `fn` can read it via
 * {@link getCurrentGameStateAccessor}.
 *
 * Used by {@link createEngine} to limit the accessor to that engine during its
 * `install()` / `connect()` phases. Nested calls save and restore the previous
 * ambient value, so engines starting concurrently don't overwrite each other's.
 *
 * Accepts `undefined`, for a test that installs categories without an
 * accessor. In that case `getCurrentGameStateAccessor()` returns `undefined`
 * inside `fn`, and the previous ambient value is restored on exit.
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
