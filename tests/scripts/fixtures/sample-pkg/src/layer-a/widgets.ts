/**
 * Widgets — covers function, interface, type, const, enum kinds, and a type merged with a const.
 *
 * @cluster widgets
 */

/** Unique identifier for a widget instance. */
export type WidgetID = string;

/** Categories of widget supported by the system. */
export enum WidgetKind {
  Basic = 'basic',
  Premium = 'premium',
}

/** A renderable widget. */
export interface Widget {
  id: WidgetID;
  kind: WidgetKind;
}

/** Maximum allowed widgets per session. */
export const WIDGET_LIMIT = 100;

/** A widget's size on screen. */
export type WidgetSize = { width: number; height: number };

/** Construct a widget size, one per call. */
export const WidgetSize = (width: number, height: number): WidgetSize => ({ width, height });

/**
 * Create a new widget with the given kind. Used by callers that need a
 * pre-validated instance — handles default-id assignment.
 *
 * Multi-paragraph summaries should stop at the first sentence.
 */
export function createWidget(kind: WidgetKind): Widget {
  return { id: 'w-' + Math.random(), kind };
}

/**
 * Internal scratch helper not intended for downstream consumption.
 * @internal
 */
export function internalHelper(): number {
  return 42;
}
