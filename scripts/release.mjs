/**
 * Release — cut the next version from the conventional commits since the last tag.
 *
 * git-cliff decides the version (`cliff.toml` § bump holds the 0.x policy) and
 * writes its CHANGELOG.md section; this script sets `package.json`, commits,
 * tags and pushes. Publishing happens in CI from the pushed tag, never here.
 * The release commit runs the pre-commit hook, so a failing typecheck or test
 * stops the cut before any tag exists.
 *
 * Usage: `pnpm release [--dry-run] [--no-push]`. `--dry-run` prints the version
 * and its changelog section and writes nothing.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const dryRun = process.argv.includes('--dry-run');
const push = !process.argv.includes('--no-push');

const run = (cmd, args) =>
  execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const fail = (message) => {
  console.error(`release: ${message}`);
  process.exit(1);
};

let lastTag;
try {
  lastTag = run('git', ['describe', '--tags', '--abbrev=0', '--match', 'v[0-9]*']);
} catch {
  fail('no v* tag yet — the first cut is a hand tag (AGENTS.md § Commits).');
}

const next = run('git-cliff', ['--bumped-version']);
if (next === lastTag) fail(`nothing releasable since ${lastTag}.`);

if (dryRun) {
  console.log(`${lastTag} → ${next}\n`);
  console.log(run('git-cliff', ['--unreleased', '--tag', next, '--strip', 'header']));
  process.exit(0);
}

if (run('git', ['status', '--porcelain'])) fail('working tree is not clean.');

run('git-cliff', ['--unreleased', '--tag', next, '--prepend', 'CHANGELOG.md']);
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
pkg.version = next.replace(/^v/, '');
writeFileSync('package.json', `${JSON.stringify(pkg, null, 2)}\n`);

try {
  execFileSync('git', ['add', 'package.json', 'CHANGELOG.md'], { stdio: 'inherit' });
  execFileSync('git', ['commit', '-m', `chore(release): ${pkg.version}`], { stdio: 'inherit' });
} catch {
  execFileSync('git', ['checkout', 'HEAD', '--', 'package.json', 'CHANGELOG.md']);
  fail('release commit failed; package.json and CHANGELOG.md restored.');
}

execFileSync('git', ['tag', '--annotate', next, '--message', next], { stdio: 'inherit' });
if (push) {
  execFileSync('git', ['push', '--atomic', '--follow-tags', 'origin', 'HEAD'], {
    stdio: 'inherit',
  });
}
console.log(`released ${next}${push ? '' : ' (not pushed)'}`);
