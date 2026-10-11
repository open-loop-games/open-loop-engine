# Composition recipes

Recurring shapes that consumers assemble from engine primitives. Each is a worked pattern from the consumer corpus, not an engine symbol. Each is a hand-roll in one consumer, where an engine helper would over-fit. A second consumer that independently writes the same wrapper is the signal to move it out of this file.

This is the companion cookbook to [consumer-guide.md](./consumer-guide.md). Read the guide for *how to think* about composing the engine. Read this file for the full worked pattern when you build one. These bulky examples are here so that the guide stays a continuous read.

## Action execution: ActionCategory, worker bundle, or Loadout

Three engine shapes answer "what is the player doing right now?". They differ on three axes: a queue, a per-execution state machine, and selection only.

| Shape | When to choose it |
|---|---|
| `createActionCategory` | Ordered-execution queue with a per-execution state machine. Lifecycle (`pending` / `running` / `waiting` / `completed` / `failed`), progress, `attempt`, error and timing are observable per running item; one item can track several progress bars (mana, ticks, runs). A list-mode game restarts a run with `replay()`. `sequencer.resetCursor()` moves only the cursor and leaves each item's progress from the last run. |
| Worker-bundle recipe | Single-active, duration-driven execution from `Sequencer` + `TimedProgress` + a `getTask(id)` lookup. No per-execution state machine; the duration accumulator is the lifecycle. Recipe below. |
| `createLoadout` | Single-active *selection*, not execution. Pick one of N at a time and switch instantly; the selection is saved. No queue, no per-tick progress. The shape of a current job or current skill. |

Decision flow:

- No queue, only "what is equipped or active right now"? → `createLoadout`.
- A queue, but execution is a start plus a duration accumulator, with no per-item state machine? → worker-bundle recipe.
- A queue with lifecycle, progress and error observable per running item? → `createActionCategory`.

When a loadout's selected item then needs queued execution, compose the two. `createLoadout` holds the selection. `createActionCategory`, or the worker-bundle recipe, reads the loadout's current value.

## Indirect-control worker pools

Games where the player posts tasks and a pool of N autonomous workers claims them: bounties, minion task lists, colony job queues. The engine provides the primitives. The coordination is consumer-side: both the per-worker wiring and the state the pool shares.

Primitives that compose, per worker:

- `Sequencer` — the schedule
- `TimedProgress` (ephemeral) — the execution accumulator
- `FillStrategy` (e.g. `createRoundRobinStrategy`) that closes over a shared `Persistent<TaskId[]>` — the claim
- a `sequencer.on('started', ...)` handler that removes the claimed id from the shared ref — a claim takes the task

The per-worker bundle is a plain object the consumer assembles. It holds an addressable `id` and the two primitives, `sequencer` and `tracker`. It adds the `currentTaskId` / `currentTask` computeds, and a `dispose` that disposes the tracker. This is the shape consumers use:

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
- A `getTask(id)` lookup over the union of task defs that any worker might execute
- Consumer-owned policy: post a bounty, recall, wake idle workers, swap the fill strategy to pin a worker to a role

Single-worker case: the same shape with one worker (`id: 'player'`).

Why no engine helper: the claim axis varies widely across games. Round-robin, distance, skill filter, priority rank and class lockout all occur. Recall and cancel semantics vary as widely. The primitives above are the stable subset. A `createSharedTaskPool` that tried to cover claim, recall and wake-idle would over-fit to one game's design. Per worker, the bundle is thin: two computeds and a one-line dispose. So inlining it costs less than an identity wrapper shipped as a primitive. Worker-shaped wiring does not fit a game whose placed units act on a per-tick cooldown. Such a game bypasses it entirely.

## Pre-completion checks in ActionCategory

ActionCategory's `completed` event is an observer after the fact. When it fires, the item has already completed, and it fires once per execution. A consumer that must end an execution on a check does so inside the `tick` closure, before it calls `sequencer.complete()`. Typical checks are a budget limit, a mana or effort maximum, and a mid-execution end condition:

```ts
mapAction: (def) => ({
  tick: ({ entry, dt, category }) => {
    category.tickItemProgress(def.id, dt);

    // Pre-completion check: end early when a budget limit or a maximum is reached
    if (shouldTerminate(entry, def)) {
      category.sequencer.complete();
      return;
    }

    if ((category.currentItem!.progress as number) >= def.duration) {
      category.sequencer.complete();
    }
  },
  signals: { /* … */ },
}),
```

When any of several pre-completion checks can end the execution (`maxMana`, `maxEffort`, content-specific checks), loop over them:

```ts
type PreCompletionCheck<E, D> = (entry: E, def: D) => 'terminate' | 'continue';
const preCompletionChecks: PreCompletionCheck<Entry, Def>[] = [];

mapAction: (def) => ({
  tick: ({ entry, dt, category }) => {
    category.tickItemProgress(def.id, dt);

    for (const check of preCompletionChecks) {
      if (check(entry, def) === 'terminate') {
        category.sequencer.complete();
        return;
      }
    }

    if ((category.currentItem!.progress as number) >= def.duration) {
      category.sequencer.complete();
    }
  },
  signals: { /* … */ },
}),
```

This is a recipe, not engine API. The list shape comes from one lineage of consumers. A second, independent consumer that writes the same list is the signal to move it onto ActionCategory.

## Persona-roster composition

A composition recipe for games that need behavioral variety: AI opponents, automated players for playtests, or populations of simulated actors. The engine provides the selection primitives and the sequencer that starts the chosen item. The persona parameters stay consumer-side until a second independent consumer tests the shape.

A common observation across many kinds of game: games ship a **roster of N differentiated personas**, not a single automated player. The sub-shapes are all one pattern: difficulty settings, parameterized personas, mode rosters, and personas that encode known weaknesses. Each is a keyed vector of persona parameters that one decision procedure reads.

**Engine substrate.** `SequencerItem<M>` holds the persona's identity in `id` and its parameter bundle in `metadata: M`. The file `src/core/sequencer-strategies.ts` provides the fill strategies:

- `createRoundRobinStrategy` — rotate across runs with a saved rotation index
- `createPriorityStrategy` — priority-ordered preference (monotonic difficulty)
- `createConditionalStrategy` — selection that reacts to measured player behavior
- `createCompositeStrategy` — a fallback list across strategies

Saving the current persona is ordinary reactive composition. The decision function reads a `persistent<PersonaId>` ref. The game writes that ref only at a boundary, such as game start or a mode change.

```ts
// N personas as typed parameter bundles
const personas: SequencerItem<PersonaParams>[] = [
  { id: 'aggressive', metadata: { aggression: 0.9, patience: 0.2 } },
  { id: 'defensive',  metadata: { aggression: 0.3, patience: 0.8 } },
  { id: 'adaptive',   metadata: { aggression: 0.6, patience: 0.5 } },
];

// Round-robin rotation across runs — the index is saved
sequencer.fillStrategy = createRoundRobinStrategy('persona', () => personas);

// Or selection that reacts to the player: read measured player aggression
sequencer.fillStrategy = createConditionalStrategy(() => [
  { condition: () => opponentAggression.value.gt(0.7), item: personas[1] },
  { condition: () => true,                             item: personas[0] },
]);
```

**Difficulty ordering.** When sub-shapes encode difficulty (beginner, normal, hard), keep difficulty monotonic in the parameter bundle. Order each parameter the player perceives as "harder" strictly across the difficulty settings. A roster that mixes increasing and decreasing parameters has no setting that is cleanly "harder". Personas that encode known weaknesses work differently: encode the weakness explicitly, not through difficulty ordering.

**Balance harness integration.** The balance harness's picker, runner and sweep tools already cover persona sweeps. Use `runMatrix` with a sweep axis over persona parameters. Or use `createPickerSnapshot` to enumerate the perturbable addresses a persona sweep can vary: lowered grants, chain modifiers and tunables. Procedural personas belong on this side too. They vary the objective that a search-based automated player optimizes, not the policy parameters.

Why no engine helper: the fill-strategy axis (round-robin, priority, conditional, composite) and the parameter-bundle shape vary widely across game types. The primitives above are the stable substrate. A `createPersonalityRoster` wrapper would only name a composition that is already clear without it. The first consumer hand-roll is the signal to revisit this.

## Priority-weighted fill across multiple content categories

A composition recipe for action-queue automation that interleaves entries from several content-type categories (gathering, crafting, research, …) under one priority order. It extends `createPriorityStrategy` to several categories. A per-content-type `passBonus` map breaks ties between equal-priority entries from different categories.

The shape consumers converge on:

- Each content-type entry has a player-set `automationPriority`, and its category has a static `passBonus`.
- The score is `priority * 10 + passBonus[contentType]`. The multiplier keeps player priority dominant, and the pass-bonus map orders cross-category ties deterministically.
- One fill strategy walks every relevant `category.getAll()`. It skips entries whose automation is not unlocked or whose priority is `Disabled`. It sorts the remaining candidates by score, highest first. It returns the first item whose task's `canStart()` returns `'now'`.

```ts
import { computed, type FillStrategy, type SequencerItem } from '@open-loop/engine';

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
      if (task?.canStart?.() === 'now') return item;
    }
    return null;
  },
};
```

The pass-bonus map is the consumer-side balance constant. Its values encode "when priorities tie, gathering wins over crafting", and each game tunes them. There is no engine helper, because the category list and the pass-bonus axis vary per consumer. The engine's `createPriorityStrategy` covers the single-category case; this recipe is the multi-category extension. A third consumer that hand-rolls the same shape is the signal to consider an engine helper. Its pass-bonus map must have the same shape, not the same values.

## Character interaction surface

A composition recipe for games with named characters that the player returns to: companions, mentors, merchants, faction contacts. The engine provides a dialog adapter and a subject category.

### Dialog: contract first, adapter second

Dialog content is a graph of nodes with text, Gates, choices and outcomes. The engine ships:

- An authored data shape (`DialogGraph`: `DialogNode[]` with an `entry` pointer). It is declarative and serializable, with no closures.
- An adapter contract (`DialogAdapter`): anything that can drive a conversation, through `start` / `present` / `choose` / `finish` plus `serialize` / `restore`.
- A native adapter (`createNativeDialogAdapter`). It walks `DialogGraph` nodes, and evaluates the `Gate`s on choices and nodes through the ambient Gate services. It applies `IEffect` outcomes and keeps visit counts.
- A category (`createDialogCategory`) that registers dialog graphs from defs.
- A dialog session (`createDialogSession`) that wraps the adapter in a saved envelope and emits `presented` / `chosen` / `finished` events.

The contract is the boundary. External adapters (Ink, Yarn Spinner, Ren'Py, Dialogic) implement `DialogAdapter` against their own content shape and runtime. Each is a separate consumer package, such as a hypothetical `open-loop-ink-adapter`. The engine never depends on a specific framework. To swap an adapter into a dialog session, pass it through the `adapterFactory` option of `createDialogSession`:

```ts
const session = createDialogSession({
  id: 'main',
  graphs: dialogCat.getAll().flatMap((e) => e.graphs),
  adapterFactory: (graphs, accessor, mutator) => createInkAdapter(inkJson, accessor, mutator),
});
```

Graph ids must be unique across every category flattened into one dialog session. Node ids must be unique within a graph. The native adapter throws at construction on a repeat. The native adapter is the default: choose it for content authored as `DialogGraph` data. Choose an external adapter when the authoring team already knows Ink or Yarn. A large dialog volume can also justify a dedicated authoring tool. Both use the same `DialogSession` API surface, so the UI and the save format do not depend on the adapter.

### Subjects: addressable named things with typed multi-field state

`createSubjectCategory` registers subjects (NPCs, factions, regions, single named things) against a shared field schema. Each schema field has one of five kinds, set by its `kind` field:

- `scalar` — one number per subject, with an optional `derive` projection
- `vector` — N independent dimensions, such as an opinion vector
- `ladder` — ordered `rungs`, with an `advanceWhen` predicate for each step up, such as a rank
- `flag` — one saved boolean per subject, such as a named event
- `enum` — one nullable enum value per subject: commitment locks, path selection

The category is the only public factory; the per-kind field builders are private. Reach a subject through `cat.get('subject-id')`. The typed `subject.fields.<name>` property narrows to the right per-kind shape at the callsite, from schema inference. No runtime narrowing helper is needed.

Per-subject overrides cover only the parts that are clearly per subject: initial values and the ladder's `advanceWhen` predicates. The structural shape stays fixed in the schema: the rung list, the vector dimensions, scalar min and max. So a save round-trip is stable across subjects. Two complementary shapes:

```ts
// Many subjects, one field per subject — a per-NPC trust ladder
const npcs = createSubjectCategory({
  id: 'npc-trust',
  fields: { trust: { kind: 'ladder', rungs: ['stranger', 'friend', 'confidant'] } },
});
npcs.register({
  id: 'mentor-rask',
  fields: { trust: { advanceWhen: protocolStepGates(npc) } },
});
npcs.get('mentor-rask')!.fields.trust.tryAdvance();

// One subject, many fields of mixed kinds
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

Cross-cutting concerns are not schema features. Compose them in the consumer:

- time decay: a tick handler that calls `field.add(-rate * dt)`;
- a layered store with a lasting and a temporary part: two scalar fields plus a derived projection;
- propagation (faction tree, attitude matrix, chemical reaction): a separate broadcast helper.

The schema's shape stays fixed. An axis qualifies for its own primitive when real consumer demand appears.

### When dialog and subjects connect

Dialog and subjects share the engine's predicate and effect machinery, through state paths that **your accessor implements**. The engine resolves no subject path. A `state` Gate passes its `path` to your `GameStateAccessor.getStateAt`. `E.state` passes its path to your mutator's `setStateAt`. Pick a convention and map it onto the category. `{categoryId}.{subjectId}.{fieldName}` works well, plus `.{dim}` for a vector dimension:

```ts
getStateAt: (path) => {
  const [cat, subjectId] = path.split('.');
  if (cat === 'npc-trust') return npcs.get(subjectId)?.fields.trust.getIndex();
  // ...other roots
},
setStateAt: (path, value) => {
  const [cat, subjectId] = path.split('.');
  if (cat === 'npc-trust') npcs.get(subjectId)?.fields.trust.setIndex(value as number);
},
```

A dialog choice then has the Gate `{ kind: 'state', path: 'npc-trust.mentor-rask.trust', operator: 'gte', value: 2 }`. It writes back with `E.state('npc-trust.mentor-rask.trust', 3)`. A path your accessor does not handle reads `undefined`, so the Gate does not hold and no error is raised. Cover every root you author.

Subject-aware atoms (a `SubjectGate` kind, `E.subject`) are deliberately **not** in the builder. One game alone uses this shape, which does not justify the API growth. The state-path encoding is the way until a second consumer needs the ergonomics.

## Spatial grids: board state, placement, and adjacency

`createSpatialGrid` (see `api/spatial.md` for every method) is a bounded 2D grid of typed cells. The central idea for a game built on it: **the grid is a derived index over the authoritative entity state, not the state itself.** Occupancy is rebuilt from your entity list, such as a roster or a `persistent<Instance[]>`. So a save serializes the entities, not the board. A board-size change rebuilds the grid and places the entities again.

### Owning the grid

A cell holds whatever per-cell metadata you need. The value is a plain object: mutate it by reference, or replace it through `set()`, which emits `cellChanged`. Provide the grid, or a thin API over it, under an `InjectionKey`. Other modules then reach it without importing the module.

```ts
interface Cell { type: 'open' | 'blocked'; occupantId: string | null }

const grid = createSpatialGrid<Cell>({
  width, height,
  initializer: () => ({ type: 'open', occupantId: null }),
  // neighborhood: DIAGONAL_OFFSETS,  // or HEX_AXIAL_OFFSETS, or your own offsets;
});                                  // sets the grid's adjacency for every traversal method

grid.at(x, y);                 // throws OOB; tryAt() returns undefined instead
grid.set(x, y, { ...grid.at(x, y), occupantId: id });  // emits cellChanged
grid.inBounds(x, y);
grid.neighbors(x, y);          // the grid's own adjacency (4-connected by default)
grid.neighbors(x, y, DIAGONAL_OFFSETS);  // ad-hoc, this call only · inRange(x,y,r) Chebyshev
grid.bfs({ x, y }, (cell) => cell.type !== 'blocked');   // PassabilityFn → parent-link map
```

The `passable` / `explored` / `visible` bitmaps and their `*Count` properties are for FOV and terrain. The commit of `beginFovUpdate()` writes `visible` and `explored`, and keeps the counts current. You write `passable` by hand: board generation, a door opening, a wall going up. After each batch of hand writes, call `grid.markMaskChanged('passable')`. It derives the counts again and emits `maskChanged` for the renderer. Without it, the counts go wrong and nothing repaints. `restore()` derives everything again, and emits `gridChanged` plus one `maskChanged` per bitmap.

### Placement and occupancy (placed and removed in play)

Entities the player places and removes during play (towers, seated pieces) are the case the modifier-chain model does *not* fit. A chain created per entity registers itself in the `ChainRegistry`, which has **no unregister path**. Sell the entity, and its chain leaks. So do not model per-entity stats as per-entity chains. The shape games ship is a plain instance list plus a per-tick handler:

```ts
const placed = persistent<Instance[]>([], { id: 'placed' });

function place(defId: string, x: number, y: number): boolean {
  const cell = grid.at(x, y);
  if (cell.type !== 'open' || cell.occupantId != null) return false;
  if (!spend(costOf(defId))) return false;               // pay; on refusal, return before any change
  const id = `e-${nextId.value++}`;
  grid.set(x, y, { ...cell, occupantId: id });
  placed.value = [...placed.value, { id, defId, x, y, cooldown: 0 }];
  return true;
}

function remove(id: string): void {
  const e = placed.value.find((p) => p.id === id);
  if (!e) return;
  grid.set(e.x, e.y, { ...grid.at(e.x, e.y), occupantId: null });
  placed.value = placed.value.filter((p) => p.id !== id);
}
```

A per-entity stat that the balance harness must perturb reads through `tunable()`, keyed by `type/<defId>/<stat>`, not through a chain. See [consumer-guide.md § Tunables](./consumer-guide.md#tunables). Occupancy is rebuilt in `connect()` / `onLoad` from `placed`, so only `placed` is saved. To save the board directly, wrap `grid.serialize()` in one `persistent()` ref; the serialized form is JSON-native.

### Grid change events — and the replacement gotcha

`grid.on('cellChanged', fn)` fires on every `set()`. But the grid may be **replaced**, for board growth or for a challenge that swaps in a masked shape. A direct subscription then stays on the old grid. Own a wrapper that subscribes again inside your build path, and let consumers subscribe to *that*:

```ts
const handlers: Array<() => void> = [];
function buildGrid() { grid = createSpatialGrid({ /* … */ }); grid.on('cellChanged', () => handlers.forEach((h) => h())); }
export function onGridChanged(h: () => void) { handlers.push(h); }
```

SpatialGrid cells are **not** reactive per cell. Reactivity comes from the event, not from reading a cell. To derive reactive board state, subscribe to `cellChanged` or `onGridChanged` and write into a `shallowRef` (next section).

### Adjacency → stat bonus

Packing bonuses, tower synergies and "N adjacent of type X" all map board position to a stat bonus. That seam works best as a **pure function over an occupancy view**. Avoid code that reads the live grid inline. The pure function gives two things. The balance harness can test it with no module state. And the same function computes a placement *preview* when it runs against an overlay view.

```ts
interface OccupancyView { width: number; height: number; occupantAt(x: number, y: number): string | null; typeOf(id: string): Def }

// Pure: (view) → bonuses keyed by entity id. No module state, no reactivity.
function evaluate(view: OccupancyView): Map<string, Bonus> { /* walk cells, read neighbors, sum */ }

// Live wrapper: recompute into a shallowRef on any board change.
const synergy = shallowRef<Map<string, Bonus>>(new Map());
onGridChanged(() => { synergy.value = evaluate(liveView()); });   // + watch() any non-spatial inputs
export const getBonus = (id: string) => synergy.value.get(id) ?? NONE;

// Preview: same evaluator, overlay the hypothetical placement.
function preview(id: string, x: number, y: number) {
  return evaluate({ ...liveView(), occupantAt: (cx, cy) => (cx === x && cy === y ? id : liveView().occupantAt(cx, cy)) });
}
```

Two disciplines keep this stable. First, **recompute on placement events, not per tick**. Structural bonuses change only when the board changes. So apply time-varying factors (freshness, decay) at read time, not inside the recomputed result. Second, the grid ships no connection shapes such as a full row, a full column or radial arcs. For those, hand-roll a small `coveredCells(shape, x, y, w, h)` that returns clipped coordinates. It stays pure and testable beside the evaluator. A fixed offset set (knight moves, hex, one-way lattices) is a `neighborhood`, or an ad-hoc `neighbors(x, y, neighborhood)` call, not a hand-roll.

### Routing: fields by default, A\* only for the opposite shape

Many units that converge on a shared goal set need **one** `distanceField` plus a descent per unit, not one search per unit. The field covers the whole board at once, and is reusable across the tick and across units. It is the shape most boards want.

A\* answers the opposite shape: one unit, one start and goal pair, and a large board. There a whole-board field is waste, and the goal moves often enough that you would rebuild the field anyway. The engine ships no A\* and no heuristic API. That search is a consumer-side loop over `neighbors()` and your own traversal-cost function. What the engine does ship is the expensive half of a *good* heuristic.

**Landmark (differential) heuristics.** Pick K cells as landmarks, and precompute each one's distance field. Then `h(a, b) = maxₗ |d(L,a) − d(L,b)|` is an admissible lower bound on `d(a,b)`. It is far tighter than Manhattan or Euclidean distance when walls or traversal cost make the straight line misleading. One landmark row is exactly one `distanceField` call:

```ts
const n = grid.width * grid.height;
const table = new Float64Array(landmarks.length * n);   // K rows, one per landmark
// subarray() is a view, so the rows are one allocation and `into` fills them in place.
landmarks.forEach((L, k) => grid.distanceField([L], cost, table.subarray(k * n, (k + 1) * n)));

const h = (a: GridCoord, b: GridCoord) => {
  const ia = a.y * grid.width + a.x, ib = b.y * grid.width + b.x;
  let best = 0;
  for (let k = 0; k < landmarks.length; k++) {
    const d = Math.abs(table[k * n + ia] - table[k * n + ib]);
    if (d > best) best = d;
  }
  return best;
};
```

Build the table with K *sequential* calls. `cost` must not call `distanceField` on the same grid, because the query reuses a per-grid scratch queue. Rebuild the table when terrain changes, not per tick. A landmark table recomputed every tick costs more than the searches it saves.

**The trap: `cost` is the cost to *enter* a cell, so travel is asymmetric.** `d(a,b)` and `d(b,a)` differ by `cost(b) − cost(a)`, while the `|Δ|` bound is admissible only against a *symmetric* metric. Under a uniform passable cost the difference vanishes, and the code above is correct as written. Under varied terrain it is not. Symmetrize each row on the way in, then undo the shift on the way out.

```ts
// filling row k:  row[i] += (costAt(L) - costAt(i)) / 2
// reading h:      Math.max(0, best + (costAt(b) - costAt(a)) / 2)
```

Both corrections are endpoint-only. So the optimal path is unchanged, and the result stays admissible *and* consistent, which is safe with a closed set. Skipping them inflates `h` by up to the spread of traversal cost. An inadmissible heuristic does not fail loudly: A\* quietly returns paths that are not shortest.

## Cross-action modifiers

One def's modifier can scale with another def's state:

- action A's output is multiplied while B is unlocked;
- skill B's level multiplies skill A's XP rate;
- upgrade A's modifier is active only while C is owned.

Each is a conditional modifier on A's gain chain, whose `active` predicate or `multiplier` value reads from B. No new primitive is needed.

**Binary modifier (owned / unlocked / ≥1 of a resource).** The simplest shape: a multiplicative modifier that flips on when the source is present. Bind it directly onto the target's gain chain:

```ts
for (const ref of def.affectedBy ?? []) {
  def.gainChain.bind({
    active: () => hasResource(ref.action, 1),
    modifier: createMultiplicativeModifier({
      multiplier: ref.multiplier,
      description: `${ref.action} bonus`,
    }),
  });
}
```

The enclosing persistent context gives each binding its attribution. `chain.bindings()` lists each binding with that attribution, for a tooltip or devtools, with no extra wiring.

**Level-scaled modifier (the source's level or XP multiplies the target).** The reactivity is in the modifier value, not in the `active` predicate. The binding is always active, and the multiplier evaluates to `1` when the source is at zero, so the modifier has no effect:

```ts
def.gainChain.bind({
  modifier: createMultiplicativeModifier({
    multiplier: computed(() => Decimal.add(1, Decimal.mul(sourceLevel.value, perLevelBonus))),
    description: `${ref.action} mastery bonus`,
  }),
});
```

[consumer-guide.md §Modifier chains and effects](./consumer-guide.md#modifier-chains-and-effects) decides among `chain.bind`, declarative `grants` and `createConditionalEffectSystem`. This recipe shows the binding after that choice. Use `ConditionalEffectSystem.register` when registration happens outside a category-driven persistent context, because automatic attribution needs a persistent context. The shape of the modifier never requires it.

## Sublinear per-source prestige payouts

A common prestige-currency shape pays a **power-law transform of run output, summed per source**. Each source's run total has diminishing returns on its own:

```ts
import { integerRoot, Decimal } from '@open-loop/engine';

// sources = [{ total: ∫production dt, scale: 280 }, { total: ∫pressure dt, scale: 350 }]
const payout = sources.reduce(
  (acc, s) => acc.add(integerRoot(Decimal.div(s.total, s.scale), 3)),
  new Decimal(0),
);
```

Two choices define the shape. **Sum per source; do not pool:** `⌊∛(a/sₐ)⌋ + ⌊∛(b/s_b)⌋`, not `⌊∛((a+b)/s)⌋`. Pooling before the root lets one dominant source hide the others. That removes the "every source must be cultivated" pressure that makes the mechanic interesting. The floor per source puts each source's returns on its own curve. **Floor with `integerRoot`, not `Decimal.floor(Decimal.root(...))`.** In break_eternity, `root` and `pow` go through log and exp. So a floored raw root under-counts at perfect powers (∛8 → 1). The `integerRoot` TSDoc says where the floor stops being provable, and what `tryIntegerRoot` reports instead. Each source's `scale` sets its exchange rate, and can be a reactive tunable. The `3` is the root degree: a cube root gives p⅓ diminishing returns, and a higher degree a harsher falloff. Wire the accumulators, the currency resource and any quorum rule consumer-side, because those differ per game. The payout formula above is the shared part.

## Shared pure state-function across live tick and harness

The balance harness tells the truth only if it measures the shipping game. When it re-implements a pacing rule or a policy decision, the two diverge. Every number it then produces describes code that the game does not run. The fix is a discipline, not a primitive. The decision or step logic is in ONE pure function over game state, exported from the game-logic module. BOTH the live `onTick` path and the balance-harness path import it and call it. Cadence and rate limiting stay with each caller; the pure function does not depend on *when* it runs.

Two flavors, one shape.

**Decision / selection:** `(state, params) => choice`. The live automation runs it each time it acts, and the balance harness queries the same function. Its parameters are both the sweep axis *and* the player-facing tuning surface.

```ts
// game module — exported pure, no side effects
export function shouldCollapse(exp: Expedition, p: CollapsePolicyParams): boolean { /* … */ }

// live: inside ctx.onTick, blocked until the automation tier unlocks
// (automation is the game's createAutomationTiers; a balance probe forces the tier with unlock())
if (automation.hasReached('auto-collapse') && shouldCollapse(exp, collapsePolicy.value)) exp.collapse();

// balance harness: the runUntil predicate calls the SAME function
runUntil({ engine, until: () => shouldCollapse(exp, { tapOutSeconds }), maxSimTime });
```

**Integration step:** `(s, dt) => s'`. A pure reflecting or accumulating step. The live variable-dt tick integrates it, and the balance harness replays it at a fixed dt. So live play and the balance harness integrate identically.

```ts
export function advanceCenter(s: CenterState, delta: number, lo: number, hi: number): CenterState { /* … */ }

// live:            ctx.onTick((dt) => { const n = advanceCenter(state, v * dt, lo, hi); /* … */ });
// balance harness: buildCenterPath integrates advanceCenter at a fixed 1 s dt to precompute the path.
```

The parameterization seam: policy parameters are an argument, and game state is read however the module already reads it. That can be pure arguments (`advanceCenter`), a state object (`exp`), or direct reads of a sibling module (a rotation module that reads `getBurnout`). Argument purity is not the invariant; the *symmetry* between live play and the balance harness is.

Why no engine helper: there is nothing to extract. Each policy or step is domain logic (target picking, drift integration, seat rotation). The shared part is already one line: export the function, and call it from both sides. The engine's only job is to make the balance-harness side cheap. `runUntil`, `createMemoryStorage`, `AutomationTiers.unlock` and `pushOverrides` are the balance-harness kernel that assembles the second caller.

This is the general form of one rule: a player-facing automation policy is game code. It is a pure function that `AutomationTiers` blocks until its automation tier unlocks. The balance harness drives the shipping tick with the automation tier forced, and does not re-implement the policy ([consumer-guide-balance.md](./consumer-guide-balance.md) § The probe). The integration-step flavor is an always-on economy step with no automation tier. It is the same discipline, used outside automation.
