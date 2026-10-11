/**
 * Common — shared generic type utilities, dev-mode helpers and Vue effect scope ownership
 */

import type { EffectScope } from 'vue';

/** Extract keys that are required (non-optional) from a type */
export type RequiredKeys<T> = {
  [K in keyof T]-?: NonNullable<unknown> extends Pick<T, K> ? never : K;
}[keyof T];

/**
 * Type guard for checking if a value is a function
 */
// `R` looks single-use but drives inference: it absorbs the non-function arm so
// `T` and `S` infer from the function arm. `| unknown` would collapse the union.
// oxlint-disable-next-line typescript/no-unnecessary-type-parameters
export function isFunction<T, S extends ReadonlyArray<unknown>, R>(
  functionOrValue: ((...args: S) => T) | R,
): functionOrValue is (...args: S) => T {
  return typeof functionOrValue === 'function';
}

/**
 * Detect dev mode. Vite sets `import.meta.env.DEV`; Node sets
 * `process.env.NODE_ENV`. Defaults to `true` when neither is available, so
 * dev-only checks still run in unconfigured environments (tests, scratch
 * runners). Distinct from {@link isDevMode} in `safeguards.ts`, which is an
 * opt-in feature toggle.
 */
export function isDev(): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const env = (import.meta as any)?.env;
    if (env && typeof env.DEV === 'boolean') return env.DEV;
    if (env && typeof env.PROD === 'boolean') return !env.PROD;
  } catch {
    // no-op
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const proc = (globalThis as any)?.process;
  return !proc || proc?.env?.NODE_ENV !== 'production';
}

/**
 * Run `fn` inside the Vue effect scope `scope` while it is active, so the
 * watchers, computeds and `onScopeDispose` handlers it builds stop with that
 * scope. Run it bare once the scope has stopped, or when there is none.
 *
 * @internal
 */
export function runInEffectScope<T>(scope: EffectScope | undefined, fn: () => T): T {
  return scope?.active ? (scope.run(fn) as T) : fn();
}
