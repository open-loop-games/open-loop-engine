# Composition recipes

Recurring shapes consumers assemble from engine primitives. Each is a worked pattern from the consumer corpus, not an engine symbol — single-consumer hand-rolls; an engine helper would over-fit. A second consumer independently reaching for the same wrapper is the signal that it has outgrown this file.

This is the companion cookbook to [consumer-guide.md](./consumer-guide.md) — a condensed starter-components reference. Read the guide for *how to think* about composing the engine; reach here for the full worked patterns when you're building one. The guide's narrative spine stays a continuous read; these bulkier examples live here so they don't bloat it.

## Action execution: ActionCategory, worker bundle, or Slot

Three engine shapes share the "what's the player doing right now?" surface. The split is queue × per-execution state machine × selection-only.

| Shape | When to reach for |
|---|---|
| `createActionCategory` | Ordered-execution queue with per-execution state machine. Lifecycle (`pending` / `running` / `waiting` / `completed` / `failed`), progress, attempt, error, timing observable per running item; multi-bar progress shapes (mana + ticks + loops). A list-mode looper restarts a run with `replay()`; `sequencer.resetCursor()` moves only the cursor and leaves each slot's progress from the last run. |
| Worker-bundle recipe | Single-active duration-driven execution from `Sequencer` + `TimedProgress` + a `getTask(id)` lookup. No per-execution state machine; the duration accumulator is the lifecycle. Recipe below. |
| `createSlot` | Single-active *selection*, not execution. Pick one of N at a time, switch instantly, persisted across saves. No queue, no per-tick progress. The shape of a current job or current skill. |

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
- `sequencer.on('started', ...)` handler that splices the claimed id from the shared ref — grab-on-claim

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

Single-worker case: same shape with one instance (`id: 'player'`).

Why no engine helper: the claim axis varies widely across games — round-robin, distance, skill-filter, priority-tier, class-lockout — and recall/cancel semantics vary just as widely. The primitives above are the stable subset; a `createSharedTaskPool` that tried to subsume claim + recall + wake-idle would over-fit to one game's design. Per-worker, the bundle is thin enough (two computeds + one-line dispose) that inlining beats shipping an identity wrapper as a primitive. In a tower-defense game, worker-shaped wiring fights the cooldown-per-tick model and has to be bypassed wholesale anyway.

## Pre-completion gating in ActionCategory

ActionCategory's `completed` event is a post-event observer — by the time it fires, the item is already terminal, and it fires once per execution. Consumers that need to gate completion (budget caps, mana / effort ceilings, mid-execution termination conditions) do it inside the `tick` closure, before declaring complete with `sequencer.complete()`:

```ts
mapAction: (def) => ({
  tick: ({ entry, dt, category }) => {
    category.tickItemProgress(def.id, dt);

    // Pre-completion gate: check budget caps before declaring complete
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

For chain-with-terminate semantics (e.g. an array of pre-completion hooks — `maxMana`, `maxEffort`, then content-specific overrides), wrap the body in an iterable:

```ts
type PreCompletionHook<E, D> = (entry: E, def: D) => 'terminate' | 'continue';
const preCompletionHooks: PreCompletionHook<Entry, Def>[] = [];

mapAction: (def) => ({
  tick: ({ entry, dt, category }) => {
    category.tickItemProgress(def.id, dt);

    for (const hook of preCompletionHooks) {
      if (hook(entry, def) === 'terminate') {
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

This is a recipe, not engine API. The chain shape comes from one lineage of consumers. A second, independent consumer surfacing the same chain is the signal to graduate it onto ActionCategory.

## Persona-roster composition

Composition recipe for games with opponent AI, automated playtest bots, or content-agent populations that need behavioral variety. The engine provides the selection and dispatch primitives; the personality definitions stay consumer-side until a second independent consumer pressure-tests the shape.

The load-bearing observation from the field (80% corpus prevalence across RTS, strategy, RPG, and idle genres): the unit the field ships is a **roster of N differentiated agents**, not a single bot. Sub-shapes — difficulty tiers, parameterized personalities, mode rosters, exploitability profiles — are all instances of the same pattern: a keyed vector of personality params consumed by one decision architecture.

**Engine substrate.** `SequencerItem<M>` carries persona identity in `id` and the param bundle in `metadata: M`. The sequencer-strategies module (`src/core/sequencer-strategies.ts`) provides selection policies:

- `createRoundRobinStrategy` — cycle across runs with a persistent rotation index
- `createPriorityStrategy` — tier-ordered preference (monotonic difficulty)
- `createConditionalStrategy` — opponent-conditioned selection (reacts to measured player behavior)
- `createCompositeStrategy` — emergency-fallback chain across strategies

Active-personality persistence (boundary-deferred-apply) is standard reactive composition: a `persistent<PersonalityId>` ref read by the decision function, written at the boundary (game start, mode shift).

```ts
// N personalities as typed param bundles
const personalities: SequencerItem<PersonaParams>[] = [
  { id: 'aggressive', metadata: { aggression: 0.9, patience: 0.2 } },
  { id: 'defensive',  metadata: { aggression: 0.3, patience: 0.8 } },
  { id: 'adaptive',   metadata: { aggression: 0.6, patience: 0.5 } },
];

// Round-robin rotation across runs — index persists across save/load
sequencer.fillStrategy = createRoundRobinStrategy('persona', () => personalities);

// Or opponent-conditioned selection: read measured player aggression
sequencer.fillStrategy = createConditionalStrategy(() => [
  { condition: () => opponentAggression.value.gt(0.7), item: personalities[1] },
  { condition: () => true,                             item: personalities[0] },
]);
```

**Difficulty-tier discipline.** When sub-shapes encode difficulty (beginner/normal/hard), enforce a monotonic-difficulty constraint in the param bundle: each param that the player perceives as "harder" should be strictly ordered across tiers. Mixing monotonically-increasing and monotonically-decreasing params produces a roster where no tier is cleanly "harder" — exploitability profiles work differently (encode known weaknesses explicitly, not via difficulty ordering).

**Harness integration.** The `src/harness/` picker/runner/sweep substrate already covers persona-population sweeps: `runMatrix` over a personality param axis, or `createPickerSnapshot` to enumerate the perturbable surface (effect-system bindings, chain modifiers, tunables) a persona sweep can vary. Procedural personas (objective variation in search-based agents) live here — vary the objective the search optimizes rather than the policy params.

Why no engine helper today: the selection-policy axis (round-robin vs. priority vs. conditional vs. composite) and the param-bundle shape vary widely across game types. The primitives above are the stable substrate. A cautionary case (a `createPersonalityRoster` wrapper shipped and then rolled back pre-release) established that the wrapper would over-name a composition that already reads naturally without it. First consumer hand-roll is the signal to revisit.

## Priority-weighted fill across multiple content categories

Composition recipe for action-queue automation that needs to interleave entries from multiple content-type categories (gathering, crafting, research, …) under one priority order. Built on `createPriorityStrategy` plus a per-content-type `passBonus` map that breaks ties between equal-priority entries from different categories.

The convergent shape across consumers:

- Each content-type entry carries a player-set `automationPriority` and a static category-level `passBonus`.
- Score is `priority * 10 + passBonus[effectSystemId]` — the multiplier preserves player priority dominance while the pass-bonus map deterministically orders cross-category ties.
- A single fill strategy walks every relevant `category.getAll()`, filters by unlock + visibility, builds a candidate list, sorts descending by score, and returns the first item whose task's `canRun()` returns `'now'`.

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
      if (task?.canRun?.() === 'now') return item;
    }
    return null;
  },
};
```

The shape is convergent today but the pass-bonus map is the consumer-side knob: bonuses encode "when priorities tie, gathering wins over crafting" and are tuned per game. No engine helper because the category list and pass-bonus axis vary per consumer — engine `createPriorityStrategy` covers the single-category case; this recipe is the multi-category extension. If a third consumer hand-rolls the same shape with the same pass-bonus map shape, drop a candidate entry.

## Character interaction surface

Composition recipe for games with named characters that the player returns to — companions, mentors, merchants, faction contacts. The engine provides a dialog runtime and a relationship-state category; both are Tier-4 surfaces (specialized in incremental, near-default in narrative-adjacent codebases) implementing the Character Interaction and Relationship Systems patterns.

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

Graph ids must be unique across every category flattened into one session, and node ids unique within a graph; the native runtime throws at construction on a repeat. Native runtime is the default — pick it for content authored as `DialogGraph` data. Reach for an external adapter when the authoring team already knows Ink/Yarn or when the dialog volume justifies a dedicated authoring tool. Both flow through the same `DialogSession` surface; UI and save format don't care which is wired underneath.

### Subjects: addressable named entities with typed multi-field state

`createSubjectCategory` registers subjects (NPCs, factions, regions, single entities) against a shared field schema. Each schema field picks one of five kinds via its `kind` discriminator: `scalar` (single value per subject, optional `derive` projection), `vector` (N independent dims, CDDA-style opinion), `tier` (ordered tier ladder with a `Predicate` gate per transition, Daggerfall-style rank), `flag` (single persistent boolean per subject, Exult-style named event), `enum` (single nullable enum value per subject — commitment locks, path selection). The category is the only public entry point; per-kind field-builders are private. Reach a subject through `cat.get('subject-id')`; the typed `subject.fields.<name>` accessor narrows to the right per-kind shape at the callsite from schema inference — no runtime narrowing helpers.

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

// One subject, many fields — a single Entity with mixed state
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

Both surfaces share the engine's predicate / effect machinery, through state paths **your accessor implements**. The engine resolves no subject path: a `state` Gate hands its key to your `GameStateAccessor.getState`, and `E.state` hands its path to your mutator's `setState`. Pick a convention — `{categoryId}.{subjectId}.{fieldName}`, plus `.{dim}` for a vector dimension, reads well — and map it onto the category:

```ts
getState: (path) => {
  const [cat, subjectId] = path.split('.');
  if (cat === 'npc-trust') return npcs.get(subjectId)?.fields.trust.getIndex();
  // ...other roots
},
setState: (path, value) => {
  const [cat, subjectId] = path.split('.');
  if (cat === 'npc-trust') npcs.get(subjectId)?.fields.trust.setIndex(value as number);
},
```

A dialog choice then gates on `{ kind: 'state', key: 'npc-trust.mentor-rask.trust', operator: 'gte', value: 2 }` and writes back with `E.state('npc-trust.mentor-rask.trust', 3)`. A path your accessor doesn't handle reads `undefined`, so the gate stays closed without an error — cover every root you author.

Bespoke subject-aware atoms (a `SubjectGate` kind / `E.subject`) are intentionally **not** in the builder yet — single-game prevalence (CDDA's `n_npc_trust()` math-DSL is the sole canonical example) doesn't justify the API growth. The state-path encoding is the path until a second consumer needs the ergonomics.

## Spatial grids: board state, placement, and adjacency

`createSpatialGrid` (see `api/spatial.md` for the full method inventory) is a bounded 2D board of typed cells. The load-bearing idea for a game built on it: **the grid is a derived index over authoritative entity state, not the state itself.** Occupancy is reconstructed from your entity list (a roster, a `persistent<Instance[]>`), so a save serializes the entities, not the board — and a tier/board-size change just rebuilds the grid and re-places.

### Owning the grid

Cells carry whatever per-cell metadata you need; the value is a plain object, either mutated by reference or replaced through `set()` (which emits `cellChanged`). Provide the grid (or a thin API over it) under an `InjectionKey` so other modules reach it without importing the module.

```ts
interface Cell { type: 'open' | 'blocked'; occupantId: string | null }

const grid = createSpatialGrid<Cell>({
  width, height,
  initializer: () => ({ type: 'open', occupantId: null }),
  // neighborhood: DIAGONAL_DELTAS,  // or HEX_AXIAL_DELTAS, or your own offsets;
});                                  // sets the board's adjacency for every traversal verb

grid.at(x, y);                 // throws OOB; tryAt() returns undefined instead
grid.set(x, y, { ...grid.at(x, y), occupantId: id });  // emits cellChanged
grid.inBounds(x, y);
grid.neighbors(x, y);          // the board's own adjacency (4-connected by default)
grid.neighbors(x, y, DIAGONAL_DELTAS);  // ad-hoc, this call only · inRange(x,y,r) Chebyshev
grid.bfs({ x, y }, (cell) => cell.type !== 'blocked');   // PassabilityFn → parent-link map
```

The `passable` / `explored` / `visible` bitmaps and their `*Count` accessors are for FOV/terrain. `beginFovUpdate()`'s commit writes `visible` and `explored` and keeps the counts; `passable` is yours to write by hand (map generation, a door opening, a wall going up). Follow each batch of hand writes with `grid.markMaskChanged('passable')`, which re-derives the counts and emits `maskChanged` for the renderer; without it the counts drift and nothing repaints. `restore()` re-derives everything and emits `bulkChanged` plus one `maskChanged` per bitmap.

### Placement and occupancy (runtime create/destroy)

Player-placed entities that come and go at runtime (towers, seated pieces) are the case the modifier-chain model does *not* fit: a chain created per entity auto-registers into `ChainRegistry`, which has **no unregister path** — sell the entity and its chain leaks. So don't model per-entity stats as per-entity chains. The production shape is a plain instance list plus a per-tick handler:

```ts
const placed = persistent<Instance[]>([], { name: 'placed' });

function place(defId: string, x: number, y: number): boolean {
  const cell = grid.at(x, y);
  if (cell.type !== 'open' || cell.occupantId != null) return false;
  if (!spend(costOf(defId))) return false;               // debit, bail without mutating on refusal
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

Per-entity stats that need to stay perturbable by the balance harness read through `tunable()` keyed by `type/<defId>/<stat>` — not a chain (see § the override registry in the main guide). Occupancy itself is rebuilt in `connect()` / `onLoad` from `placed`, so only `placed` is persisted; if you *do* want to persist the board directly, wrap `grid.serialize()` in one `persistent()` ref (the snapshot is JSON-native).

### Grid change events — and the replacement gotcha

`grid.on('cellChanged', fn)` fires on every `set()`. But if the grid can be **replaced** (board growth, a challenge that swaps in a masked shape), a direct subscription orphans on the old instance. Own a wrapper that re-subscribes inside your build path and let consumers subscribe to *that*:

```ts
const handlers: Array<() => void> = [];
function buildGrid() { grid = createSpatialGrid({ /* … */ }); grid.on('cellChanged', () => handlers.forEach((h) => h())); }
export function onGridChanged(h: () => void) { handlers.push(h); }
```

SpatialGrid cells are **not** per-cell Vue-reactive — reactivity comes from the event, not from reading a cell. Derive reactive board state by subscribing to `cellChanged`/`onGridChanged` and writing into a `shallowRef` (next section).

### Adjacency → stat bonus

The board-position-to-stat-bonus seam (packing bonuses, tower synergies, "N adjacent of type X") is best a **pure function over an occupancy view**, not code that reads the live grid inline. That buys two things: it's harness-testable with no module state, and the same function powers a placement *preview* when run against an overlay view.

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

Two disciplines that keep this stable: **recompute on placement events, not per tick** — structural bonuses change only when the board changes, so apply time-varying factors (freshness, decay) at read time rather than baking them into the recomputed result. And for connection shapes the grid doesn't ship — full row, full column, radial arcs — hand-roll a small `coveredCells(shape, x, y, w, h)` that returns clipped coords; it stays pure and testable alongside the evaluator. Anything expressible as a fixed offset set (knight moves, hex, one-way lattices) is a `neighborhood` or an ad-hoc `neighbors(x, y, deltas)` instead, not a hand-roll.

### Routing: fields by default, A\* only for the opposite shape

Many agents converging on a shared goal set is **one** `distanceField` plus a per-agent descent — not one search per agent. The field is the whole board at once, reusable across the tick and across agents, and it's the shape most boards want.

A\* answers the opposite shape: one agent, one start/goal pair, a board big enough that a whole-board field is waste, and a goal that moves often enough that you'd rebuild the field anyway. The engine ships no A\* and no heuristic surface — that search is a consumer-side loop over `neighbors()` and your own cost function. What the engine does ship is the expensive half of a *good* heuristic.

**Landmark (differential) heuristics.** Pick K cells as landmarks and precompute each one's distance field; then `h(a, b) = maxₗ |d(L,a) − d(L,b)|` is an admissible lower bound on `d(a,b)`, and a far tighter one than Manhattan or Euclidean whenever walls or terrain cost make the straight line a lie. One landmark row is exactly one `distanceField` call:

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

Build the table with K *sequential* calls — `cost` must not call `distanceField` on the same grid, which reuses a per-grid scratch queue — and rebuild it when terrain changes, not per tick. A landmark table that gets recomputed every frame has spent more than the searches it saves.

**The trap: `cost` is cost-to-*enter*, so travel is asymmetric.** `d(a,b)` and `d(b,a)` differ by `cost(b) − cost(a)`, while the `|Δ|` bound is admissible only against a *symmetric* metric. Under a uniform passable cost the difference vanishes and the code above is correct as written. Under varied terrain it doesn't: symmetrize each row on the way in, then undo the shift on the way out.

```ts
// filling row k:  row[i] += (costAt(L) - costAt(i)) / 2
// reading h:      Math.max(0, best + (costAt(b) - costAt(a)) / 2)
```

Both corrections are endpoint-only, so the optimal path is unchanged and the result stays admissible *and* consistent — safe with a closed set. Skipping them inflates `h` by up to the terrain-cost spread, and an inadmissible heuristic doesn't fail loudly: A\* just quietly returns paths that aren't shortest.

## Cross-action bonuses

When one content definition's bonus scales by another definition's state — action A's yield multiplied while B has been unlocked, skill A's XP rate boosted by skill B's level, upgrade A granting a bonus gated on C being owned — it's a conditional modifier on A's gain chain whose `active` predicate or `multiplier` value reads from B. No new primitive needed.

**Binary gate (owned / unlocked / ≥1 of a resource).** The simplest shape — a multiplicative bonus that flips on when the source is present. Bind directly onto the target's gain chain:

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

Auto-attributed via the ambient persistent context; `chain.bindings` surfaces each contribution to balance-sim with no extra wiring.

**Level-scaled bonus (source's level/xp multiplies the target).** Reactivity lives inside the modifier value, not the `active` predicate — the binding is always live, and the multiplier evaluates to `1` when the source is at zero, producing a no-op contribution:

```ts
def.gainChain.bind({
  modifier: createMultiplicativeModifier({
    multiplier: computed(() => Decimal.add(1, Decimal.mul(sourceLevel.value, perLevelBonus))),
    description: `${ref.action} mastery bonus`,
  }),
});
```

Which of `chain.bind` / declarative `grants` / `createPersistentEffectSystem` to reach for is the ladder in [consumer-guide.md §Modifier chains and effects](./consumer-guide.md#modifier-chains-and-effects); this recipe is what the binding looks like once you've picked. Reach for `PersistentEffectSystem.register` when registration happens outside a category-driven persistent context (attribution auto-derivation needs a scope), not because the bonus shape requires it.

## Sublinear per-source prestige payouts

A common prestige-currency shape (Industry Idle's Merge fragments, and games that copy it) pays out a **power-law transform of run output, summed per source** — each run-long accumulator diminishes independently:

```ts
import { integerRoot, Decimal } from '@open-loop/engine';

// sources = [{ total: ∫production dt, scale: 280 }, { total: ∫pressure dt, scale: 350 }]
const payout = sources.reduce(
  (acc, s) => acc.add(integerRoot(Decimal.div(s.total, s.scale), 3)),
  new Decimal(0),
);
```

Two things carry the shape. **Sum per source, don't pool** — `⌊∛(a/sₐ)⌋ + ⌊∛(b/s_b)⌋`, not `⌊∛((a+b)/s)⌋`. Pooling before the root lets one dominant source mask the others, collapsing the "every source must be cultivated" pressure that makes the mechanic interesting; the per-source floor is what makes each source's returns bite on its own curve. **Floor with `integerRoot`, not `Decimal.floor(Decimal.root(...))`** — break_eternity routes `root`/`pow` through log/exp, so a raw floored root under-counts at perfect powers (∛8 → 1); read `integerRoot`'s tsdoc for where the floor stops being provable and what `tryIntegerRoot` reports instead. The `scale` per source sets its exchange rate and can be a reactive tunable; the `3` is the power (cube-root ≈ p⅓ diminishing returns — raise the degree for harsher falloff). Wire the accumulators, wallet, and quorum consumer-side — those diverge per game; the payout formula above is the shared part.

## Shared pure state-function across live tick and harness

The balance harness only tells the truth if it measures the shipping game — the moment it re-implements a pacing rule or a policy decision, the two drift and every number it produces describes code that isn't running in the game. The fix is a discipline, not a primitive: the decision or step logic lives in ONE pure function over game state, exported from the game-logic module, and BOTH the live `onTick` path and the harness/sim path import and call it. Cadence and rate-limiting stay with each caller; the pure fn is stateless of *when* it runs.

Two flavors, one shape.

**Decision / selection** — `(state, params) => choice`. The live automation ticker runs it each pulse; the balance sim queries the same fn. Its params double as the sweep axis *and* the player-facing tuning surface.

```ts
// game module — exported pure, no side effects
export function shouldCollapse(exp: Expedition, p: CollapsePolicyParams): boolean { /* … */ }

// live: inside ctx.onTick, gated by the automation tier
if (effectiveOrder.value >= 3 && shouldCollapse(exp, collapsePolicy.value)) exp.collapse();

// harness: the sim's runUntil predicate calls the SAME fn
runUntil({ engine, until: () => shouldCollapse(exp, { tapOutSeconds }), maxSimTime });
```

**Integration step** — `(s, dt) => s'`. A pure reflecting/accumulating step the live variable-dt tick integrates and the harness replays at a fixed sim step, so online and offline integrate identically.

```ts
export function advanceCenter(s: CenterState, delta: number, lo: number, hi: number): CenterState { /* … */ }

// live:    engine.onTick((dt) => { const n = advanceCenter(state, v * dt, lo, hi); /* … */ });
// harness: buildCenterPath integrates advanceCenter at 1 s steps to precompute the path.
```

The parameterization seam is "policy params as an argument; game state read however the module already reads it" — pure-of-args (fork's `advanceCenter`), an accessor object (frontier's `exp`), or direct sibling-module reads (multiverse-hr's `rotation.ts` reading `getBurnout`). Argument purity is not the invariant; the live-vs-harness *symmetry* is.

Why no engine helper: nothing to extract — each policy/step is domain (target-picking, drift integration, seat rotation), and the shared part is already a one-liner (export the fn, call from both sides). The engine's only job is to make the harness side cheap: `runUntil`, memory storage, `AutomationTiers.unlock`, `pushOverrides` — the balance-harness kernel that assembles the second caller.

This is the general form of "automation is game code, not a harness bot": a player-facing automation policy is a pure function gated by `AutomationTiers`, and the harness drives the shipping tick with the tier forced rather than re-implementing the policy ([consumer-guide-balance.md](./consumer-guide-balance.md) § The probe). The integration-step flavor — an always-on economy step with no tier gate — is the same discipline applied outside automation. Consumers (each with a live `onTick` caller and a `balance/` sim caller): frontier `src/game/modules/auto-target.ts` (decision — `pickNextTarget` / `shouldCollapse`), multiverse-hr `src/modules/rotation.ts` (selection — `worstEligibleSeat` / `freshestBenchedReplacement`), fork `src/game/economy/drift.ts` (step — `advanceCenter`).
