# Composition recipes

Recurring shapes consumers assemble from engine primitives. Each is a worked pattern from the consumer corpus, not an engine symbol — single-consumer hand-rolls; an engine helper would over-fit. When a second consumer reaches for the same wrapper, the pattern graduates via `docs/candidate-primitives.md`.

This is the companion cookbook to [consumer-guide.md](./consumer-guide.md) — a condensed starter-components reference. Read the guide for *how to think* about composing the engine; reach here for the full worked patterns when you're building one. The guide's narrative spine stays a continuous read; these bulkier examples live here so they don't bloat it.

## Action execution: ActionCategory, worker bundle, or Slot

Three engine shapes share the "what's the player doing right now?" surface. The split is queue × per-execution state machine × selection-only.

| Shape | When to reach for |
|---|---|
| `createActionCategory` | Ordered-execution queue with per-execution state machine. Lifecycle (`pending` / `running` / `waiting` / `completed` / `failed`), progress, attempt, error, timing observable per running item; multi-bar progress shapes (mana + ticks + loops). Idle Loops / Cavernous lineage. |
| Worker-bundle recipe | Single-active duration-driven execution from `Sequencer` + `TimedProgress` + a `getTask(id)` lookup. No per-execution state machine; the duration accumulator is the lifecycle. spell-compiler and maldacena shape; recipe below. |
| `createSlot` | Single-active *selection*, not execution. Pick one of N at a time, switch instantly, persisted across saves. No queue, no per-tick progress. progress-knight-ng's `currentJob` / `currentSkill` shape. |

Decision flow:

- No queue, just "what's equipped or active right now"? → `createSlot`.
- Queue, but execution is dispatch + duration accumulator with no per-item state machine? → worker-bundle recipe.
- Queue with lifecycle / progress / error observable per running item? → `createActionCategory`.

For a slot whose selected entry then needs queued execution, compose them: `createSlot` for the selection, `createActionCategory` (or the worker-bundle recipe) reading the slot's current value.

## Indirect-control worker pools

Games where the player posts tasks and a pool of N autonomous workers claims them — Majesty-style bounties, DK-style imps, DF-style job queues. The engine provides the primitives; the coordination — both the per-worker wiring and the pool-shared state — lives consumer-side.

Primitives that compose, per worker:

- `Sequencer` — the schedule
- `TimedProgress` (ephemeral) — the execution accumulator
- `FillStrategy` (e.g. `createRoundRobinStrategy`) closing over a shared `Persistent<TaskId[]>` — the claim
- `sequencer.on('start', ...)` handler that splices the claimed id from the shared ref — grab-on-claim

The per-worker bundle is a plain object the consumer assembles — addressable identity (`id`), the two underlying primitives (`sequencer`, `tracker`), plus the `currentTaskId` / `currentTask` computeds and a `dispose` that tears down the tracker. This is the actual shape consumers use today:

```ts
function buildWorker(id: string, sequencer: Sequencer<unknown>, tracker: TimedProgress) {
  const currentTaskId = computed(() => sequencer.currentItem?.id);
  const currentTask = computed(() => {
    const taskId = currentTaskId.value;
    return taskId !== undefined ? getTask(taskId) : undefined;
  });
  return {
    id, sequencer, tracker, currentTaskId, currentTask,
    dispose() { tracker.dispose(); },
  };
}
```

Shared across the pool:

- The `Persistent<TaskId[]>` ref itself
- A `getTask(id)` lookup over the union of task defs all workers might execute
- Consumer-owned policy: post-bounty, recall, wake-idle orchestration, pin-to-role strategy swaps

Single-worker case: same shape with one instance (`id: 'player'`). spell-compiler and maldacena both follow this pattern in their action/spell-execution modules.

Why no engine helper: the claim axis varies widely across games — round-robin, distance, skill-filter, priority-tier, class-lockout — and recall/cancel semantics vary just as widely. The primitives above are the stable subset; a `createSharedTaskPool` that tried to subsume claim + recall + wake-idle would over-fit to one game's design. Per-worker, the bundle is thin enough (two computeds + one-line dispose) that inlining beats shipping an identity wrapper as a primitive — the structural decision case (defender towers, OL-1021) showed that worker-shaped wiring fights spatial games' cooldown-per-tick model and has to be bypassed wholesale anyway.

## Pre-completion gating in ActionCategory

ActionCategory's `complete` event is a post-event observer — by the time it fires, the item is already terminal. Consumers that need to gate completion (budget caps, mana / effort ceilings, mid-execution termination conditions) do it inside the `tick` closure, before declaring complete:

```ts
mapAction: (def) => ({
  tick: ({ entry, dt, category }) => {
    category.tickItemProgress(def.id, dt);

    // Pre-completion gate: check budget caps before declaring complete
    if (shouldTerminate(entry, def)) {
      category.setItemState(def.id, 'completed');
      category.sequencer.complete();
      return;
    }

    if ((category.currentItem!.progress as number) >= def.duration) {
      category.sequencer.complete();
    }
  },
}),
```

For chain-with-terminate semantics (idle-loops-ng's omsi-loops lineage runs an array of pre-completion hooks — `maxMana`, `maxEffort`, then content-specific overrides), wrap the body in an iterable:

```ts
type PreCompletionHook<E, D> = (entry: E, def: D) => 'terminate' | 'continue';
const preCompletionHooks: PreCompletionHook<Entry, Def>[] = [];

mapAction: (def) => ({
  tick: ({ entry, dt, category }) => {
    category.tickItemProgress(def.id, dt);

    for (const hook of preCompletionHooks) {
      if (hook(entry, def) === 'terminate') {
        category.setItemState(def.id, 'completed');
        category.sequencer.complete();
        return;
      }
    }

    if ((category.currentItem!.progress as number) >= def.duration) {
      category.sequencer.complete();
    }
  },
}),
```

This is a recipe, not engine API. The chain shape is currently single-lineage (omsi-loops). When a non-omsi consumer surfaces the same chain independently, that's the N=2 signal to graduate it onto ActionCategory — drop a breadcrumb in `docs/candidate-primitives.md`.

## Persona-roster composition

Composition recipe for games with opponent AI, automated playtest bots, or content-agent populations that need behavioral variety. The engine provides the selection and dispatch primitives; the personality definitions stay consumer-side until a second independent consumer pressure-tests the shape.

The load-bearing observation from the field (80% corpus prevalence across RTS, strategy, RPG, and idle genres): the unit the field ships is a **roster of N differentiated agents**, not a single bot. Sub-shapes — difficulty tiers, parameterized personalities, mode rosters, exploitability profiles — are all instances of the same pattern: a keyed vector of personality params consumed by one decision architecture.

**Engine substrate.** `SequencerItem<M>` carries persona identity in `id` and the param bundle in `meta<M>`. The sequencer-strategies module (`src/core/sequencer-strategies.ts`) provides selection policies:

- `createRoundRobinStrategy` — cycle across runs with a persistent rotation index
- `createPriorityStrategy` — tier-ordered preference (monotonic difficulty)
- `createConditionalStrategy` — opponent-conditioned selection (reacts to measured player behavior)
- `createCompositeStrategy` — emergency-fallback chain across strategies

Active-personality persistence (boundary-deferred-apply) is standard reactive composition: a `persistent<PersonalityId>` ref read by the decision function, written at the boundary (game start, mode shift).

```ts
// N personalities as typed param bundles
const personalities: SequencerItem<PersonaParams>[] = [
  { id: 'aggressive', meta: { aggression: 0.9, patience: 0.2 } },
  { id: 'defensive',  meta: { aggression: 0.3, patience: 0.8 } },
  { id: 'adaptive',   meta: { aggression: 0.6, patience: 0.5 } },
];

// Random rotation across runs — index persists across save/load
sequencer.fillStrategy = createRoundRobinStrategy('persona', () => personalities);

// Or opponent-conditioned selection: read measured player aggression
sequencer.fillStrategy = createConditionalStrategy(() => [
  { condition: () => opponentAggression.value.gt(0.7), item: personalities[1] },
  { condition: () => true,                             item: personalities[0] },
]);
```

**Difficulty-tier discipline.** When sub-shapes encode difficulty (beginner/normal/hard), enforce a monotonic-difficulty constraint in the param bundle: each param that the player perceives as "harder" should be strictly ordered across tiers. Mixing monotonically-increasing and monotonically-decreasing params produces a roster where no tier is cleanly "harder" — exploitability profiles work differently (encode known weaknesses explicitly, not via difficulty ordering).

**Harness integration.** The `src/harness/` picker/runner/sweep substrate already covers persona-population sweeps: `runMatrix` over a personality param axis, or `createPickerSnapshot` to enumerate what the sequencer has loaded. Procedural personas (objective variation in search-based agents) live here — vary the objective the search optimizes rather than the policy params; see `open-loop-research/practical/composition-cookbook/procedural-personas.md`.

Why no engine helper today: the selection-policy axis (round-robin vs. priority vs. conditional vs. composite) and the param-bundle shape vary widely across game types. The primitives above are the stable substrate. The OL-714 cautionary case (`4e5fc39`, rolled back `c96ec42`) established that a `createPersonalityRoster` wrapper would over-name a composition that already reads naturally without it. First consumer hand-roll is the signal to revisit (see breadcrumb in `docs/candidate-primitives.md`). Research: `open-loop-research/practical/composition-cookbook/parameterized-personality.md`.

## Priority-weighted fill across multiple content categories

Composition recipe for action-queue automation that needs to interleave entries from multiple content-type categories (gathering, crafting, research, …) under one priority order. Built on `createPriorityStrategy` plus a per-content-type `passBonus` map that breaks ties between equal-priority entries from different categories.

The convergent shape across consumers (incloneution `src/modules/automation.ts`, maldacena `src/modules/action-fill.ts`):

- Each content-type entry carries a player-set `automationPriority` and a static category-level `passBonus`.
- Score is `priority * 10 + passBonus[contentType]` — the multiplier preserves player priority dominance while the pass-bonus map deterministically orders cross-category ties.
- A single fill strategy walks every relevant `category.getAll()`, filters by unlock + visibility, builds a candidate list, sorts descending by score, and returns the first item whose task's `canRun()` returns `'now'`.

```ts
import { computed } from 'vue';
import type { FillStrategy, SequencerItem } from '@open-loop/engine';

const PASS_BONUS = {
  gathering: 5,
  research:  4,
  crafting:  3,
  // ...
} as const;

const candidates = computed(() => {
  const out: { item: SequencerItem<ActionMeta>; score: number }[] = [];

  for (const entry of gatheringCategory.getAll()) {
    if (!entry.state.isAutomationUnlocked.value) continue;
    const priority = entry.state.automationPriority.value;
    if (priority === AutomationPriority.Disabled) continue;
    out.push({
      item: actions.buildItem('gathering', entry.def.id),
      score: priority * 10 + PASS_BONUS.gathering,
    });
  }
  // ...repeat per content-type category

  return out.sort((a, b) => b.score - a.score);
});

const strategy: FillStrategy<ActionMeta> = {
  next() {
    for (const { item } of candidates.value) {
      const task = actions.getTask(item.id);
      if (task?.canRun?.() === 'now') return item;
    }
    return null;
  },
};
```

The shape is convergent today but the pass-bonus map is the consumer-side knob: bonuses encode "when priorities tie, gathering wins over crafting" and are tuned per game. No engine helper because the category list and pass-bonus axis vary per consumer — engine `createPriorityStrategy` covers the single-category case; this recipe is the multi-category extension. If a third consumer hand-rolls the same shape with the same pass-bonus map shape, drop a candidate entry.

## Character interaction surface

Composition recipe for games with named characters that the player returns to — companions, mentors, merchants, faction contacts. The engine provides a dialog runtime and a relationship-state category; both are Tier-4 surfaces (specialized in incremental, near-default in narrative-adjacent codebases). Pattern definitions live in `open-loop-research/patterns/tier-4-specialized/character-interaction-systems.md` and `open-loop-research/patterns/tier-4-specialized/relationship-systems.md`.

### Dialog: contract first, runtime second

Dialog content is a graph of nodes with text, gates, choices, and outcomes. The engine ships:

- An authored data shape (`DialogGraph` — `DialogNode[]` with an `entry` pointer) — declarative, serializable, no closures.
- An adapter contract (`DialogRuntime`) — anything that can drive a conversation: `start` / `present` / `choose` / `finish` plus `exportState` / `importState`.
- A native runtime implementation (`createNativeDialogRuntime`) that walks `DialogGraph` nodes, evaluates `Gate` predicates on choices/nodes through the ambient Gate runtime, dispatches `IEffect` outcomes, and maintains visit counts.
- A registration surface (`createDialogCategory`, `createDialogSession`) that wraps the runtime in a persistent envelope and emits `presented` / `chosen` / `finished` events.

The contract is the boundary. External adapters — Ink (Inkle), Yarn Spinner, Ren'Py, Dialogic — implement `DialogRuntime` against their own content shape and runtime. They live as separate consumer packages (e.g. a hypothetical `open-loop-ink-adapter`); the engine never depends on any specific framework. To swap an adapter into a session, pass it through `createDialogSession`'s `runtimeFactory` option:

```ts
const session = createDialogSession({
  id: 'main',
  graphs: dialogCat.getAll().flatMap((e) => e.graphs),
  runtimeFactory: (graphs, accessor, mutator) => createInkAdapter(inkJson, accessor, mutator),
});
```

Native runtime is the default — pick it for content authored as `DialogGraph` data. Reach for an external adapter when the authoring team already knows Ink/Yarn or when the dialog volume justifies a dedicated authoring tool. Both flow through the same `DialogSession` surface; UI and save format don't care which is wired underneath.

### Subjects: addressable named entities with typed multi-field state

`createSubjectCategory` registers subjects (NPCs, factions, regions, single entities) against a shared field schema. Each schema field picks one of five kinds via its `kind` discriminator: `scalar` (single value per subject, optional `derive` projection), `vector` (N independent dims, CDDA-style opinion), `tier` (ordered tier ladder with per-transition `Gate` gates, Daggerfall-style rank), `flag` (single persistent boolean per subject, Exult-style named event), `enum` (single nullable enum value per subject — commitment locks, path selection). The category is the only public entry point; per-kind field-builders are private. Reach a subject through `cat.get('subject-id')`; the typed `subject.fields.<name>` accessor narrows to the right per-kind shape at the callsite from schema inference — no runtime narrowing helpers.

Per-subject overrides cover only the obviously-per-subject bits (initial values, tier gates). Structural shape (tiers list, vector dimensions, scalar min/max) stays schema-frozen so save round-trip is stable across subjects. Two complementary shapes:

```ts
// Many subjects, one field per subject — molcremental-style per-NPC trust ladder
const npcs = createSubjectCategory({
  id: 'npc-trust',
  fields: { trust: { kind: 'tier', tiers: ['stranger', 'friend', 'confidant'] } },
});
npcs.register({
  id: 'mentor-rask',
  fields: { trust: { gates: protocolStepGates(npc) } },
});
npcs.get('mentor-rask')!.fields.trust.tryAdvance();

// One subject, many fields — maldacena-style single Entity with mixed state
const entity = createSubjectCategory({
  id: 'entity',
  fields: {
    trust:        { kind: 'scalar', min: 0, max: 100 },
    pathTendency: { kind: 'vector', dimensions: ['scientific', 'cooperative'] },
    discovered:   { kind: 'flag' },
    pathLocked:   { kind: 'enum', values: ['scientific', 'cooperative'] },
  },
});
entity.register({ id: 'the-entity' });
entity.get('the-entity')!.fields.trust.add(0.05);
```

Cross-cutting concerns the field kinds don't carry — time decay, propagation (faction-tree / attitude matrix / chemical-reaction), perma+temp layered store — aren't schema features. Compose them at the consumer: a tick handler that calls `field.add(-rate * dt)` for decay, two scalar fields plus a derived projection for perma+temp layering, a separate broadcast helper for propagation. The substrate stays shape-fixed; the axes earn standalone primitives when consumer demand surfaces.

### When dialog and subjects connect

Both surfaces share the engine's predicate / effect machinery. A dialog node gates on subject state through the typed `StateGate` path: `{ kind: 'state', key: 'subject.npc-trust.mentor-rask.trust', operator: 'gte', value: 2 }` — the path is `{categoryId}.{subjectId}.{fieldName}` for scalar/tier/flag/enum fields, with an extra `.{dim}` segment for vector dimensions. A choice writes back through `E.state('subject.npc-trust.mentor-rask.trust', 3)` — the predicate side is Gate (typed AST); the effect side is the `E` builder (consumer-facing). Reserved path conventions are documented in `src/primitives/types.ts`.

Bespoke subject-aware atoms (a `SubjectGate` kind / `E.subject`) are intentionally **not** in the builder yet — single-game prevalence (CDDA's `n_npc_trust()` math-DSL is the sole canonical example) doesn't justify the API growth. The state-path encoding is the path until a second consumer needs the ergonomics.
