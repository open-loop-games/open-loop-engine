# Narrative

Tier-4 character-interaction systems — specialized in incremental games, near-default in narrative-adjacent codebases. Dialog (authored conversation graphs + native runtime + swappable adapter contract) and Subject (addressable named entities with typed multi-field state). Both compose engine substrate (conditions, effects, gates) into save-friendly drivers.

## Canonical entrypoints

Start with these public symbols before scanning the full inventory below.

- `createDialogCategory` — batch-register authored conversation graphs.
- `createDialogSession` — persistent UI/runtime envelope for driving dialog.
- `createNativeDialogRuntime` / `DialogRuntime` — default runtime and adapter contract for external dialog tools.
- `createSubjectCategory` — addressable subjects (NPCs, factions, regions, single entities) with typed multi-field state (scalar / vector / tier / flag / enum).

## Dialog

authored conversation graphs and the engine-native runtime that walks them. The runtime composes engine substrate (Gate predicates, effects, events) into a save-friendly conversation driver

- `function createDialogCategory<Def extends { id: string; }>(options: DialogCategoryOptions<Def>): DialogCategory<Def>` — Create a dialog category — batch-registered NPC / scene dialog content with a content registry and per-def DialogGraph production. `src/systems/dialog-category.ts:85`
- `function createDialogSession(options: DialogSessionOptions): DialogSession` — Create a dialog session — the runtime envelope that drives a UI through a DialogGraph. `src/systems/dialog-session.ts:134`
- `function createNativeDialogRuntime(options: NativeDialogRuntimeOptions): NativeDialogRuntime` — Construct a native dialog runtime backed by the supplied graphs + accessor + mutator. `src/systems/dialog.ts:188`
- `interface DialogCategory<Def extends { id: string; }> extends ResettableObject` — A dialog category — batch-registered NPC/scene dialog content. `src/systems/dialog-category.ts:43`
- `interface DialogCategoryEntry<Def extends { id: string; }>` — A registered entry: definition + dialog graphs (no per-instance state). `src/systems/dialog-category.ts:37`
- `interface DialogCategoryOptions<Def extends { id: string; }>` — Options for createDialogCategory. `src/systems/dialog-category.ts:25`
- `interface DialogChoice` — A single response option attached to a DialogNode. `src/systems/dialog.ts:49`
- `interface DialogGraph` — A complete authored conversation: nodes plus an entry pointer. `src/systems/dialog.ts:64`
- `interface DialogNode` — A single line/branch in a dialog graph. `src/systems/dialog.ts:31`
- `interface DialogPresentation` — Snapshot of a presented line — what the UI binds to. `src/systems/dialog.ts:73`
- `interface DialogRuntime` — Adapter contract: anything that can drive a dialog conversation against host state. `src/systems/dialog.ts:110`
- `interface DialogRuntimeEvents` — Lifecycle events emitted by a NativeDialogRuntime instance. `src/systems/dialog.ts:134`
- `type DialogRuntimeFactory = (graphs: DialogGraph[], accessor: GameStateAccessor, mutator: GameStateMutator) => DialogRuntime` — Factory signature for swapping in alternative DialogRuntime implementations (Ink, Yarn, etc.). `src/systems/dialog-session.ts:57`
- `interface DialogRuntimeState` — Persistable runtime state — engine-canonical fields that every DialogRuntime implementation lowers into on `exportState()`. `src/systems/dialog.ts:92`
- `interface DialogSession extends Emittable<DialogSessionEvents>` — A dialog session — the public surface for driving conversations from a UI / module. `src/systems/dialog-session.ts:87`
- `interface DialogSessionEvents` — Lifecycle events emitted by a DialogSession. `src/systems/dialog-session.ts:47`
- `interface DialogSessionOptions` — Options for createDialogSession — the persistent id, the authored graphs available in this session, and optional runtime-factory + accessor overrides for swapping the dialog backend. `src/systems/dialog-session.ts:68`
- `interface NativeDialogRuntime extends DialogRuntime, Emittable<DialogRuntimeEvents>` — Native dialog runtime instance — implements DialogRuntime plus event subscription. `src/systems/dialog.ts:158`
- `interface NativeDialogRuntimeOptions` — Options for createNativeDialogRuntime — the authored graphs plus the read/write side (GameStateAccessor for predicates, GameStateMutator for outcome dispatch). `src/systems/dialog.ts:148`

## Subject Category

addressable subjects with typed multi-field state

- `function createSubjectCategory<S extends FieldSchema>(options: SubjectCategoryOptions<S>): SubjectCategory<S>` — Create a subject category. `src/systems/subject-category.ts:562`
- `interface EnumFieldDef<V extends string = string>` — Single nullable enum value per subject. `src/systems/subject-category.ts:80`
- `interface EnumFieldInstance<V extends string = string> extends Emittable<EnumFieldEvents<V>>` — Live nullable-enum accessor built from an EnumFieldDef. `src/systems/subject-category.ts:167`
- `type FieldDef = ScalarFieldDef | VectorFieldDef | TierFieldDef | FlagFieldDef | EnumFieldDef` — Discriminated field def — every schema field is one of these. `src/systems/subject-category.ts:87`
- `type FieldInstance<F extends FieldDef>` — Mapped type — produces the right accessor per field kind without runtime narrowing. `src/systems/subject-category.ts:178`
- `type FieldSchema = Record<string, FieldDef>` — A schema describes the shared field shape every registered subject carries. `src/systems/subject-category.ts:90`
- `interface FlagFieldDef` — Single persistent boolean per subject. `src/systems/subject-category.ts:70`
- `interface FlagFieldInstance extends Emittable<FlagFieldEvents>` — Live boolean accessor built from a FlagFieldDef. `src/systems/subject-category.ts:154`
- `type PerSubjectOverride<F extends FieldDef>` — Per-subject overrides — only the obviously-per-subject bits (initial values, tier gates). `src/systems/subject-category.ts:197`
- `interface ScalarFieldDef` — Single persistent number per subject. `src/systems/subject-category.ts:41`
- `interface ScalarFieldInstance extends Emittable<ScalarFieldEvents>` — Live scalar accessor built from a ScalarFieldDef. `src/systems/subject-category.ts:99`
- `interface SubjectCategory<S extends FieldSchema> extends ResettableObject` — Container that registers subjects against a shared schema and builds the matching typed instance for each. `src/systems/subject-category.ts:245`
- `interface SubjectCategoryEntry<S extends FieldSchema>` — One entry inside a SubjectCategory — authored def + live instance. `src/systems/subject-category.ts:225`
- `interface SubjectCategoryOptions<S extends FieldSchema>` — Options for createSubjectCategory. `src/systems/subject-category.ts:232`
- `interface SubjectDef<S extends FieldSchema>` — Authoring shape for one subject in a SubjectCategory. `src/systems/subject-category.ts:212`
- `interface SubjectInstance<S extends FieldSchema>` — Live subject — typed field accessors keyed by schema field name. `src/systems/subject-category.ts:219`
- `interface TierFieldDef` — Ordered tier ladder with per-transition advancement gates. `src/systems/subject-category.ts:62`
- `interface TierFieldInstance extends Emittable<TierFieldEvents>` — Live tier-ladder accessor built from a TierFieldDef. `src/systems/subject-category.ts:133`
- `interface VectorFieldDef<Dims extends string = string>` — N persistent numbers per subject, one per named dimension. `src/systems/subject-category.ts:50`
- `interface VectorFieldInstance<Dims extends string = string> extends Emittable<VectorFieldEvents<Dims>>` — Live vector accessor built from a VectorFieldDef. `src/systems/subject-category.ts:114`
