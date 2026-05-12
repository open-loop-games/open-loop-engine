/**
 * Fixture tests for `scripts/parse-dts.mjs`.
 *
 * Drives `parseEntrypoint` against a hand-built `sample-pkg` fixture that
 * exercises every symbol kind the docs pipeline emits: function, interface,
 * type, const, class, abstract-class, enum — plus `@internal`-tagged and
 * default-export edge cases.
 */
import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
// @ts-expect-error — JS module without types, fine for tests
import { parseEntrypoint } from '../../scripts/parse-dts.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = join(__dirname, 'fixtures', 'sample-pkg');
const FIXTURE_DTS = join(FIXTURE_ROOT, 'dist', 'index.d.ts');

interface Record {
  name: string;
  kind: string;
  signature: string;
  tsdocSummary: string;
  sourcePath: string;
  line: number | null;
  layer: string;
  cluster: string;
  tag: 'public' | 'internal';
}

describe('parseEntrypoint', () => {
  const { records, unresolved } = parseEntrypoint(FIXTURE_DTS, {
    projectRoot: FIXTURE_ROOT,
  });
  const byName = new Map<string, Record>(records.map((r: Record) => [r.name, r]));

  it('resolves every export without leftovers', () => {
    expect(unresolved).toEqual([]);
  });

  it('emits one record per symbol covering every kind', () => {
    const kinds = new Set(records.map((r: Record) => r.kind));
    expect(kinds).toEqual(
      new Set(['function', 'interface', 'type', 'const', 'class', 'abstract-class', 'enum']),
    );
  });

  it('shape: function (createWidget)', () => {
    const r = byName.get('createWidget')!;
    expect(r).toBeDefined();
    expect(r.kind).toBe('function');
    expect(r.layer).toBe('layer-a');
    expect(r.cluster).toBe('widgets');
    expect(r.sourcePath).toBe('src/layer-a/widgets.ts');
    expect(r.line).toBeGreaterThan(0);
    expect(r.tag).toBe('public');
    expect(r.signature).toMatch(/^export declare function createWidget\(/);
    expect(r.tsdocSummary).toBe('Create a new widget with the given kind.');
  });

  it('shape: interface (Widget)', () => {
    const r = byName.get('Widget')!;
    expect(r.kind).toBe('interface');
    expect(r.signature).toMatch(/^export interface Widget/);
    expect(r.tsdocSummary).toBe('A renderable widget.');
  });

  it('shape: type (WidgetID)', () => {
    const r = byName.get('WidgetID')!;
    expect(r.kind).toBe('type');
    expect(r.signature).toBe('export type WidgetID = string;');
  });

  it('shape: const (WIDGET_LIMIT) — wraps with `export declare const`', () => {
    const r = byName.get('WIDGET_LIMIT')!;
    expect(r.kind).toBe('const');
    expect(r.signature).toBe('export declare const WIDGET_LIMIT = 100;');
  });

  it('shape: enum (WidgetKind)', () => {
    const r = byName.get('WidgetKind')!;
    expect(r.kind).toBe('enum');
    expect(r.signature).toMatch(/^export declare enum WidgetKind/);
  });

  it('shape: class (WidgetRegistry)', () => {
    const r = byName.get('WidgetRegistry')!;
    expect(r.kind).toBe('class');
    expect(r.layer).toBe('layer-b');
    expect(r.cluster).toBe('store');
    expect(r.signature).toMatch(/^export declare class WidgetRegistry/);
  });

  it('shape: abstract-class (BaseStore) — distinguishes from regular class', () => {
    const r = byName.get('BaseStore')!;
    expect(r.kind).toBe('abstract-class');
    expect(r.signature).toMatch(/^export declare abstract class BaseStore/);
  });

  it('@internal tag flips `tag` field to internal', () => {
    const r = byName.get('internalHelper')!;
    expect(r.tag).toBe('internal');
  });

  it('default-export resolves to its declared name, not "default"', () => {
    expect(byName.has('DefaultStore')).toBe(true);
    expect(byName.has('default')).toBe(false);
    expect(byName.get('DefaultStore')!.kind).toBe('class');
  });

  it('@cluster tag in src header drives cluster id', () => {
    expect(byName.get('createWidget')!.cluster).toBe('widgets');
    expect(byName.get('BaseStore')!.cluster).toBe('store');
  });

  it('all required fields populated on every record', () => {
    for (const r of records) {
      expect(r.name).toBeTypeOf('string');
      expect(r.kind).toBeTypeOf('string');
      expect(r.signature).toBeTypeOf('string');
      expect(r.sourcePath).toBeTypeOf('string');
      expect(r.layer).toBeTypeOf('string');
      expect(r.cluster).toBeTypeOf('string');
      expect(['public', 'internal']).toContain(r.tag);
    }
  });
});
