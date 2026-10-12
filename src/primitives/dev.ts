/**
 * Dev — detect a dev build from the environment
 *
 * Shared by every source layer, so it sits at the bottom. Distinct from
 * `isDevMode` in `core/safeguards.ts`, which is an opt-in feature toggle.
 */

/**
 * Detect dev mode. Vite sets `import.meta.env.DEV`; Node sets
 * `process.env.NODE_ENV`. Defaults to `true` when neither is available, so
 * dev-only checks still run in unconfigured environments (tests, scratch
 * runners).
 *
 * @internal
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
