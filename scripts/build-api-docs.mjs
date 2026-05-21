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
 *   - Warns on public symbols without a TSDoc summary (feeds OL-928 audit)
 *
 * Run: `node scripts/build-api-docs.mjs`
 */
import { writeFileSync, existsSync } from 'node:fs'
import { join, basename } from 'node:path'
import { parseEntrypoint } from './parse-dts.mjs'
import { TIER_MANIFEST } from './lib/api-tier-manifest.mjs'
import {
  ROOT,
  CLUSTER_TITLES,
  parseFileHeader,
  titleCase,
} from './lib/source-meta.mjs'

const ENGINE_ROOT_DTS = join(ROOT, 'dist', 'index.d.ts')
const API_DIR = join(ROOT, 'docs', 'api')

const KIND_LABEL = {
  function: 'function',
  interface: 'interface',
  type: 'type',
  const: 'const',
  enum: 'enum',
  class: 'class',
  'abstract-class': 'abstract class',
}

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
  const stemMatches = files.filter((f) => basename(f, '.ts') === clusterId)
  if (stemMatches.length > 0) {
    return preferFileWithHeader(stemMatches) ?? stemMatches[0]
  }
  const indexMatches = files.filter((f) => basename(f) === 'index.ts')
  if (indexMatches.length > 0) {
    return preferFileWithHeader(indexMatches) ?? indexMatches[0]
  }
  return preferFileWithHeader(files) ?? files[0]
}

/** Return the first file in `files` whose header has a title or blurb, or null. */
function preferFileWithHeader(files) {
  for (const f of files) {
    const abs = join(ROOT, f)
    if (!existsSync(abs)) continue
    const header = parseFileHeader(abs)
    if (header.title || header.blurb) return f
  }
  return null
}

/**
 * Read cluster title + blurb + prologue from CLUSTER_TITLES (highest priority)
 * or the anchor file's header. Falls back to titleCase(clusterId) when neither
 * source has a usable title. `prologue` is CLUSTER_TITLES-only — source headers
 * don't carry it.
 */
function clusterMeta(clusterId, files) {
  const anchor = pickAnchorFile(clusterId, files)
  const abs = join(ROOT, anchor)
  const header = existsSync(abs) ? parseFileHeader(abs) : {}
  const override = CLUSTER_TITLES[clusterId] || {}
  const title = override.title || header.title || titleCase(clusterId)
  let blurb = override.blurb || header.blurb || null
  if (blurb && blurb.toLowerCase() === title.toLowerCase()) blurb = null
  const prologue = override.prologue || null
  return { title, blurb, prologue, anchor }
}

/** Stable anchor slug for cross-file links. */
function slugify(s) {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
}

/**
 * Walk a signature and return its head — everything up to the first `{` at
 * top-level `< >` depth zero. Used to strip object-literal bodies from
 * interfaces, classes, and inline-shaped types while keeping the declaration's
 * generic params and `extends` / `implements` clauses intact.
 */
function headBeforeBrace(sig) {
  let depth = 0
  for (let i = 0; i < sig.length; i++) {
    const c = sig[i]
    if (c === '<') depth++
    else if (c === '>') depth--
    else if (c === '{' && depth === 0) return sig.slice(0, i).trim()
  }
  return sig
}

const TYPE_INLINE_MAX = 160
const CONST_TYPE_INLINE_MAX = 80

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
    .trim()

  switch (rec.kind) {
    case 'interface':
    case 'class':
    case 'abstract-class':
      return headBeforeBrace(sig)
    case 'enum': {
      const m = sig.match(/^(enum\s+\w+)/)
      return m ? m[1] : sig
    }
    case 'const': {
      // Externally-re-exported values may surface as `let` rather than `const`;
      // normalize either prefix to `const` so consumers see one shape.
      const m = sig.match(/^(?:const|let)\s+(\w+)\s*:\s*([\s\S]+)$/)
      if (!m) return sig
      const [, name, rest] = m
      const compact = rest.replace(/\s+/g, ' ')
      if (compact.length <= CONST_TYPE_INLINE_MAX && !compact.includes('{')) {
        return `const ${name}: ${compact}`
      }
      return `const ${name}`
    }
    case 'type': {
      if (sig.length <= TYPE_INLINE_MAX && !sig.includes('{')) return sig
      const m = sig.match(/^(type\s+\w+(?:\s*<[^=]*?>)?)\s*=/)
      return m ? m[1].trim() : sig
    }
    case 'function':
    default:
      return sig
  }
}

/**
 * Render one symbol bullet. Format:
 *   `{signature}` — {tsdocSummary}. `src/path:line`
 *
 * Signatures are trimmed to declaration heads — the source link carries the
 * body. See {@link formatSignature}.
 */
function renderSymbol(rec) {
  const summary = rec.tsdocSummary
    ? rec.tsdocSummary.endsWith('.')
      ? rec.tsdocSummary
      : `${rec.tsdocSummary}.`
    : '_(no summary)_'
  const loc = rec.line ? `${rec.sourcePath}:${rec.line}` : rec.sourcePath
  return `- \`${formatSignature(rec)}\` — ${summary} \`${loc}\``
}

/** Group records by cluster id; preserve parser's stable sort within each. */
function bucketByCluster(records) {
  const out = new Map()
  for (const r of records) {
    if (!out.has(r.cluster)) out.set(r.cluster, [])
    out.get(r.cluster).push(r)
  }
  return out
}

/** Render one tier file's content. */
function renderTierFile(tier, byCluster) {
  const lines = [`# ${tier.title}`, '', tier.scope, '']

  if (tier.entrypoints?.length) {
    lines.push('## Canonical entrypoints', '')
    lines.push('Start with these public symbols before scanning the full inventory below.', '')
    for (const entry of tier.entrypoints) {
      lines.push(`- ${entry}`)
    }
    lines.push('')
  }

  for (const clusterId of tier.clusters) {
    const recs = byCluster.get(clusterId)
    if (!recs || recs.length === 0) {
      lines.push(`## ${titleCase(clusterId)}`, '', '_(no symbols)_', '')
      continue
    }
    const files = [...new Set(recs.map((r) => r.sourcePath))].sort()
    const { title, blurb, prologue } = clusterMeta(clusterId, files)
    lines.push(`## ${title}`)
    if (blurb) lines.push('', blurb)
    if (prologue) lines.push('', prologue)
    lines.push('')
    for (const rec of recs) lines.push(renderSymbol(rec))
    lines.push('')
  }

  return lines.join('\n').replace(/\n+$/, '\n')
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
    'The mechanical per-symbol surface for the engine. Read in full before assuming a primitive is missing — symbols group by adjacency, not by the vocabulary you arrived with, and partial reads miss real primitives whose names don\'t match the problem you brought in.',
    '',
    'Three ways to land:',
    '',
    '- **Task table** — arriving with a verb ("offline catch-up", "register a new category"). Resolves "which tier file?" without a Read.',
    '- **Concept index** — arriving with a noun-shape an agent might use ("perturbation seam", "tunable knob"). Entries resolve to tier `#section` anchors, plus `consumer-guide.md` for the prose.',
    '- **Cluster directory** — arriving with a rough subsystem in mind. Every public-symbol cluster grouped under its tier.',
    '',
    'Two quick-reference disambiguators (consult before grep-by-stem or choosing a predicate type):',
    '',
    '- **Reserved names** — symbols that share a stem (`Loop` family, etc.).',
    '- **Predicate forms** — choosing between `Gate` / `Requirement` / `Computable<boolean>`.',
    '',
    'Companion docs (do not duplicate — link):',
    '',
    '- `../consumer-guide.md` — *how* to compose the engine; levels of abstraction; what shape a module should take. Concept-index entries link here for prose.',
    '- `../candidate-primitives.md` — engine-primitive gaps consumers have hand-rolled. Grep here before hand-rolling.',
    '',
    'This file is generated by `node scripts/build-api-docs.mjs`. Editing it by hand is meaningless — re-run the generator to regenerate.',
    '',
    '## Choose a level first',
    '',
    'Most game modules should start at the highest-level surface that fits, then drop down only when that surface is fighting the shape of the game. Full prose: ../consumer-guide.md#the-expression-spectrum.',
    '',
    '| Level | Reach for | Start at |',
    '| --- | --- | --- |',
    '| **L1: Resource helpers** | Direct currency mutation, display, checks, and resource lifetime trackers | resources.md#resource |',
    '| **L2: Category systems** | Repeatable authored content: producers, purchasables, achievements, skills, challenges, dialog, subjects | content-systems.md, content-narrative.md |',
    '| **L3: Raw primitives** | One-off systems or custom registration shapes where category mapping is too constraining | content-systems.md, composition.md, mechanics.md, lifecycle.md |',
    '| **L4: Declarative data** | JSON/mod/save/sim-friendly gates and effects | mechanics.md#gate, mechanics.md#effects |',
    '',
    '## Tier map',
    '',
    'Per-tier landing pages in dependency-ascending order — numeric foundation first, headless harness last. This is *not* the L1→L4 consumer-journey ordering from `../consumer-guide.md` § The expression spectrum (helpers → categories → raw → declarative); see the by-abstraction-level lens below for that cut.',
    '',
  ]

  for (const tier of TIER_MANIFEST) {
    lines.push(`- \`${tier.tier}.md\` — ${tier.scope}`)
  }
  lines.push('')

  lines.push(
    '## Reserved names',
    '',
    'A few symbols share a stem and are easy to confuse. Each links to its anchor:',
    '',
    '- **Loop** — loop-incremental gameplay run (Idle Loops, Cavernous, Loopy Loops). `createLoop`. → content-systems.md#loop',
    '- **LoopLog** — per-loop metric delta recorder; observes a `Loop`\'s lifecycle. `createLoopLog`. → content-systems.md#looplog',
    '- **`createReset`** vs **`Loop.thingsToReset`** — `createReset` is the standalone prestige primitive (lifecycle); `Loop` extends `ScopedReset` and carries its own reset list per run.',
    '- **RunPool** — many opaque concurrent runs with per-run lifecycle. `createRunPool`. → harness.md#runpool. Distinct from `Loop` (single constrained-replay run) and from the engine\'s `TickDriver` (tick scheduler).',
    '',
    '## Task → tier',
    '',
    'Common consumer tasks resolved to their starting tier. Land in the tier file and follow its `##` sections to the cluster.',
    '',
    '| Task | Starting tier |',
    '| --- | --- |',
    '| add a new resource | resources.md#resource |',
    '| reactive resource display | resources.md#resource |',
    '| convert resources / crafting recipe / market trade | resources.md#conversion |',
    '| building / generator / passive production | content-systems.md#producer-category |',
    '| upgrade / perk / unlock gate / capped repeatable | content-systems.md#purchasable |',
    '| one-shot milestone reward | content-systems.md#achievement |',
    '| skill XP / level curve | content-systems.md#skill |',
    '| inventory with item capacities | content-systems.md#inventory |',
    '| zone unlocks / named content regions | content-systems.md#zone |',
    '| constrained loadout / persistent selection slot | content-systems.md#slot |',
    '| automation unlock ladder | content-systems.md#automation-tiers |',
    '| modifier bonus stacking on a chain | mechanics.md#modifier |',
    '| inversion-driven cost preview / "max-affordable" | mechanics.md#formulas |',
    '| declarative gate (data-driven condition) | mechanics.md#gate |',
    '| new content category (skill, purchasable, producer, …) | composition.md#category-base |',
    '| dialog tree with branching | content-narrative.md#dialog |',
    '| dialog choice effects / authored outcomes | content-narrative.md#dialog, mechanics.md#effects |',
    '| faction reputation / NPC relationships | content-narrative.md#subject-category |',
    '| achievement tier ladder | content-systems.md#achievement |',
    '| save migration / version bump | lifecycle.md#save-manager |',
    '| offline catch-up after long absence | lifecycle.md#offline |',
    '| prestige / reset with retention policy | lifecycle.md#reset |',
    '| register an engine module | runtime.md#engine-entrypoint |',
    '| subscribe to engine or category events | runtime.md#events |',
    '| time-until-X transition timing | runtime.md#transition-distance-primitives |',
    '| expose a tunable knob to a slider / mod config | introspection.md#override-registry |',
    '| in-game devtools / balance UI / walk all content | introspection.md#engine-categories |',
    '| upcoming unlock / "what changes next?" | harness.md#content-walker, runtime.md#transition-distance-primitives |',
    '| schedule jobs / persona rotation / ordered dispatch | composition.md#sequencer |',
    '| recommendation between loops | advisors.md#recommendation |',
    '| spatial adjacency / grid bonuses | spatial.md#grid, spatial.md#graph |',
    '| balance parameter sweep (multi-variant) | harness.md#cell-aggregation-kernel |',
    '| tune a single balance value to meet a target | harness.md#solvers |',
    '| perturb a modifier to test sensitivity | harness.md#perturbation-applier |',
    '',
    '## Concept index',
    '',
    'Cross-cutting concepts in agent vocabulary, resolved to tier `#section` anchors and `consumer-guide.md` prose. Concepts are higher-level than symbols — the table answers "where do I read about X?" when X is a shape, not a name. Tier anchors give symbol-level detail; consumer-guide anchors give the prose explaining how to think about it.',
    '',
    '- **perturbation seam** — address→override mechanism for the balance workbench → harness.md#perturbation-applier',
    '- **persistent context scoping** — `withPersistentContext`, save-key namespacing → lifecycle.md#persistence, ../consumer-guide.md#persistent-context',
    '- **category auto-registration** — categories self-publish into `EngineCategories` for introspection → introspection.md#engine-categories, ../consumer-guide.md#level-2-category-systems-the-default-for-content',
    '- **modifier attribution** — `BindingRecord`, trace entries, `withChain` scope → mechanics.md#modifier, mechanics.md#trace',
    '- **modifier chain composition** — named chains, `bind`, declarative `grants`/`restricts`/`rewards` → mechanics.md#modifier, ../consumer-guide.md#modifier-chains-and-effects',
    '- **cross-action bonus** — A\'s yield scaled by B\'s state via binary-gate or level-scaled modifier → ../consumer-guide.md#cross-action-bonuses, mechanics.md#modifier',
    '- **predicate-bounded sim** — `runUntil` / `runMatrixUntil`, terminate on shared predicate → harness.md#cell-aggregation-kernel',
    '- **sensitivity sweep** — baseline + variants, per-metric `{absolute, relative}` deltas → harness.md#cell-aggregation-kernel',
    '- **transition distance** — "when does X happen?" math over current state → runtime.md#transition-distance-primitives',
    '- **picker enumeration** — walk modifiers, tunables, content for solvers/UIs → harness.md#picker, ../consumer-guide.md#introspection',
    '- **indirect-control worker pool** — Sequencer + TimedProgress + claim-on-pop, Majesty/DK shape → harness.md#runpool, ../consumer-guide.md#indirect-control-worker-pools',
    '- **persona roster** — keyed vector of personality params, sequencer-strategies selection → ../consumer-guide.md#persona-roster-composition, composition.md#sequencer',
    '- **reset scope** — `ScopedReset`, recursive walking of `thingsToReset` → lifecycle.md#reset, ../consumer-guide.md#resetting-persistent-refs-in-bulk',
    '- **retention across reset** — `keep` (verbatim) vs `retain` (transformed) carry-over → lifecycle.md#retention, ../consumer-guide.md#resetting-persistent-refs-in-bulk',
    '- **save lifecycle hooks** — `SaveHandler` / `LoadHandler` / `save:loaded` events → lifecycle.md#save-manager, runtime.md#engine-entrypoint',
    '- **offline catch-up** — `processOfflineTime`, chunked simulation of elapsed seconds → lifecycle.md#offline',
    '- **tunable knob** — `tunable()` + `TuningRegistry`, scoped-stack override of balance constants → introspection.md#override-registry, ../consumer-guide.md#tunable-knobs',
    '- **declarative gate predicate** — `Gate` AST, evaluable + flip-distance + condition projection → mechanics.md#gate, ../consumer-guide.md#level-4-declarative-gates-and-effects-the-data-driven-escape-hatch',
    '- **predicate form choice** — Gate vs Requirement vs `Computable<boolean>` for gating fields → INDEX.md#predicate-forms, ../consumer-guide.md#level-4-declarative-gates-and-effects-the-data-driven-escape-hatch',
    '- **edge-triggered effect** — `PersistentEffectSystem` rising/falling-edge modifier binding → mechanics.md#effects',
    '- **cost requirement** — `CostRequirement`, bulk-buy via inversion, pay strategies → mechanics.md#requirements, ../consumer-guide.md#choosing-among-purchasable-primitives',
    '- **inversion-driven affordability** — `calculateMaxAffordable`, `InvertibleFormula` → mechanics.md#formulas',
    '- **flow-channel classification** — `FlowChannel`, `classifyFlowChannel`, Csikszentmihalyi-style engagement bands → harness.md#flow-channel',
    '- **closed-form beat timing** — `calculateBeatTiming`, `T(n) = Cost(n) / Production(n)` snapshot for balance/devtools → mechanics.md#beat-timing',
    '- **content registry mod patch** — `registry.patch()` for mod-side definition overrides → composition.md#content-registry, ../consumer-guide.md#level-2-category-systems-the-default-for-content',
    '- **batch-registered category** — `createCategoryBase`, per-def persistent context + mod patch → composition.md#category-base, ../consumer-guide.md#level-2-category-systems-the-default-for-content',
    '- **dialog session vs runtime** — `DialogSession` envelope, swappable `DialogRuntime` adapter → content-narrative.md#dialog, ../consumer-guide.md#dialog-contract-first-runtime-second',
    '- **subject field kinds** — typed multi-field state per subject: scalar / vector / tier / flag / enum → content-narrative.md#subject-category, ../consumer-guide.md#character-interaction-surface',
    '- **best-of run recording** — per-metric best with optional projection, BestOf events → content-systems.md#bestof-tracker',
    '- **loop restart event** — `beforeRestart` / `afterRestart` for loop-incremental cadence → content-systems.md#loop',
    '- **Loop disambiguation** — `Loop` (gameplay) vs `LoopLog` (metrics) vs `RunPool` (many concurrent runs) → INDEX.md#reserved-names',
    '- **recommendation arbitration** — strategies ranked between loops, auto-apply or surface → advisors.md#recommendation',
    '',
    '## Common disambiguators',
    '',
    'Short answers only; consumer-level reasoning lives in ../consumer-guide.md#common-disambiguators.',
    '',
    '| If you mean… | Use… |',
    '| --- | --- |',
    '| Ownership produces continuous flow | `createProducerCategory` → content-systems.md#producer-category |',
    '| Bought state/effect, upgrade, gate, or capped repeatable | `createPurchasableCategory` → content-systems.md#purchasable |',
    '| Observed milestone that auto-earns | `createAchievement` / `createAchievementCategory` → content-systems.md#achievement |',
    '| Generic multi-resource container | `createResourceBag` → resources.md#resource |',
    '| Game-facing item inventory with capacities | `createInventory` → content-systems.md#inventory |',
    '| Engine tick scheduler | `createTickDriver` → runtime.md#tick-driver |',
    '| Loop-incremental gameplay run | `createLoop` → content-systems.md#loop |',
    '| Many opaque concurrent runs | `createRunPool` → harness.md#runpool |',
    '| Ordered schedule or persona dispatch | `createSequencer` and fill strategies → composition.md#sequencer |',
    '| Ranked recommendation / advisory choice | advisors → advisors.md |',
    '| Discover live engine surfaces | introspection registries → introspection.md |',
    '| Execute headless simulations | harness runners → harness.md |',
    '| Bounded coordinate board | `createSpatialGrid` → spatial.md#grid |',
    '| Arbitrary node topology / nested spaces | `createSpatialGraph` → spatial.md#graph |',
    '',
    '## Predicate forms',
    '',
    'Engine fields that gate behavior accept one of three shapes. Pick the most-specific that fits.',
    '',
    '| Form | Shape | Use when | Predictor-friendly | Serializable | Tier anchor |',
    '| --- | --- | --- | --- | --- | --- |',
    '| `Gate` | typed AST (`ResourceGteGate`, `UnlockGate`, `FlagGate`, …) | declarative predicate; want `timeUntilGateFlip` + save/mod/sim serializability | yes (typed) | yes | mechanics.md#gate |',
    '| `Requirement` | cost-bearing predicate with pay strategy | the predicate also charges a resource (cost, bulk-buy via inversion, pay-by-reset / pay-by-division) | partial | no (closures) | mechanics.md#requirements |',
    '| `Computable<boolean>` | ref / computed / getter | typed refs already in scope; no introspection needed; predicate doesn\'t fit dot-paths | no | no | mechanics.md#computed |',
    '',
    'Fields accepting multiple forms: `ChallengeDef.{visible, canStart}` (`Gate` | `boolean`), `ChallengeDef.goal` (`Gate` | closure), `PurchasableOptions.requirements` (`Requirement[]`), `AchievementOptions.requirement` (`Computable<boolean>` | `Gate`). When a field accepts a `Gate`, prefer it — `Gate` is the only form that gives both flip-distance introspection and category awareness without a `GameStateAccessor` mapping.',
    '',
    '**Adapters across forms.** Where a field wants `Requirement` but the predicate is declarative, `createGateRequirement({ gate })` adapts a `Gate` into a no-cost `Requirement` — the Gate stays the source of truth for serializability and `timeUntilGateFlip`. Where the predicate is an opaque closure, `createBooleanRequirement({ requirement })` is the escape hatch (same runtime shape, no introspection). Both keep the chosen form on the *Gate / Computable* side of the boundary; only `createCostRequirement` introduces real cost behaviour.',
    '',
    'Prose: ../consumer-guide.md#level-4-declarative-gates-and-effects-the-data-driven-escape-hatch.',
    '',
    '## Cluster directory',
    '',
    'Every public-symbol cluster across the engine, grouped under its tier. Cluster ids come from `@cluster` source tags or stem fallback; section title and blurb come from the cluster\'s anchor file header.',
    '',
  )

  for (const tier of TIER_MANIFEST) {
    lines.push(`### ${tier.title}`, '')
    for (const clusterId of tier.clusters) {
      const recs = byCluster.get(clusterId) || []
      const files = [...new Set(recs.map((r) => r.sourcePath))].sort()
      const { title, blurb } = clusterMeta(clusterId, files)
      const anchor = `${tier.tier}.md#${slugify(title)}`
      const trimmed = blurb && blurb.length > 120
        ? blurb.slice(0, 117).replace(/\s+\S*$/, '') + '…'
        : blurb
      const blurbPart = trimmed ? ` — ${trimmed}` : ''
      lines.push(`- \`${clusterId}\`${blurbPart} → ${anchor}`)
    }
    lines.push('')
  }

  lines.push(
    '## Lenses',
    '',
    'The default lens is **by-question** — the task table at the top of this file. Two alternative cuts when that framing doesn\'t fit:',
    '',
    '### By abstraction level',
    '',
    'The expression spectrum from `consumer-guide.md`: pick the most specific level that fits, drop down only when the level above is fighting you. Full prose: ../consumer-guide.md#the-expression-spectrum.',
    '',
    '- **L1: Resource helpers** — `addResource`, `subtractResource`, `hasResource`, `displayResource`, `Resource.best`, `Resource.cumulative` → resources.md#resource',
    '- **L2: Category systems** — `createSkillCategory`, `createPurchasableCategory`, `createProducerCategory`, `createAchievementCategory`, `createDialogCategory`, `createSubjectCategory`, … the default for game content → content-systems.md, content-narrative.md',
    '- **L3: Raw primitives** — `createScalingPurchasable`, `createLoop`, `createModifierChain`, `createCategoryBase` → content-systems.md, composition.md, mechanics.md, lifecycle.md',
    '- **L4: Declarative data** — `E` builder, `IEffect`, `Gate`. The data-driven escape hatch for save replay, mod configs, balance tools → mechanics.md#effects, mechanics.md#gate',
    '',
    '### By layer',
    '',
    'Engine source layers `primitives → core → systems → harness` with one-way imports. Tier ≠ layer — most tier files mix layers:',
    '',
    '- **primitives/** — zero-Vue foundational types and helpers (`Decimal`, `RNG`, `IEffect` types, `Analyzer` shape).',
    '- **core/** — generic reactive primitives (modifiers, effects, persistence, save manager, game loop, transitions).',
    '- **systems/** — typed registration surfaces (every category factory; reset / retention; dialog runtime; advisors; gate).',
    '- **harness/** — headless-sim substrate (runners, probes, walkers, picker, perturbation, solvers, run pool).',
    '',
    'Open `dist/index.d.ts` after a build for the canonical layer split — `parse-dts.mjs` derives each symbol\'s layer from its source file.',
    '',
    '## Internals',
    '',
    'Per-symbol detail lives in the eleven tier files. Cluster ids come from `@cluster` tags in source-file headers — see CLAUDE.md "TSDoc Standards" for the convention. To move a cluster between tiers, edit `scripts/lib/api-tier-manifest.mjs`; no source-file edits required.',
    ''
  )

  return lines.join('\n').replace(/\n+$/, '\n')
}

// --- Main ---

if (!existsSync(ENGINE_ROOT_DTS)) {
  console.error(`Missing ${ENGINE_ROOT_DTS} — run \`pnpm build\` first`)
  process.exit(1)
}

const { records: allRecords, unresolved } = parseEntrypoint(ENGINE_ROOT_DTS)
const records = allRecords.filter((r) => r.tag === 'public')
const byCluster = bucketByCluster(records)

// Validate every cluster has exactly one tier slot.
const manifestClusters = new Set()
const dupes = []
for (const tier of TIER_MANIFEST) {
  for (const c of tier.clusters) {
    if (manifestClusters.has(c)) dupes.push(c)
    manifestClusters.add(c)
  }
}
const parsedClusters = new Set(byCluster.keys())
const unassigned = [...parsedClusters].filter((c) => !manifestClusters.has(c)).sort()
const dangling = [...manifestClusters].filter((c) => !parsedClusters.has(c)).sort()

if (dupes.length) {
  console.error(`Manifest has duplicate cluster ids: ${dupes.join(', ')}`)
  process.exit(1)
}
if (unassigned.length) {
  console.error(
    `Clusters not assigned to any tier:\n  ${unassigned.join('\n  ')}\n` +
      `Add them to scripts/lib/api-tier-manifest.mjs`
  )
  process.exit(1)
}

// Render tier files.
for (const tier of TIER_MANIFEST) {
  const content = renderTierFile(tier, byCluster)
  writeFileSync(join(API_DIR, `${tier.tier}.md`), content)
}

// Render INDEX.md.
writeFileSync(join(API_DIR, 'INDEX.md'), renderIndex(byCluster))

// Coverage report — `records` is already filtered to public symbols above.
const missingSummary = records.filter((r) => !r.tsdocSummary)
const missingLine = records.filter((r) => r.line == null)

console.log(
  `Wrote ${TIER_MANIFEST.length} tier files + INDEX.md — ${records.length} symbols across ${parsedClusters.size} clusters`
)
if (dangling.length) {
  console.warn(`  ${dangling.length} cluster(s) in manifest with no symbols: ${dangling.join(', ')}`)
}
if (missingSummary.length) {
  console.warn(`  ${missingSummary.length} public symbol(s) without TSDoc summary`)
  for (const r of missingSummary.slice(0, 10)) {
    console.warn(`    ${r.sourcePath}:${r.line ?? '?'}  ${r.name}`)
  }
  if (missingSummary.length > 10) console.warn(`    … +${missingSummary.length - 10} more`)
}
if (missingLine.length) {
  console.warn(`  ${missingLine.length} public symbol(s) without resolved source line`)
}
if (unresolved.length) {
  console.warn(`  ${unresolved.length} unresolved alias(es): ${unresolved.slice(0, 5).join(', ')}${unresolved.length > 5 ? '…' : ''}`)
}
