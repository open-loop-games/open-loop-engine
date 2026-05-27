# Consumer Guide

How to express a game with `@open-loop/engine`. Read this after forking `open-loop-starter` and before writing your first module.

This guide explains **how to compose** the engine — levels of abstraction, when to reach for which surface, the recurring shapes of consumer modules. It deliberately does not enumerate symbols; for that, route through [api/INDEX.md](api/INDEX.md) into the relevant `api/<tier>.md` file. Adjacent docs: [migration-notes.md](./migration-notes.md) for port traps; `open-loop-research/methodology/techniques/closed-form-progression/` for the math underpinning the formula primitives.

> References below to sibling repos (`open-loop-research`, `open-loop-starter`, etc.) and to `docs/candidate-primitives.md` describe studio-internal resources — they're load-bearing for our own workflow but won't resolve from a standalone clone of this repo.

## The expression spectrum

The engine offers several levels of abstraction for the same problem. Knowing which level to reach for — and when to move between them — is the core skill.

### Level 1: Resource helpers (reach for first)

The engine ships utility functions that handle the Decimal arithmetic, bounds checking, and modifier application that every game needs. Use these before writing raw `Decimal.add(resource.value, ...)`:

| Function | What it does | Replaces |
|---|---|---|
| `addResource` | Add to a resource, optionally through a modifier chain | `resource.value = Decimal.add(resource.value, amount)` |
| `subtractResource` | Subtract with insufficient-funds check; returns `false` if short | `if (Decimal.gte(r.value, cost)) { r.value = Decimal.sub(...) }` |
| `hasResource` | Check if a resource meets a threshold | `Decimal.gte(resource.value, amount)` |
| `displayResource` | Format a resource for display | `format(resource.value)` |
| `resetResource` | Reset to default value | `resource.value = Decimal.dZero` |
| `resource.best` | Persistent high-water mark on persistent resources | Manual `if (gt(current, best)) best = current` |
| `resource.cumulative` | Persistent lifetime gain on persistent resources | Manual accumulator in onTick |

These aren't sugar — they're the correct API. `subtractResource` returns a boolean so "check and spend" is one call, not two. `addResource` accepts an optional modifier chain so yield multipliers apply at the call site.

### Level 2: Category systems (the default for content)

Categories are the engine's standard shape for registering content. Each category factory exposes a typed registration contract and produces live engine objects per definition. Define a custom definition type, provide a mapper, register in bulk. The full factory list lives in `api/content-systems.md` and `api/content-narrative.md` — read the **Canonical entrypoints** block of each before reaching for raw primitives.

```ts
const skills = createSkillCategory<MySkillDef>({
  id: 'skills',
  mapSkill: (def) => ({
    xpToLevel: (xp) => Formula.variable(xp).div(def.xpDivisor).floor(),
    description: def.description,
  }),
});

skills.register([
  { id: 'woodcutting', description: 'Woodcutting', xpDivisor: 10 },
  { id: 'mining', description: 'Mining', xpDivisor: 12 },
]);
```

The `map*` function is where your game's definition shape meets the engine's options shape. For simple cases this is mostly pass-through; for complex cases (skills with custom curves, actions with type-specific behavior) the mapper does real work.

What a category gives you: per-definition persistent context, typed accessors (`getDef` / `getAll` / `getInstance` / `patch`), and per-def lifecycle. Mods extend definitions via `registry.patch()` without touching the original module.

**Categories self-register.** Creating a category enrolls it into a global registry on the engine, so any consumer that wants to walk your game's content — UI surfaces, balance panels, debug overlays, the headless harness, mods — can find it by category type without install-time coupling. There's no publishing step to write; reading is opt-in by anyone, and the read surface stays consistent regardless of how many categories you create. If you bypass categories (drop straight to raw primitives without a category wrapper), the content still works, but it falls outside the registry — tooling and mods won't see it.

**Predicate-gated purchasables.** A purchasable's "shape" is determined by its requirements, not its name. Drop in a predicate requirement instead of `createCostRequirement` and the same primitive becomes a predicate-gated unlock — no cost charged, the `active` ref flips when the requirement is met. Pair with `setupSweepAutoPurchase` to auto-flip on the first tick the predicate is true. This covers progression gates, tier ladders, era unlocks, and visibility flags through the same accessor the rest of your code already reads — `category.getPurchasable(id)?.active.value` — with no parallel visibility store to keep in sync.

Two predicate-requirement forms, in preference order:

- `createGateRequirement({ gate })` — the Gate-authored path. Express the predicate as a `Gate` AST (`resource-gte`, `cumulative-gte`, `count-gte`, `unlock`, `flag`, `state`, `all`/`any`/`not`) and the adapter lifts it into the Requirement contract. The Gate is the only form that's serializable for save/mod/sim and supports `timeUntilGateFlip` for predictor UIs. Use this whenever the predicate can be expressed as a Gate.
- `createBooleanRequirement({ requirement })` — the closure escape hatch. Use when the predicate doesn't fit a Gate kind (arbitrary cross-system computation, opaque consumer state). Same runtime shape as the Gate adapter, but the predicate isn't introspectable.

```ts
const unlocks = createPurchasableCategory<UnlockDef>({
  id: 'unlocks',
  mapPurchasable: (def) => ({
    display: { title: def.title },
    requirements: createGateRequirement({
      gate: { kind: 'cumulative-gte', resource: 'primary', value: def.threshold },
    }),
    limit: 1,
  }),
});
setupSweepAutoPurchase(unlocks.getAll().map((e) => e.instance), true, ctx.onTick);
// Elsewhere: unlocks.getPurchasable('coop-built')?.active.value
```

### Choosing among purchasable primitives

Three paths land in the consumer corpus, each fitting a different shape of need. "Purchase-shaped" here covers anything spent on with a cost requirement — buildings, upgrades, gates, perks, leveled instances:

| Need | Use |
|---|---|
| Building with continuous rate (Cookie-Clicker shape, ambient auto-producers) | `createProducerCategory` |
| Upgrades / gates / capped repeatables in batch (perks, milestones, sequential tiers, visibility unlocks) | `createPurchasableCategory` |
| Per-instance customized leveled purchases (heterogeneous `effect` / `onPurchase` per instance, post-creation per-instance wiring) | raw `createScalingPurchasable` |

**Rate-bearing → producer category.** When ownership produces a continuous resource flow, `createProducerCategory` is the fit. It bundles cost, count, rate aggregation, autobuy, and payback metric in one definition shape:

```ts
const buildings = createProducerCategory<ProducerDef>({
  id: 'buildings',
  registerTick: ctx.onTick,
  mapProducer: (def) => ({
    resource: cookies,
    baseRate: def.baseRate,
    display: def.name,
    purchase: { costResource: cookies, baseCost: def.baseCost, costScaling: def.costScaling },
  }),
});
```

**No rate, batch shape → purchasable category.** When a definition shape covers many instances and their effects fit a shared mapping — capped repeatables, sequential upgrade tiers, predicate-gated unlocks — `createPurchasableCategory` is the fit. The `limit` on the mapped options selects the sub-shape: `1` for upgrades and gates, a finite cap for repeatable perks, omitted for unbounded:

```ts
const perks = createPurchasableCategory<PerkDef>({
  id: 'ngplus-perks',
  mapPurchasable: (def) => ({
    display: { title: def.name, description: def.description },
    requirements: createCostRequirement({ resource: dna, cost: def.cost }),
    limit: def.maxLevel,
    effect: (amount) => def.effect(new Decimal(amount).toNumber()),
  }),
});
```

**Per-instance closures → raw scaling purchasable.** When you're already iterating per definition and each instance needs its own post-creation wiring — a side-channel modifier closing over the produced purchasable's refs, custom retention listing, mapping into a per-instance lookup — drop to `createScalingPurchasable` directly inside the loop. This is a Level 3 drop-down (see below); the entry is here because future authors looking for "leveled purchasables" otherwise reach for the category and fight its shape:

```ts
for (const def of spellDefs) {
  const purchasable = createScalingPurchasable({
    id: `level-${def.id}`,
    resource: knowledge,
    baseCost: 10,
    costScaling: 1.15,
    limit: 50,
    title: def.name,
    effect: (amount) => Decimal.mul(amount, Decimal.mul(def.baseDamage, 0.05)),
    onPurchase(amount) {
      schoolSkills.get(def.school)?.addXp(Decimal.mul(amount, 5));
    },
  });

  // post-creation wiring closing over per-instance refs
  spellPotency.add(createAdditiveModifier({
    addend: () => purchasable.effect.value,
    description: `${def.name} levels`,
    enabled: () => Decimal.gt(purchasable.amount.value, 0),
  }));
  spellLevels.set(def.id, purchasable);
}
```

Path C trades self-registration for direct control: the resulting purchasables aren't enrolled in a category registry, so tooling that walks `CategoriesKey` (devtools panels, balance probes, mods) won't see them. Track them at the consumer (`Map<id, Purchasable>` keyed however the game already addresses them) if anything needs batch access.

### Level 3: Raw primitives (when categories don't fit)

If a category's `map*` is fighting you — the shape is too different, the timing is wrong, you need control the category doesn't expose — drop down to the raw `create*` function directly:

- `createScalingPurchasable` instead of `createPurchasableCategory`
- `createLoop`, `createReset`, `createModifierChain` directly
- `createCategoryBase` for category-shaped registries that don't fit any built-in shape. Pass `Instance = void` and omit `buildInstance` when entries are pure per-def state (no behavior object alongside the def). The base wires per-def persistent context (`{categoryId}/{def.id}`), auto-names persistent fields, and exposes `Resettable` so `createReset` / `createLoop.thingsToReset` walk the entries. This is the same primitive `createSkillCategory`, `createPurchasableCategory`, etc. compose internally — drop here when no system-level wrapper fits but the per-def-state-with-mod-aware-registration shape still does.

This is the normal path for one-off constructs, not a failure. The engine's systems layer composes from these same primitives — dropping down gives you the same building blocks with full control. For the purchasable family specifically, the three-path table above resolves most "category or raw?" questions; reach here for the rest.

### Level 4: Declarative gates and effects (the data-driven escape hatch)

`Gate` is the typed predicate-spec data shape; `IEffect` / `E` builder / `GameStateMutator` are the matching write side — plain data objects evaluated through pure functions against the engine's ambient runtime. Reach for this level when typed refs aren't available: save-file replay, mod configs loaded from JSON/YAML, balance-sim tools, content-registry patches that override behavior via data. The full treatment — Gate kind flavors, when to use vs. avoid, `StateGate` for indexed runtime collections, the closure escape hatch — lives in [§Data and runtime separation](#data-and-runtime-separation). For symbol-level detail see `api/mechanics.md#gate` and `api/mechanics.md#effects`; for the form-choice table (Gate vs Requirement vs `Computable<boolean>`) see `api/INDEX.md#predicate-forms`.

## Common disambiguators

`api/INDEX.md#common-disambiguators` is the short routing table; this section gives the consumer-level *why* for the cases where the routing answer alone isn't enough.

**Purchasable vs achievement.** Player-initiated through requirements (and may spend resources) → purchasable. Observed by the game, auto-earns when true → achievement.

**Producer vs predicate-gated purchasable.** Ownership contributes to a rate → producer. Ownership flips a boolean / grants an effect → purchasable (with `createBooleanRequirement` or a Gate-backed requirement). A predicate-gated purchasable doesn't become a producer just because it's gated.

**TickDriver vs Loop vs RunPool.** "How does time advance?" → `TickDriver`. "Restart this gameplay run" → `Loop`. "Track many independent concurrent run instances" → `RunPool`. The three primitives don't substitute for each other — a game can use all three.

**Sequencer vs advisor.** If the system has to remember what is currently scheduled, it's a sequencer. If it only needs to choose or recommend from candidates each time it's asked, it's an advisor / selection policy.

**Three sibling axes for "choose one from a list."** The engine ships three primitives with the same conceptual job but different shapes. `FillStrategy` (`createConditionalStrategy`, `createPriorityStrategy`, `createRoundRobinStrategy`, `createCompositeStrategy`) is a **stateful generator**: the sequencer calls `next()` when its queue runs dry, and the strategy returns the next `SequencerItem<M>` or `null`. Round-robin binds a persistent cursor. `SelectionPolicy` (`selectionCheapest`, `selectionPaybackPeriod`, `selectionHybridPayback`, `selectionComposite`) is a **stateless selector**: the caller pre-filters candidates and asks `pick(candidates) → T | undefined`. `RecommendationDef` (via `createRecommendationSystem`) is a **scored candidate**: every registered def runs `canApply` / `score` on `Loop.restart`, and the highest-scoring winner runs `recommend()`. The naming asymmetry (`create*Strategy` verb form vs `selection*` noun form) is deliberate: fill strategies bind closure state, selection policies are stateless dispatchers consumed declaratively (`policy: selectionHybridPayback({ ... })`).

Two adjacent primitives sit in the wider advisor family but don't fit the immediate-choice shape above. `createGoalPicker` maintains a **weighted active-goal pool** (between-tick goal arbitration with persistent state, not a one-shot pick). `createRuleAdvisor` aggregates **observation history** into ranked suggestions surfaced to the player (derived from what happened, not selected from candidates). Both live in `api/advisors.md`; read its Canonical entrypoints block for the one-liner role of each.

**Introspection vs harness.** "Discover what's live in this engine right now" → introspection. "Run a simulation against this engine state" → harness. A dev panel usually starts with introspection; a balance experiment starts with harness.

**Unlock taxonomy.** Several primitives flip availability; pick by *who* trips the flip and *what* it gates.

| Shape | Use | Flips |
|---|---|---|
| Player action that charges a cost | `createPurchasableCategory` with `createCostRequirement` | per-instance `active` / `amount` |
| Predicate flips, no cost | `createPurchasableCategory` with `createGateRequirement` (`+ setupSweepAutoPurchase`) | per-instance `active` |
| Observed milestone, auto-earns when true | `createAchievementCategory` | per-instance `earned` |
| Named region grouping content | `createZoneCategory` | which entries are *addressable* |
| Ordered ladder of feature availability | `createAutomationTiers` | which features are exposed |
| Entity rank / relationship state | `createSubjectCategory` tier field | per-subject tier value |

The first three flip per-instance bits the rest of the game reads directly (`active.value`, `earned.value`). The last three flip *what's even surfaced* — they restructure the addressable set, not a single boolean.

## Data and runtime separation

Content modules keep `data/*.ts` engine-runtime-free: data files describe what content exists, never instantiate engine refs. This isn't dogma — it's what makes content swappable (a mod replaces the data module, the runtime stays the same), serializable (data is plain values), and analyzable (a balance tool can read data without booting the engine).

The trick is when data needs to express predicates over live game state. An achievement's `requirement` has to look at a resource value; an unlock's gate has to check a threshold against a lifetime accumulator; a dialog node's condition has to read relationship state. Those are runtime questions, but the *shape* of the question is part of the content definition.

`Gate` is the answer. Predicate shape lives in the content definition as a typed AST keyed by string IDs; the engine's ambient runtime resolves those IDs to live refs at evaluation time. The data side never touches an engine ref; the runtime side never owns predicate shape.

Gate kinds split into two flavors. **Rate-aware leaves** (`resource-gte`, `cumulative-gte`, `state`, `flag`) are declarative against the accessor with predictor-friendly distance via `timeUntilGateFlip` where the kind admits it. **Category-aware leaves** (`count-gte`, `unlock`) read through `CategoryEntrySignals` — use when the unlock or count *is* a registered category entry. Combinators (`all`, `any`, `not`) compose either flavor.

**When NOT to reach for Gate.** When you have direct typed refs in scope, `hasResource(wood, 50)` is clearer than `{ kind: 'resource-gte', resource: 'wood', value: 50 }`. The data-side discipline is about *content definitions* (where the closure can't live anyway) — typed callsites inside engine module code stay typed.

```ts
// data/achievements.ts — pure data, no engine imports
import type { Gate } from '@open-loop/engine';

export interface AchievementDef {
  id: string;
  description: string;
  requirement: Gate;
}

export const ACHIEVEMENTS: AchievementDef[] = [
  {
    id: 'first-handful',
    description: 'Ten saved.',
    requirement: { kind: 'cumulative-gte', resource: 'eggs', value: 10 },
  },
  {
    id: 'coop-built',
    description: 'Hens settle in.',
    requirement: { kind: 'count-gte', category: 'producers', entity: 'coop', value: 1 },
  },
];
```

No per-game predicate interface, no module-side implementation table, no closures handed into registration. The Gate union grows engine-side when a validated kind shows up across consumers; consumer code stays a tree of typed data. The would-be side-table for "what's currently visible?" never materializes because `unlock` reads `unlocks.getPurchasable(id)?.active.value` through the category-signals layer.

**Runtime collection queries — use `StateGate`, not a new Gate kind.** Predicates over indexed runtime state (bestiary kill counts, achievement tallies, per-tag aggregates, multi-run stats) fit `StateGate` once the collection is projected into a dot-path shape and resolved by `GameStateAccessor.getState`. A borglike-style "killed ≥5 goblins" check becomes `{ kind: 'state', key: 'bestiary.goblin.kills', operator: 'gte', value: 5 }`. Compound queries that need iteration ("killed any monster with tag X") are expressed by precomputing a derived counter game-side (`computed(() => ...)` over the collection, exposed at e.g. `derived.killsByTag.<tag>`) and gating on *that* path — the engine does not ship an iteration primitive because the collection shape (tags, types, filters) is inherently game-specific.

A custom-predicate Gate kind carrying a closure is deliberately *not* part of the union: it would break Gate's serializability and predictor introspection. When neither `StateGate` nor a derived-counter path fits, the signal is that the gate isn't declarative — express it as a typed closure game-side via `Computable<boolean>` on fields that accept that union arm (or `createBooleanRequirement` on requirement-shaped fields) and keep it out of `Gate` entirely. That's the right place for it: an unserializable predicate doesn't belong in `data/*.ts` either way. See idle-loops-ng's `data/builders.ts` for the worked pattern.

## Persistence

### Persistent context

All engine state that survives save/load must be created inside a persistent context. `withPersistentContext` runs a block inside the context and guarantees the context closes even if the block throws — return whatever refs the caller needs and destructure on the outside:

```ts
const { wood, stone } = withPersistentContext('my-resources', () => ({
  wood: createResource<DecimalSource>(Decimal.dZero, { displayName: 'Wood' }),
  stone: createResource<DecimalSource>(Decimal.dZero, { displayName: 'Stone' }),
}));
```

The context ID is the save key namespace. Changing it breaks existing saves.

### Resetting persistent refs in bulk

Use `createReset`'s `resetModules` for module-scoped resets instead of manually enumerating refs. The reset system resolves each module ID to the persistent refs created during that module's install/connect phase, including nested category and per-definition contexts:

```ts
const prestigeReset = createReset({
  resetModules: ['resources', 'upgrades', 'producers'],
});
```

This means adding a resource, upgrade, producer, or category entry inside one of those module scopes automatically includes it in resets that reference that module — no cross-file coordination. Lifetime refs such as `resource.cumulative` and `resource.best` are skipped by module-scoped resets by default; pass them directly through `thingsToReset` only for hard resets that should wipe lifetime statistics.

Inline `keep` and `retain` on the same `createReset` act as a denylist over the resolved scope, evaluated at reset time. Refs in `keep` survive verbatim; refs in `retain` are snapshot before the wipe, run through the supplied transform, and written back after:

```ts
const prestigeReset = createReset({
  resetModules: ['resources', 'upgrades'],
  keep: [premium.amount],
  retain: new Map([[skillLevel, fractional(0.1)]]),
});
```

A `Resource` returned by `createResource` is itself the `Persistent` handle (`Resource<T> & Persistent<T>`), so pass it directly to `keep` / `retain` — no `.amount` indirection. Inline `keep`/`retain` is shorthand for `createRetentionPolicy`; drop to the standalone factory only when the same policy spans more than one reset.

### Category systems scope their own persistence

Category factories (`createSkillCategory`, `createChallengeCategory`, `createPurchasableCategory`, etc.) wrap each registered definition in its own persistent context — `{categoryId}/{def.id}` — regardless of the ambient `withPersistentContext` in effect. See `category-base.ts` (the `beginPersistentContext` call inside `registerOne`).

This matters most for challenges: `active` and `completions` refs scope to per-challenge contexts and are **not** included in any ambient reset scope by default. Completions survive every prestige tier unless a consumer explicitly lists the per-challenge contexts in `resetModules` — which matches the usual game-design pattern where challenge completions are permanent rewards (AD canon, TMT convention).

If you want completions to reset with a prestige tier, list the per-challenge contexts explicitly (e.g. `'my-challenges/ic1'`) in the reset's `resetModules`.

### Bindings re-hydrate from install, not from save

Modifier bindings (`chain.bind`, `Grant` lowerings, `PersistentEffectSystem.register`) aren't serialized — closures can't round-trip. They live in module install code, which re-runs on every load. Bind unconditionally with `active` / `multiplier` closing over persistent refs; on load those refs hydrate before install reads them, so the chain reflects post-load state the same tick.

The mistake to avoid: `if (upgrade.active.value) chain.bind(...)` reads once at install and never re-fires. Bind unconditionally and let `active` gate. `active` is a `Computable<boolean>` (`T | Readonly<Ref<T>> | () => T`), so all three of these are valid:

```ts
// Ref in hand — preferred, no closure
chain.bind({ active: upgrade.active, modifier })
// Derived predicate — getter form
chain.bind({ active: () => hasResource(ref.action, 1) && upgrade.active.value, modifier })
// Constant — always-on binding with attribution
chain.bind({ modifier })  // omit `active` entirely
```

Reach for the getter only when the predicate is derived from more than one source; if you already have a `Ref<boolean>`, pass it as-is.

### Writing migrations

When you bump `EngineConfig.saveVersion`, supply a `saveMigrations` entry for each version that transforms data from `v → v+1`. Migrations run sequentially over the raw decoded save object before validation and deserialize. The engine ships a small kit of pure transforms — compose them in the migration body rather than hand-rolling traversal each time.

```ts
import {
  renameField,
  retypeField,
  dropField,
  addField,
  forEachDefinition,
} from '@open-loop/engine';

const saveMigrations = {
  // v1 → v2: definitions in three contexts gained two derived fields. Iterate
  // each entry and seed defaults with `??=` against the prior shape.
  1: (data) => {
    for (const group of ['jobs', 'constructions', 'exploration']) {
      forEachDefinition(data as Record<string, unknown>, group, (entry) => {
        entry.genStartCompletions ??= entry.timesCompleted ?? 0;
        entry.hadEncounteredBeforeGeneration ??= entry.hasEncountered ?? false;
      });
    }
    return data;
  },
  // v2 → v3: rename a top-level group.
  2: (data) => renameField(data as Record<string, unknown>, 'oldModule', 'newModule'),
  // v3 → v4: a nested record's keys no longer make sense — clear it.
  3: (data) =>
    addField(data as Record<string, unknown>, 'stats.chapterTimes', {}, { overwrite: true }),
  // v4 → v5: a field changed from `number` to `Decimal`. Engine deserialize
  // accepts string-encoded Decimals natively, so `String(v)` is enough.
  4: (data) => retypeField(data as Record<string, unknown>, 'inventory.gold', (v) => String(v)),
};
```

**Path convention.** Helpers split on `.` to walk nested objects — `'jobs.warrior.progress'` reaches `data.jobs.warrior.progress`. The engine's serialized shape is nested object trees, never flat dot-keyed records, so the convention matches what the helpers traverse. `PersistentName` segments are guaranteed not to contain a literal `.`.

**Missing-path semantic.** Every helper silently no-ops when the target path is missing. Migrations need to tolerate already-absent fields — a player loaded a save from a fork that opted out of the feature, or a previous migration dropped the field. Don't add presence checks before the helper call; that's what the helper covers.

**Mutate-and-return.** Helpers mutate the same data ref and return it for chain ergonomics. Cloning a large save tree per step is wasteful; the migration callback owns the data while it runs.

**Foundation primitives.** `getNested` and `setNested` are exported for one-off migrations that don't fit a named shape. They share semantics with the engine's serialize/deserialize paths — what they read and write is what those paths read and write.

**When to drop to a hand-rolled callback.** Reach past the helpers when a migration needs cross-field invariants (compute one field from two others), structural reshaping (collapse two contexts into one), or interaction with the persistent-ref registry (legacy ID-to-name remaps — the engine already handles that one internally). Anything else, the helpers cover.

The engine emits `save:migration-step { from, to }` for each consumer migration that runs, so per-step logging belongs in an event listener, not inside the migration body.

## Conversions

`createConversion` is an atomic multi-resource transformation: spend inputs through `Requirement`s, produce outputs through formulas over a snapshot of consumed amounts. Prestige is the canonical shape — convert resources to prestige points then reset everything — but the primitive also covers non-prestige transformations: crafting recipes (`{wood: 100, mineral: 50} → {beam: 1}`), market trades (`{gold: 5} → {wood: 1}`), and exchange actions (`{gold: 'all'} → {mana: ({gold}) => gold * 50}`). The output formula receives a snapshot of consumed inputs taken before any mutation, so same-resource compounding (output produces more of an input type) is well-defined.

Conversion and reset are composed externally — the factory holds no `Reset` reference. The standard prestige pattern wires them together at the call site by firing the reset from `afterConvert`:

```ts
const prestige = createConversion({
  inputs: {
    points: createCostRequirement({
      resource: points,
      cost: () => points.value,
      pay: () => { points.value = 0 },
    }),
  },
  outputs: {
    prestigePoints: {
      resource: prestigePoints,
      amount: ({ points }) => createSqrtFormula(10)(points),
    },
  },
  afterConvert: () => prestigeReset.reset(),
});

function onPrestigeButton() {
  if (!prestige.canConvert.value) return;
  prestige.convert();
}
```

## Modifier chains and effects

The word "effect" wears two hats in this section. `IEffect` / the `E` builder / `GameStateMutator` are the **state-mutation AST** — declarative writes evaluated against the ambient runtime. `createPersistentEffectSystem` / `createTemporaryEffectSystem` are **binding-lifecycle managers** — they hold live modifier registrations and activate/deactivate them as predicates flip. "Persistent" in the system name refers to the binding's durability across reloads, not to save serialization — the bindings themselves re-hydrate from install code on every load (see § Bindings re-hydrate from install). The modifier chain is the surface that bindings (from either source) push onto.

`createModifierChain` is a named, composable modifier that multiple modules can push modifiers onto. Use it as a shared surface for production bonuses, yield multipliers, or any value that multiple systems contribute to:

```ts
// Module A creates the chain
const productionChain = createModifierChain('production');

// Module B pushes a modifier onto it
productionChain.add(createMultiplicativeModifier({
  multiplier: () => Decimal.add(1, Decimal.mul(renown.value, 0.1)),
  description: 'Renown',
}));
```

For conditional modifiers (active only when a condition is met), there are three levels; pick the most-specific one that fits:

- **Declarative category fields (`grants` / `restricts` / `rewards`)** — preferred when the modifier's lifecycle matches a category signal. Purchasable and achievement categories expose `grants?: Grant[]` (active while the purchasable's `active` ref is true / the achievement is earned); challenge categories expose `restricts?: Grant[]` (active during the challenge) and `rewards?: Grant[]` (active after at least one completion). Each `Grant` lowers to a `chain.bind` call with scope-derived attribution — zero per-binding ceremony, balance-sim sees the contribution with an id like `ad-ip-upgrades/totalTimeMult/Time Dilation`.

  ```ts
  createPurchasableCategory<IPUpgradeDef>({
    id: 'ad-ip-upgrades',
    mapPurchasable: (def) => ({
      display: { title: def.title },
      requirements: createCostRequirement({ resource: infinityPoints, cost: def.cost }),
      limit: 1,
      grants: [
        { chain: productionChain, mult: () => computeMult(), description: 'Time Dilation' },
      ],
    }),
  });
  ```

- **`chain.bind({ active, modifier })`** — the primitive the declarative fields lower to. Use directly when you have a one-off 1:1 binding that doesn't fit a category signal (ad-hoc module-level buffs, unlock-gated conditional modifiers). Auto-derives an attribution id from the ambient `withPersistentContext` scope and the modifier's description; duplicate ids within one chain throw. Binding is **synchronous** — purchase an upgrade and `chain.apply(...)` reflects the contribution the same tick, no `nextTick()` needed. Bindings aren't persisted — the install-time call re-runs on load (see § Bindings re-hydrate from install, not from save).

- **`createPersistentEffectSystem`** — keep this for cases that `chain.bind` can't cover cleanly: multi-chain atomic bindings where all chains must activate/deactivate together, bindings with `onActivate` / `onDeactivate` side-effect hooks, or explicit registration outside any category-driven lifecycle.

When a challenge or prestige layer replaces one multiplier with another while active (AD's IC3 tickspeed rewire is the canonical example), use `replacementBinding` to generate the cancel + replacement pair as one call. It expands to two separately-described chain entries so attribution stays intact — do not use `OverrideRegistry` for this, which bypasses the chain and defeats introspection.

### Cross-action bonuses

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

The ladder choice between `chain.bind` and `createPersistentEffectSystem` is the same one described at the top of §Modifier chains and effects — cross-action bonuses are just the most common shape that hits it. idle-loops-ng's `affected-by.ts` uses `PersistentEffectSystem.register` because registration happens outside any category-driven persistent context (attribution auto-derivation needs a scope), not because the bonus shape itself requires it.

## Tunable knobs

Balance constants — base rates, cost growth factors, multipliers — sit in `data/balance.ts` as plain values most of the time. When something external needs to perturb them (a balance solver bisecting against beat windows, a dev panel sliding values live, a mod config swapping a coefficient, an A/B harness comparing two parameter sets), wrap them in `tunable()` to expose them through a tuning registry that any external surface can read.

```ts
// data/balance.ts
const tuning = createTuningRegistry('my-archetype');

export const balance = {
  tier1BaseRate:        tunable(tuning, 'producers/tier1/baseRate', () => 0.5),
  producerCostGrowth:   tunable(tuning, 'producers/costGrowth',     () => 1.08),
  achievementMultiplier: tunable(tuning, 'achievements/multiplier', () => 1.02),
  prestigeEligibleThreshold: 1_000_000, // unwrapped: structural, not a knob
};
```

The wrap turns the constant into a `ComputedRef` that consults the registry first and falls back to the default closure. Anything with a handle to the registry — typically via injection key — calls `pushScope(name, overrides)` to install a layer of overrides; every reader sees the new value reactively until the returned `restore()` thunk pops the scope. Reads inside the default fn register their own deps, so the computed also tracks the underlying state when no override is active.

Wrap values you want external surfaces to touch; leave structural constants (thresholds that mean something architectural, fixed step counts, level boundaries) unwrapped. The wrap surface doubles as documentation of *what's a knob*: a reviewer scanning the registry sees exactly what's intentionally exposed for tuning, distinct from coefficients that aren't safe to perturb.

The scoped stack means transient takeovers — sim runs, what-if probes, balance bisections — don't have to undo themselves manually. Push a scope, run, restore. The base values come back without any cleanup ceremony, and reactive readers re-render once on each transition.

Key naming convention: namespace with `category/entity/field` slashes (`'producers/tier1/baseRate'`, `'upgrades/double-gold/effect'`). Greppable, sortable, and clear about what each key controls when the registry is enumerated.

For the cross-engine layer that walks these registries (balance workbench, sim picker, dev panels) see `api/introspection.md#override-registry` — `createTuningRegistry` auto-enrolls into `TuningRegistriesKey` (the picker's enumeration surface) when constructed inside the engine's install/connect ambient. `createOverrideRegistry` is the broader primitive underneath — reach for it directly when the override target is a non-numeric function the picker shouldn't surface (challenge takeover, mod fn replacement, sim swap). For modifier-chain replacement specifically, use `replacementBinding` (§Modifier chains): it keeps attribution intact on the chain, where a raw `OverrideRegistry` swap would bypass it.

## Introspection

External tools (devtools panels, balance probes, UI hints, mods) walk the live engine surface through opt-in injection keys — `CategoriesKey`, `ChainRegistryKey`, `EffectSystemRegistryKey`, `TuningRegistriesKey`. No install-time coupling: anything with an engine handle can enumerate without being wired into its module graph.

The layering rule "game code never imports harness" applies to runtime gameplay modules — the per-tick logic, content registrations, effect bindings that the engine ticks. Tooling consumers (devtools panels, balance probes, "upcoming unlock" UI hints, mods that introspect content) are a separate class and may import the harness walkers and picker freely; that's what the snapshot helpers below are for. Keep the import surface for tooling in its own module so the gameplay/tooling boundary stays legible.

Two query shapes recur:

- **"What modifiers are live, and where did they come from?"** — `createPickerSnapshot` walks content + chains + tunables and deduplicates by `Modifier` identity. See `api/harness.md#picker`.
- **"What changes next?"** — the transition-walker family returns pending state transitions across challenges/purchasables/producers with `TransitionDistance` per emission. Two adoption shapes, picked by recomputation cadence: `createTransitionSnapshot` rebuilds from scratch on each call (one-shot probes, coarse-cadence UIs), `createIncrementalSnapshot` caches with per-label dependency tracking and `invalidate*` axes (event-stepping probes that rebuild per simulated event). See `api/harness.md#content-walker`.

Null `distance.seconds` is intentional and consumer-interpreted: a stasis analyzer treats it as "cannot rule out this transition"; a countdown UI hides null rows entirely. The walker never makes that policy call.

Neither snapshot subscribes to reactive changes — consumers drive recomputation cadence themselves. Broader "can this predicate still fire?" coverage is the target of the parked `InfeasibilityOracle` candidate (see `docs/candidate-primitives.md`), which would compose the walker with rate and input checks under a budget-bounded surface.

## Composition recipes

Recurring shapes consumers assemble from engine primitives. Each is a worked pattern from the consumer corpus, not an engine symbol — single-consumer hand-rolls; an engine helper would over-fit. When a second consumer reaches for the same wrapper, the pattern graduates via `docs/candidate-primitives.md`.

### Action execution: ActionCategory, worker bundle, or Slot

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

### Indirect-control worker pools

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

### Pre-completion gating in ActionCategory

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

### Persona-roster composition

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

### Priority-weighted fill across multiple content categories

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

### Character interaction surface

Composition recipe for games with named characters that the player returns to — companions, mentors, merchants, faction contacts. The engine provides a dialog runtime and a relationship-state category; both are Tier-4 surfaces (specialized in incremental, near-default in narrative-adjacent codebases). Pattern definitions live in `open-loop-research/patterns/tier-4-specialized/character-interaction-systems.md` and `open-loop-research/patterns/tier-4-specialized/relationship-systems.md`.

#### Dialog: contract first, runtime second

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

#### Subjects: addressable named entities with typed multi-field state

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

#### When dialog and subjects connect

Both surfaces share the engine's predicate / effect machinery. A dialog node gates on subject state through the typed `StateGate` path: `{ kind: 'state', key: 'subject.npc-trust.mentor-rask.trust', operator: 'gte', value: 2 }` — the path is `{categoryId}.{subjectId}.{fieldName}` for scalar/tier/flag/enum fields, with an extra `.{dim}` segment for vector dimensions. A choice writes back through `E.state('subject.npc-trust.mentor-rask.trust', 3)` — the predicate side is Gate (typed AST); the effect side is the `E` builder (consumer-facing). Reserved path conventions are documented in `src/primitives/types.ts`.

Bespoke subject-aware atoms (a `SubjectGate` kind / `E.subject`) are intentionally **not** in the builder yet — single-game prevalence (CDDA's `n_npc_trust()` math-DSL is the sole canonical example) doesn't justify the API growth. The state-path encoding is the path until a second consumer needs the ergonomics.

## When the engine should grow

The engine evolves as consumers use it. Two signals:

**`TODO(ergonomics)`** — a working but verbose path. When two independent consumers build the same wrapper around the same ceremony, that's the signal to promote it to engine sugar. One consumer's wrapper is a game-side helper; two is a missing engine primitive.

**The 10% threshold** — the data-driven escape hatch (level 4) is designed for the ~10% of game logic that a generic engine can't express in typed systems. If your game is spending more than 10% of its module code in `Gate` / `GameStateAccessor` territory, that's a signal: either the engine needs a new typed system for the pattern you're expressing, or the existing system needs a higher-level entry point. File a research ticket, not a workaround.

The test from [CLAUDE.md](../CLAUDE.md): if you'd copy-paste the same wiring between two different games, it belongs in the engine. If it only makes sense for one game's design, it stays game-side. If it has no opinion about game design at all, it's core.
