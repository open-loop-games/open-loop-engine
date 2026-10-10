#!/usr/bin/env node
/**
 * Build the per-tier API docs and INDEX cluster directory from parser output
 * and the tier manifest.
 *
 * Pipeline:
 *   1. `parse-dts.mjs` walks `dist/index.d.ts` → per-symbol records
 *   2. `api-tier-manifest.mjs` maps cluster ids → tier slots
 *   3. This script renders the tier files + INDEX.md
 *
 * Writes:
 *   docs/api/{resources,mechanics,composition,content-systems,content-narrative,
 *             lifecycle,runtime,introspection,advisors,spatial,harness}.md
 *   docs/api/INDEX.md
 *
 * Quality gates:
 *   - Exits non-zero if any cluster is unassigned in the manifest
 *   - Exits non-zero if an INDEX tier anchor names no emitted section
 *   - Warns on public symbols without a TSDoc summary (feeds OL-928 audit)
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
 * Within each tier, when multiple candidates exist (e.g. a split cluster with
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
 * `export declare` modifiers (everything in `index.d.ts` carries them) and
 * trims object-literal bodies from interfaces / classes / inline-shaped types
 * and consts — the full shape lives at the linked `src/path:line`.
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
 * Signatures are trimmed to declaration heads — the source link carries the
 * body. See {@link formatSignature}.
 */
function renderSymbol(rec) {
  const loc = rec.line ? `${rec.sourcePath}:${rec.line}` : rec.sourcePath;
  const bare = `- \`${formatSignature(rec)}\` \`${loc}\``;
  // Overload continuations without their own TSDoc lean on the set's lead
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
 * reprinting them costs kilobytes and reads as engine surface. Names only.
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

/** Render one tier file's content. */
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
 * tier map and cluster directory render from the tier manifest + parsed
 * cluster output. Editing the rendered INDEX.md by hand is meaningless.
 */
function renderIndex(byCluster) {
  const lines = [
    '# API Index',
    '',
    "Router into the engine's per-symbol surface. Symbols group by adjacency, not by the vocabulary you arrived with, so route from your task rather than grepping for the name you brought in — that is what keeps a reading failure from being reported as a missing primitive.",
    '',
    "Land by **verb** (§ Task → tier), by **noun-shape** (§ Concept index), or by **subsystem** (§ Tier map). Check § Reserved names before grepping a shared stem, and § Predicate forms before choosing a gating type. Prose companions — *how* to compose, not *what* exists — are `../consumer-guide.md`, and `../consumer-guide-choosing.md` when two primitives overlap and picking wrong doesn't error; entries link there rather than restating it.",
    '',
    'Generated by `node scripts/build-api-docs.mjs`; hand edits are meaningless. Per-symbol detail lives in the tier files, cluster ids come from `@cluster` source tags, and tier assignment is one line in `scripts/lib/api-tier-manifest.mjs`.',
    '',
    '## Choose a level',
    '',
    'Start at the highest-level surface that fits, and drop down only when it fights the shape of the game. Full prose: ../consumer-guide.md#the-expression-spectrum.',
    '',
    '| Level | Reach for | Start at |',
    '| --- | --- | --- |',
    '| **L1: Resource helpers** | `addResource` / `hasResource` / `displayResource`, `Resource.best` / `.cumulative` — direct currency mutation, display, lifetime trackers | resources.md#resource |',
    '| **L2: Category systems** | `createProducerCategory`, `createPurchasableCategory`, `createSkillCategory`, `createDialogCategory`, … — repeatable authored content, and the default for it | content-systems.md, content-narrative.md |',
    '| **L3: Raw primitives** | `createScalingPurchasable`, `createCycle`, `createModifierChain`, `createCategoryBase` — one-off systems, or registration shapes category mapping constrains | composition.md, mechanics.md, lifecycle.md |',
    '| **L4: Declarative data** | `Gate`, `E` / `IEffect` — JSON/mod/save/sim-friendly gates and effects | mechanics.md#gate, mechanics.md#effects |',
    '',
    '## Reserved names',
    '',
    'A few symbols share a stem and are easy to confuse. Each links to its anchor:',
    '',
    "- **Cycle** — one bounded gameplay run that ends, resets a scope, and replays. `createCycle`. → content-systems.md#cycle. Named for the lifecycle, not a genre: a loop incremental's run, a prestige layer's reincarnation, and a new-game-plus are all the same shape. `end()` resets at the run's end, then fires `afterEnd`. `count`, `bestTime` and `elapsed` persist; `running` doesn't, so call `resume()` on load. A run that dwells on a results screen before the player restarts composes by pausing in `afterEnd`; the screen reads what `onBeforeEnd` or a `CycleLog` entry captured, since the scope is already reset. A run that keeps its end state live until the player starts the next one resets on start instead: that is `createReset` plus a tick phase, not Cycle. Phases inside a run aren't Cycle's shape either.",
    "- **CycleLog** — per-cycle metric delta recorder; observes a `Cycle`'s lifecycle. `createCycleLog`. → content-systems.md#cyclelog",
    '- **Challenge** — also a start/goal/exit constrained-run lifecycle, but *enter-a-modified-ruleset*, not replay-with-reset. `createChallengeCategory`. → content-systems.md#challenge-category',
    "- **`createReset`** vs **`Cycle`** — `createReset` is the standalone reset mechanic (scope, retention, `canReset` gate); `Cycle` drives one, adding the run's timer, counter, and restart cadence. `CycleOptions` carries shorthand for the common reset fields and a `reset` field for a pre-built one — it is deliberately not a mirror of `ResetOptions`.",
    '- **RunPool** — many opaque concurrent runs with per-run lifecycle. `createRunPool`. → content-systems.md#runpool. Distinct from `Cycle` (one bounded run, reset at its boundary) and from `TickDriver` (tick scheduler). It is a `src/core` gameplay primitive despite the sim-flavoured name — nothing about it is harness-only.',
    '- **Sequencer** — ordered dispatch of *authored content items* via a cursor. `createSequencer`. → composition.md#sequencer. Its task-table verb "schedule" means job/persona dispatch, not a timed phase cadence over a generated schedule (wave cycles have no items to dispatch, and stay consumer-side). Per-item repeat counts are consumer-side too — expand at enqueue or count in metadata; `repeat()` re-dispatches the current item once, without advancing.',
    '- **TimedProgress** — *forward-only* completion accumulator (negative speed is a no-op); not a bidirectional gauge and not an input schedule, despite the generic stem. `createTimedProgress`. → mechanics.md#timedprogress',
    '- **TimeSystem vs TimeBank** — `createTimeSystem` is the play-clock (how long has the player played); `createTimeBank` is a spendable reservoir of banked seconds (offline banking, bonus time). → runtime.md#time-tracking, lifecycle.md#time-bank',
    "- **`speedMultiplier` ×2** — `TickDriver.speedMultiplier` (runtime.md#tickdriver) scales actual tick dt; `TimeSystem.speedMultiplier` (runtime.md#time-tracking) scales only that system's internal play-time counter. Only the TickDriver one accelerates the game. `createBankedAcceleration` drives the TickDriver one.",
    '- **"total over a span" ×3** — `evaluateIntegral`, `cumulative(a, b)`, and `sum(a, n)` all answer it, and picking wrong is silently wrong rather than an error. → mechanics.md#formulas; which one is yours, at ../consumer-guide-choosing.md#common-disambiguators.',
    '- **"when do I reach X" ×3** — one question, three coordinate systems, so they deliberately share no name. `Formula.firstPassage` answers on a *curve*: pure algebra, no engine state, returns the input (→ mechanics.md#formulas). `timeUntilResource` / `timeUntilAffordable` / `timeUntilGateFlip` answer against *live state and rates*, in seconds (→ runtime.md#transition-distance-primitives, mechanics.md#gate). `calculateMaxAffordable` answers in *levels*, against a cost curve plus the resource paying for it (→ mechanics.md#formulas). Pick by what you have in hand, not by the wording of the question.',
    '',
    '## Task → tier',
    '',
    'Common consumer tasks resolved to their starting tier. Land in the tier file and follow its `##` sections to the cluster.',
    '',
    'Deliberately absent: real-time entity combat (positioning, collision, frame-level action resolution). The engine is a headless incremental substrate — combat resolution stays consumer-side; spatial.md covers only adjacency and traversal.',
    '',
    '| Task | Starting tier |',
    '| --- | --- |',
    '| add a new resource | resources.md#resource |',
    '| reactive resource display | resources.md#resource |',
    '| convert resources / crafting recipe / market trade | resources.md#conversion |',
    '| cap a resource / storage capacity / overflow | `createResourceBag` (capacity + `link`) → resources.md#resource |',
    '| random pick / draw k from a pool / shuffle / weighted roll | `randomItem` / `shuffle` / `weightedPick` → resources.md#rng |',
    '| building / generator / passive production | content-systems.md#producer-category |',
    '| total income / production rate of a resource | `ProducerCategory.getTotalRate` → content-systems.md#producer-category |',
    '| upgrade / perk / unlock gate / capped repeatable | content-systems.md#purchasable |',
    '| one-shot milestone reward | content-systems.md#achievement |',
    '| skill XP / level curve | content-systems.md#skill |',
    '| inventory with item capacities | content-systems.md#inventory |',
    '| zone unlocks / named content regions | content-systems.md#zone |',
    '| constrained loadout / persistent selection slot | content-systems.md#slot |',
    '| automation unlock ladder | content-systems.md#automation-tiers |',
    '| modifier bonus stacking on a chain | mechanics.md#modifier |',
    '| "buy max" count / bulk cost preview | mechanics.md#formulas |',
    '| softcap / bend a value past a threshold | `Formula.step` → mechanics.md#formulas |',
    '| declarative gate (data-driven condition) | mechanics.md#gate |',
    '| new content category (skill, purchasable, producer, …) | composition.md#category-base |',
    '| dialog tree with branching | content-narrative.md#dialog |',
    '| dialog choice effects / authored outcomes | content-narrative.md#dialog, mechanics.md#effects |',
    '| faction reputation / NPC relationships | content-narrative.md#subject-category |',
    '| achievement tier ladder | content-systems.md#achievement |',
    '| save migration / version bump | lifecycle.md#save-manager |',
    '| offline catch-up after long absence | lifecycle.md#offline |',
    '| prestige / reset with retention policy | lifecycle.md#reset |',
    '| retire / freeze a set of mechanics when a phase or chapter ends | mechanics.md#effects |',
    '| register an engine module | runtime.md#engine-assembly |',
    '| subscribe to engine or category events | runtime.md#events |',
    '| time-until-X transition timing | runtime.md#transition-distance-primitives |',
    '| expose a tunable knob to a slider / mod config | introspection.md#override-registry |',
    '| in-game devtools / balance UI / walk all content | introspection.md#engine-categories |',
    '| upcoming unlock / "what changes next?" | harness.md#transition-walker, runtime.md#transition-distance-primitives |',
    '| schedule jobs / persona rotation / ordered dispatch | composition.md#sequencer |',
    '| recommendation between cycles | advisors.md#recommendation |',
    '| spatial adjacency / grid bonuses | spatial.md#grid, spatial.md#graph |',
    '| routing / pathfinding / travel cost over a map | `SpatialGrid.distanceField` (weighted, multi-source, descend the field) or `SpatialGrid.bfs` (reachability + parent links) → spatial.md#grid |',
    '| balance parameter sweep (multi-variant) | harness.md#cell-aggregation-kernel |',
    '| tune a single balance value to meet a target | harness.md#solvers |',
    '| perturb a modifier to test sensitivity | harness.md#perturbation-applier |',
    '',
    '## Concept index',
    '',
    'Cross-cutting shapes rather than symbol names — "where do I read about X?" when X has no single name. Tier anchors give symbol-level detail; consumer-guide anchors give the prose.',
    '',
    '- **perturbation seam** — address→override mechanism for the balance workbench → harness.md#perturbation-applier',
    '- **persistent context scoping** — `withPersistentContext`, save-key namespacing → lifecycle.md#persistence, ../consumer-guide.md#persistent-context',
    '- **category auto-registration** — categories self-publish into `EngineCategories` for introspection → introspection.md#engine-categories, ../consumer-guide.md#level-2-category-systems-the-default-for-content',
    '- **modifier attribution** — `BindingRecord`, trace entries, `withChain` scope → mechanics.md#modifier, mechanics.md#trace',
    '- **modifier chain composition** — named chains, `bind`, declarative `grants`/`restricts`/`rewards` → mechanics.md#modifier, ../consumer-guide.md#modifier-chains-and-effects',
    "- **cross-action bonus** — A's yield scaled by B's state via binary-gate or level-scaled modifier → ../consumer-guide-recipes.md#cross-action-bonuses, mechanics.md#modifier",
    '- **predicate-bounded sim** — `runUntil` / `runMatrixUntil`, terminate on shared predicate → harness.md#cell-aggregation-kernel',
    '- **live-play replay** — `replayLive`, deterministic speed-scaled `intervalTick` cadence; `createTickCounter` for fixed-mode speed-invariance → harness.md#headless-runner',
    '- **sensitivity sweep** — baseline + variants, per-metric `{absolute, relative}` deltas → harness.md#cell-aggregation-kernel',
    '- **transition distance** — "when does X happen?" math over current state → runtime.md#transition-distance-primitives',
    '- **picker enumeration** — walk modifiers, tunables, content for solvers/UIs → harness.md#picker, ../consumer-guide.md#introspection',
    '- **indirect-control worker pool** — Sequencer + TimedProgress + claim-on-pop, Majesty/DK shape → content-systems.md#runpool, ../consumer-guide-recipes.md#indirect-control-worker-pools',
    '- **persona roster** — keyed vector of personality params, sequencer-strategies selection → ../consumer-guide-recipes.md#persona-roster-composition, composition.md#sequencer',
    '- **reset scope** — `ScopedReset`, recursive walking of `thingsToReset` → lifecycle.md#reset, ../consumer-guide.md#resetting-persistent-refs-in-bulk',
    '- **retention across reset** — `keep` (verbatim) vs `retain` (transformed) carry-over → lifecycle.md#retention, ../consumer-guide.md#resetting-persistent-refs-in-bulk',
    '- **save lifecycle hooks** — `SaveHandler` / `LoadHandler` / `save:loaded` events → lifecycle.md#save-manager, runtime.md#engine-assembly',
    '- **offline catch-up** — `processOfflineTime`, chunked simulation of elapsed seconds → lifecycle.md#offline; strategy families and the mechanism-vs-policy split → ../consumer-guide-choosing.md#common-disambiguators',
    '- **tunable knob** — `tunable()` + `TuningRegistry`, scoped-stack override of balance constants → introspection.md#override-registry, ../consumer-guide.md#tunable-knobs',
    '- **declarative gate predicate** — `Gate` AST, evaluable + flip-distance + condition projection → mechanics.md#gate, ../consumer-guide.md#level-4-declarative-gates-and-effects-the-data-driven-escape-hatch',
    '- **predicate form choice** — Gate vs Requirement vs `Computable<boolean>` for gating fields → INDEX.md#predicate-forms, ../consumer-guide.md#level-4-declarative-gates-and-effects-the-data-driven-escape-hatch',
    '- **edge-triggered effect** — `ConditionalEffectSystem` rising/falling-edge modifier binding → mechanics.md#effects',
    "- **phase-scoped mechanic set** — one `ConditionalEffectSystem` def carries N chain bindings behind one predicate, so a chapter's mechanics freeze and thaw together; the predicate may be one-way, and re-evaluates on load with no `restore()`. This is the batch verb for *gating*, the counterpart to `resetPersistentContexts` for *wiping*. Per-def `visibility` stays one line per def → mechanics.md#effects, lifecycle.md#reset",
    '- **cost requirement** — `CostRequirement`, bulk-buy via inversion, pay strategies → mechanics.md#requirements, ../consumer-guide-choosing.md#choosing-among-purchasable-primitives',
    '- **softcap / bend** — `Formula.step(value, start, modifier)` passes the value through below `start` and applies the modifier to the excess above it → mechanics.md#formulas',
    '- **buy-max affordability** — `calculateMaxAffordable` counts the levels a balance covers, `calculateCost` prices them; any cost curve, an inverse only seeds the count → mechanics.md#formulas',
    '- **flow-channel classification** — `FlowChannel`, `classifyFlowChannel`, Csikszentmihalyi-style engagement bands → harness.md#flow-channel-classification',
    '- **content registry mod patch** — `registry.patch()` for mod-side definition overrides → composition.md#content-registry, ../consumer-guide.md#level-2-category-systems-the-default-for-content',
    '- **batch-registered category** — `createCategoryBase`, per-def persistent context + mod patch → composition.md#category-base, ../consumer-guide.md#level-2-category-systems-the-default-for-content',
    '- **dialog session vs runtime** — `DialogSession` envelope, swappable `DialogRuntime` adapter → content-narrative.md#dialog, ../consumer-guide-recipes.md#dialog-contract-first-runtime-second',
    '- **subject field kinds** — typed multi-field state per subject: scalar / vector / tier / flag / enum → content-narrative.md#subject-category, ../consumer-guide-recipes.md#character-interaction-surface',
    '- **best-of run recording** — per-metric best with optional projection, BestOf events → content-systems.md#bestof-tracker',
    '- **cycle restart event** — `beforeEnd` / `afterEnd` for the end→reset→replay cadence → content-systems.md#cycle',
    '- **run-shaped surfaces** — `Cycle` (one bounded gameplay run) vs `CycleLog` (its metrics) vs `RunPool` (many concurrent runs) vs `TickDriver` (tick scheduler) → INDEX.md#reserved-names',
    '- **recommendation arbitration** — strategies ranked between cycles, auto-apply or surface → advisors.md#recommendation',
    '- **spatial agent steering** — steer an agent over a map: influence layers supply per-cell field values, the goal picker scores and ranks candidates built from them → spatial.md#influence-layer, advisors.md#goal-picker',
    '- **distance field / flow field** — least-cost distance from a source set to every cell, agents move by descending it. `SpatialGrid.distanceField`; the step direction is derived consumer-side so routing and rendering share one tie-break → spatial.md#grid',
    '',
    '## Common disambiguators',
    '',
    "Short answers only — which symbol does X. When two of these overlap and picking wrong doesn't error, the boundary is at ../consumer-guide-choosing.md#common-disambiguators.",
    '',
    '| If you mean… | Use… |',
    '| --- | --- |',
    '| Ownership produces continuous flow | `createProducerCategory` → content-systems.md#producer-category |',
    '| Bought state/effect, upgrade, gate, or capped repeatable | `createPurchasableCategory` → content-systems.md#purchasable |',
    '| Observed milestone that auto-earns | `createAchievement` / `createAchievementCategory` → content-systems.md#achievement |',
    '| Resource storage capacity, or a multi-resource container | `createResourceBag` → resources.md#resource |',
    '| Game-facing item inventory with capacities | `createInventory` → content-systems.md#inventory |',
    '| Engine tick scheduler | `createTickDriver` → runtime.md#tickdriver |',
    '| Bounded gameplay run that resets and replays | `createCycle` → content-systems.md#cycle |',
    '| Many opaque concurrent runs | `createRunPool` → content-systems.md#runpool |',
    '| Ordered schedule or persona dispatch | `createSequencer` and fill strategies → composition.md#sequencer |',
    '| Ranked recommendation / advisory choice | advisors → advisors.md |',
    '| Discover live engine surfaces | introspection registries → introspection.md |',
    '| Execute headless simulations | harness runners → harness.md |',
    '| Bounded coordinate board | `createSpatialGrid` → spatial.md#grid |',
    '| Hex board, or any non-square adjacency | still `createSpatialGrid` — pass `neighborhood` (`HEX_AXIAL_DELTAS`, `DIAGONAL_DELTAS`, or your own offsets); traversal follows it → spatial.md#grid |',
    '| Arbitrary node topology / nested spaces | `createSpatialGraph` → spatial.md#graph |',
    '',
    '## Predicate forms',
    '',
    'Engine fields that gate behavior accept one of three shapes. Pick the most-specific that fits.',
    '',
    '| Form | Shape | Use when | Predictor-friendly | Serializable | Tier anchor |',
    '| --- | --- | --- | --- | --- | --- |',
    '| `Gate` | typed AST (`ResourceGteGate`, `ActiveGate`, `FlagGate`, …) | declarative predicate; want `timeUntilGateFlip` + save/mod/sim serializability | yes (typed) | yes | mechanics.md#gate |',
    '| `Requirement` | cost-bearing predicate with pay strategy | the predicate also charges a resource (cost, bulk-buy via inversion, pay-by-reset / pay-by-division) | partial | no (closures) | mechanics.md#requirements |',
    "| `Computable<boolean>` | ref / computed / getter | typed refs already in scope; no introspection needed; predicate doesn't fit dot-paths | no | no | mechanics.md#computed |",
    '',
    "Systems-layer predicate fields take `Predicate` (`Gate` | `Computable<boolean>`) — challenge `visible` / `canStart` / `goal`, achievement `requirement` / `visible` / `hidden`, purchasable and producer `visible`, automation tier `requirement`, cycle `endCondition`, reset `canReset`, time-bank `gate`, subject tier `gates`, persistent-effect `active` and `Grant.when` — and assert a Gate's handles when the definition registers. Core fields stay `Computable<boolean>`, dialog conditions stay `Gate`, and `PurchasableOptions.requirements` takes `Requirement[]`. When a field accepts a `Gate`, prefer it — `Gate` is the only form that gives both flip-distance introspection and category awareness without a `GameStateAccessor` mapping.",
    '',
    '**Adapters across forms.** Where a field wants `Requirement` but the predicate is declarative, `createGateRequirement({ gate })` adapts a `Gate` into a no-cost `Requirement` — the Gate stays the source of truth for serializability and `timeUntilGateFlip`. Where the predicate is an opaque closure, `createBooleanRequirement({ requirement })` is the escape hatch (same runtime shape, no introspection). Both keep the chosen form on the *Gate / Computable* side of the boundary; only `createCostRequirement` introduces real cost behaviour.',
    '',
    'Prose: ../consumer-guide.md#level-4-declarative-gates-and-effects-the-data-driven-escape-hatch.',
    '',
    '## Tier map',
    '',
    'The landing pages, in dependency-ascending order (numeric foundation first, headless harness last) with the clusters each holds — *not* the L1→L4 order of § Choose a level. Follow a cluster anchor for its symbols and its blurb.',
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
    "A second cut, orthogonal to the tiers above: source layers `primitives → core → systems → harness`, one-way imports. Tier ≠ layer — most tier files mix them, and `parse-dts.mjs` derives each symbol's layer from its `src/` path.",
    '',
    '- **primitives/** — zero-Vue foundational types and helpers (`Decimal`, `RNG`, `IEffect` types, `Analyzer` shape).',
    '- **core/** — generic reactive primitives (modifiers, effects, persistence, save manager, game loop, transitions).',
    '- **systems/** — typed registration surfaces (every category factory; reset / retention; dialog runtime; advisors; gate).',
    '- **harness/** — headless-sim substrate (runners, probes, walkers, picker, perturbation, solvers, run pool).',
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

// Validate every cluster has exactly one tier slot.
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
    `Clusters not assigned to any tier:\n  ${unassigned.join('\n  ')}\n` +
      `Add them to scripts/lib/api-tier-manifest.mjs`,
  );
  process.exit(1);
}

// Render tier files, collecting the `##` anchors each one emits.
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

// Validate INDEX's hand-written tier anchors against what the tier files just
// emitted. Section titles come from source file headers, so a header reword
// silently rots every INDEX link naming the old title — this turns that class
// of drift into a build failure. Only tier anchors are checked; links into
// consumer-guide.md point at a file this generator doesn't own.
const brokenAnchors = [...indexContent.matchAll(/([\w-]+\.md)#([\w-]+)/g)]
  .filter(([, file, anchor]) => emittedAnchors.has(file) && !emittedAnchors.get(file).has(anchor))
  .map(([ref]) => ref);
if (brokenAnchors.length) {
  const unique = [...new Set(brokenAnchors)].sort();
  console.error(
    `INDEX.md references ${unique.length} tier anchor(s) that no section emits:\n  ${unique.join('\n  ')}\n` +
      `Fix the link in scripts/build-api-docs.mjs, or restore the section title in the source file header.`,
  );
  process.exit(1);
}

// Coverage report — `records` is already filtered to public symbols above.
// Overload continuations may lean on their lead declaration's doc; compact
// clusters re-export a dependency's symbols and never render a summary at all.
const missingSummary = records.filter(
  (r) => !r.tsdocSummary && !(r.overloadIndex > 0) && CLUSTER_TITLES[r.cluster]?.compact !== true,
);
const missingLine = records.filter((r) => r.line == null);

console.log(
  `Wrote ${TIER_MANIFEST.length} tier files + INDEX.md — ${records.length} symbols across ${parsedClusters.size} clusters`,
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
