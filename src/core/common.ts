/**
 * Common — shared generic type utilities and dev-mode helpers
 */

/** Extract keys that are required (non-optional) from a type */
export type RequiredKeys<T> = {
  [K in keyof T]-?: NonNullable<unknown> extends Pick<T, K> ? never : K;
}[keyof T];

/**
 * Type guard for checking if a value is a function
 */
export function isFunction<T, S extends ReadonlyArray<unknown>, R>(
  functionOrValue: ((...args: S) => T) | R,
): functionOrValue is (...args: S) => T {
  return typeof functionOrValue === 'function';
}

/**
 * Detect dev mode. Vite sets `import.meta.env.DEV`; Node sets
 * `process.env.NODE_ENV`. Defaults to `true` when neither is available so
 * dev-only diagnostics surface in unconfigured environments (tests, scratch
 * runners) rather than going silent. Distinct from {@link isDevMode} in
 * `safeguards.ts`, which is an opt-in feature toggle.
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
