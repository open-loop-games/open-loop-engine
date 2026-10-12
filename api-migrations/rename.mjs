// Engine rename — apply one family of a version's manifest to the engine's src/ and tests/.
// Run from the engine root:
//   node api-migrations/rename.mjs <version> <family> [--dry]
// Report: .api-migration-rename.md (gitignored).
//
// Order inside a family: members (property, method, param) while their owners still
// have the names the manifest gives; then top-level names; then literals, by their
// declarations and then by the type errors the declarations cause; then save keys
// and labels by text in the listed files; then file moves. An owner renamed by an
// earlier family in the manifest resolves by its old name.
import { writeFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Project, Node, SyntaxKind } from 'ts-morph';
import { loadManifest } from './manifests.mjs';

/** Rename one family's entries across the project at `root`; returns the log and the entries left by hand. */
export async function renameFamily({
  root,
  entries,
  family,
  tsconfig = 'tsconfig.typecheck.json',
  dry = false,
}) {
  const mine = entries.filter((e) => e.family === family);
  if (mine.length === 0) throw new Error(`no entries for family ${family}`);
  const types = {};
  for (const e of entries) {
    if (e.family === family) break;
    if (['function', 'type', 'const', 'merge'].includes(e.kind) && !e.owners?.length)
      types[e.old] = e.new;
  }
  const cur = (name) => {
    let n = name;
    for (let i = 0; i < 5 && types[n]; i++) n = types[n];
    return n;
  };
  const project = new Project({ tsConfigFilePath: join(root, tsconfig) });
  const file = (f) => project.getSourceFile(join(root, f));
  const log = [];
  const todo = [];
  const say = (s) => log.push(s);
  const hand = (e, why) =>
    todo.push(
      `${e.kind} \`${e.old}\` → \`${e.new}\`${e.owners?.length ? ` on ${e.owners.join(', ')}` : ''}: ${why}`,
    );

  // === LOOKUP ===
  function typeDecls(name) {
    const out = [];
    for (const sf of project.getSourceFiles()) {
      for (const d of [sf.getInterface(name), sf.getClass(name), sf.getTypeAlias(name)])
        if (d) out.push(d);
      const v = sf.getVariableDeclaration(name);
      if (v) out.push(v);
      const f = sf.getFunction(name);
      if (f) out.push(f);
    }
    return out;
  }

  // Type literals that make up an alias's own shape, through unions, intersections and
  // parentheses, but not through property types.
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
    if (Node.isInterfaceDeclaration(decl)) return decl.getMembers().filter((m) => bare(m) === name);
    if (Node.isClassDeclaration(decl)) return decl.getMembers().filter((m) => bare(m) === name);
    if (Node.isTypeAliasDeclaration(decl))
      return ownLiterals(decl.getTypeNode()).flatMap((l) =>
        l.getMembers().filter((m) => bare(m) === name),
      );
    if (Node.isVariableDeclaration(decl)) {
      const init = decl.getInitializer();
      if (init && Node.isObjectLiteralExpression(init))
        return init.getProperties().filter((p) => p.getName?.() === name);
    }
    return [];
  }

  // "Owner.member" → the member's declarations; "fn" → functions or members named fn.
  function callables(owner) {
    const [a, b] = owner.split('.');
    if (b) return typeDecls(cur(a)).flatMap((d) => membersOf(d, b));
    return typeDecls(cur(a)).flatMap((d) =>
      Node.isFunctionDeclaration(d) || Node.isVariableDeclaration(d)
        ? [d]
        : (d.getMembers?.() ?? []),
    );
  }
  function paramsOf(node, name) {
    let fn = node;
    if (
      Node.isVariableDeclaration(node) ||
      Node.isPropertyAssignment(node) ||
      Node.isPropertySignature(node)
    ) {
      fn = node.getInitializer?.() ?? node.getTypeNode?.();
    }
    if (fn && Node.isFunctionTypeNode?.(fn) === false && fn.getParameters === undefined) return [];
    const params = fn?.getParameters?.() ?? [];
    return params.filter((p) => p.getName() === name);
  }

  // === MEMBERS ===
  for (const e of mine.filter((e) => e.kind === 'event')) {
    let n = 0;
    const owners = e.owners?.length
      ? e.owners.flatMap((o) => typeDecls(cur(o)))
      : (e.files ?? []).flatMap((f) => file(f)?.getInterfaces() ?? []);
    for (const d of owners) {
      for (const m of membersOf(d, e.old)) {
        if (!dry) m.rename(e.new, { usePrefixAndSuffixText: true });
        n++;
      }
    }
    if (n === 0) hand(e, 'no event declaration found');
    else say(`event ${e.old} → ${e.new} (${n} decl)`);
  }
  for (const e of mine.filter((e) => ['property', 'method'].includes(e.kind))) {
    let n = 0;
    for (const owner of e.owners) {
      for (const d of typeDecls(cur(owner))) {
        if (Node.isFunctionDeclaration(d)) continue;
        let ms = membersOf(d, e.old);
        // an owner without the member directly holds it in a nested type, such as a
        // callback parameter's inline shape
        if (ms.length === 0 && !Node.isVariableDeclaration(d)) {
          ms = d
            .getDescendantsOfKind(SyntaxKind.PropertySignature)
            .filter((m) => bare(m) === e.old);
          if (ms.length)
            say(`member ${e.old} → ${e.new}: ${ms.length} nested in ${owner}; check them`);
        }
        for (const m of ms) {
          if (!dry) m.rename(e.new, { usePrefixAndSuffixText: true });
          n++;
        }
      }
    }
    if (n === 0) {
      for (const owner of e.owners)
        for (const d of typeDecls(cur(owner)))
          for (const m of d
            .getDescendantsOfKind(SyntaxKind.PropertySignature)
            .filter((m) => bare(m) === e.old)) {
            if (!dry) m.rename(e.new, { usePrefixAndSuffixText: true });
            n++;
          }
      if (n)
        say(
          `member ${e.old} → ${e.new} (${n} nested decl inside ${e.owners.join(', ')}; check them)`,
        );
      else hand(e, 'no member declaration found');
    } else say(`member ${e.old} → ${e.new} (${n} decl)`);
  }
  for (const e of mine.filter((e) => e.kind === 'param')) {
    let n = 0;
    for (const owner of e.owners) {
      for (const c of callables(owner)) {
        for (const p of paramsOf(c, e.old)) {
          if (!dry) p.rename(e.new);
          n++;
        }
      }
      // a type parameter is declared per declaration, so each one is renamed
      for (const d of typeDecls(cur(owner))) {
        const tps = (d.getTypeParameters?.() ?? []).filter((t) => t.getName() === e.old);
        for (const t of tps) {
          if (!dry) t.rename(e.new);
          n++;
        }
      }
    }
    if (n === 0) hand(e, 'no parameter found');
    else say(`param ${e.old} → ${e.new} (${n})`);
  }

  // === TOP LEVEL ===
  for (const e of mine.filter((e) => ['function', 'type', 'const'].includes(e.kind))) {
    let decls = typeDecls(e.old).filter(
      (d) => !e.files?.length || e.files.some((f) => d.getSourceFile().getFilePath().endsWith(f)),
    );
    if (decls.length === 0)
      decls = (e.files ?? []).flatMap((f) =>
        [
          ...(file(f)?.getDescendantsOfKind(SyntaxKind.FunctionDeclaration) ?? []),
          ...(file(f)?.getDescendantsOfKind(SyntaxKind.VariableDeclaration) ?? []),
        ].filter((d) => d.getName?.() === e.old),
      );
    if (decls.length === 0) {
      hand(e, 'no declaration found');
      continue;
    }
    // overloads share one symbol, so one rename covers them
    if (!dry) decls[0].rename(e.new, { usePrefixAndSuffixText: false });
    types[e.old] = e.new;
    say(`${e.kind} ${e.old} → ${e.new}`);
  }

  // === LITERALS ===
  const litMap = new Map();
  for (const e of mine.filter((e) => ['literal', 'event'].includes(e.kind))) {
    if (!litMap.has(e.old)) litMap.set(e.old, []);
    litMap.get(e.old).push(e.new);
  }
  for (const e of mine.filter((e) => e.kind === 'literal')) {
    let n = 0;
    for (const owner of e.owners) {
      for (const d of typeDecls(cur(owner))) {
        for (const lit of d.getDescendantsOfKind(SyntaxKind.LiteralType)) {
          const s = lit.getLiteral();
          if (Node.isStringLiteral(s) && s.getLiteralValue() === e.old) {
            if (!dry) s.setLiteralValue(e.new);
            n++;
          }
        }
      }
    }
    if (n === 0) {
      for (const f of e.files ?? []) {
        for (const lit of file(f)?.getDescendantsOfKind(SyntaxKind.LiteralType) ?? []) {
          const s = lit.getLiteral();
          if (Node.isStringLiteral(s) && s.getLiteralValue() === e.old) {
            if (!dry) s.setLiteralValue(e.new);
            n++;
          }
        }
      }
      if (n) say(`literal '${e.old}' → '${e.new}' (${n} decl, by file)`);
    }
    if (n === 0) {
      const fns = e.owners
        .flatMap((o) => typeDecls(cur(o)))
        .filter((d) => Node.isFunctionDeclaration(d) || Node.isVariableDeclaration(d));
      for (const fn of fns) {
        for (const x of fn.getDescendantsOfKind(SyntaxKind.StringLiteral)) {
          if (x.getLiteralValue() === e.old) {
            if (!dry) x.setLiteralValue(e.new);
            n++;
          }
        }
      }
      if (n) say(`literal '${e.old}' → '${e.new}' (${n} values inside ${e.owners.join(', ')})`);
    }
    if (n === 0) {
      for (const f of e.files ?? []) {
        for (const x of file(f)?.getDescendantsOfKind(SyntaxKind.StringLiteral) ?? []) {
          if (
            x.getLiteralValue() === e.old &&
            !Node.isImportDeclaration(x.getParent()) &&
            !Node.isExportDeclaration(x.getParent())
          ) {
            if (!dry) x.setLiteralValue(e.new);
            n++;
          }
        }
      }
      if (n)
        say(
          `literal '${e.old}' → '${e.new}' (${n} untyped values in ${e.files.join(', ')}; check them)`,
        );
    }
    if (n === 0) hand(e, 'no literal type found in the owners or files');
  }

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
    // a span that covers a whole expression: take the literals inside it
    if (out.length === 0 && diag.getLength() < 400) for (const x of node.getDescendants()) add(x);
    return out;
  }
  function pickNew(lit, all) {
    const news = [...new Set(all)];
    if (news.length === 1) return news[0];
    const ct = lit.getContextualType?.() ?? lit.getType();
    const members = ct?.isUnion() ? ct.getUnionTypes() : ct ? [ct] : [];
    return news.find((n) => members.some((t) => t.isStringLiteral() && t.getLiteralValue() === n));
  }
  let fixed = 0;
  if (!dry && litMap.size) {
    for (let pass = 0; pass < 6; pass++) {
      let changed = 0;
      for (const diag of project.getPreEmitDiagnostics()) {
        const sf = diag.getSourceFile();
        const start = diag.getStart();
        if (!sf || start == null) continue;
        const text = JSON.stringify(diag.getMessageText());
        const node = sf.getDescendantAtPos(start);
        if (!node) continue;
        let target = node;
        while (
          target.getParent() &&
          target.getParent().getStart() === start &&
          target.getParent().getEnd() <= start + diag.getLength()
        )
          target = target.getParent();
        for (const lit of literalCandidates(target, diag)) {
          const v = lit.getLiteralValue();
          if (!litMap.has(v) || !text.includes(`\\"${v}\\"`)) continue;
          const nv = pickNew(lit, litMap.get(v));
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

  // === TEXT: SAVE KEYS AND LABELS ===
  for (const e of mine.filter((e) => ['save-key', 'label'].includes(e.kind))) {
    let n = 0;
    for (const f of e.files ?? []) {
      const sf = file(f);
      if (!sf) continue;
      for (const x of sf.getDescendants()) {
        if (Node.isStringLiteral(x) || Node.isNoSubstitutionTemplateLiteral(x)) {
          const v = x.getLiteralValue();
          if (v === e.old || v.startsWith(e.old)) {
            if (!dry) x.setLiteralValue(e.new + v.slice(e.old.length));
            n++;
          }
        } else if (Node.isTemplateHead(x)) {
          const raw = x.getText();
          const [op, np] = [e.old.split('${')[0], e.new.split('${')[0]];
          if (raw === '`' + op + '${') {
            if (!dry) x.replaceWithText('`' + np + '${');
            n++;
          }
        }
      }
    }
    if (n === 0) hand(e, 'no string found in the listed files');
    else say(`${e.kind} '${e.old}' → '${e.new}' (${n})`);
  }

  // === FILES ===
  for (const e of mine.filter((e) => e.kind === 'file')) {
    if (!e.new) {
      hand(e, 'file removal: delete by hand with what it exports');
      continue;
    }
    if (!e.old.endsWith('.ts')) {
      hand(e, 'not a TypeScript file: move by hand and fix links');
      continue;
    }
    const sf = file(e.old);
    if (!sf) {
      hand(e, 'file not in the project');
      continue;
    }
    if (!dry) {
      sf.move(join(root, e.new));
      // ts-morph rewrites relative specifiers; the @/ alias ones are rewritten here
      const alias = (p) => '@/' + p.replace(/^src\//, '').replace(/\.ts$/, '');
      const [from, to] = [alias(e.old), alias(e.new)];
      for (const f of project.getSourceFiles())
        for (const lit of f.getDescendantsOfKind(SyntaxKind.StringLiteral))
          if (lit.getLiteralValue() === from) lit.setLiteralValue(to);
    }
    say(`file ${e.old} → ${e.new}`);
  }

  // === BY HAND ===
  for (const e of mine.filter((e) => ['removal', 'merge'].includes(e.kind))) hand(e, e.kind);

  if (!dry) await project.save();
  return { log, todo };
}

// === CLI ===
if (import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const [version, family] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  if (!version || !family) throw new Error('usage: rename.mjs <version> <family> [--dry]');
  const dry = process.argv.includes('--dry');
  const { log, todo } = await renameFamily({
    root: process.cwd(),
    entries: loadManifest(version).entries,
    family,
    dry,
  });
  const out = [
    `# ${version} ${family}${dry ? ' (dry run)' : ''}`,
    '',
    ...log.map((s) => `- ${s}`),
    '',
    `## By hand (${todo.length})`,
    ...todo.map((s) => `- ${s}`),
    '',
  ];
  writeFileSync('.api-migration-rename.md', out.join('\n'));
  console.log(
    `${version} ${family}: ${log.length} applied, ${todo.length} by hand → .api-migration-rename.md`,
  );
}
