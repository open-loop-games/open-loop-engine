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

- `function createDialogCategory<Def extends { id: string; }>(options: DialogCategoryOptions<Def>): DialogCategory<Def>` — Create a dialog category — batch-registered NPC / scene dialog content with a content registry and per-def DialogGraph production. `src/systems/dialog-category.ts:91`
- `function createDialogSession(options: DialogSessionOptions): DialogSession` — Create a dialog session — the runtime envelope that drives a UI through a DialogGraph. `src/systems/dialog-session.ts:138`
- `function createNativeDialogRuntime(options: NativeDialogRuntimeOptions): NativeDialogRuntime` — Construct a native dialog runtime backed by the supplied graphs + accessor + mutator. `src/systems/dialog.ts:185`
- `interface DialogCategory<Def extends { id: string; }> extends ResettableObject` — A dialog category — batch-registered NPC/scene dialog content. `src/systems/dialog-category.ts:47`
- `interface DialogCategoryEntry<Def extends { id: string; }>` — A registered entry: definition + dialog graphs (no per-instance state). `src/systems/dialog-category.ts:41`
- `interface DialogCategoryOptions<Def extends { id: string; }>` — Options for createDialogCategory. `src/systems/dialog-category.ts:29`
- `const DialogCategoryType: unique symbol` — Symbol identifying DialogCategory features. `src/systems/dialog-category.ts:26`
- `interface DialogChoice` — A single response option attached to a DialogNode. `src/systems/dialog.ts:52`
- `interface DialogGraph` — A complete authored conversation: nodes plus an entry pointer. `src/systems/dialog.ts:67`
- `interface DialogNode` — A single line/branch in a dialog graph. `src/systems/dialog.ts:33`
- `interface DialogPresentation` — Snapshot of a presented line — what the UI binds to. `src/systems/dialog.ts:76`
- `interface DialogRuntime` — Adapter contract: anything that can drive a dialog conversation against host state. `src/systems/dialog.ts:113`
- `interface DialogRuntimeEvents` — Lifecycle events emitted by a NativeDialogRuntime instance. `src/systems/dialog.ts:130`
- `type DialogRuntimeFactory = (graphs: DialogGraph[], accessor: GameStateAccessor, mutator: GameStateMutator) => DialogRuntime` — Factory signature for swapping in alternative DialogRuntime implementations (Ink, Yarn, etc.). `src/systems/dialog-session.ts:59`
- `interface DialogRuntimeState` — Persistable runtime state — engine-canonical fields that every DialogRuntime implementation lowers into on `exportState()`. `src/systems/dialog.ts:95`
- `interface DialogSession extends Emittable<DialogSessionEvents>` — A dialog session — the public surface for driving conversations from a UI / module. `src/systems/dialog-session.ts:89`
- `interface DialogSessionEvents` — Lifecycle events emitted by a DialogSession. `src/systems/dialog-session.ts:49`
- `interface DialogSessionOptions` — Options for createDialogSession — the persistent id, the authored graphs available in this session, and optional runtime-factory + accessor overrides for swapping the dialog backend. `src/systems/dialog-session.ts:70`
- `const DialogSessionType: unique symbol` — Symbol identifying DialogSession features. `src/systems/dialog-session.ts:46`
- `function isDialogCategory(value: unknown): value is DialogCategory<{ id: string; }>` — Type guard: returns `true` if the value is a DialogCategory instance. `src/systems/dialog-category.ts:139`
- `function isDialogSession(value: unknown): value is DialogSession` — Type guard: returns `true` if the value is a DialogSession instance. `src/systems/dialog-session.ts:231`
- `interface NativeDialogRuntime extends DialogRuntime, Emittable<DialogRuntimeEvents>` — Native dialog runtime instance — implements DialogRuntime plus event subscription. `src/systems/dialog.ts:154`
- `interface NativeDialogRuntimeOptions` — Options for createNativeDialogRuntime — the authored graphs plus the read/write side (GameStateAccessor for predicates, GameStateMutator for outcome dispatch). `src/systems/dialog.ts:144`

## Relationship

typed per-actor / per-faction state with five variant shapes (scalar, faction, tiered, vector, flag)

- `interface FactionRelationshipDef extends RelationshipDefBase` — Scalar per-faction with attitude-matrix propagation (Endless Sky, Daggerfall faction tree). `src/primitives/relationship.ts:54`
- `interface FlagRelationshipDef extends RelationshipDefBase` — Boolean flag bag (Exult `Obj_flags` + global `gflags`). `src/primitives/relationship.ts:123`
- `type RelationshipDef = ScalarRelationshipDef | FactionRelationshipDef | TieredRelationshipDef | VectorRelationshipDef | FlagRelationshipDef` — Discriminated union — every registered relationship def is one of these. `src/primitives/relationship.ts:134`
- `interface RelationshipDefBase` — Common identity for every relationship def. `src/primitives/relationship.ts:20`
- `interface ScalarRelationshipDef extends RelationshipDefBase` — Scalar per-entity (Tuxemon bond, Level13 trust). `src/primitives/relationship.ts:31`
- `interface TieredRelationshipDef extends RelationshipDefBase` — Ordered tier ladder (Daggerfall guild rank, OpenMW faction rank, molcremental NPC trust). `src/primitives/relationship.ts:76`
- `interface VectorRelationshipDef extends RelationshipDefBase` — Multi-dimensional vector (CDDA opinion: `{trust, fear, value, anger, owed, sold}`). `src/primitives/relationship.ts:98`
- `function createRelationshipCategory<Def extends RelationshipDef = RelationshipDef>(options: RelationshipCategoryOptions): RelationshipCategory<Def>` — Create a relationship category that dispatches per-def to one of the five variant shapes by `def.kind`. `src/systems/relationship.ts:583`
- `function isRelationshipCategory(value: unknown): value is RelationshipCategory<RelationshipDef>` — Type guard: returns `true` if the value is a RelationshipCategory instance. `src/systems/relationship.ts:619`
- `interface RelationshipCategory<Def extends RelationshipDef> extends ResettableObject` — Container that registers a heterogeneous mix of relationship defs (scalar / vector / tiered / faction / flag) and builds the matching live instance for each by dispatching on `def.kind`. `src/systems/relationship.ts:214`
- `interface RelationshipCategoryEntry<Def extends RelationshipDef>` — One entry inside a RelationshipCategory — the authored def paired with the live RelationshipInstance dispatched from it. `src/systems/relationship.ts:204`
- `interface RelationshipCategoryOptions` — Options for createRelationshipCategory. `src/systems/relationship.ts:195`
- `const RelationshipCategoryType: unique symbol` — Symbol identifying RelationshipCategory features. `src/systems/relationship.ts:192`
- `type RelationshipInstance = ScalarRelationship | TieredRelationship | VectorRelationship | FactionRelationship | FlagRelationship` — Discriminated runtime instance — one variant per registered def. `src/systems/relationship.ts:182`
