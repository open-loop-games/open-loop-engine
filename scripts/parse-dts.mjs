#!/usr/bin/env node
/**
 * Walk `dist/index.d.ts` and emit per-symbol metadata for the docs pipeline.
 *
 * Walks just the root entrypoint via the TypeScript compiler API; TS resolves
 * the re-export tree (`export * from './primitives'` etc.) automatically, so
 * cross-layer dedup happens naturally — every symbol resolves to one
 * declaration site, which pins it to its source layer.
 *
 * Each public symbol becomes one record:
 *   {
 *     name, kind, signature, tsdocSummary,
 *     sourcePath, line, layer, cluster, tag
 *   }
 *
 * Reads:
 *   dist/index.d.ts  (must exist — run `pnpm build` first)
 *
 * Writes:
 *   temp/api/symbols.json
 *
 * Run: `node scripts/parse-dts.mjs`
 */
import { writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, dirname, sep } from 'node:path'
import ts from 'typescript'
import {
  ROOT,
  findDeclarationLine,
  parseFileHeader,
  clusterFor,
  stripTsdocLinks,
} from './lib/source-meta.mjs'

const ENGINE_ROOT_DTS = join(ROOT, 'dist', 'index.d.ts')
const ENGINE_OUT_DIR = join(ROOT, 'temp', 'api')
const ENGINE_OUT_FILE = join(ENGINE_OUT_DIR, 'symbols.json')

/**
 * Build the "in-project" predicate for a given dist root. External package
 * declarations (transitive `eternal_notations` types) fail this check and the
 * resolver anchors them at the engine-side re-export point instead.
 */
function makeIsInProject(rootDts) {
  const distRoot = dirname(rootDts)
  return (filename) => filename.startsWith(distRoot + sep) || filename === rootDts
}

const KIND_FROM_NODE = new Map([
  [ts.SyntaxKind.FunctionDeclaration, 'function'],
  [ts.SyntaxKind.InterfaceDeclaration, 'interface'],
  [ts.SyntaxKind.TypeAliasDeclaration, 'type'],
  [ts.SyntaxKind.EnumDeclaration, 'enum'],
])

/**
 * Resolve an exported symbol to two declarations:
 *   - `terminal`: the actual declaration (provides kind, JSDoc, signature).
 *     For external re-exports (e.g. `Notation` from `eternal_notations`) this
 *     lives in `node_modules/` and gives us the right kind/shape.
 *   - `anchor`: the in-project source file we point readers at — the terminal
 *     when in-project, otherwise the last engine-side ExportSpecifier in the
 *     alias chain (typically the re-exporting file like `primitives/notations`).
 *
 * Splitting these lets external re-exports show up under the engine layer that
 * owns the re-export, while their kind/signature still comes from the real
 * declaration upstream.
 */
function resolveDeclaration(symbol, checker, isInProject) {
  let sym = symbol
  let anchorDecl = null

  // Walk one alias hop at a time (not `getAliasedSymbol` which collapses the
  // whole chain). Stepwise traversal lets us pin the anchor to the deepest
  // in-project ExportSpecifier — for external re-exports like
  // `eternal_notations`, that's the re-exporting file (e.g.
  // `src/primitives/notations.ts`), not the top-level barrel.
  while (sym) {
    const inProjectDecl = sym.declarations?.find((d) =>
      isInProject(d.getSourceFile().fileName)
    )
    if (inProjectDecl) anchorDecl = inProjectDecl

    if (!(sym.flags & ts.SymbolFlags.Alias)) break
    const next = checker.getImmediateAliasedSymbol(sym)
    if (!next || next === sym) break
    sym = next
  }

  const terminalDecl = sym?.declarations?.[0]
  if (!terminalDecl) return null

  return {
    symbol: sym,
    terminal: terminalDecl,
    anchor: anchorDecl || terminalDecl,
  }
}

/**
 * Map a TS AST node to one of the kinds the docs pipeline emits.
 * `class` distinguishes `abstract class` via the modifier; `const` covers
 * exported values declared via `VariableStatement`.
 */
function kindFromDeclaration(decl) {
  if (KIND_FROM_NODE.has(decl.kind)) return KIND_FROM_NODE.get(decl.kind)

  if (ts.isClassDeclaration(decl)) {
    const isAbstract = ts.getCombinedModifierFlags(decl) & ts.ModifierFlags.Abstract
    return isAbstract ? 'abstract-class' : 'class'
  }

  // `export const foo = ...` → VariableDeclaration nested under VariableStatement
  if (ts.isVariableDeclaration(decl)) return 'const'
  if (ts.isVariableStatement(decl)) return 'const'

  // Function overloads can present as multiple FunctionDeclarations; the loop
  // in KIND_FROM_NODE already handles that. Method/property signatures inside
  // interfaces shouldn't reach here — we only inspect top-level exports.
  return null
}

/**
 * Extract the first sentence of the symbol's TSDoc, stripped of `{@link}`
 * syntax and trailing markdown links. Looks at JSDoc on the declaration; for
 * function overloads, the first declaration's comment is canonical.
 *
 * Returns the empty string when the symbol has no TSDoc summary — the docs
 * generator (OL-929) treats that as a coverage gap.
 */
function extractTsdocSummary(declaration) {
  const jsDoc = ts.getJSDocCommentsAndTags(declaration).find((d) => ts.isJSDoc(d))
  if (!jsDoc) return ''

  const comment = jsDoc.comment
  if (!comment) return ''

  let text
  if (typeof comment === 'string') {
    text = comment
  } else {
    // NodeArray<JSDocComment> — concatenate text spans, expanding {@link} nodes
    text = comment
      .map((c) => {
        if (c.kind === ts.SyntaxKind.JSDocLink || c.kind === ts.SyntaxKind.JSDocLinkCode || c.kind === ts.SyntaxKind.JSDocLinkPlain) {
          const name = c.name ? c.name.getText() : ''
          return c.text ? c.text.trim() : name
        }
        return c.text || ''
      })
      .join('')
  }

  // First sentence: up to the first `. ` or end of paragraph (blank line).
  const paragraphEnd = text.search(/\n\s*\n/)
  if (paragraphEnd !== -1) text = text.slice(0, paragraphEnd)

  const sentenceEnd = text.search(/\.(?:\s|$)/)
  if (sentenceEnd !== -1) text = text.slice(0, sentenceEnd + 1)

  return stripTsdocLinks(text).replace(/\s+/g, ' ').trim()
}

/**
 * Check for `@internal` among a declaration's JSDoc tags. Used to split the
 * public surface from internals — internal symbols still flow through the
 * pipeline (consumers may need to read them) but get tagged for filtering.
 */
function hasInternalTag(declaration) {
  return ts.getJSDocTags(declaration).some((tag) => tag.tagName.text === 'internal')
}

/**
 * One-line signature: the declaration text with leading JSDoc stripped (TS
 * doesn't include the JSDoc trivia in `getText()` on a declaration node) and
 * runs of whitespace collapsed. Trailing function bodies are absent in `.d.ts`,
 * so this is naturally a declaration-only string.
 */
function extractSignature(declaration) {
  // VariableDeclaration loses its `export declare const` wrapper when
  // `getText()`'d alone — climb to the enclosing VariableStatement so the
  // signature includes the modifiers, matching how the symbol appears in .d.ts.
  let node = declaration
  if (ts.isVariableDeclaration(node)) {
    let p = node.parent
    while (p && !ts.isVariableStatement(p)) p = p.parent
    if (p) node = p
  }

  // For interfaces/classes, `getText()` includes the body — fine for short
  // bodies but for richly-documented members (OverrideRegistry) the signature
  // balloons to hundreds of chars and breaks the tier file's scan pattern.
  // Truncate at the body's opening brace so the signature is just the header.
  if (ts.isInterfaceDeclaration(node) || ts.isClassDeclaration(node)) {
    const openBrace = node.getChildren().find((c) => c.kind === ts.SyntaxKind.OpenBraceToken)
    if (openBrace) {
      const sourceText = node.getSourceFile().text
      const header = sourceText.slice(node.getStart(), openBrace.getStart())
      return header.replace(/\s+/g, ' ').trim()
    }
  }

  let text = node.getText()
  text = text.replace(/^\s*\/\*\*[\s\S]*?\*\/\s*/, '')
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * Map `dist/<rel>.d.ts` → `src/<rel>.ts`. Falls back to the input path when it
 * isn't under `dist/` (shouldn't happen in normal runs).
 */
function distToSrc(distPath) {
  const norm = distPath.split(sep).join('/')
  const distIdx = norm.lastIndexOf('/dist/')
  if (distIdx === -1) {
    // Possibly already a src path, or running from a tarball — pass through.
    return norm.replace(/^.*\/(src\/.*)$/, '$1').replace(/\.d\.ts$/, '.ts')
  }
  return norm
    .slice(distIdx + 1)
    .replace(/^dist\//, 'src/')
    .replace(/\.d\.ts$/, '.ts')
}

/**
 * Layer derivation from a repo-relative src path. `src/index.ts` is the engine
 * façade and gets its own layer id so the tier manifest can route those symbols
 * (`createEngine`, `Engine`, `EngineContext`, etc.) without colliding with the
 * four real layers.
 */
function layerFromSrcPath(srcPath) {
  const m = srcPath.match(/^src\/([^/]+)(?:\/|$)/)
  if (!m) return 'unknown'
  const top = m[1]
  if (top === 'index.ts') return 'engine'
  if (['primitives', 'core', 'systems', 'harness'].includes(top)) return top
  return top
}

/**
 * Parse all public symbols reachable from `rootDts` and return them as records.
 *
 * @param {string} rootDts  Absolute path to the entrypoint `.d.ts`.
 * @param {{ projectRoot?: string }} [opts]
 *   `projectRoot` — repo root used to resolve `src/...` paths for source-grep
 *   and header parsing. Defaults to the engine root.
 * @returns {{ records: object[], unresolved: string[] }}
 */
export function parseEntrypoint(rootDts, opts = {}) {
  const projectRoot = opts.projectRoot ?? ROOT
  const isInProject = makeIsInProject(rootDts)

  const program = ts.createProgram({
    rootNames: [rootDts],
    options: {
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      allowJs: false,
      declaration: false,
      noEmit: true,
      skipLibCheck: true,
    },
  })

  const checker = program.getTypeChecker()
  const rootSource = program.getSourceFile(rootDts)
  if (!rootSource) throw new Error(`TS could not load ${rootDts}`)

  const moduleSymbol = checker.getSymbolAtLocation(rootSource)
  if (!moduleSymbol) throw new Error(`Could not resolve module symbol for ${rootDts}`)

  const exports = checker.getExportsOfModule(moduleSymbol)

  const headerCache = new Map()
  const getHeader = (srcPath) => {
    if (headerCache.has(srcPath)) return headerCache.get(srcPath)
    const abs = join(projectRoot, srcPath)
    const h = existsSync(abs) ? parseFileHeader(abs) : {}
    headerCache.set(srcPath, h)
    return h
  }

  const records = []
  const unresolved = []

  for (const exp of exports) {
    const resolved = resolveDeclaration(exp, checker, isInProject)
    if (!resolved) {
      unresolved.push(exp.name)
      continue
    }

    const { terminal, anchor, symbol } = resolved
    const kind = kindFromDeclaration(terminal)
    if (!kind) continue

    const declName = terminal.name?.getText?.()
    const name = symbol.name === 'default' && declName ? declName : symbol.name

    const srcPath = distToSrc(anchor.getSourceFile().fileName)
    const layer = layerFromSrcPath(srcPath)
    const header = getHeader(srcPath)
    const cluster = clusterFor(srcPath, header)
    const line = findDeclarationLine(srcPath, name, kind, projectRoot)

    records.push({
      name,
      kind,
      signature: extractSignature(terminal),
      tsdocSummary: extractTsdocSummary(terminal),
      sourcePath: srcPath,
      line,
      layer,
      cluster,
      tag: hasInternalTag(terminal) ? 'internal' : 'public',
    })
  }

  records.sort((a, b) => {
    if (a.layer !== b.layer) return a.layer.localeCompare(b.layer)
    if (a.cluster !== b.cluster) return a.cluster.localeCompare(b.cluster)
    return a.name.localeCompare(b.name)
  })

  return { records, unresolved }
}

// --- CLI ---

const isCLI = import.meta.url === `file://${process.argv[1]}`
if (isCLI) {
  if (!existsSync(ENGINE_ROOT_DTS)) {
    console.error(`Missing ${ENGINE_ROOT_DTS} — run \`pnpm build\` first`)
    process.exit(1)
  }

  const { records, unresolved } = parseEntrypoint(ENGINE_ROOT_DTS)

  mkdirSync(ENGINE_OUT_DIR, { recursive: true })
  writeFileSync(ENGINE_OUT_FILE, JSON.stringify(records, null, 2) + '\n')

  const byLayer = new Map()
  let publicCount = 0
  let internalCount = 0
  let missingLine = 0
  let missingSummary = 0
  for (const r of records) {
    byLayer.set(r.layer, (byLayer.get(r.layer) || 0) + 1)
    if (r.tag === 'internal') internalCount++
    else publicCount++
    if (r.line == null) missingLine++
    if (!r.tsdocSummary) missingSummary++
  }

  console.log(`Parsed ${records.length} symbols from dist/index.d.ts`)
  console.log(`  public:   ${publicCount}`)
  console.log(`  internal: ${internalCount}`)
  for (const [layer, count] of [...byLayer.entries()].sort()) {
    console.log(`  ${layer.padEnd(11)} ${count}`)
  }
  if (missingLine > 0) console.log(`  ${missingLine} without resolved src line`)
  if (missingSummary > 0) console.log(`  ${missingSummary} without TSDoc summary`)
  if (unresolved.length > 0) {
    console.log(
      `  ${unresolved.length} unresolved aliases: ${unresolved.slice(0, 5).join(', ')}${unresolved.length > 5 ? '…' : ''}`
    )
  }
  console.log(`→ ${ENGINE_OUT_FILE.replace(ROOT + '/', '')}`)
}
