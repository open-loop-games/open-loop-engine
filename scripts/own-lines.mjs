/**
 * Own-lines density scan — find function bodies that are dense rather than long.
 *
 * Length alone is blind on this tree: the longest functions are `create*`
 * factories, whose bodies mostly hold nested helpers (the shape
 * `AGENTS.md` § Systems-layer factory decomposition requires). Two
 * columns separate the two shapes:
 *
 * - **own** — body lines minus the lines of the functions nested directly
 *   inside it. A factory's own-lines count is small however long the factory is.
 * - **ratio** — own / total. At or below ~0.30 the body is mostly nested helpers
 *   and not a finding; at or above ~0.70 it is genuinely dense code.
 *
 * Anonymous functions are included, which is the point — they are invisible to
 * every named-function metric and to review-by-name alike.
 *
 * Usage: `node scripts/own-lines.mjs [minRatio] [limit]` (defaults 0.7, 25).
 * Prints distribution percentiles, then the ranked table.
 *
 * Cyclomatic complexity is deliberately not joined in here. It was measured
 * once over this tree and came back near-flat, so it discriminated nothing that
 * own-lines did not already find; reintroduce it only if that stops holding.
 */

import { Project, SyntaxKind } from 'ts-morph';

const minRatio = Number(process.argv[2] ?? 0.7);
const limit = Number(process.argv[3] ?? 25);

const FN = new Set([
  SyntaxKind.FunctionDeclaration,
  SyntaxKind.FunctionExpression,
  SyntaxKind.ArrowFunction,
  SyntaxKind.MethodDeclaration,
  SyntaxKind.GetAccessor,
  SyntaxKind.SetAccessor,
  SyntaxKind.Constructor,
]);

const project = new Project({
  tsConfigFilePath: 'tsconfig.json',
  skipAddingFilesFromTsConfig: true,
});
project.addSourceFilesAtPaths(['src/**/*.ts']);

const rows = [];
for (const sourceFile of project.getSourceFiles()) {
  const path = sourceFile.getFilePath().replace(`${process.cwd()}/`, '');
  sourceFile.forEachDescendant((node) => {
    if (!FN.has(node.getKind())) return;
    const body = node.getBody?.();
    if (!body) return;

    const total = body.getEndLineNumber() - body.getStartLineNumber() + 1;

    // Only the outermost nested functions count: a helper inside a helper is
    // already covered by its parent's span, and double-counting it would push
    // `own` negative on deeply nested bodies.
    let nested = 0;
    for (const child of body.getDescendants()) {
      if (!FN.has(child.getKind())) continue;
      let ancestor = child.getParent();
      let inner = false;
      while (ancestor && ancestor !== body) {
        if (FN.has(ancestor.getKind())) {
          inner = true;
          break;
        }
        ancestor = ancestor.getParent();
      }
      if (inner) continue;
      nested += child.getEndLineNumber() - child.getStartLineNumber() + 1;
    }

    const name =
      node.getSymbol?.()?.getName?.() ||
      (node.getKind() === SyntaxKind.ArrowFunction ? '<arrow>' : '<anon>');
    const own = total - nested;
    rows.push({
      own,
      total,
      ratio: own / total,
      name,
      where: `${path}:${node.getStartLineNumber()}`,
    });
  });
}

const owns = rows.map((r) => r.own).sort((a, b) => b - a);
const at = (p) => owns[Math.floor(owns.length * (1 - p))];
console.log(
  `count=${owns.length} max=${owns[0]} p99=${at(0.99)} p95=${at(0.95)} ` +
    `p90=${at(0.9)} median=${owns[Math.floor(owns.length / 2)]}`,
);

console.log(`\nratio >= ${minRatio}, top ${limit} by own-lines\n`);
console.log('own\ttotal\tratio\tname\twhere');
for (const r of rows
  .filter((r) => r.ratio >= minRatio)
  .sort((a, b) => b.own - a.own)
  .slice(0, limit)) {
  console.log(`${r.own}\t${r.total}\t${r.ratio.toFixed(2)}\t${r.name}\t${r.where}`);
}
