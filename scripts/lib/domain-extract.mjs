/**
 * Domain-language extractor — structure-sourced vocabulary, is-a relations, and
 * a field-name reference graph for a single consumer game's domain.
 *
 * Consumers lack the engine's tsdoc discipline, so the source of truth is CODE
 * STRUCTURE, not prose: TS enums and string-literal/discriminated unions carry
 * the vocabulary (enum/union membership = is-a), `*Def`-style interfaces carry
 * the def inventory, and untyped IDs in named fields (`requiredExplorations:
 * number[]`) carry the domain edges — which type-graph tools (knip,
 * dependency-cruiser, findReferences) miss because the relationships are
 * name-encoded, not type-encoded.
 *
 * Two invariants make the output a per-GAME map rather than a union of the whole
 * dependency graph:
 *   1. Scope is a hard boundary — we add only the config's scope globs and never
 *      `resolveSourceFileDependencies()`. Resolving deps pulls the engine type
 *      graph in through the workspace symlink (whose real path has no
 *      `node_modules` segment, so a path filter can't catch it) and the map
 *      fills with engine vocabulary.
 *   2. Only EXPORTED declarations are owners. The checker flattens an
 *      interface's base props into each union arm, so a non-exported base
 *      (`ActionDefBase`) contributes its fields through the exported union
 *      (`ActionDef`) without producing duplicate base-vs-arm edges.
 *
 * @cluster domain-map
 */
import { createRequire } from 'node:module'

/**
 * ts-morph is an optional peer dependency — declared in package.json
 * `peerDependenciesMeta` as optional so the engine install stays lean.
 * Loaded lazily so importing this module never fails; only running the
 * extractor without ts-morph installed does, with an actionable message.
 */
function loadProject() {
  try {
    const require = createRequire(import.meta.url)
    return require('ts-morph').Project
  } catch {
    throw new Error(
      'ol-domain-map requires ts-morph, which is an optional peer dependency of ' +
        '@open-loop/engine. Install it in your project: pnpm add -D ts-morph',
    )
  }
}

// === CONSTANTS ===

/** Discriminator field names probed on union members for is-a arms. */
const DISCRIMINATORS = ['type', 'kind', 'tier']

/** Trailing field-name tokens that mark a reference, not a domain noun. */
const REF_SUFFIX_TOKENS = new Set(['id', 'ids', 'num', 'nums', 'key', 'keys', 'ref', 'refs'])

// === TOKENIZATION ===

/** Split a camelCase / snake identifier into lowercase word tokens. */
function tokenize(name) {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
}

/**
 * Conservative singularize. Deliberately leaves `status` → `statu` (not `stat`)
 * so it can't masquerade as the `stat` noun — the false positive the stopword
 * guard would otherwise have to catch by hand.
 */
function singular(tok) {
  if (tok.length <= 2) return tok
  if (tok.endsWith('ies')) return tok.slice(0, -3) + 'y'
  if (/(ses|xes|zes|ches|shes)$/.test(tok)) return tok.slice(0, -2)
  if (tok.endsWith('ss')) return tok
  if (tok.endsWith('s')) return tok.slice(0, -1)
  return tok
}

const tokensOf = (name) => tokenize(name).map(singular)

/** True when `needle` tokens occur as a contiguous run inside `hay` tokens. */
function containsSubsequence(hay, needle) {
  if (needle.length === 0 || needle.length > hay.length) return false
  for (let i = 0; i + needle.length <= hay.length; i++) {
    let ok = true
    for (let j = 0; j < needle.length; j++) {
      if (hay[i + j] !== needle[j]) { ok = false; break }
    }
    if (ok) return true
  }
  return false
}

// === DECLARATION COLLECTION ===

/** Strip the first matching def-suffix; returns null when none match. */
function defStem(name, defSuffixes) {
  for (const sfx of defSuffixes) {
    if (name.length > sfx.length && name.endsWith(sfx)) {
      const stem = name.slice(0, -sfx.length)
      return stem[0].toLowerCase() + stem.slice(1)
    }
  }
  return null
}

const matchesAny = (name, suffixes) => suffixes.some((s) => name.endsWith(s))

// === EXTRACTOR ===

/**
 * Extract the domain map for one game.
 *
 * @param {object} config  Dialect config (see build-domain-map.mjs typedef).
 * @param {object} [opts]
 * @param {string} [opts.rootDir]  Base dir scope globs resolve against (the
 *   config file's directory). Defaults to cwd.
 * @returns {{ defs: string[], vocabulary: Array<{owner:string,kind:string,arms:string[]}>,
 *   edges: Array<{from:string,to:string}>, thinSpots: string[], fileCount: number }}
 */
export function extractDomain(config, opts = {}) {
  const rootDir = opts.rootDir ?? process.cwd()
  const defSuffixes = config.defSuffixes ?? ['Def']
  const viewSuffixes = config.viewSuffixes ?? ['State', 'GameState']
  const stopwords = new Set((config.stopwords ?? []).map((s) => s.toLowerCase()))

  const Project = loadProject()
  const project = new Project({
    compilerOptions: { skipLibCheck: true, allowJs: false },
    skipAddingFilesFromTsConfig: true,
  })
  const added = []
  for (const glob of config.scope) {
    const abs = glob.startsWith('/') ? glob : `${rootDir}/${glob}`
    added.push(...project.addSourceFilesAtPaths(abs))
  }
  // Invariant 1: no resolveSourceFileDependencies — scope stays the boundary.
  const files = added

  // Exported declarations only (invariant 2). Owners = interfaces + type-aliases;
  // enums + unions additionally carry vocabulary.
  const interfaces = []
  const typeAliases = []
  const enums = []
  for (const sf of files) {
    for (const i of sf.getInterfaces()) if (i.isExported()) interfaces.push(i)
    for (const t of sf.getTypeAliases()) if (t.isExported()) typeAliases.push(t)
    for (const e of sf.getEnums()) if (e.isExported()) enums.push(e)
  }

  // --- DEF INVENTORY ---
  const defs = []
  for (const decl of [...interfaces, ...typeAliases]) {
    const n = decl.getName()
    if (matchesAny(n, viewSuffixes)) continue
    if (matchesAny(n, defSuffixes)) defs.push(n)
  }

  // --- VOCABULARY (is-a) ---
  const vocabulary = []
  for (const e of enums) {
    vocabulary.push({ owner: e.getName(), kind: 'enum', arms: e.getMembers().map((m) => m.getName()) })
  }
  for (const ta of typeAliases) {
    const t = ta.getType()
    if (!t.isUnion()) continue
    const members = t.getUnionTypes()
    const bare = members.filter((u) => u.isStringLiteral()).map((u) => u.getLiteralValue())
    if (bare.length === members.length && bare.length > 1) {
      vocabulary.push({ owner: ta.getName(), kind: 'union', arms: bare })
      continue
    }
    for (const disc of DISCRIMINATORS) {
      const arms = []
      for (const member of members) {
        const prop = member.getProperty(disc)
        if (!prop) { arms.length = 0; break }
        const pt = prop.getTypeAtLocation(ta)
        if (pt.isStringLiteral()) arms.push(pt.getLiteralValue())
        else { arms.length = 0; break }
      }
      if (arms.length > 1) {
        vocabulary.push({ owner: `${ta.getName()}.${disc}`, kind: 'discriminator', arms })
        break
      }
    }
  }

  // --- EDGE GRAPH ---
  // Nouns: auto-seeded from def stems unless config supplies them. Longest
  // (most tokens) first so multi-word nouns (`progressVar`) win over a prefix.
  const seeded = config.nouns ?? defs.map((d) => defStem(d, defSuffixes)).filter(Boolean)
  const nouns = [...new Set(seeded)]
    .map((n) => ({ noun: n, tokens: tokensOf(n) }))
    .filter((n) => n.tokens.length > 0)
    .sort((a, b) => b.tokens.length - a.tokens.length)

  const ownerFields = [] // { owner, field }
  for (const i of interfaces) {
    for (const p of i.getProperties()) ownerFields.push({ owner: i.getName(), field: p.getName() })
  }
  for (const ta of typeAliases) {
    const t = ta.getType()
    if (t.isUnion()) {
      const seen = new Set()
      for (const arm of t.getUnionTypes()) {
        for (const p of arm.getProperties()) {
          if (seen.has(p.getName())) continue
          seen.add(p.getName())
          ownerFields.push({ owner: ta.getName(), field: p.getName() })
        }
      }
    } else {
      for (const p of t.getProperties?.() ?? []) ownerFields.push({ owner: ta.getName(), field: p.getName() })
    }
  }

  const edgeSet = new Set()
  const edges = []
  for (const { owner, field } of ownerFields) {
    if (stopwords.has(field.toLowerCase())) continue
    let fieldTokens = tokensOf(field)
    while (fieldTokens.length > 1 && REF_SUFFIX_TOKENS.has(fieldTokens[fieldTokens.length - 1])) {
      fieldTokens = fieldTokens.slice(0, -1)
    }
    const hit = nouns.find((n) => containsSubsequence(fieldTokens, n.tokens))
    if (!hit) continue
    if (defStem(owner, defSuffixes) === hit.noun) continue // skip self-reference
    const key = `${owner}.${field}\x00${hit.noun}`
    if (edgeSet.has(key)) continue
    edgeSet.add(key)
    edges.push({ from: `${owner}.${field}`, to: hit.noun })
  }

  // --- THIN SPOTS --- defs with no vocabulary and no incident edge: curated residue candidates.
  const vocabOwners = new Set(vocabulary.map((v) => v.owner.split('.')[0]))
  const edgedStems = new Set()
  for (const e of edges) {
    const stem = defStem(e.from.split('.')[0], defSuffixes)
    if (stem) edgedStems.add(stem)
    edgedStems.add(e.to)
  }
  const thinSpots = defs.filter((d) => {
    if (vocabOwners.has(d)) return false
    const stem = defStem(d, defSuffixes)
    return !(stem && edgedStems.has(stem))
  })

  return {
    defs: [...new Set(defs)].sort(),
    vocabulary,
    edges,
    thinSpots,
    fileCount: files.length,
  }
}
