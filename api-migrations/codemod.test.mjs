// Fixture pairs for the migration codemod: an old engine .d.ts, a consumer file before,
// and the file the codemod must leave. One pair per manifest kind, plus a range.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { applyManifests } from './codemod.mjs';
import {
  KINDS,
  compareVersions,
  loadManifest,
  manifestVersions,
  manifestsInRange,
} from './manifests.mjs';

const dirs = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A consumer with `engine` as the installed engine's index.d.ts and `before` as its one source file. */
function consumer(engine, before) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ol-api-migration-')));
  dirs.push(root);
  const pkg = join(root, 'node_modules/@open-loop/engine');
  mkdirSync(join(pkg, 'dist'), { recursive: true });
  mkdirSync(join(root, 'src'));
  writeFileSync(
    join(pkg, 'package.json'),
    JSON.stringify({ name: '@open-loop/engine', version: '0.4.0', types: 'dist/index.d.ts' }),
  );
  writeFileSync(join(pkg, 'dist/index.d.ts'), engine);
  writeFileSync(join(root, 'src/game.ts'), before);
  writeFileSync(
    join(root, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        module: 'esnext',
        moduleResolution: 'bundler',
        target: 'es2022',
        noEmit: true,
      },
      include: ['src'],
    }),
  );
  return root;
}

function migrate(engine, before, ...manifests) {
  const root = consumer(engine, before);
  const versioned = manifests.map((entries, i) => ({ version: `0.${5 + i}.0`, entries }));
  const report = applyManifests({ root, manifests: versioned, tsconfig: 'tsconfig.json' });
  return { after: readFileSync(join(root, 'src/game.ts'), 'utf8'), ...report };
}

const entry = (kind, old, next, more = {}) => ({
  family: 'F',
  kind,
  old,
  new: next,
  public: true,
  ...more,
});

describe('API migration codemod', () => {
  it('renames a member on its owner, and leaves the same name on another type', () => {
    const engine = `export interface Purchasable { amount: number }\nexport interface Other { amount: number }\n`;
    const before = `import type { Purchasable, Other } from '@open-loop/engine'\nexport const a = (p: Purchasable, o: Other) => p.amount + o.amount\n`;
    const r = migrate(engine, before, [
      entry('property', 'amount', 'count', { owners: ['Purchasable'] }),
    ]);
    expect(r.after).toBe(
      `import type { Purchasable, Other } from '@open-loop/engine'\nexport const a = (p: Purchasable, o: Other) => p.count + o.amount\n`,
    );
    expect(r.remaining).toEqual([]);
  });

  it('renames a type at its import and every use', () => {
    const engine = `export interface SlotOptions { id: string }\n`;
    const before = `import type { SlotOptions } from '@open-loop/engine'\nexport const o: SlotOptions = { id: 'a' }\n`;
    const r = migrate(engine, before, [entry('type', 'SlotOptions', 'LoadoutOptions')]);
    expect(r.after).toBe(
      `import type { LoadoutOptions } from '@open-loop/engine'\nexport const o: LoadoutOptions = { id: 'a' }\n`,
    );
  });

  it('merges a type into one the engine already has', () => {
    const engine = `export type MaybeGetter<T> = T | (() => T)\nexport type Computable<T> = T | { value: T } | (() => T)\n`;
    const before = `import type { MaybeGetter } from '@open-loop/engine'\nexport const d: MaybeGetter<string> = () => 'x'\n`;
    const r = migrate(engine, before, [entry('merge', 'MaybeGetter', 'Computable')]);
    expect(r.after).toBe(
      `import type { Computable } from '@open-loop/engine'\nexport const d: Computable<string> = () => 'x'\n`,
    );
  });

  it('renames a literal in the declaration, then its uses from the type errors', () => {
    const engine = `export interface Gate { mode: 'unlock' | 'hide' }\n`;
    const before = `import type { Gate } from '@open-loop/engine'\nexport const g: Gate = { mode: 'unlock' }\n`;
    const r = migrate(engine, before, [entry('literal', 'unlock', 'active', { owners: ['Gate'] })]);
    expect(r.after).toBe(
      `import type { Gate } from '@open-loop/engine'\nexport const g: Gate = { mode: 'active' }\n`,
    );
    expect(r.remaining).toEqual([]);
  });

  it('lists a save key by hand and changes nothing', () => {
    const engine = `export interface Challenge { entered: boolean }\n`;
    const before = `export const key = 'active'\n`;
    const r = migrate(engine, before, [
      entry('save-key', 'active', 'entered', { owners: ['Challenge'] }),
    ]);
    expect(r.after).toBe(before);
    expect(r.todo).toEqual([
      expect.stringContaining(
        'save-key `active` → `entered` on Challenge: save-key: check the consumer by hand',
      ),
    ]);
  });

  it('applies a range in order, so a later release renames the earlier rename', () => {
    const engine = `export interface Bonus { mult: number }\nexport declare function createSlot(): Bonus\n`;
    const before = `import { createSlot } from '@open-loop/engine'\nexport const m = createSlot().mult\n`;
    const r = migrate(
      engine,
      before,
      [entry('function', 'createSlot', 'createLoadout'), entry('type', 'Bonus', 'Grant')],
      [entry('property', 'mult', 'multiplier', { owners: ['Grant'] })],
    );
    expect(r.after).toBe(
      `import { createLoadout } from '@open-loop/engine'\nexport const m = createLoadout().multiplier\n`,
    );
  });
});

describe('API migration manifests', () => {
  it('picks the releases after the installed version, up to the target', () => {
    expect(compareVersions('0.5.0', '0.4.9')).toBeGreaterThan(0);
    expect(compareVersions('0.5.0-sha.1', '0.5.0')).toBeLessThan(0);
    const versions = manifestVersions();
    expect(manifestsInRange('0.4.3').map((m) => m.version)).toEqual(
      versions.filter((v) => compareVersions(v, '0.4.3') > 0),
    );
    expect(manifestsInRange('0.4.3', '0.5.2').map((m) => m.version)).toContain('0.5.0');
    expect(manifestsInRange('0.5.0', '0.5.2')).toEqual([]);
  });

  it.each(manifestVersions())(
    '%s: every entry has a known kind and the fields the codemod reads',
    (version) => {
      for (const e of loadManifest(version).entries) {
        expect(KINDS, JSON.stringify(e)).toContain(e.kind);
        expect(typeof e.family).toBe('string');
        expect(typeof e.old).toBe('string');
        expect(typeof e.public).toBe('boolean');
        // a removal, or a deleted file, has no new name
        if (e.new !== null) expect(typeof e.new).toBe('string');
        else expect(['removal', 'file']).toContain(e.kind);
      }
    },
  );
});
