/**
 * Resettable protocol — opt-in interface for objects that can yield their
 * resettable contents to a reset's `thingsToReset` walk.
 *
 * It is in core, so core primitives and systems alike can implement it
 * without importing the reset system. Every system that owns a persistent
 * context yields that context's refs, and a category yields each category
 * entry's. So passing one to `thingsToReset` resets what a
 * `resetPersistentContexts` reset of its persistent context would. It never
 * resets a resource or ref it only names.
 */

import { bindPersistenceNamespace, getPersistentContextRefs } from './persistence';

/**
 * Symbol key for the Resettable protocol. An object that implements it
 * has a method that returns an iterable of objects for the reset walk to
 * walk and reset.
 */
export const Resettable = Symbol('Resettable');

/**
 * An object whose persistent contents can be yielded for recursive reset.
 *
 * Implement `[Resettable]()` to return an iterable of objects containing
 * persistent refs. The reset system walks each yielded object the same way
 * it walks any other object in `thingsToReset`.
 */
export interface ResettableObject {
  [Resettable](): Iterable<unknown>;
}

/**
 * Make `target` yield the non-lifetime refs of persistent context
 * `contextId` and its child persistent contexts: the refs a
 * `resetPersistentContexts` reset of that persistent context writes. Call it
 * while building, inside the engine that owns the persistent context.
 *
 * @internal
 */
export function attachPersistentContextReset<T extends object>(
  target: T,
  contextId: string,
): T & ResettableObject {
  return Object.assign(target, {
    [Resettable]: bindPersistenceNamespace(() => getPersistentContextRefs(contextId)),
  });
}
