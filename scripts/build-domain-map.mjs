#!/usr/bin/env node
/**
 * Generate a consumer game's domain-language map from code structure.
 *
 * Usage:
 *   ol-domain-map <config.mjs> [<config.mjs> ...]
 *   node scripts/build-domain-map.mjs <config.mjs>
 *
 * Each config is a per-game dialect (the engine/systems-vs-modules split applied
 * to tooling: shared mechanism here, per-game DATA in the consumer). One config
 * = one game = one committed map. Scope globs resolve relative to the config
 * file's own directory, so a config travels with the code it describes.
 *
 * The mechanism lives in the engine because the engine is published + link:-
 * shared — a tool here propagates to every consumer on bump, whereas one housed
 * in copy-and-deleted starter would fork-drift. The OUTPUT still regenerates
 * from each consumer's own structure, so the map itself can never drift.
 *
 * @typedef {object} DomainMapConfig
 * @property {string[]} scope       Globs (relative to the config dir) selecting
 *   ONLY this game's domain files. Hard boundary — see domain-extract.mjs.
 * @property {string[]} [defSuffixes]  Definition-type suffixes. Default `['Def']`.
 *   The dialect knob that varies most across games (`Def` / `Spec` / `Entry`).
 * @property {string[]} [viewSuffixes] Read-view interface suffixes excluded from
 *   the def inventory. Default `['State', 'GameState']`.
 * @property {string[]} [nouns]     Explicit domain vertices. Omit to auto-seed
 *   from def-type stems (then prune via this field if needed).
 * @property {string[]} [stopwords] Field names (lowercased) to skip in the edge
 *   miner — the escape hatch for residual false positives.
 * @property {Array<{term:string,note:string}>} [curated] The hand-authored
 *   disambiguator block: module-level concepts no single type owns.
 * @property {string} [title]       Map heading.
 * @property {string} [description] One-line blurb under the heading.
 * @property {string} [output]      Map path relative to the config dir. Default
 *   `domain-map.md`.
 */
import { writeFileSync } from 'node:fs';
import { dirname, resolve, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { extractDomain } from './lib/domain-extract.mjs';
import { renderDomainMap } from './lib/domain-render.mjs';

/** Load, extract, render, and write one config's map. Returns a summary line. */
async function buildOne(configPath) {
  const abs = resolve(configPath);
  const rootDir = dirname(abs);
  const mod = await import(pathToFileURL(abs).href);
  const config = mod.default ?? mod.config;
  if (!config || !Array.isArray(config.scope)) {
    throw new Error(`${configPath}: config must default-export an object with a \`scope\` array`);
  }

  const result = extractDomain(config, { rootDir });
  const markdown = renderDomainMap(result, config);
  const outPath = resolve(rootDir, config.output ?? 'domain-map.md');
  writeFileSync(outPath, markdown);

  const isa = result.vocabulary.reduce((a, v) => a + v.arms.length, 0);
  return `${basename(rootDir)}: ${result.defs.length} defs, ${isa} is-a, ${result.edges.length} edges → ${outPath.replace(process.cwd() + '/', '')}`;
}

// === CLI ===

const configs = process.argv.slice(2);
if (configs.length === 0) {
  console.error('usage: ol-domain-map <config.mjs> [<config.mjs> ...]');
  process.exit(1);
}

let failed = false;
for (const c of configs) {
  try {
    console.log(await buildOne(c));
  } catch (err) {
    failed = true;
    console.error(`✗ ${c}: ${err.message}`);
  }
}
process.exit(failed ? 1 : 0);
