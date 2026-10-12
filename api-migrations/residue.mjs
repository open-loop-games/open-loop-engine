// List old names still present after a rename: in comments, in strings the language
// service does not reach, in untyped object keys, and in docs.
//   consumer root: node <engine>/api-migrations/residue.mjs --from <version> [--to <version>]
//                  public names of every manifest in the range, from the pre-bump version
//   engine root:   node api-migrations/residue.mjs --engine <version> [family]
//                  one release's names, or one family's, across the engine
// Report: .api-migration-residue.md in the current directory (delete it before committing).
// A hit is a candidate, not a verdict: a common name often has a sense of its own.
import { writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { argValue, loadManifest, manifestsInRange } from './manifests.mjs';

const argv = process.argv.slice(2);
const engineVersion = argValue(argv, '--engine');
const inEngine = engineVersion !== undefined;
let entries;
if (inEngine) {
  const family = argv.find((a, i) => i > 0 && argv[i - 1] !== '--engine' && !a.startsWith('--'));
  entries = loadManifest(engineVersion).entries.filter((e) => !family || e.family === family);
} else {
  const from = argValue(argv, '--from');
  if (!from)
    throw new Error(
      'usage: residue.mjs --from <pre-bump version> [--to <version>] | --engine <version> [family]',
    );
  entries = manifestsInRange(from, argValue(argv, '--to'))
    .flatMap((m) => m.entries)
    .filter((e) => e.public && e.kind !== 'param');
}
const where = inEngine ? ['src', 'tests', 'scripts', 'docs', 'README.md', 'AGENTS.md'] : ['.'];
const exclude = [
  ':(exclude)**/api/**',
  ':(exclude)*.save',
  ':(exclude)pnpm-lock.yaml',
  ':(exclude)CHANGELOG.md',
  ':(exclude)api-migrations/**',
];
const COMMON = 7;

const grep = (args) => {
  try {
    // Tracked text files only, so gitignored scrapes, dist and notes never report.
    return execFileSync('git', ['grep', '-InE', ...args, '--', ...where, ...exclude], {
      encoding: 'utf8',
      maxBuffer: 1 << 28,
    })
      .split('\n')
      .filter(Boolean);
  } catch {
    return [];
  }
};
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// One search per old name: a name several entries rename is listed once, with every target.
const byOld = new Map();
for (const e of entries) {
  if (!e.old || e.kind === 'file') continue;
  if (!byOld.has(e.old)) byOld.set(e.old, []);
  byOld.get(e.old).push(e);
}
const isCommon = (old) => old.length < COMMON || !/^[\w$]+$/.test(old);
const olds = [...byOld.keys()].sort((a, b) => isCommon(a) - isCommon(b));

const out = ['# API migration residue', ''];
let total = 0;
let commonHeading = false;
for (const old of olds) {
  const o = esc(old);
  // A distinctive name is searched as a word, so prose and TODO markers report too. In a
  // consumer only a compound identifier (SpatialGraph, createSlot) is; a plain word
  // (condition) is a word of the consumer's own as often as an engine name.
  const asWord = !isCommon(old) && (inEngine || /^.+[A-Z0-9]/.test(old));
  const pattern = asWord ? `\\b${o}\\b` : `\`${o}\`|\\.${o}\\b|\\b${o}\\??:|'${o}'|"${o}"`;
  const hits = grep([pattern]);
  if (!hits.length) continue;
  if (isCommon(old) && !commonHeading) {
    out.push("# Common names: most hits are the code's own sense", '');
    commonHeading = true;
  }
  total += hits.length;
  const targets = [
    ...new Set(
      byOld
        .get(old)
        .map(
          (e) => `\`${e.new}\` (${e.kind}${e.owners?.length ? ` on ${e.owners.join(', ')}` : ''})`,
        ),
    ),
  ];
  out.push(`## \`${old}\` → ${targets.join('; ')} — ${hits.length}`);
  out.push(...hits.slice(0, 40).map((h) => `- ${h.slice(0, 220)}`));
  if (hits.length > 40) out.push(`- … ${hits.length - 40} more`);
  out.push('');
}
writeFileSync('.api-migration-residue.md', out.join('\n'));
console.log(`${total} residue lines → .api-migration-residue.md`);
