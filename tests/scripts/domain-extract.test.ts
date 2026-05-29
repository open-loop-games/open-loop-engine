/**
 * Fixture tests for `scripts/lib/domain-extract.mjs`.
 *
 * Drives `extractDomain` against a hand-built `sample-game` fixture covering def
 * inventory + view exclusion, vocabulary (enum / bare union / discriminated
 * union), edge mining (multi-word noun, ref-suffix strip, plural container,
 * base/arm flattening, self-reference skip), the false-positive guards
 * (`status` ≠ stat, `modulo` ≠ mod), scope isolation, and the stopword escape
 * hatch.
 */
import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
// @ts-expect-error — JS module without types, fine for tests
import { extractDomain } from '../../scripts/lib/domain-extract.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(__dirname, 'fixtures', 'sample-game');

interface Edge {
  from: string;
  to: string;
}
interface Vocab {
  owner: string;
  kind: string;
  arms: string[];
}
interface Result {
  defs: string[];
  vocabulary: Vocab[];
  edges: Edge[];
  thinSpots: string[];
  fileCount: number;
}

const run = (overrides = {}): Result =>
  extractDomain({ scope: ['data/*.ts'], defSuffixes: ['Def'], ...overrides }, { rootDir: FIXTURE });

describe('extractDomain', () => {
  const r = run();
  const edgeStr = r.edges.map((e) => `${e.from} -> ${e.to}`);
  const hasEdge = (from: string, to: string) => r.edges.some((e) => e.from === from && e.to === to);

  it('def inventory: matches defSuffixes, excludes view interfaces and non-Def/non-exported types', () => {
    expect(r.defs).toEqual([
      'ActionDef',
      'BarDef',
      'FooDef',
      'ModDef',
      'StatDef',
      'WidgetGadgetDef',
    ]);
    expect(r.defs).not.toContain('GameState'); // view interface
    expect(r.defs).not.toContain('SampleData'); // no Def suffix
    expect(r.defs).not.toContain('ActionBase'); // non-exported
  });

  it('vocabulary: enum, bare string union, and discriminated-union arm', () => {
    const byOwner = new Map(r.vocabulary.map((v) => [v.owner, v]));
    expect(byOwner.get('Color')).toMatchObject({ kind: 'enum', arms: ['Red', 'Green', 'Blue'] });
    expect(byOwner.get('Size')).toMatchObject({ kind: 'union', arms: ['small', 'large'] });
    expect(byOwner.get('ActionDef.type')).toBeUndefined();
    expect(byOwner.get('ActionDef.kind')).toMatchObject({
      kind: 'discriminator',
      arms: ['move', 'wait'],
    });
  });

  it('edges: ref-suffix strip, multi-word noun, plural container, base/arm flatten', () => {
    expect(hasEdge('FooDef.barId', 'bar')).toBe(true);
    expect(hasEdge('FooDef.widgetGadgetId', 'widgetGadget')).toBe(true); // multi-word
    expect(hasEdge('FooDef.statId', 'stat')).toBe(true);
    expect(hasEdge('SampleData.foos', 'foo')).toBe(true); // plural container
    expect(hasEdge('ActionDef.fooId', 'foo')).toBe(true); // flattened from non-exported base
    expect(hasEdge('ActionDef.targetBarId', 'bar')).toBe(true);
    // base/arm: fooId surfaces once, under the exported union — never ActionBase
    expect(edgeStr.filter((e) => e === 'ActionDef.fooId -> foo')).toHaveLength(1);
    expect(r.edges.some((e) => e.from.startsWith('ActionBase.'))).toBe(false);
  });

  it('false-positive guards: status ≠ stat, modulo ≠ mod', () => {
    expect(hasEdge('FooDef.status', 'stat')).toBe(false);
    expect(hasEdge('FooDef.modulo', 'mod')).toBe(false);
  });

  it('self-reference edges are skipped (FooDef → foo)', () => {
    expect(hasEdge('FooDef.parentFooId', 'foo')).toBe(false);
  });

  it('scope isolation: out-of-scope (imported) types and nouns never leak', () => {
    expect(r.defs).not.toContain('EngineWidgetDef');
    expect(r.edges.some((e) => e.to === 'engineWidget')).toBe(false);
    expect(r.vocabulary.some((v) => v.owner === 'EngineMode')).toBe(false);
    // Only the data/ file is in scope.
    expect(r.fileCount).toBe(1);
  });

  it('thin spots: defs with no vocabulary and no incident edge', () => {
    expect(r.thinSpots).toEqual(['ModDef']);
  });

  it('stopword guard removes a specific field edge', () => {
    const guarded = run({ stopwords: ['barId'] });
    expect(guarded.edges.some((e) => e.from === 'FooDef.barId')).toBe(false);
    // unrelated bar edges remain
    expect(guarded.edges.some((e) => e.from === 'ActionDef.targetBarId' && e.to === 'bar')).toBe(
      true,
    );
  });

  it('explicit nouns override auto-seeding', () => {
    const onlyBar = run({ nouns: ['bar'] });
    expect(onlyBar.edges.every((e) => e.to === 'bar')).toBe(true);
    expect(onlyBar.edges.some((e) => e.from === 'FooDef.barId')).toBe(true);
  });
});
