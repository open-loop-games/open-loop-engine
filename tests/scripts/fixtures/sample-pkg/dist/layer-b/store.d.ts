import type { Widget } from '../layer-a/widgets';
/** Base store with shared persistence shape. */
export declare abstract class BaseStore<T> {
  abstract save(item: T): void;
}
/** Concrete widget registry. */
export declare class WidgetRegistry extends BaseStore<Widget> {
  save(_item: Widget): void;
}
/**
 * The default fallback store — used when no explicit store is wired.
 */
export default class DefaultStore {
  reset(): void;
}
/** Store for widgets an operator pinned. */
export declare class PinnedStore {
  pin(item: Widget): void;
}
export interface PinnedStore {
  unpin(item: Widget): void;
}
