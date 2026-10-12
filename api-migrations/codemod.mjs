// API migration codemod — apply rename manifests to a consumer that still has the old engine installed.
// It renames the engine's .d.ts declarations in memory, family by family, so the
// language service carries each rename to the consumer's references. It saves only
// the consumer's own files: node_modules is hardlinked from the pnpm store, and a write
// there would change the store's copy of the engine.
// Then it fixes old literal values from the type errors the renamed declarations cause.
// .vue files are outside ts-morph: bump the engine and fix them from vue-tsc.
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { Project, Node, SyntaxKind } from 'ts-morph';
import { byFamily } from './manifests.mjs';

const ENGINE = '/node_modules/@open-loop/engine/dist/';
const dts = (f) => f.replace(/^src\//, '').replace(/\.ts$/, '.d.ts');

/**
 * Rename every entry of `manifests`, in order, across the consumer at `root`.
 * Returns the report's lists: saved files, type errors left, entries to do by hand, and the log.
 */
export function applyManifests({ root, manifests, tsconfig = 'tsconfig.app.json', dry = false }) {
  const project = new Project({ tsConfigFilePath: join(root, tsconfig) });
  // ts-morph never lists node_modules files it resolved lazily, so add the engine's
  project.addSourceFilesAtPaths(
    realpathSync(join(root, 'node_modules/@open-loop/engine')) + '/dist/**/*.d.ts',
  );
  const isEngine = (sf) => sf.getFilePath().includes(ENGINE);
  const isMine = (sf) =>
    !sf.getFilePath().includes('/node_modules/') && sf.getFilePath().startsWith(root);
  const engineFiles = project.getSourceFiles().filter(isEngine);
  if (engineFiles.length === 0)
    throw new Error('no engine .d.ts in the project: is the old engine installed?');
  const engineFile = (f) => project.getSourceFile((p) => p.getFilePath().endsWith(ENGINE + dts(f)));

  // A type renamed by an earlier entry, or an earlier manifest, still resolves by its old name.
  const types = {};
  const cur = (name) => {
    let n = name;
    for (let i = 0; i < 5 && types[n]; i++) n = types[n];
    return n;
  };
  const log = [];
  const todo = [];
  const say = (s) => log.push(s);
  const hand = (v, e, why) =>
    todo.push(
      `${v} ${e.family} ${e.kind} \`${e.old}\` → \`${e.new}\`${e.owners?.length ? ` on ${e.owners.join(', ')}` : ''}: ${why}`,
    );

  // === LOOKUP ===
  function typeDecls(name, files) {
    const out = [];
    for (const sf of engineFiles) {
      for (const d of [
        sf.getInterface(name),
        sf.getClass(name),
        sf.getTypeAlias(name),
        sf.getVariableDeclaration(name),
        ...sf
          .getFunctions()
          .filter((f) => f.getName() === name)
          .slice(0, 1),
      ])
        if (d) out.push(d);
    }
    if (!files?.length) return out;
    const inFiles = out.filter((d) =>
      files.some((f) =>
        d
          .getSourceFile()
          .getFilePath()
          .endsWith(ENGINE + dts(f)),
      ),
    );
    return inFiles.length ? inFiles : out;
  }
  function ownLiterals(node) {
    if (!node) return [];
    if (Node.isTypeLiteral(node)) return [node];
    if (Node.isUnionTypeNode(node) || Node.isIntersectionTypeNode(node))
      return node.getTypeNodes().flatMap(ownLiterals);
    if (Node.isParenthesizedTypeNode(node)) return ownLiterals(node.getTypeNode());
    return [];
  }
  const bare = (m) => {
    const n = m.getName?.();
    return typeof n === 'string' ? n.replace(/^['"]|['"]$/g, '') : n;
  };
  function membersOf(decl, name) {
    if (Node.isInterfaceDeclaration(decl) || Node.isClassDeclaration(decl))
      return decl.getMembers().filter((m) => bare(m) === name);
    // a type alias's own literals; a const object in a .d.ts is `declare const X: { ... }`
    if (Node.isTypeAliasDeclaration(decl) || Node.isVariableDeclaration(decl))
      return ownLiterals(decl.getTypeNode()).flatMap((l) =>
        l.getMembers().filter((m) => bare(m) === name),
      );
    return [];
  }
  const rename = (node, name, prefix) => {
    if (!dry) node.rename(name, { usePrefixAndSuffixText: prefix });
  };
  function renameLiterals(decls, old, next) {
    let n = 0;
    for (const d of decls)
      for (const lit of d.getDescendantsOfKind(SyntaxKind.LiteralType)) {
        const s = lit.getLiteral();
        if (Node.isStringLiteral(s) && s.getLiteralValue() === old) {
          if (!dry) s.setLiteralValue(next);
          n++;
        }
      }
    return n;
  }

  // === FAMILIES ===
  // Inside a family: members while their owners still have the names the manifest gives,
  // then top-level names, then literals, then what only a person can check.
  const litMap = new Map();
  for (const { version: v, entries } of manifests) {
    for (const [family, mine] of byFamily(entries)) {
      for (const e of mine.filter(
        (e) =>
          ['property', 'method', 'event'].includes(e.kind) ||
          (e.kind === 'merge' && e.owners?.length),
      )) {
        let n = 0;
        for (const owner of e.owners ?? []) {
          for (const d of typeDecls(cur(owner), e.files)) {
            if (Node.isFunctionDeclaration(d)) continue;
            let ms = membersOf(d, e.old);
            if (ms.length === 0)
              ms = d
                .getDescendantsOfKind(SyntaxKind.PropertySignature)
                .filter((m) => bare(m) === e.old);
            for (const m of ms) {
              rename(m, e.new, true);
              n++;
            }
          }
        }
        if (n === 0 && e.kind === 'event')
          for (const f of e.files ?? [])
            for (const i of engineFile(f)?.getInterfaces() ?? [])
              for (const m of membersOf(i, e.old)) {
                rename(m, e.new, true);
                n++;
              }
        if (n === 0) hand(v, e, 'no member declaration in the engine .d.ts');
        else say(`${v} ${family} member ${e.old} → ${e.new} (${n} decl)`);
      }
      for (const e of mine.filter(
        (e) =>
          ['function', 'type', 'const'].includes(e.kind) ||
          (e.kind === 'merge' && !e.owners?.length),
      )) {
        const decls = typeDecls(e.old, e.files);
        if (decls.length === 0) {
          hand(v, e, 'no declaration in the engine .d.ts');
          continue;
        }
        rename(decls[0], e.new, false);
        types[e.old] = e.new;
        say(`${v} ${family} ${e.kind} ${e.old} → ${e.new}`);
      }
      for (const e of mine.filter((e) => e.kind === 'literal')) {
        let n = 0;
        for (const owner of e.owners ?? [])
          n += renameLiterals(typeDecls(cur(owner), e.files), e.old, e.new);
        if (n === 0)
          for (const f of e.files ?? [])
            n += renameLiterals([engineFile(f)].filter(Boolean), e.old, e.new);
        if (n === 0) hand(v, e, 'no literal type in the engine .d.ts');
        else say(`${v} ${family} literal '${e.old}' → '${e.new}' (${n} decl)`);
        if (!litMap.has(e.old)) litMap.set(e.old, []);
        litMap.get(e.old).push(e.new);
      }
      for (const e of mine.filter((e) => ['removal', 'save-key', 'label'].includes(e.kind)))
        hand(v, e, `${e.kind}: check the consumer by hand`);
    }
  }

  // === LITERAL USES ===
  function literalCandidates(node, diag) {
    const out = [];
    const add = (x) => {
      if (x && (Node.isStringLiteral(x) || Node.isNoSubstitutionTemplateLiteral(x))) out.push(x);
    };
    add(node);
    const parent = node.getParent();
    if (parent && Node.isPropertyAssignment(parent) && parent.getNameNode() === node)
      add(parent.getInitializer());
    if (Node.isBinaryExpression(node)) {
      add(node.getLeft());
      add(node.getRight());
    }
    if (out.length === 0 && diag.getLength() < 400) for (const x of node.getDescendants()) add(x);
    return out;
  }
  // An old literal with two new values takes the one the site's contextual type admits.
  function pickNew(lit, news) {
    const u = [...new Set(news)];
    if (u.length === 1) return u[0];
    const ct = lit.getContextualType?.() ?? lit.getType();
    const members = ct?.isUnion() ? ct.getUnionTypes() : ct ? [ct] : [];
    return u.find((n) => members.some((t) => t.isStringLiteral() && t.getLiteralValue() === n));
  }
  const mineFiles = project.getSourceFiles().filter(isMine);
  if (!dry && litMap.size) {
    let fixed = 0;
    for (let pass = 0; pass < 6; pass++) {
      let changed = 0;
      for (const sf of mineFiles)
        for (const diag of sf.getPreEmitDiagnostics()) {
          const start = diag.getStart();
          if (start == null) continue;
          const text = JSON.stringify(diag.getMessageText());
          let target = sf.getDescendantAtPos(start);
          if (!target) continue;
          while (
            target.getParent() &&
            target.getParent().getStart() === start &&
            target.getParent().getEnd() <= start + diag.getLength()
          )
            target = target.getParent();
          for (const lit of literalCandidates(target, diag)) {
            const val = lit.getLiteralValue();
            if (!litMap.has(val) || !text.includes(`\\"${val}\\"`)) continue;
            const nv = pickNew(lit, litMap.get(val));
            if (!nv) continue;
            lit.setLiteralValue(nv);
            changed++;
          }
        }
      fixed += changed;
      if (changed === 0) break;
    }
    say(`literal uses fixed from type errors: ${fixed}`);
  }

  // === SAVE ===
  const saved = [];
  if (!dry)
    for (const sf of mineFiles)
      if (!sf.isSaved()) {
        sf.saveSync();
        saved.push(sf.getFilePath().slice(root.length + 1));
      }
  const message = (d) =>
    String(
      typeof d.getMessageText() === 'string'
        ? d.getMessageText()
        : d.getMessageText().getMessageText(),
    ).slice(0, 160);
  const remaining = dry
    ? []
    : mineFiles.flatMap((sf) =>
        sf
          .getPreEmitDiagnostics()
          .map(
            (d) =>
              `${sf.getFilePath().slice(root.length + 1)}:${sf.getLineAndColumnAtPos(d.getStart() ?? 0).line}: ${message(d)}`,
          ),
      );
  return { saved, remaining, todo, log };
}
