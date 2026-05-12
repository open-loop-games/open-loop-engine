/**
 * Shared source-introspection helpers for API-docs tooling.
 *
 * Consumed by `parse-dts.mjs` (per-symbol metadata walked from
 * `dist/index.d.ts`) and `build-api-docs.mjs` (cluster titles + anchor headers).
 *
 * Everything here reads `src/**` directly. `findDeclarationLine` greps the
 * source file for the symbol's declaration; `parseFileHeader` parses the file's
 * leading TSDoc for title, blurb, and `@cluster` tag. Cluster bucketing
 * precedence: `@cluster` tag → CLUSTER_OVERRIDES → subdir name → file stem.
 */
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
export const ROOT = join(__dirname, '..', '..')

/**
 * Cross-file cluster overrides for files that don't (or can't) declare
 * `@cluster <name>` in their header TSDoc. Prefer adding the tag in source so
 * the cluster lives next to the code; this map exists as an escape hatch.
 */
export const CLUSTER_OVERRIDES = {
  // (currently empty — every cross-file cluster declares @cluster in source)
}

/**
 * Override the auto-derived title/blurb for a cluster id. Use when no anchor
 * file's header is suitable (e.g. the cluster spans a subdir whose `index.ts`
 * has no header). Both fields optional.
 */
export const CLUSTER_TITLES = {
  'spatial-grid': {
    title: 'Grid',
    blurb: 'Bounded 2D grid with adjacency, BFS, FOV adapter, and snapshot persistence. Shared coordinate types (`GridCoord`, `PassabilityFn`, `Unsubscribe`) sit here.',
  },
  'spatial-graph': {
    title: 'Graph',
    blurb: 'Keyed node/edge container with nested child-graph composition — the substrate `ScopeStack` walks.',
  },
  'spatial-scope-stack': {
    title: 'Scope stack',
    blurb: 'Stack navigator over a recursive `SpatialGraph` — tracks which nested child graph is currently active.',
  },
  'spatial-influence-layer': {
    title: 'Influence layer',
    blurb: 'Utility-function layer over `SpatialGrid<number>` — the per-frame propagation/decay lifecycle that turns a numeric grid into an influence map.',
  },
  formulas: {
    title: 'Formulas',
    blurb: 'Algebraic expression trees with evaluate / invert / integrate.',
  },
  probe: {
    title: 'Probes',
    blurb:
      'Seed-sweep runners. `runProbe` collects per-beat termination-time distributions (with optional `targetWindow` → `inWindow` classification); `runWaypointProbe` returns consumer-shaped snapshots at scheduled waypoints. Both dispatch on `RunMode` (`tick` / `event` / `stasis-aware-tick`) inherited from `runMatrixUntil`.',
  },
  picker: {
    title: 'Picker',
    blurb: 'Walk engine state to enumerate addressable choices for solvers / UIs.',
  },
  walker: {
    title: 'Content walker',
    blurb: 'Enumerate purchasables, producers, and challenges with their next-transition timing.',
  },
  analyzers: {
    title: 'Analyzers',
    blurb: 'Reusable in-run trackers (resource peaks, loop finalize, default pack).',
  },
  solve: {
    title: 'Solvers',
    blurb: 'Tune a parameter to satisfy a predicate (bisection, etc.).',
  },
  purchasable: {
    prologue:
      'Three factories in increasing flexibility: `createSimplePurchasable` for static one-shot costs, `createScalingPurchasable` for leveled geometric scaling, `createPurchasable` for arbitrary requirements. See consumer-guide.md §Choosing among purchasable primitives.',
  },
}

const fileCache = new Map()
function readFileLines(absPath) {
  let lines = fileCache.get(absPath)
  if (!lines) {
    lines = readFileSync(absPath, 'utf-8').split('\n')
    fileCache.set(absPath, lines)
  }
  return lines
}

/**
 * Grep the source file for the line where `symbolName` is declared.
 * Returns 1-based line number, or `null` when neither an `export` form nor a
 * locally-declared-then-re-exported form matches.
 *
 * `sourcePath` is repo-relative (e.g. `src/core/resource.ts`); `kind` is the
 * symbol's declared kind (`function` | `interface` | `type` | `const` |
 * `class` | `abstract-class` | `enum`). `projectRoot` overrides the default
 * repo root for tests / alternative project layouts.
 */
export function findDeclarationLine(sourcePath, symbolName, kind, projectRoot = ROOT) {
  if (!sourcePath) return null
  const abs = join(projectRoot, sourcePath)
  if (!existsSync(abs)) return null

  const lines = readFileLines(abs)

  const kindPattern =
    kind === 'abstract-class'
      ? 'abstract\\s+class'
      : 'function|class|interface|type|const|let|var|enum'
  const declRe = new RegExp(
    `^\\s*export\\s+(?:async\\s+|declare\\s+|default\\s+)?(?:${kindPattern})\\s+${symbolName}\\b`
  )
  for (let i = 0; i < lines.length; i++) {
    if (declRe.test(lines[i])) return i + 1
  }
  // Fallback: top-level non-export declaration that gets re-exported via an
  // `export { ... }` clause later in the file.
  const localRe = new RegExp(
    `^\\s*(?:async\\s+)?(?:${kindPattern})\\s+${symbolName}\\b`
  )
  for (let i = 0; i < lines.length; i++) {
    if (localRe.test(lines[i])) return i + 1
  }
  return null
}

/**
 * Parse the file-header TSDoc in `absPath` for:
 *   title   — first non-empty line if it contains `Title — Blurb`, else null
 *             (callers fall back to titleCase(clusterId))
 *   blurb   — text after the dash, OR the entire first paragraph when there's no dash
 *   cluster — `@cluster <name>` tag, if present
 *
 * A file header is the first `/** ... *\/` in the file with only whitespace
 * and line comments before it, and not immediately followed by a declaration
 * (which would make it a symbol's doc).
 */
export function parseFileHeader(absPath) {
  const content = readFileSync(absPath, 'utf-8')
  const start = content.indexOf('/**')
  if (start === -1) return {}
  const end = content.indexOf('*/', start)
  if (end === -1) return {}

  const before = content.slice(0, start)
  if (/[^\s]/.test(before.replace(/\/\/[^\n]*/g, ''))) {
    return {} // there's code before the first /**
  }

  // A doc followed directly by a declaration belongs to that symbol.
  // `export * from` and `export { ... }` re-exports don't count.
  const after = content.slice(end + 2).trimStart()
  if (
    /^(function|class|interface|type|const|let|var|enum|abstract)\b/.test(after) ||
    /^export\s+(?:async\s+|declare\s+)?(function|class|interface|type|const|let|var|enum|abstract)\b/.test(after)
  ) {
    return {}
  }

  const block = content.slice(start + 3, end)
  const rawLines = block
    .split('\n')
    .map((l) => l.replace(/^\s*\*\s?/, '').replace(/\s+$/, ''))

  let i = 0
  while (i < rawLines.length && !rawLines[i].trim()) i++
  if (i >= rawLines.length) return {}

  const para = []
  while (
    i < rawLines.length &&
    rawLines[i].trim() &&
    !rawLines[i].trim().startsWith('@')
  ) {
    para.push(rawLines[i].trim())
    i++
  }
  const firstPara = para.join(' ').replace(/\s+/g, ' ')

  let title = null
  let blurb = null

  // Hyphen first (literal in char class), then en/em-dash in ascending order —
  // anything else risks a reversed-range SyntaxError.
  const dashMatch = firstPara.match(/^(.+?)\s+[-–—]\s+(.+)$/)
  if (dashMatch) {
    title = dashMatch[1].trim()
    blurb = dashMatch[2].trim()
  } else {
    blurb = firstPara.trim()
  }

  if (title) title = stripTsdocLinks(title).replace(/\s+(system|systems|helpers?)\s*$/i, '').trim()
  if (blurb) blurb = stripTsdocLinks(blurb).replace(/\s*\.$/, '').trim()

  let cluster = null
  for (const line of rawLines) {
    const m = line.match(/^@cluster\s+([\w-]+)/)
    if (m) {
      cluster = m[1]
      break
    }
  }

  return { title: title || null, blurb: blurb || null, cluster }
}

/**
 * Strip TSDoc link syntax to plain text. `{@link Foo}` → `_Foo_`,
 * `{@link Foo | label}` → `_label_`. Italics keep bare names visually distinct
 * as cross-references.
 */
export function stripTsdocLinks(s) {
  return s
    .replace(/\{@link\s+([^}|]+?)\s*\|\s*([^}]+)\}/g, '_$2_')
    .replace(/\{@link\s+([^}]+)\}/g, '_$1_')
}

/**
 * Resolve a file's cluster id. Precedence:
 *   1. `@cluster <name>` tag in the file's header TSDoc
 *   2. CLUSTER_OVERRIDES entry keyed by the repo-relative path
 *   3. Subdir name under the layer root (`src/<layer>/<subdir>/...`)
 *   4. File stem
 */
export function clusterFor(filePath, header) {
  if (header?.cluster) return header.cluster
  if (CLUSTER_OVERRIDES[filePath]) return CLUSTER_OVERRIDES[filePath]
  const parts = filePath.split('/')
  if (parts.length >= 4) return parts[2]
  return basename(filePath, '.ts')
}

export function titleCase(slug) {
  return slug.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}
