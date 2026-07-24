# Consumer Guide

How to express a game with `@open-loop/engine`. Read this after forking `open-loop-starter` and before writing your first module.

This guide explains **how to compose** the engine — levels of abstraction, when to reach for which surface, the recurring shapes of consumer modules. It deliberately does not enumerate symbols; for that, route through [api/INDEX.md](api/INDEX.md) into the relevant `api/<tier>.md` file. Adjacent docs: `CHANGELOG.md` for breaking-change migration blocks; `open-loop-research/methodology/techniques/closed-form-progression/` for the math underpinning the formula primitives.

> References below to sibling repos (`open-loop-research`, `open-loop-starter`, etc.) describe studio-internal resources — they're load-bearing for our own workflow but won't resolve from a standalone clone of this repo.

## The expression spectrum

The engine offers several levels of abstraction for the same problem. Knowing which level to reach for — and when to move between them — is the core skill.

### Level 1: Resource helpers (reach for first)

The engine ships utility functions that handle the Decimal arithmetic, bounds checking, and modifier application that every game needs. Use these before writing raw `Decimal.add(resource.value, ...)`:

| Function | What it does | Replaces |
|---|---|---|
| `addResource` | Add to a resource, optionally tagging the gain with a modifier chain for trace attribution | `resource.value = Decimal.add(resource.value, amount)` |
| `subtractResource` | Subtract with insufficient-funds check; returns `false` if short | `if (Decimal.gte(r.value, cost)) { r.value = Decimal.sub(...) }` |
| `hasResource` | Check if a resource meets a threshold | `Decimal.gte(resource.value, amount)` |
| `displayResource` | Format a resource for display | `format(resource.value)` |
| `resetResource` | Reset to default value | `resource.value = Decimal.dZero` |
| `resource.best` | Persistent high-water mark on persistent resources | Manual `if (gt(current, best)) best = current` |
| `resource.cumulative` | Persistent lifetime gain on persistent resources | Manual accumulator in onTick |

These aren't sugar — they're the correct API. `subtractResource` returns a boolean so "check and spend" is one call, not two. `addResource` accepts an optional modifier chain that tags the gain for trace attribution (it does *not* apply the chain as a yield multiplier — pre-multiply the amount if you need that).

### Level 2: Category systems (the default for content)

Categories are the engine's standard shape for registering content: each factory exposes a typed registration contract and produces live engine objects per definition. Define a definition type, provide a mapper, register in bulk. The full factory list is in `api/content-systems.md` and `api/content-narrative.md` — read each's **Canonical entrypoints** block before reaching for raw primitives.

```ts
const skills = createSkillCategory<MySkillDef>({
  id: 'skills',
  mapSkill: (def) => ({
    xpToLevel: (xp) => Formula.variable(xp).div(def.xpDivisor).floor(),
    levelToMultiplier: (level) => Formula.variable(level).pow_base(1.05),
  }),
});
skills.register([{ id: 'woodcutting', xpDivisor: 10 }, { id: 'mining', xpDivisor: 12 }]);
```

The `map*` function is where your game's definition shape meets the engine's options shape. For simple cases this is mostly pass-through; for complex cases (skills with custom curves, actions with type-specific behavior) the mapper does real work.

What a category gives you: per-definition persistent context, typed accessors (`getDef` / `getAll` / `patch`), and per-def lifecycle. Mods extend definitions via `registry.patch()` without touching the original module.

**Categories self-register.** Creating a category enrolls it into a global engine registry, so any consumer — UI surfaces, balance panels, debug overlays, the headless harness, mods — can walk your content by category type without install-time coupling. No publishing step; reading is opt-in. Bypass categories (raw primitives, no wrapper) and the content still works but falls outside the registry — tooling and mods won't see it.

**Predicate-gated purchasables.** A purchasable's shape is its requirements, not its name. Swap `createCostRequirement` for a predicate requirement and the same primitive becomes an unlock — no cost charged, the `active` ref flips when the requirement is met (pair with `setupSweepAutoPurchase` to auto-flip on the first true tick). Progression gates, tier ladders, era unlocks, and visibility flags all read through the one accessor — `category.getPurchasable(id)?.active.value` — with no parallel visibility store to keep in sync.

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

**Rate-bearing → producer category.** When ownership produces a continuous resource flow, `createProducerCategory` bundles cost, count, rate aggregation, autobuy, and payback metric in one definition shape:

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

**No rate, batch shape → purchasable category.** When many instances share an effect mapping — capped repeatables, sequential upgrade tiers, predicate-gated unlocks — `createPurchasableCategory` fits. The mapped `limit` selects the sub-shape: `1` for upgrades and gates, a finite cap for repeatable perks, omitted for unbounded:

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
    id: `level-${def.id}`, resource: knowledge, baseCost: 10, costScaling: 1.15, limit: 50,
    effect: (amount) => Decimal.mul(amount, Decimal.mul(def.baseDamage, 0.05)),
    onPurchase: (amount) => schoolSkills.get(def.school)?.addXp(Decimal.mul(amount, 5)),
  });

  // post-creation wiring closing over per-instance refs
  spellPotency.add(createAdditiveModifier({
    addend: () => purchasable.effect.value,
    enabled: () => Decimal.gt(purchasable.amount.value, 0),
    description: `${def.name} levels`,
  }));
  spellLevels.set(def.id, purchasable);
}
```

Path C trades self-registration for direct control — like any raw-primitive bypass, the purchasables fall outside the category registry (see *Categories self-register* above), so track them at the consumer (`Map<id, Purchasable>`) if anything needs batch access.

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

**Offline progress strategy.** Four families recur across the corpus — *extrapolation* (closed-form reward for time away), *tick-sim* (replay elapsed time through the loop), *cap-and-trickle* (release banked time at a bounded rate), and *banking* (idle becomes spendable fast-forward inside a later active session). The engine ships **mechanism, not policy**: `processOfflineTime` (blocking chunked replay through the TickDriver — covers extrapolation and tick-sim), `TickDriver.speedMultiplier` (the live tick scaler), and the `onStepsOverflow` / `onDeltaOverflow` hooks (the seam for *banking* dropped live-path time instead of discarding it). Which family you pick, whether catch-up runs blocking or drains gradually over frames, whether live-path overflow is re-routed losslessly, and how screen/menu gating works are all **consumer-side policy** composed on top. Two shipped points show the spread on the *same* mechanism: idle-loops-ng runs variable-mode + blocking `processOfflineTime` on load + a `bonus-time` banking reservoir; incloneution runs fixed-mode + a gradual `requestAnimationFrame`-budgeted drain that re-routes live overflow losslessly back into the catch-up queue. They diverge by design — don't reach for an engine primitive to unify them. The *banking* family is the one actually converging across consumers, and it has no engine surface today — build it on the overflow hooks. `processOfflineTime` itself is `api/lifecycle.md#offline`.

**Sequencer vs advisor.** If the system has to remember what is currently scheduled, it's a sequencer. If it only needs to choose or recommend from candidates each time it's asked, it's an advisor / selection policy.

**Three sibling axes for "choose one from a list."** The engine ships three primitives with the same conceptual job but different shapes. `FillStrategy` (`createConditionalStrategy`, `createPriorityStrategy`, `createRoundRobinStrategy`, `createCompositeStrategy`) is a **stateful generator**: the sequencer calls `next()` when its queue runs dry, and the strategy returns the next `SequencerItem<M>` or `null`. Round-robin binds a persistent cursor. `SelectionPolicy` (`selectionCheapest`, `selectionPaybackPeriod`, `selectionHybridPayback`, `selectionComposite`) is a **stateless selector**: the caller pre-filters candidates and asks `pick(candidates) → T | undefined`. `RecommendationDef` (via `createRecommendationSystem`) is a **scored candidate**: every registered def runs `canApply` / `score` between loops, and the highest-scoring winner runs `recommend()`. The naming asymmetry (`create*Strategy` verb form vs `selection*` noun form) is deliberate: fill strategies bind closure state, selection policies are stateless dispatchers consumed declaratively (`policy: selectionHybridPayback({ ... })`).

Two adjacent primitives sit in the wider advisor family but don't fit the immediate-choice shape above. `createGoalPicker` maintains a **weighted active-goal pool** (between-tick goal arbitration with persistent state, not a one-shot pick). `createRuleAdvisor` aggregates **observation history** into ranked suggestions surfaced to the player (derived from what happened, not selected from candidates). Both live in `api/advisors.md`; read its Canonical entrypoints block for the one-liner role of each.

**Introspection vs harness.** "Discover what's live in this engine right now" → introspection. "Run a simulation against this engine state" → harness. A dev panel usually starts with introspection; a balance experiment starts with harness.

**Unlock taxonomy.** Several primitives flip availability; pick by *who* trips the flip and *what* it gates.

| Shape | Use | Flips |
|---|---|---|
| Player action that charges a cost | `createPurchasableCategory` with `createCostRequirement` | per-instance `active` / `amount` |
| Predicate flips, no cost | `createPurchasableCategory` with `createGateRequirement` (`+ setupSweepAutoPurchase`) | per-instance `active` |
| Observed milestone, auto-earns when true | `createAchievementCategory` | per-instance `earned` |
| Named region grouping content | `createZoneSystem` | which entries are *addressable* |
| Ordered ladder of feature availability | `createAutomationTiers` | which features are exposed |
| Entity rank / relationship state | `createSubjectCategory` tier field | per-subject tier value |

The first three flip per-instance bits the rest of the game reads directly (`active.value`, `earned.value`). The last three flip *what's even surfaced* — they restructure the addressable set, not a single boolean.

## Data and runtime separation

Content modules keep `data/*.ts` engine-runtime-free: data files describe what content exists, never instantiate engine refs. This isn't dogma — it's what makes content swappable (a mod replaces the data module, the runtime stays the same), serializable (data is plain values), and analyzable (a balance tool can read data without booting the engine).

The trick is when data needs to express predicates over live game state. An achievement's `requirement` has to look at a resource value; an unlock's gate has to check a threshold against a lifetime accumulator; a dialog node's condition has to read relationship state. Those are runtime questions, but the *shape* of the question is part of the content definition.

`Gate` is the answer. Predicate shape lives in the content definition as a typed AST keyed by string IDs; the engine's ambient runtime resolves those IDs to live refs at evaluation time. The data side never touches an engine ref; the runtime side never owns predicate shape.

Gate kinds split into two flavors. **Rate-aware leaves** (`resource-gte`, `cumulative-gte`, `state`, `flag`) are declarative against the accessor with predictor-friendly distance via `timeUntilGateFlip` where the kind admits it. **Category-aware leaves** (`count-gte`, `unlock`) read through `CategoryEntrySignals` — use when the unlock or count *is* a registered category entry. Combinators (`all`, `any`, `not`) compose either flavor; children go in an `of` field — `of: Gate[]` for `all`/`any`, `of: Gate` for `not`.

**When NOT to reach for Gate.** When you have direct typed refs in scope, `hasResource(wood, 50)` is clearer than `{ kind: 'resource-gte', resource: 'wood', value: 50 }`. The data-side discipline is about *content definitions* (where the closure can't live anyway) — typed callsites inside engine module code stay typed.

```ts
// data/achievements.ts — pure data, no engine imports
import type { Gate } from '@open-loop/engine';

export interface AchievementDef { id: string; description: string; requirement: Gate }

export const ACHIEVEMENTS: AchievementDef[] = [
  { id: 'first-handful', description: 'Ten saved.',
    requirement: { kind: 'cumulative-gte', resource: 'eggs', value: 10 } },
  { id: 'coop-built', description: 'Hens settle in.',
    requirement: { kind: 'count-gte', category: 'producers', entity: 'coop', value: 1 } },
  { id: 'flock-master', description: 'A big coop and a full larder.',
    requirement: { kind: 'all', of: [
      { kind: 'count-gte', category: 'producers', entity: 'coop', value: 5 },
      { kind: 'cumulative-gte', resource: 'eggs', value: 1000 },
    ] } },
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

So adding a resource, upgrade, producer, or category entry inside a module scope automatically joins resets that reference that module — no cross-file coordination. Lifetime refs (`resource.cumulative`, `resource.best`) are skipped by default; pass them through `thingsToReset` only for hard resets meant to wipe lifetime stats.

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
import { renameField, retypeField, forEachDefinition } from '@open-loop/engine';

const saveMigrations = {
  // v1 → v2: definitions gained derived fields — iterate each entry, seed with `??=`.
  1: (data) => {
    for (const group of ['jobs', 'constructions', 'exploration']) {
      forEachDefinition(data as Record<string, unknown>, group, (entry) => {
        entry.genStartCompletions ??= entry.timesCompleted ?? 0;
      });
    }
    return data;
  },
  // v2 → v3: rename a top-level group via a named helper.
  2: (data) => renameField(data as Record<string, unknown>, 'oldModule', 'newModule'),
  // v3 → v4: number → Decimal — engine deserialize accepts string-encoded Decimals.
  3: (data) => retypeField(data as Record<string, unknown>, 'inventory.gold', (v) => String(v)),
};
```

The helpers share their `.`-split nested-path convention, silent no-op on missing paths, and mutate-and-return semantics with the engine's serialize/deserialize paths — read their tsdoc for the per-helper detail. `getNested` / `setNested` are the raw escape hatch for one-off shapes that don't fit a named helper.

Drop to a hand-rolled callback only when a migration needs cross-field invariants (compute one field from two others), structural reshaping (collapse two contexts into one), or persistent-ref-registry interaction (legacy ID-to-name remaps — already handled internally). The engine emits `save:migration-step { from, to }` per migration, so per-step logging belongs in an event listener, not the migration body.

## Conversions

`createConversion` is an atomic multi-resource transformation: spend inputs through `Requirement`s, produce outputs through formulas over a snapshot of consumed amounts. Prestige is the canonical shape (convert to prestige points, then reset), but it equally covers crafting recipes (`{wood: 100, mineral: 50} → {beam: 1}`), market trades (`{gold: 5} → {wood: 1}`), and exchange actions (`{gold: 'all'} → {mana: ({gold}) => gold * 50}`). The input snapshot is taken before any mutation, so same-resource compounding (output produces more of an input type) is well-defined.

Conversion and reset are composed externally — the factory holds no `Reset` reference. The standard prestige pattern wires them together at the call site by firing the reset from `afterConvert`:

```ts
const prestige = createConversion({
  inputs: {
    points: createCostRequirement({ resource: points, cost: () => points.value, pay: () => { points.value = 0 } }),
  },
  outputs: {
    prestigePoints: { resource: prestigePoints, amount: ({ points }) => createSqrtFormula(10)(points) },
  },
  afterConvert: () => prestigeReset.reset(),
});

// At the call site: if (prestige.canConvert.value) prestige.convert();
```

### Sublinear per-source payouts

A common prestige-currency shape (Industry Idle's Merge fragments, and games that copy it) pays out a **power-law transform of run output, summed per source** — each run-long accumulator diminishes independently:

```ts
import { integerRoot, Decimal } from '@open-loop/engine';

// sources = [{ total: ∫production dt, scale: 280 }, { total: ∫pressure dt, scale: 350 }]
const payout = sources.reduce(
  (acc, s) => acc.add(integerRoot(Decimal.div(s.total, s.scale), 3)),
  new Decimal(0),
);
```

Two things carry the shape. **Sum per source, don't pool** — `⌊∛(a/sₐ)⌋ + ⌊∛(b/s_b)⌋`, not `⌊∛((a+b)/s)⌋`. Pooling before the root lets one dominant source mask the others, collapsing the "every source must be cultivated" pressure that makes the mechanic interesting; the per-source floor is what makes each source's returns bite on its own curve. **Floor with `integerRoot`, not `Decimal.floor(Decimal.root(...))`** — break_eternity routes `root`/`pow` through log/exp, so a raw floored root under-counts at perfect powers (∛8 → 1); `integerRoot(x, n)` snaps to the true integer with a scale-robust relative tolerance (see its tsdoc). The `scale` per source sets its exchange rate and can be a reactive tunable; the `3` is the power (cube-root ≈ p⅓ diminishing returns — raise the degree for harsher falloff). Wire the accumulators, wallet, and quorum consumer-side — those diverge per game; the payout formula above is the shared part.

## Modifier chains and effects

The word "effect" wears two hats in this section. `IEffect` / the `E` builder / `GameStateMutator` are the **state-mutation AST** — declarative writes evaluated against the ambient runtime. `createPersistentEffectSystem` / `createTemporaryEffectSystem` are **binding-lifecycle managers** — they hold live modifier registrations and activate/deactivate them as predicates flip. "Persistent" in the system name refers to the binding's durability across reloads, not to save serialization — the bindings themselves re-hydrate from install code on every load (see § Bindings re-hydrate from install). The modifier chain is the surface that bindings (from either source) push onto.

`createModifierChain` is a named, composable modifier multiple modules can push onto — a shared surface for production bonuses, yield multipliers, or any value many systems contribute to:

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

The `chain.bind` vs `createPersistentEffectSystem` choice here is the same ladder from the top of this section. idle-loops-ng uses `PersistentEffectSystem.register` in places only because registration happens outside a category-driven persistent context (attribution auto-derivation needs a scope) — not because the bonus shape requires it.

## Tunable knobs

Balance constants — base rates, cost growth, multipliers — sit in `data/balance.ts` as plain values most of the time. When something external needs to perturb them (a balance solver bisecting against beat windows, a live dev-panel slider, a mod config, an A/B harness), wrap them in `tunable()` to expose them through a tuning registry any external surface can read.

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

The wrap returns a `ComputedRef` that reads registry-then-default; `pushScope` / `restore` install and pop override layers reactively (see `tunable()` tsdoc for the scoped-stack mechanics). The design payoff is two-fold. First, the wrap surface doubles as documentation of *what's a knob*: wrap values external surfaces should touch, leave structural constants (architectural thresholds, fixed step counts, level boundaries) unwrapped, and a reviewer scanning the registry sees exactly what's safe to perturb. Second, transient takeovers — sim runs, what-if probes, balance bisections — push a scope, run, restore: base values come back with no manual cleanup.

Key naming convention: namespace with `category/entity/field` slashes (`'producers/tier1/baseRate'`, `'upgrades/double-gold/effect'`). Greppable, sortable, and clear about what each key controls when the registry is enumerated.

For the cross-engine layer that walks these registries (balance workbench, sim picker, dev panels) see `api/introspection.md#override-registry` — `createTuningRegistry` auto-enrolls into `TuningRegistriesKey` (the picker's enumeration surface) when constructed inside the engine's install/connect ambient. `createOverrideRegistry` is the broader primitive underneath — reach for it directly when the override target is a non-numeric function the picker shouldn't surface (challenge takeover, mod fn replacement, sim swap). For modifier-chain replacement specifically, prefer `replacementBinding` (§Modifier chains) over a raw `OverrideRegistry` swap — it keeps chain attribution intact.

## Introspection

External tools (devtools panels, balance probes, UI hints, mods) walk the live engine surface through opt-in injection keys — `CategoriesKey`, `ChainRegistryKey`, `EffectSystemRegistryKey`, `TuningRegistriesKey`. No install-time coupling: anything with an engine handle can enumerate without being wired into its module graph.

The "game code never imports harness" rule applies to runtime gameplay modules (per-tick logic, content registrations, effect bindings). Tooling consumers — devtools panels, balance probes, "upcoming unlock" hints, content-introspecting mods — are a separate class and may import the harness walkers and picker freely. Keep tooling imports in their own module so the gameplay/tooling boundary stays legible.

Two query shapes recur:

- **"What modifiers are live, and where did they come from?"** — `createPickerSnapshot` walks content + chains + tunables and deduplicates by `Modifier` identity. See `api/harness.md#picker`.
- **"What changes next?"** — the transition-walker family returns pending state transitions across challenges/purchasables/producers with `TransitionDistance` per emission. Two adoption shapes, picked by recomputation cadence: `createTransitionSnapshot` rebuilds from scratch on each call (one-shot probes, coarse-cadence UIs), `createIncrementalSnapshot` caches with per-label dependency tracking and `invalidate*` axes (event-stepping probes that rebuild per simulated event). See `api/harness.md#content-walker`.

Null `distance.seconds` is intentional and consumer-interpreted: a stasis analyzer treats it as "cannot rule out this transition"; a countdown UI hides null rows entirely. The walker never makes that policy call.

Neither snapshot subscribes to reactive changes — consumers drive recomputation cadence themselves. Broader "can this predicate still fire?" coverage would need a budget-bounded layer composing the walker with rate and input checks; that's deliberately absent, not overlooked.

## Composition recipes

Recurring shapes consumers assemble from engine primitives — worked patterns from the consumer corpus, not engine symbols; single-consumer hand-rolls that earn an engine surface only once a second consumer independently reaches for them. The full cookbook lives in [consumer-guide-recipes.md](./consumer-guide-recipes.md), an invaluable condensed starter-components reference for a new consumer:

- **Action execution** — `ActionCategory` vs worker-bundle vs `Slot`: which shape for "what's the player doing right now?"
- **Indirect-control worker pools** — Sequencer + TimedProgress + claim-on-pop (Majesty/DK/DF shape).
- **Pre-completion gating** — gate ActionCategory completion inside the `tick` closure; the omsi-loops hook-chain shape.
- **Persona-roster composition** — a keyed vector of personality params over sequencer-strategies selection.
- **Priority-weighted fill** — interleave multiple content categories under one priority order via a `passBonus` map.
- **Character interaction** — dialog (contract-first runtime) and subjects (typed multi-field relationship state), and where they connect.
- **Spatial grids** — `createSpatialGrid` board state, runtime placement/removal, the grid-replacement event gotcha, and the adjacency→stat-bonus seam (pure evaluator over an occupancy view).

## Domain-language map

Past a certain vocabulary size, re-reading your `data/` types to recall "what's an action vs a job, what references what" costs more than maintaining a small generated map. The engine ships `ol-domain-map` (a bin) for exactly this: point a per-game `domain-map.config.mjs` at your domain files and it emits a committed `domain-map.md` — vocabulary (enums + string-literal/discriminated unions, where membership is an is-a relation), the def inventory, and a field-name reference graph (the untyped-ID edges like `requiredExplorations` that type-graph tools miss). Source of truth is code STRUCTURE, not tsdoc — it regenerates from your types every run, so it can't drift. The config carries the dialect knobs (`scope` globs, `defSuffixes`, optional `nouns`/`stopwords`) plus a small hand-authored `curated` block for the cross-symbol concepts no single type owns. Wire `"domain-map": "ol-domain-map src/domain-map.config.mjs"` and commit both files; edit the config, never the `.md`. Run it from your pre-commit hook so a stale map can never be committed — the same regenerate-then-check discipline the engine uses for its own API docs. See the per-archetype `domain-map.config.mjs` in `open-loop-starter/src/showcase/archetypes/*` for worked examples across dialects (`Def` vs `Spec` suffixes). Note `ts-morph` must resolve for the bin — workspace consumers get it through the engine's own `node_modules`; a registry install needs it added consumer-side.

## When the engine should grow

The engine evolves as consumers use it. Two signals:

**`TODO(ergonomics)`** — a working but verbose path. When two independent consumers build the same wrapper around the same ceremony, that's the signal to promote it to engine sugar. One consumer's wrapper is a game-side helper; two is a missing engine primitive.

**The 10% threshold** — the data-driven escape hatch (level 4) is designed for the ~10% of game logic that a generic engine can't express in typed systems. If your game is spending more than 10% of its module code in `Gate` / `GameStateAccessor` territory, that's a signal: either the engine needs a new typed system for the pattern you're expressing, or the existing system needs a higher-level entry point. File a research ticket, not a workaround.

The test from [CLAUDE.md](../CLAUDE.md): if you'd copy-paste the same wiring between two different games, it belongs in the engine. If it only makes sense for one game's design, it stays game-side. If it has no opinion about game design at all, it's core.
