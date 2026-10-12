// Upgrade a consumer's code across every breaking release from its installed engine to the target.
// Run from the consumer root, before the bump, with the old engine still installed:
//   node <engine>/api-migrations/run.mjs [--to <version>] [--dry] [--tsconfig tsconfig.app.json]
// Report: <consumer>/.api-migration-codemod.md (delete it before committing).
import { readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { applyManifests } from './codemod.mjs';
import { argValue, manifestsInRange, manifestVersions } from './manifests.mjs';

const argv = process.argv.slice(2);
const dry = argv.includes('--dry');
const tsconfig = argValue(argv, '--tsconfig') ?? 'tsconfig.app.json';
const root = realpathSync(process.cwd());
const installed = JSON.parse(
  readFileSync(join(root, 'node_modules/@open-loop/engine/package.json'), 'utf8'),
).version;
const to = argValue(argv, '--to') ?? manifestVersions().at(-1);
const manifests = manifestsInRange(installed, to);
if (manifests.length === 0) {
  console.log(`installed ${installed}: no manifest up to ${to}, so nothing to rename`);
  process.exit(0);
}

const { saved, remaining, todo, log } = applyManifests({ root, manifests, tsconfig, dry });
const list = (title, xs) => [`## ${title} (${xs.length})`, ...xs.map((s) => `- ${s}`), ''];
const out = [
  `# API migration codemod${dry ? ' (dry run)' : ''}: ${installed} → ${to}`,
  '',
  `Manifests: ${manifests.map((m) => m.version).join(', ')}. Read each version's CHANGELOG section for the breaks that are not renames.`,
  '',
  ...list('Saved', saved),
  ...list('Type errors left against the renamed .d.ts', remaining),
  ...list('By hand', todo),
  ...list('Applied', log),
];
writeFileSync(join(root, '.api-migration-codemod.md'), out.join('\n'));
console.log(
  `${installed} → ${to}: ${saved.length} files saved, ${remaining.length} type errors left, ${todo.length} by hand → .api-migration-codemod.md`,
);
