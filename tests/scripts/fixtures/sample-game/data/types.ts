// In-scope domain types for the domain-map extractor fixture. Exercises:
// def inventory + view exclusion, vocabulary (enum / bare union / discriminated
// union), edge mining (multi-word noun, ref-suffix strip, plural container,
// base/arm flattening, self-reference skip), and false-positive guards
// (`status` ≠ stat, `modulo` ≠ mod).

import type { EngineWidgetDef } from '../external/engine-types';

// --- vocabulary ---
export enum Color {
  Red,
  Green,
  Blue,
}

export type Size = 'small' | 'large';

// --- definitions ---
export interface FooDef {
  id: string;
  barId: string; // → bar
  widgetGadgetId: string; // → widgetGadget (multi-word noun)
  statId: string; // → stat (positive control for the guard below)
  status: string; // must NOT match `stat`
  modulo: number; // must NOT match `mod`
  parentFooId: string; // self-reference (FooDef → foo) — skipped
}

export interface BarDef {
  id: string;
  colorId: string; // Color is an enum, not a Def → no `color` noun → no edge
}

export interface WidgetGadgetDef {
  id: string;
}

export interface StatDef {
  id: string;
}

export interface ModDef {
  id: string;
}

// Non-exported base — its `fooId` reaches the map only through the exported
// union arms (checker flattening), and must appear exactly once.
interface ActionBase {
  id: string;
  fooId: string; // → foo
}

export type ActionDef =
  | (ActionBase & { kind: 'move'; targetBarId: string })
  | (ActionBase & { kind: 'wait'; durations: number[] });

// Read-view interface — excluded from the def inventory by viewSuffixes.
export interface GameState {
  getFoo(): FooDef;
}

// Root aggregate — an edge owner but not a `*Def`, so not in the inventory.
export interface SampleData {
  foos: FooDef[];
  bars: BarDef[];
  actions: ActionDef[];
  engineRef?: EngineWidgetDef; // out-of-scope type; `engineWidget` must not leak
}
