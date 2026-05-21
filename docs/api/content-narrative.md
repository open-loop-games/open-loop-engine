# Narrative

Tier-4 character-interaction systems — specialized in incremental games, near-default in narrative-adjacent codebases. Dialog (authored conversation graphs + native runtime + swappable adapter contract) and Relationship (five typed sub-primitives: scalar / faction / tiered / vector / flag). Both compose engine substrate (conditions, effects, gates) into save-friendly drivers.

## Canonical entrypoints

Start with these public symbols before scanning the full inventory below.

- `createDialogCategory` — batch-register authored conversation graphs.
- `createDialogSession` — persistent UI/runtime envelope for driving dialog.
- `createNativeDialogRuntime` / `DialogRuntime` — default runtime and adapter contract for external dialog tools.
- `createRelationshipCategory` — scalar, faction, tiered, vector, and flag relationship state by definition.

## Dialog

authored conversation graphs and the engine-native runtime that walks them. The runtime composes engine substrate (conditions, effects, events, Gate) into a save-friendly conversation driver

- `function createDialogCategory<Def extends { id: string; }>(options: DialogCategoryOptions<Def>): DialogCategory<Def>` — Create a dialog category — batch-registered NPC / scene dialog content with a content registry and per-def DialogGraph production. `src/systems/dialog-category.ts:85`
- `function createDialogSession(options: DialogSessionOptions): DialogSession` — Create a dialog session — the runtime envelope that drives a UI through a DialogGraph. `src/systems/dialog-session.ts:132`
- `function createNativeDialogRuntime(options: NativeDialogRuntimeOptions): NativeDialogRuntime` — Construct a native dialog runtime backed by the supplied graphs + accessor + mutator. `src/systems/dialog.ts:183`
- `interface DialogCategory<Def extends { id: string; }> extends ResettableObject` — A dialog category — batch-registered NPC/scene dialog content. `src/systems/dialog-category.ts:43`
- `interface DialogCategoryEntry<Def extends { id: string; }>` — A registered entry: definition + dialog graphs (no per-instance state). `src/systems/dialog-category.ts:37`
- `interface DialogCategoryOptions<Def extends { id: string; }>` — Options for createDialogCategory. `src/systems/dialog-category.ts:25`
- `interface DialogChoice` — A single response option attached to a DialogNode. `src/systems/dialog.ts:50`
- `interface DialogGraph` — A complete authored conversation: nodes plus an entry pointer. `src/systems/dialog.ts:65`
- `interface DialogNode` — A single line/branch in a dialog graph. `src/systems/dialog.ts:32`
- `interface DialogPresentation` — Snapshot of a presented line — what the UI binds to. `src/systems/dialog.ts:74`
- `interface DialogRuntime` — Adapter contract: anything that can drive a dialog conversation against host state. `src/systems/dialog.ts:111`
- `interface DialogRuntimeEvents` — Lifecycle events emitted by a NativeDialogRuntime instance. `src/systems/dialog.ts:128`
- `type DialogRuntimeFactory = (graphs: DialogGraph[], accessor: GameStateAccessor, mutator: GameStateMutator) => DialogRuntime` — Factory signature for swapping in alternative DialogRuntime implementations (Ink, Yarn, etc.). `src/systems/dialog-session.ts:55`
- `interface DialogRuntimeState` — Persistable runtime state — engine-canonical fields that every DialogRuntime implementation lowers into on `exportState()`. `src/systems/dialog.ts:93`
- `interface DialogSession extends Emittable<DialogSessionEvents>` — A dialog session — the public surface for driving conversations from a UI / module. `src/systems/dialog-session.ts:85`
- `interface DialogSessionEvents` — Lifecycle events emitted by a DialogSession. `src/systems/dialog-session.ts:45`
- `interface DialogSessionOptions` — Options for createDialogSession — the persistent id, the authored graphs available in this session, and optional runtime-factory + accessor overrides for swapping the dialog backend. `src/systems/dialog-session.ts:66`
- `interface NativeDialogRuntime extends DialogRuntime, Emittable<DialogRuntimeEvents>` — Native dialog runtime instance — implements DialogRuntime plus event subscription. `src/systems/dialog.ts:152`
- `interface NativeDialogRuntimeOptions` — Options for createNativeDialogRuntime — the authored graphs plus the read/write side (GameStateAccessor for predicates, GameStateMutator for outcome dispatch). `src/systems/dialog.ts:142`

## Relationship

variant shapes and category dispatch

- `function createRelationshipCategory<Def extends RelationshipDef = RelationshipDef>(options: RelationshipCategoryOptions): RelationshipCategory<Def>` — Create a relationship category that dispatches per-def to one of the five variant shapes by `def.kind`. `src/systems/relationship.ts:571`
- `interface FactionRelationshipDef extends RelationshipDefBase` — Scalar per-faction with attitude-matrix propagation (Endless Sky, Daggerfall faction tree). `src/systems/relationship-defs.ts:56`
- `interface FlagRelationshipDef extends RelationshipDefBase` — Boolean flag bag (Exult `Obj_flags` + global `gflags`). `src/systems/relationship-defs.ts:127`
- `interface RelationshipCategory<Def extends RelationshipDef> extends ResettableObject` — Container that registers a heterogeneous mix of relationship defs (scalar / vector / tiered / faction / flag) and builds the matching live instance for each by dispatching on `def.kind`. `src/systems/relationship.ts:209`
- `interface RelationshipCategoryEntry<Def extends RelationshipDef>` — One entry inside a RelationshipCategory — the authored def paired with the live RelationshipInstance dispatched from it. `src/systems/relationship.ts:199`
- `interface RelationshipCategoryOptions` — Options for createRelationshipCategory. `src/systems/relationship.ts:190`
- `type RelationshipDef = ScalarRelationshipDef | FactionRelationshipDef | TieredRelationshipDef | VectorRelationshipDef | FlagRelationshipDef` — Discriminated union — every registered relationship def is one of these. `src/systems/relationship-defs.ts:138`
- `interface RelationshipDefBase` — Common identity for every relationship def. `src/systems/relationship-defs.ts:22`
- `type RelationshipInstance = ScalarRelationship | TieredRelationship | VectorRelationship | FactionRelationship | FlagRelationship` — Discriminated runtime instance — one variant per registered def. `src/systems/relationship.ts:180`
- `interface ScalarRelationshipDef extends RelationshipDefBase` — Scalar per-entity (Tuxemon bond, Level13 trust). `src/systems/relationship-defs.ts:33`
- `interface TieredRelationshipDef extends RelationshipDefBase` — Ordered tier ladder (Daggerfall guild rank, OpenMW faction rank, molcremental NPC trust). `src/systems/relationship-defs.ts:78`
- `interface VectorRelationshipDef extends RelationshipDefBase` — Multi-dimensional vector (CDDA opinion: `{trust, fear, value, anger, owed, sold}`). `src/systems/relationship-defs.ts:102`
