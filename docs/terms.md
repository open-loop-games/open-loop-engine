# Terms

The engine's controlled vocabulary. Each term has one meaning, and each meaning has one term. A word in the "not" column is retired in that meaning. Read the family for a word before you write engine text that uses it.

## Scope

The list governs the engine's own text:

- `AGENTS.md`, `README.md` and `docs/*.md`;
- TSDoc, and through it the generated `docs/api/`;
- runtime messages: errors, warnings and dev-mode text;
- the hand-written strings of the doc generators;
- the `BREAKING CHANGE:` footer of a commit, because the changelog publishes it verbatim.

The rest of a commit message, old `CHANGELOG.md` entries, code spans, fenced blocks and quoted source are outside it.

## Rules

1. **One word, one meaning. One meaning, one word.** Use a listed term only in its listed sense. Do not use a retired word in its retired sense.
2. **Sentence limits.** An instruction has at most 20 words. A description has at most 25. Write one instruction per sentence; a list counts as one.
3. **Literal verbs.** Write "is in", not "lives in"; "contains", not "carries"; "is committed", not "lands".

Four rules decide how a word is placed:

- **A technical sense of a common word takes its qualified form.** The bare word keeps its everyday sense: "reset scope", "persistent context".
- **An API name and its prose term are one word.** Prose uses the API's word for the API's concept.
- **A game's own word** in an example keeps that game's sense.
- **An external vocabulary keeps its owner's sense,** qualified where it could be misread. The external vocabularies are Vue, break_eternity, TypeScript and JavaScript, npm, graph theory, and calculus and numerics: "Vue effect scope", "break_eternity layer".

Text that restates another project's vocabulary uses that project's words. A word this list lacks is added here before engine text uses it.

## Families

Each sense has a stable ID: two letters for the family and a number.

### CS — persistent context, scope, module

| ID | term | meaning | not |
|---|---|---|---|
| CS1 | **persistent context** | the named prefix a ref's save key starts with. The engine opens one per module, category entry and system (`withPersistentContext`) | bare "context", persistence context, save context, sub-context, persistence ID, scope, module scope, ambient context |
| CS2 | **child / enclosing persistent context** | a persistent context opened inside another; the one open now | outer context, current context |
| CS3 | **persistence namespace** | the per-engine-instance prefix on every persistent context id | bare "namespace", engine namespace, bucket |
| CS4 | **ambient value** | a value the engine sets for the length of a call, mostly `install` and `connect`, read without a parameter: ambient accessor, ambient Gate services | ambient scope, ambient context, ambient slot, ambient target, ambient triple, "the ambient" |
| CS5 | **engine context** | the object a module's `install` and `connect` receive (`EngineContext`) | module context |
| CS6 | **context** | everyday: the inputs bundled for one call (`RunContext`, `UntilContext`) | — |
| CS7 | **annotations** | the notes a consumer attaches to the running cycle, captured into its log entry (`CycleLog.annotate`) | context |
| CS8 | **reset scope** | the set of persistent refs a reset writes (`ResetScope`) | bare "scope" |
| CS9 | **graph scope** | the nested child graph a scope stack has entered (`ScopeStack`) | bare "scope" outside scope-stack text |
| CS10 | **scoped override** | a set of overrides pushed onto an override registry and removed by the cleanup it returns. The verbs are push overrides and pop overrides | override scope, scope, override layer |
| CS11 | **Vue effect scope** | Vue's effect scope (external) | bare "effect scope", bare "scope" |
| CS12 | **module** | an `EngineModule`: the consumer-provided unit of game content | engine module (except as the type name) |
| CS13 | **file**, **ES module** | a source file; the JavaScript module sense | module, for a file |
| CS14 | **install**, **install/connect** | a module's `install` phase; the start-up window of both phases | install for adding a watcher or a callback; install-time |
| CS15 | **owner** | the def, module, category, node or object a thing belongs to | — |
| CS16 | **unowned** | a persistent ref whose object was disposed. It keeps saving, and the next ref with its id in its persistent context takes it over (`disownPersistent`) | released, orphaned |
| CS17 | **take over** | a ref given an unowned ref's id takes its value, and the unowned ref is deleted | adopt, reclaim, inherit |

"Scope" has two engine senses, CS8 and CS9, and they never share a subsystem.

### PD — predicates

| ID | term | meaning | not |
|---|---|---|---|
| PD1 | **Gate** | the typed, serializable yes/no test with a `kind` field. Always capitalized | lowercase "gate", predicate spec |
| PD2 | **Predicate** | any yes/no test form: a boolean, a ref, a getter or a Gate (`Predicate`) | — |
| PD3 | **predicate field** | a def field typed `Predicate` | requirement-bearing field, gating field |
| PD4 | **predicate** | plain: any test that returns a boolean | — |
| PD5 | **requirement** | a `Requirement`: an object with a met state and an optional payment | requirement, for any test that is not a `Requirement` |
| PD6 | **met** | a requirement's satisfied state | met |
| PD7 | **condition IR** | the internal serializable test `ICondition` | bare "condition" for it |
| PD8 | **condition** | plain: a state of affairs that holds or not | — |
| PD9 | **holds**, **flips** | a predicate is true; a predicate's truth value changes | fires, lands, trips (for a predicate) |
| PD10 | **evaluate** | compute a predicate's truth now | resolve (for a predicate) |
| PD11 | **adopt** | a system takes an authored predicate field at register time and returns its live form | lower |
| PD12 | **transition**, **transition distance** | a pending state change the predictor measures; the seconds until one | pending state change; bare "distance" for it |
| PD13 | **block** | the verb for holding something back on a test | gate (verb), gated, gating |
| PD14 | **combinator** | a node that combines child tests: `all`, `any`, `not` | and / or as combinator names |
| PD15 | **type guard**, **guard** | TypeScript's type guard; plain: a check that stops a mistake | — |
| PD16 | **goal** | the predicate that completes a challenge or earns an achievement; also a goal picker's objective | requirement (for an achievement's test) |
| PD17 | **activation**, **deactivation** | a predicate's change to true; its change to false | rising edge, falling edge, edge-triggered |

### PO — position and rank

| ID | term | meaning | not |
|---|---|---|---|
| PO1 | **automation tier** | one level of `AutomationTiers`, an ordered unlock of automation features | bare "tier", automation level |
| PO2 | **API tier** | one file of `docs/api/` | bare "tier", landing page |
| PO3 | **cascade tier** | a producer's position in a production cascade | upstream tier, next-tier |
| PO4 | **ladder**, **rung** | an authored ordered sequence of gated states; one position on it. An achievement ladder and a ladder field are ladders | tier, tiered, tier ladder, tier field |
| PO5 | **level** | a skill's level, a whole number derived from XP | level, for a purchasable's count (→ QT2) |
| PO6 | **abstraction level** | one of the L1–L4 levels of engine use | front door and escape hatch as level names |
| PO7 | **source layer** | one of the four `src/` directories: primitives, core, systems, harness. Consumer modules sit above the engine | bare "layer", five layers |
| PO8 | **break_eternity layer** | a `Decimal`'s representation level (external) | bare "layer" near PO7 |
| PO9 | **prestige layer** | a reset boundary of a game (game) | prestige tier |
| PO10 | **tick phase** | a TickDriver named phase with enter, exit and tick handlers | bare "phase" for it |
| PO11 | **emit depth**, **scope depth** | the nesting count of re-entrant emits; the number of graph scopes a scope stack has entered (`ScopeStack.depth`) | level, for a scope stack entry |
| PO12 | **rank**, **priority** | to order candidates by a comparator; higher is picked first | tier, for a rank |
| PO13 | **step** | everyday; also a pool run's step, a curve step and a migration step | step, for a tick (→ TM1) |

A loose "tier" or "layer" takes an everyday word: sort rank, test suite, "by audience", "built on".

### RN — runs, cycles and resets

| ID | term | meaning | not |
|---|---|---|---|
| RN1 | **run** | the play between two resets | cycle (for one period), loop, loop run, cycle run, a prestige, turn |
| RN2 | **cycle** | the repeating structure of runs: a run, a reset, the next run (`Cycle`) | — |
| RN3 | **pool run**, **run pool** | one member of a `RunPool`; the collection itself | instance; bare "pool" for a run pool |
| RN4 | **headless run** | one engine execution from build to termination: one cell and seed | sim run, probe run, sensitivity run |
| RN5 | **resume** | start a cycle's ticking again (`Cycle.resume()`) | run() |
| RN6 | **end** | the end of a run: its events are `beforeEnd`, `afterEnd`, `onBeforeEnd`, `onEnd` | restart sequence, loop restart |
| RN7 | **reset** | the mechanic and event that clears a reset scope, with retention. A `reset()` method is the everyday verb | — |
| RN8 | **hard reset** | a reset that also names lifetime refs | hard wipe |
| RN9 | **prestige**, **prestige currency** | the mechanic of a reset for a currency; the currency it pays | a prestige, for a run or an event |
| RN10 | **play session** | one continuous sitting, from launch to close | bare "session", intra-session |
| RN11 | **dialog session**, **agent session** | the envelope over one dialog adapter; a model session that reads the engine | bare "session" |
| RN12 | **challenge** | the `Challenge` system and its entry; "while a challenge is entered" | challenge run |
| RN13 | **arc** | the designed progression a probe plays, start to end | — |
| RN14 | **first launch** | a start with no save | first run |
| RN15 | **completion** | one completion of a timed progress | completion cycle, full run |
| RN16 | **pick** | one call of a picker | pick cycle, evaluation cycle |
| RN17 | **game loop**, **loop** | the TickDriver's per-tick loop; a code loop | loop, for a run |
| RN18 | **balance loop** | the spine, build, run, diff, decide process | the loop, the workbench cycle |
| RN19 | **dependency cycle**, **import cycle** | a cycle in a graph | bare "cycle" for it |
| RN20 | **phase** | a stretch of a run that a game's own value names, such as build or wave | tick phase, for it; stage |

### SV — saving and loading

| ID | term | meaning | not |
|---|---|---|---|
| SV1 | **save** | the stored game a slot holds; to write live state to a slot | — |
| SV2 | **save text** | one save as a string (`saveText`, `exportSave`) | save blob, save string, envelope JSON |
| SV3 | **envelope**, **save data** | the versioned wrapper a slot stores; the tree of ref values inside it | save object |
| SV4 | **load** | apply a save to live state, by any entry point | hydrate, for the load |
| SV5 | **serialize**, **serialized form** | encode as plain data; an object's plain-data form, typed `Serialized<Name>`, which `serialize()` produces and `restore(x)` writes back | snapshot, for this sense; export state, import state |
| SV6 | **snapshot** | a copy taken at one moment: a non-reactive read, a captured copy, a balance-harness view | snapshot, for a serialized form |
| SV7 | **hydration**, **hydrate** | the rebuild of live state from persistent refs, once a load's or a reset's writes settle | reconcile, rehydrate, load reconstruction, resync |
| SV8 | **revive** | decode one save leaf against its ref's default | rehydrate, for a leaf |
| SV9 | **settle**, **settle guard** | the end of a load's or a reset's writes; the hold that keeps those writes out of lifetime refs such as `cumulative` and `best` | load guard |
| SV10 | **save migration**, **API migration** | a step from save version N to N+1; the consumer code change a breaking release needs | bare "migration" |
| SV11 | **save version**, **engine save version**, **format version** | the consumer's save-format number; the engine's; a serialized form's own schema number. A version ref is ST10 | bare "version", game version |
| SV12 | **game build**, **writing build**, **loading build** | the shipped code of a game; the build that wrote a save; the build that loads it | saving build |
| SV13 | **checkpoint** | save text plus RNG state, taken before an advance so a bisection can replay it | save checkpoint |

### LT — what survives

| ID | term | meaning | not |
|---|---|---|---|
| LT1 | **persistent**, **persistent ref** | saved and loaded; a ref the save manager saves and loads. A field backed by one is "saved" | persistent, for anything not saved |
| LT2 | **persistence** | the save subsystem as a feature | — |
| LT3 | **persistent alias** | a write-through view of a persistent ref that the save walk skips (`PersistentAlias`) | non-persistent wrapper |
| LT4 | **ephemeral** | not saved: it starts at its default on every load | runtime-only, session-only, transient, not persisted, non-persistent |
| LT5 | **lifetime** | a persistent ref a reset leaves alone unless the reset names it. A value "survives a reset". Its opposite is run state | permanent, cross-run, outlives, carries over, preserved |
| LT6 | **keep**, **retain**, **retention** | one reset's options to keep a value through it verbatim, or transformed; both together (`createRetention`) | retention policy |
| LT7 | **retention factor**, **decay** | an influence layer's fraction kept per tick (`retentionFactor`); a fraction lost over time | decay or bare retention, for a kept fraction; evaporate |
| LT8 | **best** | a resource's high-water mark (`Resource.best`), or a best-of record | — |
| LT9 | **since reset** | a resource's gain since the last reset whose scope contains it (`Resource.sinceReset`). Run state: the per-run counterpart of `cumulative` | — |
| LT10 | **tracker** | a resource ref that a watch on its amount keeps current: `cumulative`, `best`, `sinceReset` | tracker, for a BestOf or a timed progress |

### VC — values and their changes

| ID | term | meaning | not |
|---|---|---|---|
| VC1 | **effect** | a declarative state write: the `IEffect` AST that `E` builds | state-mutation AST, as a name |
| VC2 | **temporary effect**, **conditional effect**, **effect system** | a timed entry, or one held while a predicate holds, that binds its grants; either system | persistent effect, status, bare "effect" for an entry |
| VC3 | **effect value** | the number a purchasable, achievement or automation tier yields | bonus value, reward value |
| VC4 | **Vue effect**, **side effect** | Vue's reactive effect; an action's incidental result | bare "effect" for these |
| VC5 | **modifier** | one apply/invert step on a value; a modifier's part of a value | contribution, link, registration, boost, buff. "Bonus" only in player-facing text |
| VC6 | **modifier chain**, **sequential modifier**, **op chain** | a `ModifierChain`; the composite `createSequentialModifier` returns; a formula's ops from its variable to its root | pipeline, calculation chain, stack |
| VC7 | **binding** | a modifier added by `chain.bind`, with its attribution record | binding, for an effect-system entry |
| VC8 | **grant**, **lowered grant** | an authored entry `{ chain, multiplier / add / exponent, when }`, sign-neutral; one grant an effect system places in a reserved chain slot | binding entry, declarative binding |
| VC9 | **multiplier**, **cost ratio** | a multiplicative factor; the factor each purchase multiplies the next cost by | multiplier, for a cost ratio |
| VC10 | **apply** | with its object: apply a modifier, an effect, a recommendation | apply, for starting an effect |
| VC11 | **activate**, **deactivate**, **expire**, **dispel** | an effect starts or ends; a temporary effect runs out, or is removed early | applied, onActivate |
| VC12 | **composite** | a node that combines children in order | — |

### RX — replacing and extending

| ID | term | meaning | not |
|---|---|---|---|
| RX1 | **loadout** | the `Loadout` selection system: a capacity of chosen items | slot, for a loadout |
| RX2 | **slot** | a save slot, or a position in a modifier chain | slot, for a loadout or an auto-purchase turn |
| RX3 | **mod** | a whole-game ruleset (`ModDef`) | mod, for an add-on; game variant |
| RX4 | **wrap** | a modifier wrapped around a chain entry (`BindingSlots.wrap`) | overlay, wrapped form |
| RX5 | **patch**, **pushed patch**, **update** | a content registry's field merge; a set of patches that `pushPatches` adds and its cleanup removes; a sequencer item's replacement (`updateItem`) | patch, for a replacement; scoped override, for a pushed patch |
| RX6 | **override** | an override registry's replacement of a named function; scoped overrides are CS10 | takeover, swap, substitution |
| RX7 | **ref default**, **option default**, **registry default** | a ref's start value; an option's value when absent; an override registry key's first implementation | bare "default" where two could be meant |
| RX8 | **perturbation** | the balance harness's change to one address, made by a wrap or a scoped override | — |

### CI — content items

| ID | term | meaning | not |
|---|---|---|---|
| CI1 | **def** | consumer-authored data for one item, which a category or system builds from | definition, content definition, entry, entity, item, member |
| CI2 | **definition** | everyday and mathematical | definition, for a def |
| CI3 | **category entry** | the record a category keeps per def: def, instance, def state and signals | entity, item, member, registered entry |
| CI4 | **instance** | the live object a category or system builds from one def | instance, for a pool run (→ RN3) |
| CI5 | **sequencer item**, **inventory**, **inventory item** | one element of a sequencer queue; the `Inventory` system; one kind of thing it holds | instance, for a queued action; inventory, for any full list |
| CI6 | **entry** | everyday: one element of a list, log or table | sequencer entry |
| CI7 | **content**, **content registry** | the game content a consumer supplies; a category's id-to-def store, with patching | content, for lowered grants |
| CI8 | **chain registry**, **effect-system registry**, **resource registry**, **flag registry**, **override registry**, **tuning registry**, **persistent-ref registry** | the per-engine registries, always qualified | bare "registry", global engine registry |
| CI9 | **category** | a batch-registration system for one kind of content | category system |
| CI10 | **Gate service**, **accessor services**, **handle** | a named engine service a Gate kind reads (`GateService`); the engine services an accessor factory receives (`AccessorServices`); an object returned to control one thing | handle, for a Gate service |
| CI11 | **subject**, **achievement**, **threshold** | a named thing in a subject category; an item earned once its goal holds; the value a tracked quantity must reach | entity (for a subject), milestone (for an achievement) |

### BB — the engine's building blocks

| ID | term | meaning | not |
|---|---|---|---|
| BB1 | **primitive**, **engine primitive** | an engine building block; the qualified form where the primitives layer could be meant | — |
| BB2 | **system** | a piece of the systems layer: a typed registration contract over core | registration surface; "X system" outside the systems layer |
| BB3 | **factory** | a `create*` function | — |
| BB4 | **utility**, **helper** | a public function; an internal one | helper, for a public function |
| BB5 | **surface** | a named noun only: API surface, instruction surface | surface (verb) |
| BB6 | **present**, **show** | hand to the UI; the prose verb for displaying | surface (verb), render |
| BB7 | **subpath**, **canonical entrypoint**, **root barrel**, **public function** | a package export; an entry of an API tier's Canonical entrypoints block; `src/index.ts`; any other | entry point, entrypoint (for a subpath or a function) |
| BB8 | **adapter**, **runtime** | the dialog contract (`DialogAdapter`); the JavaScript process | runtime, for an engine object |
| BB9 | **consumer** | any code that imports the engine, starter included | game author |
| BB10 | **engine**, **engine instance** | the package; one `Engine` object, where the package could be meant | — |
| BB11 | **mechanic** | a gameplay rule (`createReset` is the reset mechanic). The Mechanics API tier keeps its name | mechanics kernel |
| BB12 | **mechanism**, **substrate** | how code works; what a layer builds on | — |
| BB13 | **options**, **mapping** | a settings object a factory or run takes (`*Options`); what a `map*` callback returns where no factory options type exists (`*Mapping`) | config, spec, for a settings object |
| BB14 | **shape** | a design; a type's structural shape; a save shape | — |

A research pattern is cited by its roster handle, with no prevalence claim and no tier label.

### TM — time

| ID | term | meaning | not |
|---|---|---|---|
| TM1 | **tick** | one run of the tick handlers, with one dt, in either tick mode | step, sub-tick, sub-step, frame, pass, update |
| TM2 | **interval** | one timer firing of the live loop, which runs one or more ticks (`processInterval`); a throttle's gap between firings | interval tick |
| TM3 | **interval rate** | timer firings per second (`intervalRate`) | tick rate, TPS |
| TM4 | **iteration** | one pass of a balance-harness loop | tick, for an iteration; tick mode, for a run mode |
| TM5 | **advance time**, **advance** | feed seconds through the loop as ticks (`advanceTime`); bare: move a position (a cursor, a pointer, a rung) | advanceTime; offline processing, for the replay path |
| TM6 | **dt**, **raw dt**, **fixed dt** | the game seconds one tick advances; the wall-clock seconds one interval measured; the dt of every fixed-mode tick | elapsed time, delta, step size |
| TM7 | **game time**, **sim-time**, **sim-seconds**, **wall-clock time**, **play time** | seconds the engine simulated, scaled by game speed; game time in a balance-harness run, in sim-seconds; elapsed time on the system clock; how long the player has played | real, real time, simulated time, play-clock |
| TM8 | **offline** | time away: time the game was not running, replayed on return | absence, idle |
| TM9 | **rate** | a quantity's change per second: net rate, inflow rate, a converter's realized rate (`realizedRate`), a progress rate | speed (for progress), income, yield |
| TM10 | **game speed** | `TickDriver.speedMultiplier`, which scales dt in live play | boost, acceleration (as the setting's noun) |
| TM11 | **duration**, **needed** | seconds a thing lasts; the progress a timed progress needs to complete | duration, for progress |
| TM12 | **accumulator**, **accumulator skill** | a value ticks add to and a threshold drains; a skill whose lifetime bonus accumulates across runs | accumulator, for the category set (say collection) |
| TM13 | **animation frame** | one browser repaint, in which a drawing reads game state (`requestAnimationFrame`) | frame, tick (for it) |

### BH — the balance harness

| ID | term | meaning | not |
|---|---|---|---|
| BH1 | **harness**, **balance harness** | the `src/harness/` layer, the `/harness` subpath and the tooling on it; "balance harness" at a doc's first use | balance-sim, balance tooling, headless-sim substrate, sim, headless harness |
| BH2 | **agent harness** | the program that runs a model session | bare "harness" |
| BH3 | **probe**, **beat probe**, **waypoint probe** | a consumer's balance script; the balance harness's canned seed-sweep probes | instrument, harness, sim (for the script) |
| BH4 | **simulate**, **simulation** | advance an engine through given seconds; a design method against a closed form | sim, as a noun for a run |
| BH5 | **headless** | an adjective: with no browser or DOM | headless, as a name for the harness |
| BH6 | **balance workbench** | a consumer's interactive balance tool | sim workbench, sim picker, balance panel |
| BH7 | **runner**, **analyzer** | a function that drives headless runs; an observer of one headless run that collects metrics | tracker, for an analyzer |
| BH8 | **transition walker**, **discovery walker**, **walk** | the walkers over challenges, purchasables and producers; the picker's walkers over lowered grants, chains and tunables; everyday traversal | content walker |
| BH9 | **picker** | the balance harness's enumeration of perturbable addresses; a goal picker is always qualified | — |
| BH10 | **sweep**, **matrix** | a set of runs over cells and seeds; its `cells × seeds` shape | batch |
| BH11 | **cell**, **variant**, **baseline**, **sweep axis** | one named configuration in a matrix ("matrix cell" beside grids); a named change to the baseline cell; the reference cell; one dimension a sweep varies | config, for a cell; param axis |
| BH12 | **beat**, **fire time**, **termination time** | a designed progression moment; the sim-time a beat is reached; the sim-time a run's until-predicate ends it | beat time, for a fire time |
| BH13 | **beat time** | the seconds to earn the next purchase. Never shortened | beat duration, bare "beat" |
| BH14 | **attempt** | one firing of an auto-purchase interval | beat |
| BH15 | **payback period**, **flow channel**, **tolerance band** | cost over the rate one more unit adds; one of six engagement classes (external); a range around a measured value | payback, for beat time; band, for a flow channel |
| BH16 | **tunable**, **balance constant**, **authored parameter** | a value declared through `tunable()`; any design number; an automated player's stated-intent parameter | knob, lever, dial |
| BH17 | **spine**, **fixture**, **scratch engine** | the closed form behind each constant; a stored content set or starting state with a known outcome; an isolated engine for one run or prediction | spec (for the spine), scenario; sensitivity-fork, forkable instance |

### AC — actors and choices

| ID | term | meaning | not |
|---|---|---|---|
| AC1 | **policy**, **selection policy** | a decision rule: a function over game state that returns a choice; `SelectionPolicy` | policy, for the actor, a keep list or an enum |
| AC2 | **automated player** | the actor that plays the game for a probe | agent, bot, policy agent, the automation |
| AC3 | **agent** | a model session | agent, for any actor in a game |
| AC4 | **AI opponent**, **unit** | an in-game opponent; something that moves on a map | agent, bot |
| AC5 | **persona** | one objective or parameter variant of a shared decision procedure | personality |
| AC6 | **player** | the person who plays the shipped game | player, for the automated player |
| AC7 | **automation**, **auto-purchase** | the mechanic in which the game decides for the player; automation that buys | auto-buy, autobuy, auto-buyer |
| AC8 | **fill strategy** | the sequencer's stateful next-item chooser. "Strategy" has no other engine sense; game theory's is qualified | strategy, for a def, a configuration, a pay function or a solver |
| AC9 | **recommender** | a registered behavior object that scores and proposes (`Recommender`) | def, strategy |
| AC10 | **advisor**, **recommendation**, **suggestion** | the decision-support family; the recommendation system's winning proposal; one entry of a rule advisor's ranked list | suggestion, for a recommendation |
| AC11 | **configuration** | the game configuration a recommendation captures and replays (`captureConfig`, `configSnapshot`) | strategy, strategy snapshot |
| AC12 | **candidate**, **incumbent**, **winner**, **selection**, **candidate pool** | an item a chooser considers; best-of's stored best; the chosen candidate; the act of choosing, or a loadout's held set; the eligible set | chosen (noun) |
| AC13 | **death disposition** | a run pool's default for a run whose step ended | death policy |
| AC14 | **worker**, **Web Worker** | an in-game unit that claims tasks; a compute thread (external) | worker pool, for compute; pool, for a store of XP |

### QT — quantities and limits

| ID | term | meaning | not |
|---|---|---|---|
| QT1 | **amount** | a quantity of a resource, held or moved (`getAmount`) | balance, holdings, stock, funds, wallet, bank |
| QT2 | **count**, **purchase count**, **bulk count**, **effective count** | how many; how many of an entry the player owns; how many units one purchase takes; a producer's owned count plus its extra count | amount, level, number of purchases (for these) |
| QT3 | **cost**, **costlier** | what a purchase or action spends, noun and verb; costing more | price, priced, charge; dear, dearer, dearest |
| QT4 | **traversal cost** | the cost to enter a grid cell (external, pathfinding) | bare "cost" outside spatial text |
| QT5 | **affordable** | a cost the resource's amount covers | payable |
| QT6 | **reserve** | an amount an auto-purchase leaves unspent | floor, spending floor |
| QT7 | **limit**, **capacity**, **cap**, **budget** | the most times an entry is bought or completed; the most a container holds; a runtime safety maximum; an allowance a search spends | ceiling, for a hard limit |
| QT8 | **lower bound**, **upper bound**, **representation floor**, **representation ceiling** | the ends of a search domain; where `Decimal` precision gives out | domain floor, bare "floor" |
| QT9 | **clamp**, **overflow** | hold a value at a cap or capacity; the excess past one | overspill |
| QT10 | **resource**, **currency** | a `Resource`; a resource the player spends | currency, for any resource |
| QT11 | **total rate** | a producer category's aggregate production rate (`getTotalRate`) | headline rate |
| QT12 | **threshold** | the number a Gate compares against, held in its `value` field | — |
| QT13 | **balance** | the design sense only: tuning an economy | balance, for a held amount |

### ID — identity

| ID | term | meaning | not |
|---|---|---|---|
| ID1 | **id** | the stable identity a consumer or system chooses, unique in a stated scope. Spelled "id" in prose | ID, identifier, name (for identity), key (for identity) |
| ID2 | **display name** | the text a player sees for a thing (`displayName`) | name, for display text |
| ID3 | **save key**, **save path** | a value's full stored name, `${contextId}.${refId}`; its segments | save name |
| ID4 | **injection key** | a typed symbol for `provide` and `inject` | discovery key |
| ID5 | **key**, **tuning key**, **metric key** | a key of a map or record (the JavaScript sense); an override or tuning registry entry; a metric's name | — |
| ID6 | **state path** | a dot-path into consumer game state (`path`) | key, target (for a state path) |
| ID7 | **discriminant** | the tag field of a tagged union. A tag that names only the variant is `kind` | type (as a tag field), discriminator, kind tag |
| ID8 | **mode** | one of a fixed set of behaviors an option selects, named with its owner: tick mode, run mode | mode, where no `mode` field makes the choice |
| ID9 | **schema field**, **field** | a typed slot in a subject category's schema; a JavaScript property | — |
| ID10 | **tag** | a free-form string for filtering; qualified: TSDoc tag, release tag | kind tag |
| ID11 | **description**, **attribution text** | display text; the string a binding id is derived from (`BindOptions.text`) | description, for attribution text |
| ID12 | **leaf**, **cluster**, **histogram bucket**, **item type** | a tree's terminal node; the doc generator's group of source files; a histogram bin; the kind of item a resource bag holds | type ID |

### SG — events and handlers

| ID | term | meaning | not |
|---|---|---|---|
| SG1 | **event** | what an `*Events` map names and an emitter sends | signal, for a pushed notification |
| SG2 | **handler** | any registered or subscribed function (`TickHandler`, `on(name, handler)`) | callback, listener, subscriber, hook |
| SG3 | **option callback** | an `onX` field of an options object | hook |
| SG4 | **signal** | a category entry's reactive value, read on demand (`CategoryEntrySignals`) | — |
| SG5 | **emit** | send an event | emit, for returning a list |

"Hook" appears only as a git hook or a Vue lifecycle hook, qualified.

### AV — availability

| ID | term | meaning | not |
|---|---|---|---|
| AV1 | **flag**, **saved flag**, **derived flag** | a named boolean in the flag registry (`createFlag`), read by `getFlag` and `FlagGate`; one the game sets, saved; one read-only over game state | unlock flag |
| AV2 | **active** | a category entry is on, or a binding or effect is in force (`ActiveGate`) | owned, unlocked (for the entry signal) |
| AV3 | **entered**, **current** | a challenge's state while it runs; the selected one of a category or container | active, for these |
| AV4 | **unlock** | content becomes available; a system's unlock set and the act of adding to it | — |
| AV5 | **enabled** | a switch someone sets, against active, a state the game derives | — |
| AV6 | **visible**, **hidden** | shown to the player; an achievement shown concealed until earned | hidden, for `visible: false` |
| AV7 | **maxed**, **earned**, **alive**, **running**, **latch** | at its limit; attained; a pool run not destroyed or parked; a clock going; a one-way flip set once | — |

### ST — state and reactivity

| ID | term | meaning | not |
|---|---|---|---|
| ST1 | **game state** | everything the game-state accessor reads | bare "state" for it, engine state, host state |
| ST2 | **def state** | the persistent refs a category builds beside each def's instance (`DefState`) | per-instance state, per-def state, extra state |
| ST3 | **serializable value** | what a persistent ref may hold (`Serializable`) | state, for the type |
| ST4 | **status** | the current member of a small set: an item status, a scope status | state, for a phase value |
| ST5 | **live state** | the in-memory values a save is written from and loaded into | runtime state, current state |
| ST6 | **state** | everyday: what an object keeps between calls | — |
| ST7 | **stateless** | keeps no data between calls | stateless, for "saves nothing" |
| ST8 | **game-state accessor**, **accessor**, **mutator** | the object that reads and writes game state, which a consumer supplies or `createGameStateAccessor` builds (`GameStateAccessorMutator`). Its read side is `GameStateAccessor`; its write side is the mutator (`GameStateMutator`) | accessor, for any read method |
| ST9 | **view** | a read-only interface over an object (`InfluenceLayerView`) | reader, for an interface |
| ST10 | **ref**, **version ref**, **backing ref** | a Vue ref (external); a counter every mutation bumps; the inner ref behind a persistent ref | state ref |
| ST11 | **reactive** | tracked by Vue: a `computed` over it recomputes when it changes | live, dynamic (for this sense) |
| ST12 | **live** | everyday: running now, in live play | live, for reactive |
| ST13 | **Computable**, **getter**, **property getter** | a value, a ref or a getter; a zero-argument function; a TypeScript `get` property | `MaybeGetter`, a hand-written `T \| (() => T)`, for a Computable |
| ST14 | **stale**, **invalidate** | marked out of date; mark it so | — |

### DS — display and formatting

| ID | term | meaning | not |
|---|---|---|---|
| DS1 | **format** | the one formatter verb (`formatResource`) | display, as a formatter verb |
| DS2 | **notation**, **regular format**, **save format** | the number style (external); its default style; a stored layout | notation format |
| DS3 | **display**, **effect description** | a def's display-text bundle; the text that describes an effect value | effect display |
| DS4 | **label** | a display-only string on a harness row, a profiler entry or a rate source (`text`) | label, for a unique key |
| DS5 | **decimals**, **sig figs**, **precision** | decimal places; significant figures; numerical precision only (external) | precision, for decimal places or significant figures |
| DS6 | **compact**, **small** | an achievement's smaller card; a resource's display of tiny values | small, for a card size |

### SP — spatial and graphs

| ID | term | meaning | not |
|---|---|---|---|
| SP1 | **grid**, **board** | the bounded 2D cell container (`SpatialGrid`); the game's play space a grid stores | board, for the container; map, for the play space |
| SP2 | **graph** | keyed nodes and edges with nested child graphs (`Graph`), in graph theory's sense | spatial graph |
| SP3 | **dialog graph** | one authored conversation | conversation tree |
| SP4 | **node**, **edge** | a graph node or a dialog node; a graph edge, or a histogram bucket edge | edge, for a predicate change (→ PD17) |
| SP5 | **neighborhood**, **adjacency** | the offset set that decides which cells are neighbors; the neighbor relation, and the game mechanic | delta set, topology (for the offset set) |
| SP6 | **offset** | a 2D integer step from a cell (`GridOffset`) | delta, for an offset |
| SP7 | **radius**, **range** | the half-width of a Chebyshev square around a cell; that square | region, box, bounding box |
| SP8 | **influence layer**, **influence**, **influence source** | the object that propagates numbers over a grid; the number at a cell; an emitter | influence map, field |
| SP9 | **source** | an input form accepted where an X is read (`FormulaSource`, `CapacitySource`) | source, for provenance (→ BH8's walkers) |
| SP10 | **card** | the UI item that shows one achievement or purchasable | tile |
| SP11 | **fall-through node** | a dialog node with `fallThrough` set. With no visible choice, it runs `onEnter` and enters `next` without presenting | skip node, silent node |

### LV — lifecycle verbs

| ID | term | meaning | not |
|---|---|---|---|
| LV1 | **start**, **enter**, **exit** | begin an activity that later ends; enter or leave a mode that is later left (`canEnter`) | dispatch, for a start; run, for a start |
| LV2 | **complete**, **finish**, **end**, **finalize**, **terminal** | reach the natural end; a dialog's; a run's; a cycle-log entry's; a dialog line with no way on | finished, as a flag |
| LV3 | **cancel**, **dismiss** | end early, without completing; set a suggestion aside | abandon |
| LV4 | **stop**, **pause**, **resume** | suspend the tick clock; suspend a system's own flag; restart it | halt, freeze |
| LV5 | **dispose**, **teardown** | end an object's runtime wiring; the balance harness's `teardown` option callback. An object's `dispose()` leaves its saved refs unowned. `engine.dispose()` deletes its persistent contexts instead | tear down, detach, release, drop, evict, stop (for dispose) |
| LV6 | **cleanup**, **unsubscribe** | the undo function a push, add or bind returns; the one an `on()` returns | disposer |
| LV7 | **release** | give up a reservation or a protection | release, for saved refs |
| LV8 | **remove**, **clear**, **deselect** | take one entry out of a collection; take all out; take a loadout item out | drop, for remove |
| LV9 | **delete** | erase from the save registry or save storage | clear, drop (for saved refs) |
| LV10 | **discard**, **destroy**, **die** | drop what exceeds a capacity; a pool run leaves its pool; the event for that | destroy, for overflow; truncate |
| LV11 | **dispatch** | route by a discriminant (programming) | dispatch, for a sequencer start |

### RF — resource flow

| ID | term | meaning | not |
|---|---|---|---|
| RF1 | **time bank** | the store of banked seconds (`createTimeBank`) | reservoir (for it), pool, stored time, bare "bank" |
| RF2 | **deposit**, **withdraw**, **spend**, **burst discharge** | put seconds in; take seconds out; take them out to accelerate play; replay many at once | drain, charge, pay (for seconds) |
| RF3 | **pay** | spend a cost (`resourcePaidAt`) | consume, charge |
| RF4 | **add**, **subtract**, **transfer** | raise and lower a resource's amount; move amounts between bags | remove, drain, decrease (for a resource) |
| RF5 | **purchase**, **purchase max**, **bulk purchase** | the one buying word; purchase as many as are affordable; purchase several at once. A purchasable may purchase max by default (`purchaseMaxByDefault`) | buy, buy-max, max-buy |
| RF6 | **produce**, **production**, **producer** | a producer's output and the act; the engine's word for a generator | generator |
| RF7 | **gain**, **prestige gain** | any increase; the prestige currency a reset pays | gain, for a modifier's input (say value) |
| RF8 | **earn** | an achievement's attainment | earn, for a resource inflow |
| RF9 | **converter**, **bottleneck**, **Conversion** | a continuous producer that draws its `inputs` per unit of output, and makes less when one runs short; what held back its last tick (`Producer.bottleneck`); one atomic exchange that refuses a shortfall (`createConversion`) | converter, for a Conversion; limit, for a bottleneck |
| RF10 | **rate source** | one labeled rate per second on a resource; the resource's rate is the sum of its rate sources (`addRateSource`, `getRate`) | flow, income source, drain (for a negative one) |

### FM — formula math

| ID | term | meaning | not |
|---|---|---|---|
| FM1 | **cumulative**, **sum** | the continuous definite integral (`Formula.cumulative`); the discrete series of levels (`Formula.sum`, `sumLevels`) | integral, area, continuous integral (for cumulative); cumulative, for the sum |
| FM2 | **antiderivative** | the indefinite integral a formula evaluates (`evaluateAntiderivative`) | integral, for an antiderivative |
| FM3 | **series**, **time series** | a sum's graded result (`Series`); a per-tick sample list (`createTimeSeriesAnalyzer`) | series, for a time series |
| FM4 | **first passage**, **reached**, **crossing** | the smallest input that reaches a target; its verdict; a live comparison changing over time | crossed, for first passage |
| FM5 | **on-target**, **exact** | within a stated tolerance; exact arithmetic only | exact, for a tolerance verdict |
| FM6 | **graded result** | a value that carries its verdict and reason | diagnosed result, checked result |
| FM7 | **op**, **operation** | a node of a formula; a `Formula` method | — |
| FM8 | **curve**, **curve factory** | a built formula; a function that builds one from a ref | curve, for the factory |

Calculus and numerics words (image, pre-image, domain, bracket, tolerance) keep their mathematical sense, qualified by the function they belong to.

### ME — measurement

| ID | term | meaning | not |
|---|---|---|---|
| ME1 | **aggregate** | the balance harness's reduction of analyzer output across seeds | aggregate, for the rule advisor's history |
| ME2 | **digest**, **advisor analyzer** | the rule advisor's reduced history; a rule advisor function that reads it (`AdvisorAnalyzerFn`) | profile, aggregate (for it); bare "analyzer", for an advisor analyzer |
| ME3 | **profile**, **profiler** | time a call; the timing tool | profiling hook, for an observe-only callback |
| ME4 | **summary** | an analyzer's end-of-run output (`AnalyzerSummary`) | result, readout, measurements |
| ME5 | **safeguard diagnostics** | the engine's developer health counters | bare "diagnostics" |
| ME6 | **trace**, **attribution** | the trace that records chain evaluation; the record of which binding produced a value | trace, for attribution |
| ME7 | **tracked metric**, **analyzer metric** | a named quantity a cycle log tracks; a value an analyzer reports. Bare "metric" where only one is in reach | — |
| ME8 | **report**, **stats**, **tally** | a returned failure kind; descriptive statistics; a count kept over runs | report, for logging |

## Where the engine differs from nearby vocabularies

- **persistent** means saved. Some balance-design writing says "persists" for "survives a reset"; engine text says lifetime (LT5).
- **producer** is the engine's word for what some incremental-game math calls a generator (RF6).
- **cumulative** and **first passage** match incremental-game math (FM1, FM4).
- **mechanism** and **substrate** keep the engine's senses (BB12). Text that restates a game-design pattern library uses that library's words.
