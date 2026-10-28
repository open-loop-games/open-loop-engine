/**
 * Game-state accessor — the opt-in builder over the resource registry, the
 * record of the methods an accessor implements, and the ambient accessor
 * `createEngine` sets around `install()` / `connect()`.
 *
 * - {@link createGameStateAccessor} builds a `GameStateAccessorMutator` whose
 *   amounts, resource writes and rates come from the engine's resource
 *   registry, and whose flags come from its flag registry. The consumer
 *   supplies state paths, and may supply flags and rates of its own, which
 *   win. A method with no source throws, naming the kind that called it.
 * - {@link AccessorMethods} keys the record of methods an accessor
 *   implements. Construction checks read it, so a `flag` Gate over an accessor
 *   without `getFlag` fails where it is registered, not inside a `computed`.
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

/** The engine services an accessor factory receives from `createEngine`. */
export interface AccessorServices {
  resourceRegistry: ResourceRegistry;
  /** Serves `getFlag` and `setFlag` when the options leave them out. `createEngine` always passes it. */
  flagRegistry?: FlagRegistry;
}

/** What the consumer supplies to {@link createGameStateAccessor}. */
export interface GameStateAccessorOptions {
  /** Replaces the flag registry's reads. */
  getFlag?: GameStateAccessor['getFlag'];
  /** Replaces the flag registry's writes. */
  setFlag?: GameStateMutator['setFlag'];
  getStateAt?: GameStateAccessor['getStateAt'];
  setStateAt?: GameStateMutator['setStateAt'];
  /** Net rate per second, replacing the resources' rate sources. */
  getRate?: GameStateAccessor['getRate'];
  /**
   * Gross inflow rate, replacing the rate sources' inflow. With a supplied
   * `getRate` and no `getInflowRate`, `cumulative-gte` predictions use the net rate.
   */
  getInflowRate?: GameStateAccessor['getInflowRate'];
  /** Let a `subtract` take a resource below zero. Default `false`: such a subtract throws. */
  allowNegative?: boolean;
}

/**
 * Injection key for the accessor `createEngine` was given or built. Read it
 * with `engine.tryInject` after `start()`, from UI code or a balance tool.
 */
export const GameStateAccessorKey: InjectionKey<GameStateAccessorMutator> =
  Symbol('GameStateAccessor');

// === CONSTANTS ===

/** What calls each method that may get a throwing stub, for the error it throws. */
const CALLERS = {
  getFlag: "a 'flag' Gate or condition",
  setFlag: "a 'flag' effect",
  getStateAt: "a 'state' Gate or condition",
  setStateAt: "a 'state' effect",
} as const satisfies Partial<Record<keyof GameStateAccessorOptions, string>>;

// === RECORD ===

/**
 * How to fix a method an accessor does not implement, for the errors.
 *
 * @internal
 */
export const ACCESSOR_METHOD_REMEDY =
  'Supply it to createGameStateAccessor, or add it to the accessor and its AccessorMethods record.';

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
 * Build a game-state accessor and mutator over the engine's registries.
 * Amounts, resource writes and rates come from the resource registry, rates
 * as each resource's rate sources. Flags come from the flag registry. State
 * paths, and any flag or rate reads the game keeps itself, come from
 * `options`, and a supplied method wins. Nothing is wired unless you pass it
 * to `createEngine`.
 *
 * Every read is at call time, so the registries may still be empty when this
 * runs. A resource or flag id the registries lack throws. `getRate` throws for
 * a resource with no rate sources, so a Gate prediction over one fails loudly;
 * a display reads the core `getRate(resource)`, which reads zero. A method
 * with no source throws, naming the kind that called it, and is missing from
 * the {@link AccessorMethods} record, so construction checks fail first.
 *
 * @param services the engine services; `createEngine` passes them to an
 *   `accessor` factory.
 * @param options the reads and writes the registries cannot answer, and the
 *   subtract policy.
 * @returns a `GameStateAccessorMutator` with an {@link AccessorMethods} record.
 *
 * @example
 * ```ts
 * const engine = createEngine({
 *   gameId: 'my-game',
 *   accessor: (services) =>
 *     createGameStateAccessor(services, {
 *       getStateAt: (path) => state[path],
 *       setStateAt: (path, value) => { state[path] = value; },
 *     }),
 * });
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

  function missing(method: keyof typeof CALLERS): never {
    throw new Error(
      `createGameStateAccessor: ${CALLERS[method]} called ${method}, which this accessor was not given. ` +
        `Pass ${method} in createGameStateAccessor's options.`,
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

  const flags = buildFlagMethods(options, flagRegistry);
  const rates = buildRateMethods(options, resourceFor);

  const methods = new Set<GameStateAccessorMethod>(['getAmount', 'applyResourceOp']);
  if (flags.getFlag) methods.add('getFlag');
  if (flags.setFlag) methods.add('setFlag');
  if (getStateAt) methods.add('getStateAt');
  if (setStateAt) methods.add('setStateAt');
  methods.add('getRate');
  if (rates.getInflowRate) methods.add('getInflowRate');

  return {
    getAmount: (id) => {
      // Read per Gate evaluation, so skip the copy when the value is already a Decimal.
      const { value } = resourceFor(id);
      return value instanceof Decimal ? value : new Decimal(value);
    },
    applyResourceOp,
    getFlag: flags.getFlag ?? (() => missing('getFlag')),
    setFlag: flags.setFlag ?? (() => missing('setFlag')),
    getStateAt: getStateAt ?? (() => missing('getStateAt')),
    setStateAt: setStateAt ?? (() => missing('setStateAt')),
    getRate: rates.getRate,
    // Absent, not a stub: an absent getInflowRate means "use the net rate".
    ...(rates.getInflowRate && { getInflowRate: rates.getInflowRate }),
    [AccessorMethods]: methods,
  };
}

/** The flag reads and writes: the options' own, else the flag registry's, else none. */
function buildFlagMethods(
  options: GameStateAccessorOptions,
  flagRegistry: FlagRegistry | undefined,
): Pick<GameStateAccessorOptions, 'getFlag' | 'setFlag'> {
  const flagFor = (id: string): Flag => {
    const flag = flagRegistry!.get(id);
    if (!flag) throw new Error(`createGameStateAccessor: no flag '${id}' registered`);
    return flag;
  };
  return {
    getFlag: options.getFlag ?? (flagRegistry && ((id) => flagFor(id).value)),
    setFlag:
      options.setFlag ??
      (flagRegistry &&
        ((id, value) => {
          const flag = flagFor(id);
          if (flag.derived) {
            throw new Error(
              `createGameStateAccessor: a 'flag' effect set '${id}', a derived flag, which reads game state and cannot be set.`,
            );
          }
          (flag as SavedFlag).value = value;
        })),
  };
}

/**
 * The rate reads: the options' own, else the resources' rate sources. A
 * supplied `getRate` alone leaves `getInflowRate` absent, so the consumer's
 * net rate stands in for inflow rather than the rate sources'.
 */
function buildRateMethods(
  options: GameStateAccessorOptions,
  resourceFor: (id: string) => Resource,
): { getRate: GameStateAccessor['getRate']; getInflowRate?: GameStateAccessor['getInflowRate'] } {
  if (options.getRate) return { getRate: options.getRate, getInflowRate: options.getInflowRate };
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
    getInflowRate: options.getInflowRate ?? ((id) => getInflowRate(flowingResource(id))),
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
 * Accepts `undefined` for engines that don't use an accessor (tests, engine-
 * only workbenches). In that case `getCurrentGameStateAccessor()` returns
 * `undefined` inside `fn`, and the previous ambient value is restored on exit.
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
