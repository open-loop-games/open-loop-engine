// Out-of-scope types. Imported by data/types.ts so that a dependency-resolution
// bug in the extractor would leak these into the map. The extractor must NOT
// surface EngineWidgetDef or an `engineWidget` noun when scope is `data/*.ts`.

export interface EngineWidgetDef {
  id: string;
  engineOnlyField: number;
}

export type EngineMode = 'tick' | 'event';
