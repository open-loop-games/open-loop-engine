/**
 * Resettable protocol — opt-in interface for objects that can yield their
 * resettable contents to {@link resetObject} in the reset system.
 *
 * Lives in its own file so any system can implement it without importing
 * category machinery. CategoryBase is the primary implementor today;
 * standalone collections (inventory, skill pools) can adopt it later.
 */

/**
 * Symbol key for the Resettable protocol. Objects that implement this
 * provide a method returning an iterable of items that {@link resetObject}
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
