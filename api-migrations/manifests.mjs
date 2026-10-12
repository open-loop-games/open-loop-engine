// Manifests — load the rename manifests a consumer's upgrade crosses.
// Each `<version>/manifest.json` lists the renames that release made, in application order.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MIGRATIONS = dirname(fileURLToPath(import.meta.url));

export const KINDS = [
  'type',
  'function',
  'const',
  'merge',
  'property',
  'method',
  'event',
  'param',
  'literal',
  'save-key',
  'label',
  'file',
  'removal',
];

/** Compare two `x.y.z` versions; a prerelease sorts before its release. */
export function compareVersions(a, b) {
  const parse = (v) => {
    const [core, pre] = v.split('-', 2);
    return { nums: core.split('.').map(Number), pre };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) if (x.nums[i] !== y.nums[i]) return x.nums[i] - y.nums[i];
  if (x.pre === y.pre) return 0;
  if (x.pre === undefined) return 1;
  if (y.pre === undefined) return -1;
  return x.pre < y.pre ? -1 : 1;
}

/** Every version folder that has a manifest, oldest first. */
export function manifestVersions(dir = MIGRATIONS) {
  return readdirSync(dir, { withFileTypes: true })
    .filter(
      (d) =>
        d.isDirectory() &&
        /^\d+\.\d+\.\d+$/.test(d.name) &&
        existsSync(join(dir, d.name, 'manifest.json')),
    )
    .map((d) => d.name)
    .sort(compareVersions);
}

export function loadManifest(version, dir = MIGRATIONS) {
  return {
    version,
    entries: JSON.parse(readFileSync(join(dir, version, 'manifest.json'), 'utf8')),
  };
}

/** The manifests an upgrade from `from` to `to` crosses: newer than `from`, up to `to`. */
export function manifestsInRange(from, to, dir = MIGRATIONS) {
  return manifestVersions(dir)
    .filter(
      (v) => compareVersions(v, from) > 0 && (to === undefined || compareVersions(v, to) <= 0),
    )
    .map((v) => loadManifest(v, dir));
}

/** Each family's entries, in the order the manifest first names the family. */
export function byFamily(entries) {
  const out = new Map();
  for (const e of entries) {
    if (!out.has(e.family)) out.set(e.family, []);
    out.get(e.family).push(e);
  }
  return out;
}

export function argValue(argv, flag) {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}
