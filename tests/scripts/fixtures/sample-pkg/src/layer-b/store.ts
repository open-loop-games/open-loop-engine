/**
 * Store — covers class, abstract-class, and default-export kinds.
 *
 * @cluster store
 */

import type { Widget } from '../layer-a/widgets';

/** Base store with shared persistence shape. */
export abstract class BaseStore<T> {
  abstract save(item: T): void;
}

/** Concrete widget registry. */
export class WidgetRegistry extends BaseStore<Widget> {
  save(_item: Widget): void {
    // no-op
  }
}

/**
 * The default fallback store — used when no explicit store is wired.
 */
export default class DefaultStore {
  reset(): void {
    // no-op
  }
}
