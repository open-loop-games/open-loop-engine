# Narrative

Character-interaction systems: Dialog (authored dialog graphs, a native adapter, a swappable adapter contract) and Subject (named subjects with typed multi-field state). Specialized in incremental games, near-default in narrative-adjacent ones.

## Canonical entrypoints

- `createDialogCategory` — batch-register authored dialog graphs.
- `createDialogSession` — the saved envelope over one dialog adapter, which a UI drives.
- `createNativeDialogAdapter` / `DialogAdapter` — the default adapter, and the adapter contract for external dialog tools.
- `createSubjectCategory` — addressable subjects (NPCs, factions, regions, single named things) with typed multi-field state (scalar / vector / ladder / flag / enum).

## Dialog

authored dialog graphs and the native dialog adapter that walks them. The adapter combines engine primitives (Gates, effects, events) into a conversation driver whose state serializes

- `function createDialogCategory<Def extends { id: string; }>(options: DialogCategoryOptions<Def>): DialogCategory<Def>` — Create a dialog category — batch-registered NPC / scene dialog content with a content registry and per-def DialogGraph production. `src/systems/dialog-category.ts:89`
- `function createDialogSession(options: DialogSessionOptions): DialogSession` — Create a dialog session — the envelope that drives a UI through a DialogGraph. `src/systems/dialog-session.ts:166`
- `function createNativeDialogAdapter(options: NativeDialogAdapterOptions): NativeDialogAdapter` — Create a native dialog adapter over the supplied graphs, accessor and mutator. `src/systems/dialog.ts:227`
- `interface DialogAdapter` — Adapter contract: anything that can drive a dialog conversation against game state. `src/systems/dialog.ts:126`
- `interface DialogAdapterEvents` — Lifecycle events emitted by a NativeDialogAdapter instance. `src/systems/dialog.ts:162`
- `type DialogAdapterFactory = (graphs: DialogGraph[], accessor: GameStateAccessor, mutator: GameStateMutator) => DialogAdapter` — Factory signature for alternative DialogAdapter implementations (Ink, Yarn, etc.). `src/systems/dialog-session.ts:68`
- `interface DialogCategory<Def extends { id: string; }> extends ResettableObject` — A dialog category — batch-registered NPC/scene dialog content. `src/systems/dialog-category.ts:43`
- `interface DialogCategoryEntry<Def extends { id: string; }>` — A category entry: the def and its dialog graphs (no def state). `src/systems/dialog-category.ts:37`
- `interface DialogCategoryOptions<Def extends { id: string; }>` `src/systems/dialog-category.ts:25`
- `interface DialogChoice` — A single response option attached to a DialogNode. `src/systems/dialog.ts:61`
- `interface DialogGraph` — A complete authored conversation: nodes plus an entry pointer. `src/systems/dialog.ts:76`
- `interface DialogNode` — One line or branch in a dialog graph. `src/systems/dialog.ts:30`
- `interface DialogPresentation` — Snapshot of a presented line — what the UI binds to. `src/systems/dialog.ts:85`
- `interface DialogSession extends Emittable<DialogSessionEvents>` — A dialog session — the public surface for driving conversations from a UI / module. `src/systems/dialog-session.ts:101`
- `interface DialogSessionEvents` — Lifecycle events emitted by a DialogSession. `src/systems/dialog-session.ts:49`
- `interface DialogSessionOptions` — Options for createDialogSession — the persistent context id, the authored graphs, and an optional adapter factory and accessor for another dialog backend. `src/systems/dialog-session.ts:79`
- `interface NativeDialogAdapter extends DialogAdapter, Emittable<DialogAdapterEvents>` — Native dialog adapter instance — implements DialogAdapter plus event subscription. `src/systems/dialog.ts:194`
- `interface NativeDialogAdapterOptions` — Options for createNativeDialogAdapter — the authored graphs plus the read/write side (GameStateAccessor for predicates, GameStateMutator for outcome effects). `src/systems/dialog.ts:180`
- `interface SerializedDialogAdapter` — The adapter's serialized form: the fields every DialogAdapter writes on `serialize()`. `src/systems/dialog.ts:108`

## Subject Category

addressable subjects with typed multi-field state

- `function createSubjectCategory<S extends FieldSchema>(options: SubjectCategoryOptions<S>): SubjectCategory<S>` — Create a subject category. `src/systems/subject-category.ts:643`
- `interface EnumFieldDef<V extends string = string>` — Single nullable enum value per subject. `src/systems/subject-category.ts:91`
- `interface EnumFieldInstance<V extends string = string> extends Emittable<EnumFieldEvents<V>>` — Live nullable-enum field built from an EnumFieldDef. `src/systems/subject-category.ts:189`
- `type FieldDef = ScalarFieldDef | VectorFieldDef | LadderFieldDef | FlagFieldDef | EnumFieldDef` — Discriminated field def — every schema field is one of these. `src/systems/subject-category.ts:98`
- `type FieldInstance<F extends FieldDef>` — Conditional type — the right field instance per field kind, with no narrowing at run time. `src/systems/subject-category.ts:200`
- `type FieldSchema = Record<string, FieldDef>` — A schema describes the shared field shape every registered subject has. `src/systems/subject-category.ts:106`
- `interface FlagFieldDef` — Single persistent boolean per subject. `src/systems/subject-category.ts:81`
- `interface FlagFieldInstance extends Emittable<FlagFieldEvents>` — Live flag field built from a FlagFieldDef. `src/systems/subject-category.ts:176`
- `interface LadderFieldDef` — Ordered ladder with a predicate per step between rungs. `src/systems/subject-category.ts:73`
- `interface LadderFieldInstance extends Emittable<LadderFieldEvents>` — Live ladder field built from a LadderFieldDef. `src/systems/subject-category.ts:150`
- `type PerSubjectOverride<F extends FieldDef>` — Per-subject overrides — only the obviously-per-subject bits (initial values, a ladder's `advanceWhen`). `src/systems/subject-category.ts:219`
- `interface ScalarFieldDef` — Single persistent number per subject. `src/systems/subject-category.ts:52`
- `interface ScalarFieldInstance extends Emittable<ScalarFieldEvents>` — Live scalar field built from a ScalarFieldDef. `src/systems/subject-category.ts:115`
- `interface SubjectCategory<S extends FieldSchema> extends ResettableObject` — Container that registers subjects against a shared schema and builds the matching typed instance for each. `src/systems/subject-category.ts:274`
- `interface SubjectCategoryEntry<S extends FieldSchema>` — One category entry of a SubjectCategory — authored def, live instance and signals. `src/systems/subject-category.ts:247`
- `interface SubjectCategoryOptions<S extends FieldSchema>` `src/systems/subject-category.ts:254`
- `interface SubjectDef<S extends FieldSchema>` — Authoring shape for one subject in a SubjectCategory. `src/systems/subject-category.ts:234`
- `interface SubjectInstance<S extends FieldSchema>` — Live subject — typed fields keyed by schema field name. `src/systems/subject-category.ts:241`
- `interface VectorFieldDef<Dims extends string = string>` — N persistent numbers per subject, one per named dimension. `src/systems/subject-category.ts:61`
- `interface VectorFieldInstance<Dims extends string = string> extends Emittable<VectorFieldEvents<Dims>>` — Live vector field built from a VectorFieldDef. `src/systems/subject-category.ts:130`
