/**
 * Resettable protocol — opt-in interface for objects that can yield their
 * resettable contents to a reset's `thingsToReset` walk.
 *
 * Lives in core so core primitives and systems alike can implement it
 * without importing the reset system. Every system that owns a persistent
 * context yields that context's refs, and a category yields each entry's,
 * so passing one to `thingsToReset` resets what a module reset would reset
 * of it and never a resource or ref it only names.
 */

import {
  getModulePersistentRefs,
  getPersistenceNamespace,
  withPersistenceNamespace,
} from './persistence';

/**
 * Symbol key for the Resettable protocol. Objects that implement this
 * provide a method returning an iterable of items that the reset walk
 * should recursively walk and reset.
 */
export const Resettable = Symbol('Resettable');

/**
 * An object whose persistent contents can be yielded for recursive reset.
 *
 * Implement `[Resettable]()` to return an iterable of objects containing
 * persistent refs. The reset system will recursively walk each yielded item
 * the same way it walks any other object in `thingsToReset`.
 */
export interface ResettableObject {
  [Resettable](): Iterable<unknown>;
}

/**
 * Make `target` yield the non-lifetime refs of persistent context
 * `contextId` and its child contexts — the refs a module reset of that
 * context would write. Call it while building, inside the engine that owns
 * the context.
 *
 * @internal
 */
export function attachContextReset<T extends object>(
  target: T,
  contextId: string,
): T & ResettableObject {
  // A reset runs after install has closed the ambient namespace, so resolve
  // the context in the engine that built it.
  const namespace = getPersistenceNamespace();
  return Object.assign(target, {
    [Resettable]: () =>
      withPersistenceNamespace(namespace, () => getModulePersistentRefs(contextId)),
  });
}
