/** Unique identifier for a widget instance. */
export type WidgetID = string;
/** Categories of widget supported by the system. */
export declare enum WidgetKind {
  Basic = 'basic',
  Premium = 'premium',
}
/** A renderable widget. */
export interface Widget {
  id: WidgetID;
  kind: WidgetKind;
}
/** Maximum allowed widgets per session. */
export declare const WIDGET_LIMIT = 100;
/** A widget's size on screen. */
export type WidgetSize = {
  width: number;
  height: number;
};
/** Construct a widget size, one per call. */
export declare const WidgetSize: (width: number, height: number) => WidgetSize;
/**
 * Create a new widget with the given kind. Used by callers that need a
 * pre-validated instance — handles default-id assignment.
 *
 * Multi-paragraph summaries should stop at the first sentence.
 */
export declare function createWidget(kind: WidgetKind): Widget;
/**
 * Internal scratch helper not intended for downstream consumption.
 * @internal
 */
export declare function internalHelper(): number;
