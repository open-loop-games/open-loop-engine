// Print a Migration list for a breaking commit's body: the public names a consumer must
// change, old → new. Parameters are left out: renaming one breaks no caller. The
// BREAKING CHANGE sentence and any removal text are written by hand.
//   node api-migrations/migration.mjs <version> [family]
import { loadManifest } from './manifests.mjs';

const [version, family] = process.argv.slice(2);
if (!version) throw new Error('usage: migration.mjs <version> [family]');
const mine = loadManifest(version).entries.filter(
  (e) => (!family || e.family === family) && e.public && e.kind !== 'param',
);

const show = (e) => {
  const q = (s) => (['literal', 'save-key', 'label'].includes(e.kind) ? `'${s}'` : s);
  const types = (e.owners || []).filter((o) => /^[A-Z]/.test(o));
  const on =
    types.length && ['property', 'method', 'literal'].includes(e.kind)
      ? ` (${types.join(', ')})`
      : '';
  if (e.kind === 'removal') return `  ${e.old}${on}: removed`;
  if (e.kind === 'merge') return `  ${e.old} → ${e.new}: merged`;
  if (e.kind === 'file') return `  ${e.old} → ${e.new}`;
  const opt = e.optional ? ' *' : '';
  return `  ${q(e.old)} → ${q(e.new)}${on}${opt}`;
};
const order = [
  'type',
  'function',
  'const',
  'method',
  'property',
  'event',
  'literal',
  'save-key',
  'label',
  'file',
  'merge',
  'removal',
];
mine.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
console.log('Migration:');
if (mine.some((e) => e.optional))
  console.log('  (* an optional key: a stale one passes typecheck, so search for it)');
for (const line of new Set(mine.map(show))) console.log(line);
