/**
 * Dialog Category — batch-register {@link DialogGraph} content from per-NPC
 * (or per-character, per-scene) definitions. Mirrors the shape of other
 * category systems (Skill, Achievement, Producer): a content registry plus a
 * domain-specific instance per definition.
 *
 * The category itself doesn't drive conversation flow — that's the
 * {@link DialogSession}'s job. The category is the authoring surface: register
 * a content def, the category produces the DialogGraph(s) for it and exposes
 * lookup helpers for the session to consume.
 *
 * @see ./dialog-session for the runtime that drives a graph from this category
 *
 * @cluster dialog
 */

import type { DialogGraph } from './dialog';
import { createCategoryBase, type CategoryBase } from './category-base';
import type { ContentRegistryView } from './content-registry';
import { Resettable, type ResettableObject } from './resettable';

// === TYPES ===

/** Options for {@link createDialogCategory}. */
export interface DialogCategoryOptions<Def extends { id: string }> {
  /** Persistence context name. Each definition gets a sub-context `{id}/{def.id}`. */
  id: string;
  /**
   * Map a content def to one or more dialog graphs. Most NPCs have one graph
   * (their canonical conversation tree); shop / quest givers may have several
   * keyed by entry point. A graph id already mapped by any def throws.
   */
  mapDialog: (def: Def) => DialogGraph | DialogGraph[];
}

/** A registered entry: definition + dialog graphs (no per-instance state). */
export interface DialogCategoryEntry<Def extends { id: string }> {
  readonly def: Def;
  readonly graphs: DialogGraph[];
}

/** A dialog category — batch-registered NPC/scene dialog content. */
export interface DialogCategory<Def extends { id: string }> extends ResettableObject {
  /**
   * The content registry. `registry.patch()` / `pushPatches()` change the def;
   * an instance sees the change only through a getter that reads `getDef(id)`
   * or `registry.get(id)`, since value fields and closures over `def` are
   * copied or frozen at register. The view has no `register`: add defs with the
   * category's `register`, which builds each def's instance and state.
   */
  readonly registry: ContentRegistryView<Def>;
  register(defs: Def | Def[]): void;
  getDef(id: string): Def | undefined;
  getEntry(id: string): DialogCategoryEntry<Def> | undefined;
  getAll(): DialogCategoryEntry<Def>[];
  /** Flat lookup of a graph by its `id` field across every registered entry; graph ids are unique across the category. */
  getGraph(graphId: string): DialogGraph | undefined;
  readonly size: number;
}

// === FACTORIES ===

/**
 * Create a dialog category — batch-registered NPC / scene dialog content with
 * a content registry and per-def {@link DialogGraph} production.
 *
 * @param options - Persistence-context id and a `mapDialog(def) => graph(s)`
 *   function. Most NPCs map to one graph; shop / quest givers may map to
 *   several keyed by entry point.
 * @returns A {@link DialogCategory} with `register` / `getDef` / `getEntry` /
 *   `getAll` / `getGraph(graphId)` accessors and a `registry.patch` extension
 *   point for mods.
 *
 * @example
 * ```ts
 * interface NpcDef { id: string; name: string; lines: AuthoredLine[] }
 *
 * const dialog = createDialogCategory<NpcDef>({
 *   id: 'npcs',
 *   mapDialog: (def) => buildGraphsForNpc(def),
 * });
 *
 * dialog.register(NPC_DEFS);
 *
 * const session = createDialogSession({
 *   id: 'main',
 *   graphs: dialog.getAll().flatMap((e) => e.graphs),
 * });
 * ```
 */
export function createDialogCategory<Def extends { id: string }>(
  options: DialogCategoryOptions<Def>,
): DialogCategory<Def> {
  const base: CategoryBase<Def, DialogGraph[], void> = createCategoryBase<Def, DialogGraph[], void>(
    {
      id: options.id,
      buildInstance: (def) => {
        const out = options.mapDialog(def);
        const graphs = Array.isArray(out) ? out : [out];
        for (const [i, graph] of graphs.entries()) {
          const prior = base.getAll().find((e) => e.instance.some((g) => g.id === graph.id));
          const clash = graphs.slice(0, i).some((g) => g.id === graph.id)
            ? `def "${def.id}" maps to it twice`
            : prior && `def "${prior.def.id}" and def "${def.id}" both map to it`;
          if (clash) {
            throw new Error(
              `DialogCategory "${options.id}": duplicate dialog graph id "${graph.id}" — ${clash}. Graph ids are unique across a category.`,
            );
          }
        }
        return graphs;
      },
    },
  );

  return {
    registry: base.registry,
    register: base.register,
    getDef: base.getDef,

    getEntry(id: string): DialogCategoryEntry<Def> | undefined {
      const e = base.getEntry(id);
      return e ? { def: e.def, graphs: e.instance } : undefined;
    },

    getAll(): DialogCategoryEntry<Def>[] {
      return base.getAll().map((e) => ({ def: e.def, graphs: e.instance }));
    },

    getGraph(graphId: string): DialogGraph | undefined {
      for (const entry of base.getAll()) {
        for (const g of entry.instance) {
          if (g.id === graphId) return g;
        }
      }
      return undefined;
    },

    get size(): number {
      return base.size;
    },

    [Resettable]: base[Resettable],
  };
}
