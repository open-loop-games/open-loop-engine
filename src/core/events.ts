/**
 * Typed per-instance event emitter primitive
 *
 * Provides type-safe event subscription for system instances (Reset, Skill, etc.).
 * Per-instance emitters eliminate identity comparison issues entirely.
 *
 * Two interfaces enforce a clean boundary:
 * - Emittable<E>  — public (subscribe only), exposed on system interfaces
 * - EmitHandle<E> — internal (subscribe + emit), stays inside factory closures
 */

import { createNanoEvents } from 'nanoevents';
import { reportEmitDepthTrip } from './safeguards';

/** Default maximum emit depth before recursive chains are blocked. */
export const DEFAULT_MAX_EMIT_DEPTH = 10;

/** Public event interface exposed on system instances — subscribe only, emit is internal. */
export interface Emittable<E> {
  /** Subscribe to an event. Returns an unsubscribe function. */
  on<K extends keyof E>(event: K, handler: E[K]): () => void;
}

/** Internal event interface held inside factory closures — subscribe and emit. */
export interface EmitHandle<E> {
  /** Emit an event to all current subscribers. Blocked if recursive depth exceeds the configured limit. */
  emit<K extends keyof E>(
    event: K,
    ...args: E[K] extends (...args: infer A) => any ? A : never
  ): void;
  /** Subscribe to an event. Returns an unsubscribe function. */
  on<K extends keyof E>(event: K, handler: E[K]): () => void;
}

/** Options for {@link createEmitHandle}. */
export interface EmitHandleOptions {
  /**
   * Maximum recursive emit depth before further emits are blocked.
   * Default: {@link DEFAULT_MAX_EMIT_DEPTH} (10).
   */
  maxEmitDepth?: number;
}

/**
 * Create a typed event handle for use inside a factory closure.
 *
 * Expose `handle.on` on the public interface as `Emittable<E>['on']`.
 * Keep `handle.emit` private to the factory.
 *
 * @example
 * ```ts
 * const handle = createEmitHandle<ResetEvents>();
 * // Inside factory: handle.emit('afterReset')
 * // On public interface: on: handle.on
 * ```
 */
export function createEmitHandle<E>(options?: EmitHandleOptions): EmitHandle<E> {
  const maxDepth = options?.maxEmitDepth ?? DEFAULT_MAX_EMIT_DEPTH;

  // nanoevents requires an index-signature constraint that TS interfaces
  // don't satisfy. The cast is safe — our EmitHandle<E> generic preserves
  // full type safety at every call site.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const bus = createNanoEvents<any>();

  let _emitDepth = 0;

  return {
    emit(event, ...args) {
      if (++_emitDepth > maxDepth) {
        _emitDepth--;
        reportEmitDepthTrip(String(event), maxDepth);
        return;
      }
      try {
        bus.emit(event, ...args);
      } finally {
        _emitDepth--;
      }
    },
    on: (event, handler) => bus.on(event, handler),
  };
}
