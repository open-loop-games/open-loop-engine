# Consumer Guide

How to express a game with `@open-loop/engine`. Read this after forking `open-loop-starter` and before writing your first module.

This guide covers **how to think about using the engine** — levels of abstraction, composition, when to reach for which surface. For the mechanical per-symbol lookup ("does X exist? where?"), see [docs/api/INDEX.md](api/INDEX.md). For traps surfaced during consumer ports (counter drift, dual-write hazards), see [docs/migration-notes.md](./migration-notes.md). For the **math underpinning** the formula primitives — when each rate function is the right shape, what closes in closed form, where the algebra ends and named adjacent math takes over — see `open-loop-research/methodology/techniques/closed-form-progression/`. This file answers *what shape* your module should take; INDEX answers *which symbol* to call; migration-notes answers *how to get there from existing code*; closed-form-progression answers *what math you're choosing among*.

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

Categories are the engine's standard shape for registering content. Each category factory — `createSkillCategory`, `createProducerCategory`, `createPurchasableCategory`, `createAchievementCategory`, `createChallengeCategory`, `createDialogCategory`, `createRelationshipCategory`, `createZoneSystem` — exposes a typed registration contract and produces live engine objects per definition. Define a custom definition type, provide a mapper, register in bulk:

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

**Predicate-gated purchasables.** A purchasable's "shape" is determined by its requirements, not its name. Drop in `createBooleanRequirement` instead of `createCostRequirement` and the same primitive becomes a predicate-gated unlock — no cost charged, the `active` ref flips when the requirement is met. Pair with `setupSweepAutoPurchase` to auto-flip on the first tick the predicate is true. This covers progression gates, tier ladders, era unlocks, and visibility flags through the same accessor the rest of your code already reads — `category.getPurchasable(id)?.active.value` — with no parallel visibility store to keep in sync.

```ts
const unlocks = createPurchasableCategory<UnlockDef>({
  id: 'unlocks',
  mapPurchasable: (def) => ({
    display: { title: def.title },
    requirements: createBooleanRequirement({
      requirement: () => primary.lifetime.value.gte(def.threshold),
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

Path C trades self-registration for direct control: the resulting purchasables aren't enrolled in a category registry, so tooling that walks categories won't see them unless you wrap with `createPurchasableGroup` for batch operations.

### Level 3: Raw primitives (when categories don't fit)

If a category's `map*` is fighting you — the shape is too different, the timing is wrong, you need control the category doesn't expose — drop down to the raw `create*` function directly:

- `createScalingPurchasable` instead of `createPurchasableCategory`
- `createLoop`, `createReset`, `createModifierChain` directly
- `createCategoryBase` for category-shaped registries that don't fit any built-in shape. Pass `Instance = void` and omit `buildInstance` when entries are pure per-def state (no behavior object alongside the def). The base wires per-def persistent context (`{categoryId}/{def.id}`), auto-names persistent fields, and exposes `Resettable` so `createReset` / `createLoop.thingsToReset` walk the entries. This is the same primitive `createSkillCategory`, `createPurchasableCategory`, etc. compose internally — drop here when no system-level wrapper fits but the per-def-state-with-mod-aware-registration shape still does.

This is the normal path for one-off constructs, not a failure. The engine's systems layer composes from these same primitives — dropping down gives you the same building blocks with full control. For the purchasable family specifically, the three-path table above resolves most "category or raw?" questions; reach here for the rest.

### Level 4: Declarative conditions and effects (the data-driven escape hatch)

`ICondition` / `C` builder / `GameStateAccessor` and `IEffect` / `E` builder / `GameStateMutator` are the engine's data-driven evaluation system. Conditions and effects are plain data objects — no closures, no typed refs — evaluated by pure functions against an accessor.

```ts
// Data-driven: string IDs resolved at evaluation time
C.resource('wood', 'gte', 50)
C.and(C.resource('gold', 'gte', 10), C.unlock('forest'))
```

**When to use this level:**

- Save-file replay or headless simulation where typed refs don't exist
- Mod configs loaded from JSON/YAML where closures can't be serialized
- Balance-sim tools that need to evaluate conditions without instantiating game state
- Content-registry patches that override behavior via data, not code

**When NOT to use this level:**

- When you have direct typed references in scope. A challenge that checks `hasResource(wood, 50)` is clearer than `C.resource('wood', 'gte', 50)` when you're holding `wood` already.
- When the condition involves game logic that doesn't map to resource/unlock/state checks.

**Runtime collection queries — use the accessor, not a new condition type.** Unlock predicates over indexed runtime state (bestiary kill counts, achievement tallies, per-tag aggregates, multi-run stats) fit `StateCondition` once the collection is projected into a dot-path shape and resolved by `GameStateAccessor.getState`. A borglike-style "killed ≥5 goblins" check becomes `C.state('bestiary.goblin.kills', 'gte', 5)` with an accessor that walks `bestiary[goblin].kills`. Compound queries that need iteration ("killed any monster with tag X") are expressed by precomputing a derived counter game-side (`computed(() => ...)` over the collection, exposed at e.g. `derived.killsByTag.<tag>`) and gating on *that* path — the engine does not ship an iteration primitive because the collection shape (tags, types, filters) is inherently game-specific.

A `CustomCondition` with a user-provided predicate is deliberately *not* part of the union: it would break `C`-builder serializability and `extractDependencies` reactive dep extraction. When neither `StateCondition` nor a derived-counter path fits, the signal is that the gate isn't declarative — express it as a typed closure game-side (see idle-loops-ng's `data/builders.ts` pattern) and keep it out of `ICondition` entirely.

The typed path (levels 1-3) is the default for game modules. The data-driven path is for systems that need to operate on game state *generically* — without knowing the specific game's types at compile time.

## Common disambiguators

These are the choices that most often look similar from the outside. The API index gives the short routing answer; this section gives the consumer-level reason.

**Producer vs purchasable.** Use `createProducerCategory` when owning something creates continuous resource flow: buildings, generators, workers producing a rate. Use `createPurchasableCategory` when buying something changes state or grants an effect: upgrades, gates, capped repeatables, perks, and visibility unlocks. A purchasable can be predicate-gated with `createBooleanRequirement`, but it does not become a producer unless ownership contributes to a rate.

**Purchasable vs achievement.** A purchasable is player-initiated or system-purchased through requirements and may spend resources. An achievement is observed: it completes when its requirement becomes true and then stays earned. If the player decides to buy it, use a purchasable. If the game notices it happened, use an achievement.

**Category vs raw primitive.** Categories are the default for authored content because they provide registration, per-definition persistence, patching, reset traversal, and introspection. Raw primitives are for one-off systems or cases where post-creation wiring needs direct closure over an instance. Dropping to raw is fine, but it trades away automatic category visibility unless you wrap the result in an appropriate group or custom category.

**ResourceBag vs inventory.** `createResourceBag` is the generic container: many resource types, capacity limits, transfers, and serialization helpers. `createInventory` is the game-facing item system backed by a `ResourceBag`, with known item IDs, per-item capacity, modifier-driven capacity, and optional auto-persistence.

**GameLoop vs Loop vs RunPool.** `GameLoop` is the engine tick scheduler. `Loop` is a gameplay primitive for loop-incremental runs with reset scope and lifecycle events. `RunPool` manages many opaque concurrent runs, each with its own step/death lifecycle. If the question is "how does time advance?", start at `GameLoop`; if it is "restart this gameplay run", start at `Loop`; if it is "track many independent run instances", start at `RunPool`.

**Sequencer vs advisor.** A sequencer owns ordered dispatch: queues, rotations, fill strategies, and current item state. Advisors rank or recommend choices based on observed state. If the system must remember what is currently scheduled, use a sequencer. If it only needs to choose or recommend from candidates, use advisors or selection policies.

**Introspection vs harness.** Introspection discovers the live engine surface: categories, chains, resources, effects, tunables, and diagnostics. Harness executes simulations: headless runs, matrices, sensitivity sweeps, probes, perturbations, and transition walkers. A dev panel usually starts with introspection; a balance experiment starts with harness.

**SpatialGrid vs SpatialGraph.** Use `createSpatialGrid` for bounded coordinate boards where adjacency comes from x/y positions. Use `createSpatialGraph` for arbitrary node topology, rooms, nested spaces, world maps, or places where edges are authored rather than implied by coordinates. `createScopeStack` layers active-location navigation over a recursive graph.

## Data and runtime separation

Content modules keep `data/*.ts` engine-runtime-free: data files describe what content exists, never instantiate engine refs. This isn't dogma — it's what makes content swappable (a mod replaces the data module, the runtime stays the same), serializable (data is plain values), and analyzable (a balance tool can read data without booting the engine).

The trick is when data needs to express predicates over live game state. An achievement's `requirement` has to look at a resource value; an unlock's gate has to check a threshold against a lifetime accumulator; a dialog node's condition has to read relationship state. Those are runtime questions, but the *shape* of the question is part of the content definition.

The pattern: data declares a `GameState` interface describing the predicate-shaped queries it wants to make; modules implement that interface over live engine refs.

```ts
// data/types.ts — engine-runtime-free
export interface GameState {
  primaryAtLeast(n: number): boolean;
  primaryLifetimeAtLeast(n: number): boolean;
  producerCountAtLeast(id: string, n: number): boolean;
  unlockVisible(id: string): boolean;
}

export interface AchievementDef {
  id: string;
  description: string;
  requirement: (s: GameState) => boolean;
}

// data/achievements.ts — pure data, no engine imports
export const ACHIEVEMENTS: AchievementDef[] = [
  { id: 'first-handful', description: 'Ten saved.', requirement: (s) => s.primaryLifetimeAtLeast(10) },
  { id: 'coop-built', description: 'Hens settle in.', requirement: (s) => s.producerCountAtLeast('coop', 1) },
];

// modules/achievements.ts — wires the interface to live engine state
function createAchievementsModule(data: GameData): EngineModule {
  return {
    install(ctx) {
      const primary = ctx.inject(PrimaryResourceKey);
      const producers = ctx.inject(ProducersCategoryKey);
      const unlocks = ctx.inject(UnlocksCategoryKey);

      const state: GameState = {
        primaryAtLeast: (n) => primary.value.gte(n),
        primaryLifetimeAtLeast: (n) => primary.lifetime.value.gte(n),
        producerCountAtLeast: (id, n) => producers.getInstance(id)?.amount.value.gte(n) ?? false,
        unlockVisible: (id) => unlocks.getPurchasable(id)?.active.value ?? false,
      };

      // hand `state` to the achievement category's registration so requirements close over it
    },
  };
}
```

Helpers extend incrementally — add a method to the interface when a predicate needs it, implement it module-side. The interface is the contract; what fills it changes per-archetype, the data stays portable.

The payoff: predicates resolve to category accessors automatically. `unlockVisible(id)` is `unlocks.getPurchasable(id)?.active.value`, not a parallel visibility store. The temptation to hand-roll a side-table for "what's currently visible?" disappears once data is typed against the helper interface — there's nothing for the side-table to compete with.

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

### Category systems scope their own persistence

Category factories (`createSkillCategory`, `createChallengeCategory`, `createPurchasableCategory`, etc.) wrap each registered definition in its own persistent context — `{categoryId}/{def.id}` — regardless of the ambient `withPersistentContext` in effect. See `category-base.ts` (the `beginPersistentContext` call inside `registerOne`).

This matters most for challenges: `active` and `completions` refs scope to per-challenge contexts and are **not** included in any ambient reset scope by default. Completions survive every prestige tier unless a consumer explicitly lists the per-challenge contexts in `resetModules` — which matches the usual game-design pattern where challenge completions are permanent rewards (AD canon, TMT convention).

If you want completions to reset with a prestige tier, list the per-challenge contexts explicitly (e.g. `'my-challenges/ic1'`) in the reset's `resetModules`.

## Resets and conversions

`createReset` bundles a list of things to reset into a single callable. Use it wherever you'd otherwise manually zero out refs:

```ts
const prestigeReset = createReset({
  resetModules: ['resources', 'upgrades', 'producers'],
});
```

`createConversion` and reset are composed externally — the conversion factory holds no `Reset` reference. The standard prestige pattern wires them together at the call site, either by calling reset right after `convert()` or by firing the reset from `afterConvert`:

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

Conversions also cover non-prestige cross-resource transformations: crafting recipes (`{wood: 100, mineral: 50} → {beam: 1}`), market trades (`{gold: 5} → {wood: 1}`), and exchange-style actions like buy-mana (`{gold: 'all'} → {mana: ({gold}) => gold * 50}`). The output formula receives a snapshot of consumed input amounts taken before any mutation, so same-resource compounding (output produces more of an input type) is well-defined.

## Modifier chains and effects

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

- **`chain.bind({ active, modifier })`** — the primitive the declarative fields lower to. Use directly when you have a one-off 1:1 binding that doesn't fit a category signal (ad-hoc module-level buffs, unlock-gated conditional modifiers). Auto-derives an attribution id from the ambient `withPersistentContext` scope and the modifier's description; duplicate ids within one chain throw. Binding is **synchronous** — purchase an upgrade and `chain.apply(...)` reflects the contribution the same tick, no `nextTick()` needed.

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

**When to reach for `createPersistentEffectSystem` instead.** Binary-gate + single chain + no side-effect hook is `chain.bind` territory. Drop to `createPersistentEffectSystem` when any of the following hold: the binding spans multiple chains that must activate/deactivate atomically; `onActivate` / `onDeactivate` hooks fire game-side side-effects; or registration happens outside any category-driven persistent context (attribution auto-derivation needs a scope). idle-loops-ng's `affected-by.ts` uses `PersistentEffectSystem.register` for that last reason — the helper is called from content modules that each hold their own `PersistentEffectSystem` instance and pass it through — but the shape itself is `chain.bind` idiomatic.

## Tunable knobs

Balance constants — base rates, cost growth factors, multipliers — sit in `data/balance.ts` as plain values most of the time. When something external needs to perturb them (a balance solver bisecting against beat windows, a dev panel sliding values live, a mod config swapping a coefficient, an A/B harness comparing two parameter sets), wrap them in `tunable()` to expose them through an override registry that any external surface can read.

```ts
// data/balance.ts
const tuning = createOverrideRegistry<MyTunables>('my-archetype');

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

## Indirect-control worker pools

Composition recipe for games where the player posts tasks and a pool of N autonomous workers claims them — Majesty-style bounties, DK-style imps, DF-style job queues. The engine provides the primitives; the coordination lives consumer-side until a second independent consumer pressure-tests the shape.

Primitives that compose, per worker:

- `Sequencer` — the schedule
- `TimedProgress` (ephemeral) — the execution accumulator
- `FillStrategy` (e.g. `createRoundRobinStrategy`) closing over a shared `Persistent<TaskId[]>` — the claim
- `sequencer.on('start', ...)` handler that splices the claimed id from the shared ref — grab-on-claim
- `createWorker` — identity wrapper exposing `currentTask` + `dispose`

Shared across the pool:

- The `Persistent<TaskId[]>` ref itself
- A `getTask(id)` lookup over the union of task defs all workers might execute
- Consumer-owned policy: post-bounty, recall, wake-idle orchestration, pin-to-role strategy swaps

Reference implementation: `tiny-civ/workers.ts` in open-loop-starter. The `buildWorker(id)` local factory wires all five primitives; `wakeIdleWorkers(exceptId?)` and `recall()` sit outside the factory because they're policy, not pool state.

Why no engine helper today: the claim axis varies widely across games — round-robin, distance, skill-filter, priority-tier, class-lockout — and recall/cancel semantics vary just as widely. The primitives above are the stable subset; a `createSharedTaskPool` that tried to subsume claim + recall + wake-idle would over-fit to one game's design. The second Majesty-shape consumer is the trigger to revisit (see `TODO(expansion)` in `src/systems/worker.ts`).

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

## Character interaction surface

Composition recipe for games with named characters that the player returns to — companions, mentors, merchants, faction contacts. The engine provides a dialog runtime and a relationship-state category; both are Tier-4 surfaces (specialized in incremental, near-default in narrative-adjacent codebases). Pattern definitions live in `open-loop-research/patterns/tier-4-specialized/character-interaction-systems.md` and `open-loop-research/patterns/tier-4-specialized/relationship-systems.md`.

### Dialog: contract first, runtime second

Dialog content is a graph of nodes with text, gates, choices, and outcomes. The engine ships:

- An authored data shape (`DialogGraph` — `DialogNode[]` with an `entry` pointer) — declarative, serializable, no closures.
- An adapter contract (`DialogRuntime`) — anything that can drive a conversation: `start` / `present` / `choose` / `finish` plus `exportState` / `importState`.
- A native runtime implementation (`createNativeDialogRuntime`) that walks `DialogGraph` nodes, evaluates `ICondition` gates, dispatches `IEffect` outcomes, and maintains visit counts.
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

### Relationships: one category, five typed sub-primitives

`createRelationshipCategory` registers per-actor or per-faction state. Each registered def picks one of five variation shapes via its `kind` discriminator: `scalar` (single value per entity, optional decay/derivation), `faction` (per-faction with attitude-matrix propagation), `tiered` (ordered tier ladder with per-transition `ICondition` gates), `vector` (N independent dims per actor, CDDA-style opinion), `flag` (named booleans per actor, Exult-style). Each variation lives in its own factory under `src/systems/relationship-variants/` and can be reached directly when category dispatch is overkill.

Cross-cutting axes — decay rate, derivation function, propagation matrix, permanent/temporary split — are options on the variation defs, not separate primitives. This keeps the variation count finite (5) while letting each shape parameterize its own policy.

### When dialog and relationships connect

Both surfaces share the engine's existing condition/effect machinery. A dialog node gates on relationship state through the standard `StateCondition` path: `C.state('rel.npc-trust.mentor-rask.tier', 'gte', 2)`. A choice writes back through `E.state('rel.npc-trust.mentor-rask.tier', 'set', 3)`. The reserved path conventions are documented in `src/primitives/types.ts`.

Bespoke relationship-aware atoms (`C.relationship` / `E.relationship`) are intentionally **not** in the builder yet — single-game prevalence (CDDA's `n_npc_trust()` math-DSL is the sole canonical example) doesn't justify the API growth. The state-path encoding is the path until a second consumer needs the ergonomics. The relevant `TODO(expansion)` is co-located with the relationship category.

## Introspection

Harness-layer helpers walk the engine's auto-registered content and return sorted snapshots — one shape for modifiers, another for upcoming state transitions. All read opt-in injection keys (`CategoriesKey`, `ChainRegistryKey`, `EffectSystemRegistryKey`), so there's no install-time coupling: a devtools panel, a balance probe, or a UI hint can call them against a running engine without being wired into its module graph.

### Modifier discovery

`createPickerSnapshot(engine)` — returns `{ all, content, chains, categories }`, deduplicated by `Modifier` object identity. Use to enumerate every live modifier the engine has attached, with attribution back to its source (content-registered bindings, `chain.bind` calls, category auto-registration). Built fresh on each call; no reactive subscription, no internal cache.

### Pending-transition discovery — two tiers

The walker family answers "what changes next?" — pending state transitions across challenges, purchasables, and producers, with a `TransitionDistance` per emission. The canonical engine-internal consumers are `eventDrivenProbe` (event-stepping headless sim) and `stasisAwareTickProbe` (run-until-stasis predicate). Broader external adoption — devtools panels, UI unlock hints, tutorial reachability, mod-QA — is the target of the parked `InfeasibilityOracle` candidate (see `docs/candidate-primitives.md`), which would compose the walker with rate and input checks under a budget-bounded "can this predicate still fire?" surface.

Two adoption shapes, picked by the consumer's recomputation cadence:

- **One-shot snapshot** — `createTransitionSnapshot(engine, accessor)`. Returns `{ all, challenges, purchasables, producers }`, sorted by `distance.seconds` (finite ascending, null last, tie-broken by label). Each entry carries `{ source, kind, categoryId, entityId, currentValue, distance, label }`. Cheap to rebuild from scratch; no internal state. The right shape for one-shot predicates ("any reachable transitions?"), batch probes, and any caller that recomputes on a coarse cadence. Stasis analyzers use this tier.
- **Incremental cache** — `createIncrementalSnapshot(engine, accessor)`. Builds a cached snapshot plus per-label `TransitionDeps` reverse-indexed by resource / rate / unlock / state-path. Consumers signal dirty axes via `invalidateResource`/`invalidateRate`/`invalidateUnlock`/`invalidateState` and call `rebuild()`; the cache re-emits only the affected entries. `invalidateAll()` forces a full re-walk and is required after entity-set mutations (registry patches, new categories) — the entity set is frozen per instance. The right shape for event-stepping probes that rebuild per simulated event. `eventDrivenProbe` uses this tier.

Null `distance.seconds` is intentional and consumer-interpreted: a stasis analyzer treats it as "cannot rule out this transition"; a countdown UI hides null rows entirely. The walker never makes that policy call.

The one-shot snapshot is built fresh on each call. The incremental cache holds state but only between explicit `rebuild()` calls — neither subscribes to reactive changes; consumers drive recomputation cadence themselves.

## When the engine should grow

The engine evolves as consumers use it. Two signals:

**`TODO(ergonomics)`** — a working but verbose path. When two independent consumers build the same wrapper around the same ceremony, that's the signal to promote it to engine sugar. One consumer's wrapper is a game-side helper; two is a missing engine primitive.

**The 10% threshold** — the data-driven escape hatch (level 4) is designed for the ~10% of game logic that a generic engine can't express in typed systems. If your game is spending more than 10% of its module code in `ICondition`/`C`/`GameStateAccessor` territory, that's a signal: either the engine needs a new typed system for the pattern you're expressing, or the existing system needs a higher-level entry point. File a research ticket, not a workaround.

The test from [CLAUDE.md](../CLAUDE.md): if you'd copy-paste the same wiring between two different games, it belongs in the engine. If it only makes sense for one game's design, it stays game-side. If it has no opinion about game design at all, it's core.
