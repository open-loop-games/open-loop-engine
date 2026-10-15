#!/usr/bin/env node
/**
 * Build the API tier files and INDEX.md from parser output and the API tier
 * manifest.
 *
 * Pipeline:
 *   1. `parse-dts.mjs` walks `dist/index.d.ts` → per-symbol records
 *   2. `api-tier-manifest.mjs` maps cluster ids → API tiers
 *   3. This script renders the API tier files + INDEX.md
 *
 * Writes:
 *   docs/api/{resources,mechanics,composition,content-systems,content-narrative,
 *             lifecycle,runtime,introspection,advisors,spatial,harness}.md
 *   docs/api/INDEX.md
 *
 * Quality gates:
 *   - Exits non-zero if any cluster is unassigned in the manifest
 *   - Exits non-zero if an INDEX API tier anchor names no emitted section
 *   - Warns on public symbols without a TSDoc summary
 *
 * Run: `node scripts/build-api-docs.mjs`
 */
import { writeFileSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { parseEntrypoint } from './parse-dts.mjs';
import { TIER_MANIFEST } from './lib/api-tier-manifest.mjs';
import { ROOT, CLUSTER_TITLES, parseFileHeader, titleCase } from './lib/source-meta.mjs';

const ENGINE_ROOT_DTS = join(ROOT, 'dist', 'index.d.ts');
const API_DIR = join(ROOT, 'docs', 'api');

const KIND_LABEL = {
  function: 'function',
  interface: 'interface',
  type: 'type',
  const: 'const',
  enum: 'enum',
  class: 'class',
  'abstract-class': 'abstract class',
};

/**
 * Decide which file in a cluster supplies the title/blurb. Prefer:
 *   1. The file whose stem matches the cluster id (`resource.ts` for cluster `resource`)
 *   2. A subdir `index.ts` if one exists among the cluster's files
 *   3. The first file alphabetically
 *
 * Within each step, when multiple candidates exist (e.g. a split cluster with
 * `primitives/x.ts` + `systems/x.ts` both stem-matching), prefer one whose
 * file-header TSDoc supplies a title or blurb — primitives files are often
 * pure types with no header, and falling through to them strips the section
 * of its blurb.
 */
function pickAnchorFile(clusterId, files) {
  const stemMatches = files.filter((f) => basename(f, '.ts') === clusterId);
  if (stemMatches.length > 0) {
    return preferFileWithHeader(stemMatches) ?? stemMatches[0];
  }
  const indexMatches = files.filter((f) => basename(f) === 'index.ts');
  if (indexMatches.length > 0) {
    return preferFileWithHeader(indexMatches) ?? indexMatches[0];
  }
  return preferFileWithHeader(files) ?? files[0];
}

/** Return the first file in `files` whose header has a title or blurb, or null. */
function preferFileWithHeader(files) {
  for (const f of files) {
    const abs = join(ROOT, f);
    if (!existsSync(abs)) continue;
    const header = parseFileHeader(abs);
    if (header.title || header.blurb) return f;
  }
  return null;
}

/**
 * Read cluster title + blurb + prologue + compact flag from CLUSTER_TITLES
 * (highest priority) or the anchor file's header. Falls back to
 * titleCase(clusterId) when neither source has a usable title. `prologue` and
 * `compact` are CLUSTER_TITLES-only — source headers don't carry them.
 */
function clusterMeta(clusterId, files) {
  const anchor = pickAnchorFile(clusterId, files);
  const abs = join(ROOT, anchor);
  const header = existsSync(abs) ? parseFileHeader(abs) : {};
  const override = CLUSTER_TITLES[clusterId] || {};
  const title = override.title || header.title || titleCase(clusterId);
  let blurb = override.blurb || header.blurb || null;
  if (blurb && blurb.toLowerCase() === title.toLowerCase()) blurb = null;
  const prologue = override.prologue || null;
  return { title, blurb, prologue, compact: override.compact === true, anchor };
}

/** Stable anchor slug for cross-file links. */
function slugify(s) {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Walk a signature and return its head — everything up to the first `{` at
 * top-level `< >` depth zero. Used to strip object-literal bodies from
 * interfaces, classes, and inline-shaped types while keeping the declaration's
 * generic params and `extends` / `implements` clauses intact.
 */
function headBeforeBrace(sig) {
  let depth = 0;
  for (let i = 0; i < sig.length; i++) {
    const c = sig[i];
    if (c === '<') depth++;
    else if (c === '>') depth--;
    else if (c === '{' && depth === 0) return sig.slice(0, i).trim();
  }
  return sig;
}

const TYPE_INLINE_MAX = 160;
const CONST_TYPE_INLINE_MAX = 80;

/**
 * Format a symbol's declaration for the directory bullet. Drops the
 * `export declare` modifiers (everything in `index.d.ts` has them) and
 * trims object-literal bodies from interfaces / classes / inline-shaped types
 * and consts — the full shape is at the linked `src/path:line`.
 *
 * - function: declaration head from `.d.ts` (already body-free)
 * - interface / class / abstract class: head before the first top-level `{`
 * - type alias: full when short, `type Name<T>` head when long
 * - const: `const Name: Type` when short and not an inline object; else `const Name`
 * - enum: `enum Name` only
 */
function formatSignature(rec) {
  let sig = rec.signature
    .replace(/^export\s+/, '')
    .replace(/^declare\s+/, '')
    .replace(/^default\s+/, '')
    .replace(/;$/, '')
    .trim();

  switch (rec.kind) {
    case 'interface':
    case 'class':
    case 'abstract-class':
      return headBeforeBrace(sig);
    case 'enum': {
      const m = sig.match(/^(enum\s+\w+)/);
      return m ? m[1] : sig;
    }
    case 'const': {
      // Externally-re-exported values may surface as `let` rather than `const`;
      // normalize either prefix to `const` so consumers see one shape.
      const m = sig.match(/^(?:const|let)\s+(\w+)\s*:\s*([\s\S]+)$/);
      if (!m) return sig;
      const [, name, rest] = m;
      const compact = rest.replace(/\s+/g, ' ');
      if (compact.length <= CONST_TYPE_INLINE_MAX && !compact.includes('{')) {
        return `const ${name}: ${compact}`;
      }
      return `const ${name}`;
    }
    case 'type': {
      if (sig.length <= TYPE_INLINE_MAX && !sig.includes('{')) return sig;
      const m = sig.match(/^(type\s+\w+(?:\s*<[^=]*?>)?)\s*=/);
      return m ? m[1].trim() : sig;
    }
    case 'function':
    default:
      return sig;
  }
}

/**
 * True when a summary only restates the symbol's own name — "Options for
 * createCycle." on `CreateCycleOptions`, "Result of validateSaveData." on
 * `ValidateSaveDataResult`. The bullet renders bare instead: the absence of
 * prose is itself the signal that the shape is the factory's options bag.
 * Harmless in IDE hover, pure noise in a scannable directory.
 */
function isTautologicalSummary(name, summary) {
  const m = summary.match(/^(?:Options for|Result of)\s+(.+?)\.?$/i);
  if (!m) return false;
  const norm = (s) =>
    s
      .toLowerCase()
      .replace(/\b(?:a|an|the)\b/g, '')
      .replace(/[^a-z]/g, '')
      .replace(/^creat(?:ing|e)/, '');
  return norm(m[1]) === norm(name.replace(/(?:Options|Result)$/, ''));
}

/**
 * Render one symbol bullet. Format:
 *   `{signature}` — {tsdocSummary}. `src/path:line`
 *
 * Signatures are trimmed to declaration heads — the source link points at the
 * body. See {@link formatSignature}.
 */
function renderSymbol(rec) {
  const loc = rec.line ? `${rec.sourcePath}:${rec.line}` : rec.sourcePath;
  const bare = `- \`${formatSignature(rec)}\` \`${loc}\``;
  // Overload continuations without their own TSDoc depend on the set's lead
  // declaration — render signature + source line only, no coverage marker.
  if (!rec.tsdocSummary && rec.overloadIndex > 0) return bare;
  if (rec.tsdocSummary && isTautologicalSummary(rec.name, rec.tsdocSummary)) return bare;
  const summary = rec.tsdocSummary
    ? rec.tsdocSummary.endsWith('.')
      ? rec.tsdocSummary
      : `${rec.tsdocSummary}.`
    : '_(no summary)_';
  return `- \`${formatSignature(rec)}\` — ${summary} \`${loc}\``;
}

/**
 * Render a cluster whose symbols are re-exported from a dependency (Vue's
 * reactivity API). Their signatures and docs belong to the upstream project —
 * reprinting them costs kilobytes and looks like engine API surface. Names only.
 */
function renderCompactCluster(recs) {
  return recs.map((r) => `\`${r.name}\``).join(' · ');
}

/** Group records by cluster id; preserve parser's stable sort within each. */
function bucketByCluster(records) {
  const out = new Map();
  for (const r of records) {
    if (!out.has(r.cluster)) out.set(r.cluster, []);
    out.get(r.cluster).push(r);
  }
  return out;
}

/** Render one API tier file's content. */
function renderTierFile(tier, byCluster) {
  const lines = [`# ${tier.title}`, '', tier.scope, ''];

  if (tier.entrypoints?.length) {
    lines.push('## Canonical entrypoints', '');
    for (const entry of tier.entrypoints) {
      lines.push(`- ${entry}`);
    }
    lines.push('');
  }

  for (const clusterId of tier.clusters) {
    const recs = byCluster.get(clusterId);
    if (!recs || recs.length === 0) {
      lines.push(`## ${titleCase(clusterId)}`, '', '_(no symbols)_', '');
      continue;
    }
    const files = [...new Set(recs.map((r) => r.sourcePath))].sort();
    const { title, blurb, prologue, compact } = clusterMeta(clusterId, files);
    lines.push(`## ${title}`);
    if (blurb) lines.push('', blurb);
    if (prologue) lines.push('', prologue);
    lines.push('');
    if (compact) lines.push(renderCompactCluster(recs));
    else for (const rec of recs) lines.push(renderSymbol(rec));
    lines.push('');
  }

  return lines.join('\n').replace(/\n+$/, '\n');
}

/**
 * INDEX.md content. Generator owns every line — static prose is inlined here,
 * and the API tier map renders from the API tier manifest + parsed cluster
 * output. Editing the rendered INDEX.md by hand is meaningless.
 */
function renderIndex(byCluster) {
  const lines = [
    '# API Index',
    '',
    "The router into the engine's per-symbol API surface. Symbols are grouped by adjacency, not by the vocabulary you arrived with. So route from your task, not from a grep for the name you brought. That keeps a reading failure from being reported as a missing primitive.",
    '',
    'Enter by **verb** (§ Task → API tier), by **noun-shape** (§ Concept index), or by **subsystem** (§ API tier map). Check § Reserved names before you grep a shared stem. Check § Predicate forms before you choose a predicate form. The prose companions say *how* to compose, not *what* exists. `../consumer-guide.md` is the main one. `../consumer-guide-choosing.md` covers two primitives that overlap, where a wrong pick raises no error. Entries link to them and do not restate them.',
    '',
    "Generated by `node scripts/build-api-docs.mjs`; hand edits are meaningless. Per-symbol detail is in the API tier files. Cluster ids come from `@cluster` TSDoc tags, and each cluster's API tier is one line in `scripts/lib/api-tier-manifest.mjs`.",
    '',
    '## Choose an abstraction level',
    '',
    'Start at the highest abstraction level that fits. Drop down only when it does not fit the shape of the game. Full prose: ../consumer-guide.md#the-expression-spectrum.',
    '',
    '| Abstraction level | Use | Start at |',
    '| --- | --- | --- |',
    '| **L1: Resource utilities** | `addResource` / `hasResource` / `formatResource`, `Resource.best` / `.cumulative` / `.sinceReset` — direct resource changes, formatting, lifetime and per-run gain | resources.md#resource |',
    '| **L2: Categories** | `createProducerCategory`, `createPurchasableCategory`, `createSkillCategory`, `createDialogCategory`, … — repeatable authored content, and the default for it | content-systems.md, content-narrative.md |',
    "| **L3: Raw primitives** | `createScalingPurchasable`, `createCycle`, `createModifierChain`, `createCategoryBase` — one-off mechanics, or registration shapes a category's mapping constrains | composition.md, mechanics.md, lifecycle.md |",
    '| **L4: Declarative data** | `Gate`, `E` / `IEffect` — Gates and effects as data, for JSON, mods, saves and the balance harness | mechanics.md#gate, mechanics.md#effects |',
    '',
    '## Reserved names',
    '',
    'A few symbols share a stem and are easy to confuse. Each links to its anchor:',
    '',
    "- **Cycle** — the repeating structure of runs: a run ends, its reset scope resets, and the next run starts. `createCycle`. → content-systems.md#cycle. It is named for the lifecycle, not a genre. A short run that a game repeats many times, a prestige layer's reincarnation and a new-game-plus all have the same shape. A cycle starts paused: `resume()` starts the first run, and `pause()` holds `elapsed` and the end check. `end()` resets at the run's end, then emits `afterEnd`, and the clock keeps running, so the next run starts at once. `elapsed` is the run's seconds, a saved ref that resets to 0 at each end. `count` and `bestTime` are saved too; `running` is not, so call `resume()` on load. For a run that stays on a results screen until the player restarts, call `pause()` in `afterEnd`. The screen reads what `onBeforeEnd` or a `CycleLog` entry captured, because the reset scope is already reset. A run can instead keep its end state live until the player starts the next one. That run resets on start: it is `createReset` plus a guarded `onTick`, not Cycle. Phases inside a run do not have Cycle's shape either (§ tick phase, below).",
    "- **CycleLog** — records each tracked metric's change across one run; observes a `Cycle`'s lifecycle. `createCycleLog`. → content-systems.md#cyclelog",
    '- **Challenge** — also a lifecycle with an entry, a goal and an exit, but it *enters a modified ruleset*; it does not replay with a reset. `createChallengeCategory`. → content-systems.md#challenge-category',
    "- **`createReset`** vs **`Cycle`** — `createReset` is the standalone reset mechanic (reset scope, retention, `canReset` predicate). `Cycle` drives one, and adds the run's timer, counter and restart cadence. `CycleOptions` has shorthand for the common reset fields, and a `reset` field for a pre-built reset. It is deliberately not a mirror of `ResetOptions`.",
    "- **RunPool** — many opaque concurrent pool runs, each with its own lifecycle. `createRunPool`. → content-systems.md#runpool. Distinct from `Cycle` (runs with a reset at each run's end) and from `TickDriver` (tick scheduler). It is a `src/core` gameplay primitive, despite a name that sounds like part of the balance harness. Nothing in it is harness-only.",
    '- **Sequencer** — an ordered queue of authored *sequencer items*, started in turn through a cursor. `createSequencer`. → composition.md#sequencer. Its verb in § Task → API tier, "schedule", means starting jobs or personas in order. It does not mean a timed cadence over a generated schedule: waves on a timer have no items to start, so they stay consumer-side (→ ../consumer-guide-recipes-tick.md#phases-inside-a-run). Per-item repeat counts are consumer-side too: expand them at enqueue, or count them in metadata. `repeat()` starts the current item once more, without advancing.',
    "- **tick phase** vs **a phase inside a run** — a tick phase is a TickDriver's named handler set: `registerPhase`, `enterPhase`, `exitPhase` → runtime.md#tickdriver. Its entered set is not saved. A game's own phases inside a run, such as build and wave, are one saved phase value and one guarded `onTick` → ../consumer-guide-recipes-tick.md#phases-inside-a-run",
    '- **TimedProgress** — *forward-only* progress toward a completion; a negative rate does nothing. It is not a two-way gauge and not an input schedule, despite the generic stem. `createTimedProgress`. → mechanics.md#timedprogress',
    '- **TimeSystem vs TimeBank** — `createTimeSystem` tracks play time: how long the player has played. `createTimeBank` is a store of banked seconds to spend (offline banking, bonus time). → runtime.md#time-tracking, lifecycle.md#time-bank',
    '- **"total over a span" ×3** — `evaluateAntiderivative`, `cumulative(a, b)` and `sum(a, n)` all answer it. A wrong pick gives a wrong answer, not an error. → mechanics.md#formulas; which one is yours, at ../consumer-guide-choosing.md#common-disambiguators.',
    '- **"when do I reach X" ×3** — one question in three coordinate systems, so they deliberately share no name. `Formula.firstPassage` answers on a *curve*: pure algebra, no engine state, and it returns the input (→ mechanics.md#formulas). `timeUntilResource` / `timeUntilAffordable` / `timeUntilGateFlip` answer against *live state and rates*, in seconds (→ runtime.md#transition-distance-primitives, mechanics.md#gate). `calculateMaxAffordable` answers in a *purchase count*, against a cost curve and the resource that pays for it (→ mechanics.md#formulas). Choose by what you already have, not by how the question is worded.',
    '',
    '## Task → API tier',
    '',
    'Common consumer tasks, each with its starting API tier. Open the API tier file, and follow its `##` sections to the cluster.',
    '',
    'Deliberately absent: real-time combat between units (positioning, collision, per-tick action resolution). The engine is a headless incremental substrate, so combat resolution stays consumer-side. spatial.md covers only adjacency and traversal.',
    '',
    '| Task | Starting API tier |',
    '| --- | --- |',
    '| add a new resource | resources.md#resource |',
    '| show a resource reactively | resources.md#resource |',
    '| convert resources / crafting recipe / market trade | resources.md#conversion |',
    '| turn stock into output each tick / a smelter or workshop that draws inputs | `ProducerMapping.inputs` → content-systems.md#producer-category |',
    '| cap a resource / storage capacity / overflow | `createResourceBag` (capacity + `link`) → resources.md#resource |',
    '| random pick / draw k items / shuffle / weighted roll | `randomItem` / `shuffle` / `weightedPick` → resources.md#rng |',
    '| building / producer (a "generator" elsewhere) / passive production | content-systems.md#producer-category |',
    '| total production rate of a resource | `ProducerCategory.getTotalRate` → content-systems.md#producer-category |',
    '| upgrade / perk / unlock / capped repeatable | content-systems.md#purchasable |',
    '| achievement with a one-time reward | content-systems.md#achievement |',
    '| skill XP / level curve | content-systems.md#skill |',
    '| inventory with item capacities | content-systems.md#inventory |',
    '| zone unlocks / named content regions | content-systems.md#zone |',
    '| constrained loadout / saved selection | content-systems.md#loadout |',
    '| saved queues / layout templates / named saves of a state slice | ../consumer-guide-recipes.md#named-saves-of-a-state-slice |',
    '| automation unlock ladder | content-systems.md#automation-tiers |',
    '| stack modifiers on a chain | mechanics.md#modifier |',
    '| timed buff / temporary multiplier / an effect with a duration | `createTemporaryEffectSystem` → mechanics.md#effects |',
    '| speed up one action / a rate chain per action | `rateChain: true` on the action mapping → content-systems.md#action-category |',
    '| "purchase max" count / bulk purchase cost preview | mechanics.md#formulas |',
    '| softcap / bend a value past a threshold | `Formula.step` → mechanics.md#formulas |',
    '| declarative Gate (data-driven predicate) | mechanics.md#gate |',
    '| new content category (skill, purchasable, producer, …) | composition.md#category-base |',
    '| branching dialog graph | content-narrative.md#dialog |',
    '| dialog choice effects / authored outcomes | content-narrative.md#dialog, mechanics.md#effects |',
    '| faction reputation / NPC relationships | content-narrative.md#subject-category |',
    '| achievement ladder | content-systems.md#achievement |',
    '| save migration / save version bump | lifecycle.md#save-manager |',
    '| offline catch-up after a long time away | lifecycle.md#offline |',
    '| prestige / reset with retention | lifecycle.md#reset |',
    '| phases inside a run (build ↔ wave, day ↔ night) / waves on a timer | ../consumer-guide-recipes-tick.md#phases-inside-a-run |',
    '| retire / switch off a set of mechanics when a phase or chapter ends | mechanics.md#effects |',
    '| register a module | runtime.md#engine-assembly |',
    '| subscribe to engine or category events | runtime.md#events |',
    '| time until X (transition distance) | runtime.md#transition-distance-primitives |',
    '| expose a tunable to a slider or a mod | introspection.md#override-registry |',
    '| in-game devtools / balance UI / walk all content | introspection.md#engine-categories |',
    '| upcoming unlock / "what changes next?" | harness.md#transition-walker, runtime.md#transition-distance-primitives |',
    '| schedule jobs / persona rotation / ordered queue | composition.md#sequencer |',
    '| recommendation between runs | advisors.md#recommendation |',
    '| draw ticking game state on a canvas / smooth it between ticks | ../consumer-guide-recipes-tick.md#drawing-ticking-game-state-a-read-only-projection |',
    '| spatial adjacency / adjacency modifiers on a grid | spatial.md#grid, spatial.md#graph |',
    '| routing / pathfinding / traversal cost over a board | `SpatialGrid.distanceField` (weighted, multi-source, descend the field) or `SpatialGrid.bfs` (reachability + parent links) → spatial.md#grid |',
    '| balance sweep over variants | harness.md#cell-aggregation-kernel |',
    '| tune one balance constant to meet a target | harness.md#solvers |',
    '| perturb a modifier to test sensitivity | harness.md#perturbation-applier |',
    '',
    '## Concept index',
    '',
    'Cross-cutting shapes, not symbol names: "where do I read about X?" when X has no single name. API tier anchors give symbol-level detail; consumer-guide anchors give the prose.',
    '',
    '- **perturbation seam** — the address→override mechanism for the balance workbench → harness.md#perturbation-applier',
    '- **persistent contexts** — `withPersistentContext`, save-key prefixes → lifecycle.md#persistence, ../consumer-guide.md#persistent-context',
    '- **category auto-registration** — categories register themselves in `EngineCategories` for introspection → introspection.md#engine-categories, ../consumer-guide.md#level-2-categories-the-default-for-content',
    '- **modifier attribution** — `BindingRecord`, trace entries, `withTraceChain` → mechanics.md#modifier, mechanics.md#trace',
    '- **modifier chain composition** — named chains, `bind`, declarative `grants`/`restricts`/`rewards` → mechanics.md#modifier, ../consumer-guide.md#modifier-chains-and-effects',
    "- **cross-action modifier** — A's output scaled by B's state, through a modifier held by a yes/no predicate or scaled by a level → ../consumer-guide-recipes.md#cross-action-modifiers, mechanics.md#modifier",
    '- **predicate-bounded headless run** — `runUntil` / `runMatrixUntil`, ended by a shared until-predicate → harness.md#cell-aggregation-kernel',
    '- **live-play replay** — `replayLive`, a deterministic `intervalTick` cadence scaled by game speed; `createTickCounter` to show fixed tick mode is invariant to game speed → harness.md#headless-runner',
    '- **sensitivity sweep** — baseline + variants, per-metric `{absolute, relative}` deltas → harness.md#cell-aggregation-kernel',
    '- **transition distance** — "when does X happen?" math over live state → runtime.md#transition-distance-primitives',
    '- **picker enumeration** — walk modifiers, tunables and content for solvers and UIs → harness.md#picker, ../consumer-guide.md#introspection',
    '- **indirect-control worker pool** — Sequencer + TimedProgress + claim-on-pop, for workers the player directs only indirectly → content-systems.md#runpool, ../consumer-guide-recipes.md#indirect-control-worker-pools',
    '- **persona roster** — a keyed vector of persona parameters, chosen by fill strategy → ../consumer-guide-recipes.md#persona-roster-composition, composition.md#sequencer',
    '- **reset scope** — `ScopedReset`, a recursive walk of `thingsToReset` → lifecycle.md#reset, ../consumer-guide.md#resetting-persistent-refs-in-bulk',
    '- **retention through a reset** — `keep` (verbatim) vs `retain` (transformed) → lifecycle.md#retention, ../consumer-guide.md#resetting-persistent-refs-in-bulk',
    '- **save lifecycle handlers** — `SaveHandler` / `LoadHandler` / `save:loaded` events → lifecycle.md#save-manager, runtime.md#engine-assembly',
    '- **offline catch-up** — `processOfflineTime`, a chunked simulation of the offline seconds → lifecycle.md#offline; offline-progress families and the mechanism-vs-choices split → ../consumer-guide-choosing.md#common-disambiguators',
    '- **tunable** — `tunable()` + `TuningRegistry`, scoped overrides of balance constants → introspection.md#override-registry, ../consumer-guide.md#tunables',
    '- **declarative Gate** — the `Gate` AST: evaluable, with transition distance and a condition IR projection → mechanics.md#gate, ../consumer-guide.md#level-4-declarative-gates-and-effects',
    '- **predicate form choice** — Gate vs Requirement vs `Computable<boolean>` for predicate fields → INDEX.md#predicate-forms, ../consumer-guide.md#level-4-declarative-gates-and-effects',
    '- **conditional effect** — `ConditionalEffectSystem` binds its grants on activation and removes them on deactivation → mechanics.md#effects',
    "- **mechanic set for one phase** — one `ConditionalEffectSystem` def holds many grants behind one predicate. So a chapter's mechanics switch on and off together. The predicate may be one-way, and is evaluated again on load with no `restore()`. This is the batch verb for *blocking*, the counterpart to `resetPersistentContexts` for *resetting*. Per-def `visible` stays one line per def → mechanics.md#effects, lifecycle.md#reset",
    '- **cost requirement** — `CostRequirement`, bulk purchase via inversion, pay functions → mechanics.md#requirements, ../consumer-guide-choosing.md#choosing-among-purchasable-primitives',
    '- **softcap / bend** — `Formula.step(value, start, modifier)` passes the value through below `start` and applies the modifier to the excess above it → mechanics.md#formulas',
    '- **purchase max** — `calculateMaxAffordable` counts the purchases an amount covers, and `calculateCost` gives their cost. It takes any cost curve; an inverse only seeds the count → mechanics.md#formulas',
    '- **flow-channel classification** — `FlowChannel`, `classifyFlowChannel`, Csikszentmihalyi-style engagement classes → harness.md#flow-channel-classification',
    '- **content registry patch** — `registry.patch()` merges fields into a registered def → composition.md#content-registry, ../consumer-guide.md#level-2-categories-the-default-for-content',
    '- **batch-registered category** — `createCategoryBase`, per-def persistent context + patch → composition.md#category-base, ../consumer-guide.md#level-2-categories-the-default-for-content',
    '- **dialog session vs adapter** — the `DialogSession` envelope over a swappable `DialogAdapter` → content-narrative.md#dialog, ../consumer-guide-recipes.md#dialog-contract-first-adapter-second',
    '- **subject schema fields** — typed multi-field state per subject: scalar / vector / ladder / flag / enum → content-narrative.md#subject-category, ../consumer-guide-recipes.md#character-interaction-surface',
    '- **best-of record** — a per-metric best with an optional projection, and BestOf events → content-systems.md#bestof-tracker',
    "- **run end events** — `beforeEnd` / `afterEnd` around a cycle's end, reset and next run → content-systems.md#cycle",
    '- **run-shaped APIs** — `Cycle` (runs and the resets between them) vs `CycleLog` (their tracked metrics) vs `RunPool` (many concurrent pool runs) vs `TickDriver` (tick scheduler) → INDEX.md#reserved-names',
    '- **recommendation arbitration** — recommenders ranked between runs; the winner is applied automatically or presented → advisors.md#recommendation',
    '- **spatial unit steering** — steer a unit over a board. Influence layers give a per-cell influence; the goal picker scores and ranks candidates built from it → spatial.md#influence-layer, advisors.md#goal-picker',
    '- **distance field / flow field** — the least-cost distance from a set of source cells to every cell; units move by descending it. `SpatialGrid.distanceField`; the step direction is derived consumer-side, so routing and rendering share one tie-break → spatial.md#grid',
    '',
    '## Common disambiguators',
    '',
    'Short answers only: which symbol does X. Where two of these overlap and a wrong pick raises no error, the boundary is at ../consumer-guide-choosing.md#common-disambiguators.',
    '',
    '| If you mean… | Use… |',
    '| --- | --- |',
    '| Owning something produces continuous output | `createProducerCategory` → content-systems.md#producer-category |',
    '| Purchased state or effect, upgrade, unlock, or capped repeatable | `createPurchasableCategory` → content-systems.md#purchasable |',
    '| Achievement earned automatically once its goal holds | `createAchievement` / `createAchievementCategory` → content-systems.md#achievement |',
    '| Resource storage capacity, or a multi-resource container | `createResourceBag` → resources.md#resource |',
    '| Game-facing item inventory with capacities | `createInventory` → content-systems.md#inventory |',
    '| Engine tick scheduler | `createTickDriver` → runtime.md#tickdriver |',
    '| Runs that end, reset and start again | `createCycle` → content-systems.md#cycle |',
    '| Many opaque concurrent pool runs | `createRunPool` → content-systems.md#runpool |',
    '| Ordered schedule or persona rotation | `createSequencer` and fill strategies → composition.md#sequencer |',
    '| Ranked recommendation / advisory choice | advisors → advisors.md |',
    '| Walk the live engine: its categories and registries | introspection registries → introspection.md |',
    '| Drive headless runs | balance harness runners → harness.md |',
    '| Bounded coordinate grid | `createSpatialGrid` → spatial.md#grid |',
    '| Hex grid, or any non-square adjacency | still `createSpatialGrid`: pass `neighborhood` (`HEX_AXIAL_OFFSETS`, `DIAGONAL_OFFSETS`, or your own offsets), and traversal follows it → spatial.md#grid |',
    '| Arbitrary node topology / nested spaces | `createGraph` → spatial.md#graph |',
    '',
    '## Predicate forms',
    '',
    'Engine fields that hold a yes/no test accept one of three forms. Choose the most specific one that fits.',
    '',
    '| Form | Shape | Use when | Predictor-friendly | Serializable | API tier anchor |',
    '| --- | --- | --- | --- | --- | --- |',
    '| `Gate` | typed AST (`ResourceGteGate`, `ActiveGate`, `FlagGate`, …) | a declarative predicate; you want `timeUntilGateFlip`, and serializable data for saves, mods and the balance harness | yes (typed) | yes | mechanics.md#gate |',
    '| `Requirement` | a predicate with a cost and a pay function | the predicate also spends a resource (cost, bulk purchase via inversion, pay by reset / pay by division) | partial | no (closures) | mechanics.md#requirements |',
    '| `Computable<boolean>` | ref / computed / getter | typed refs are already at hand; no introspection needed; the predicate does not fit state paths | no | no | mechanics.md#computed |',
    '',
    'Systems-layer predicate fields take `Predicate` (`Gate` | `Computable<boolean>`). Challenge `visible` / `canEnter` / `goal` take it, as do achievement `goal` / `visible` / `hidden` and purchasable and producer `visible`. So do automation tier `unlockWhen`, cycle `endCondition`, reset `canReset` and time-bank `when`. So do subject ladder `advanceWhen`, conditional effect `active` and `Grant.when`. The Gate services a Gate reads are asserted when the def is registered. Core fields stay `Computable<boolean>`, dialog conditions stay `Gate`, and `PurchasableOptions.requirements` takes `Requirement[]`. When a field accepts a `Gate`, prefer it. `Gate` is the only form with both transition-distance introspection and category awareness, without a `GameStateAccessor` mapping.',
    '',
    '**Converting between forms.** A field may want a `Requirement` where the predicate is declarative. Then `createGateRequirement({ gate })` converts a `Gate` into a no-cost `Requirement`, and the Gate stays the source of truth for serializability and `timeUntilGateFlip`. Where the predicate is an opaque closure, `createBooleanRequirement({ met })` is the escape hatch: the same shape, with no introspection. Both keep the chosen form on the *Gate / Computable* side of the boundary. Only `createCostRequirement` adds real cost behavior.',
    '',
    'Prose: ../consumer-guide.md#level-4-declarative-gates-and-effects.',
    '',
    '## API tier map',
    '',
    'The API tiers in dependency order, numeric foundation first and balance harness last, with the clusters each holds. This is *not* the L1→L4 order of § Choose an abstraction level. Follow a cluster anchor for its symbols and its blurb.',
    '',
  ];

  for (const tier of TIER_MANIFEST) {
    lines.push(`### ${tier.title} — \`${tier.tier}.md\``, '', tier.scope, '');
    for (const clusterId of tier.clusters) {
      const recs = byCluster.get(clusterId) || [];
      const files = [...new Set(recs.map((r) => r.sourcePath))].sort();
      const { title } = clusterMeta(clusterId, files);
      lines.push(`- \`${clusterId}\` → ${tier.tier}.md#${slugify(title)}`);
    }
    lines.push('');
  }

  lines.push(
    '## Source layers',
    '',
    "A second cut, orthogonal to the API tiers above: the source layers `primitives → core → systems → harness`, with one-way imports. An API tier is not a source layer. Most API tier files mix source layers, and `parse-dts.mjs` derives each symbol's source layer from its `src/` path.",
    '',
    '- **primitives/** — zero-Vue foundational types and utilities (`Decimal`, `RNG`, `IEffect` types, `Analyzer` shape).',
    '- **core/** — generic reactive primitives (modifiers, effects, persistence, save manager, game loop, transitions).',
    '- **systems/** — typed registration contracts (every category factory; reset / retention; dialog; advisors; Gate).',
    '- **harness/** — the balance harness (runners, probes, walkers, picker, perturbation, solvers).',
    '',
  );

  return lines.join('\n').replace(/\n+$/, '\n');
}

// --- Main ---

if (!existsSync(ENGINE_ROOT_DTS)) {
  console.error(`Missing ${ENGINE_ROOT_DTS} — run \`pnpm build\` first`);
  process.exit(1);
}

const { records: allRecords, unresolved } = parseEntrypoint(ENGINE_ROOT_DTS);
const records = allRecords.filter((r) => r.tag === 'public');
const byCluster = bucketByCluster(records);

// Validate every cluster has exactly one API tier.
const manifestClusters = new Set();
const dupes = [];
for (const tier of TIER_MANIFEST) {
  for (const c of tier.clusters) {
    if (manifestClusters.has(c)) dupes.push(c);
    manifestClusters.add(c);
  }
}
const parsedClusters = new Set(byCluster.keys());
const unassigned = [...parsedClusters].filter((c) => !manifestClusters.has(c)).sort();
const dangling = [...manifestClusters].filter((c) => !parsedClusters.has(c)).sort();

if (dupes.length) {
  console.error(`Manifest has duplicate cluster ids: ${dupes.join(', ')}`);
  process.exit(1);
}
if (unassigned.length) {
  console.error(
    `Clusters not assigned to any API tier:\n  ${unassigned.join('\n  ')}\n` +
      `Add them to scripts/lib/api-tier-manifest.mjs`,
  );
  process.exit(1);
}

// Render API tier files, collecting the `##` anchors each one emits.
const emittedAnchors = new Map();
for (const tier of TIER_MANIFEST) {
  const content = renderTierFile(tier, byCluster);
  writeFileSync(join(API_DIR, `${tier.tier}.md`), content);
  emittedAnchors.set(
    `${tier.tier}.md`,
    new Set([...content.matchAll(/^#{2,3} (.+)$/gm)].map((m) => slugify(m[1]))),
  );
}

// Render INDEX.md.
const indexContent = renderIndex(byCluster);
writeFileSync(join(API_DIR, 'INDEX.md'), indexContent);

// Validate INDEX's hand-written API tier anchors against what the API tier
// files just emitted. Section titles come from source file headers, so a header
// reword silently breaks every INDEX link naming the old title — this turns that
// class of drift into a build failure. Only API tier anchors are checked; links into
// consumer-guide.md point at a file this generator doesn't own.
const brokenAnchors = [...indexContent.matchAll(/([\w-]+\.md)#([\w-]+)/g)]
  .filter(([, file, anchor]) => emittedAnchors.has(file) && !emittedAnchors.get(file).has(anchor))
  .map(([ref]) => ref);
if (brokenAnchors.length) {
  const unique = [...new Set(brokenAnchors)].sort();
  console.error(
    `INDEX.md references ${unique.length} API tier anchor(s) that no section emits:\n  ${unique.join('\n  ')}\n` +
      `Fix the link in scripts/build-api-docs.mjs, or restore the section title in the source file header.`,
  );
  process.exit(1);
}

// Coverage report — `records` is already filtered to public symbols above.
// Overload continuations may use their lead declaration's doc; compact
// clusters re-export a dependency's symbols and never render a summary at all.
const missingSummary = records.filter(
  (r) => !r.tsdocSummary && !(r.overloadIndex > 0) && CLUSTER_TITLES[r.cluster]?.compact !== true,
);
const missingLine = records.filter((r) => r.line == null);

console.log(
  `Wrote ${TIER_MANIFEST.length} API tier files + INDEX.md — ${records.length} symbols across ${parsedClusters.size} clusters`,
);
if (dangling.length) {
  console.warn(
    `  ${dangling.length} cluster(s) in manifest with no symbols: ${dangling.join(', ')}`,
  );
}
if (missingSummary.length) {
  console.warn(`  ${missingSummary.length} public symbol(s) without TSDoc summary`);
  for (const r of missingSummary.slice(0, 10)) {
    console.warn(`    ${r.sourcePath}:${r.line ?? '?'}  ${r.name}`);
  }
  if (missingSummary.length > 10) console.warn(`    … +${missingSummary.length - 10} more`);
}
if (missingLine.length) {
  console.warn(`  ${missingLine.length} public symbol(s) without resolved source line`);
}
if (unresolved.length) {
  console.warn(
    `  ${unresolved.length} unresolved alias(es): ${unresolved.slice(0, 5).join(', ')}${unresolved.length > 5 ? '…' : ''}`,
  );
}
