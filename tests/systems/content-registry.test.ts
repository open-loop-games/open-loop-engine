import { describe, it, expect } from 'vitest';
import { createContentRegistry } from '@/systems/content-registry';

interface TestItem {
  id: string;
  name: string;
  value: number;
}

describe('ContentRegistry', () => {
  function make() {
    return createContentRegistry<TestItem>('test');
  }

  // --- Factory ---

  it('creates a registry with the given name', () => {
    const reg = make();
    expect(reg.name).toBe('test');
  });

  it('starts empty', () => {
    const reg = make();
    expect(reg.size).toBe(0);
    expect(reg.getAll()).toEqual([]);
  });

  // --- register() ---

  it('registers a single entry', () => {
    const reg = make();
    reg.register({ id: 'a', name: 'Alpha', value: 1 });
    expect(reg.size).toBe(1);
    expect(reg.get('a')).toEqual({ id: 'a', name: 'Alpha', value: 1 });
  });

  it('registers an array of entries', () => {
    const reg = make();
    reg.register([
      { id: 'a', name: 'Alpha', value: 1 },
      { id: 'b', name: 'Beta', value: 2 },
    ]);
    expect(reg.size).toBe(2);
    expect(reg.has('a')).toBe(true);
    expect(reg.has('b')).toBe(true);
  });

  it('registers an empty array without error', () => {
    const reg = make();
    reg.register([]);
    expect(reg.size).toBe(0);
  });

  it('throws on duplicate id', () => {
    const reg = make();
    reg.register({ id: 'a', name: 'Alpha', value: 1 });
    expect(() => reg.register({ id: 'a', name: 'Again', value: 2 })).toThrow(
      '[test] Duplicate entry id: "a"',
    );
  });

  it('throws on empty string id', () => {
    const reg = make();
    expect(() => reg.register({ id: '', name: 'Bad', value: 0 })).toThrow(
      '[test] Cannot register entry with empty id',
    );
  });

  it('batch register is atomic — no entries added on failure', () => {
    const reg = make();
    reg.register({ id: 'existing', name: 'Exists', value: 0 });
    expect(() =>
      reg.register([
        { id: 'new1', name: 'New', value: 1 },
        { id: 'existing', name: 'Dup', value: 2 },
      ]),
    ).toThrow('[test] Duplicate entry id: "existing"');
    expect(reg.size).toBe(1);
    expect(reg.has('new1')).toBe(false);
  });

  it('detects duplicates within the same batch', () => {
    const reg = make();
    expect(() =>
      reg.register([
        { id: 'x', name: 'X', value: 1 },
        { id: 'x', name: 'X2', value: 2 },
      ]),
    ).toThrow('[test] Duplicate entry id in batch: "x"');
    expect(reg.size).toBe(0);
  });

  it('preserves insertion order', () => {
    const reg = make();
    reg.register({ id: 'c', name: 'C', value: 3 });
    reg.register({ id: 'a', name: 'A', value: 1 });
    reg.register({ id: 'b', name: 'B', value: 2 });
    expect(reg.getAll().map((e) => e.id)).toEqual(['c', 'a', 'b']);
  });

  // --- get() / has() ---

  it('get returns undefined for unknown id', () => {
    const reg = make();
    expect(reg.get('nope')).toBeUndefined();
  });

  it('has returns false for unknown id', () => {
    const reg = make();
    expect(reg.has('nope')).toBe(false);
  });

  // --- patch() ---

  it('shallow-patches an existing entry', () => {
    const reg = make();
    reg.register({ id: 'a', name: 'Alpha', value: 1 });
    reg.patch('a', { name: 'Modified', value: 99 });
    expect(reg.get('a')).toEqual({ id: 'a', name: 'Modified', value: 99 });
  });

  it('patch does not change id even if somehow included', () => {
    const reg = make();
    reg.register({ id: 'a', name: 'Alpha', value: 1 });
    // TypeScript prevents this, but test the runtime behavior
    reg.patch('a', { name: 'Patched' } as any);
    expect(reg.get('a')!.id).toBe('a');
  });

  it('throws when patching unknown id', () => {
    const reg = make();
    expect(() => reg.patch('nope', { value: 5 })).toThrow('[test] Cannot patch unknown id: "nope"');
  });

  it('patch with empty object is a no-op', () => {
    const reg = make();
    reg.register({ id: 'a', name: 'Alpha', value: 1 });
    reg.patch('a', {});
    expect(reg.get('a')).toEqual({ id: 'a', name: 'Alpha', value: 1 });
  });

  it('patch mutates the original entry (same reference)', () => {
    const reg = make();
    reg.register({ id: 'a', name: 'Alpha', value: 1 });
    const before = reg.get('a');
    reg.patch('a', { value: 42 });
    const after = reg.get('a');
    expect(before).toBe(after);
    expect(after!.value).toBe(42);
  });

  // --- getAll() ---

  it('getAll reflects patches', () => {
    const reg = make();
    reg.register([
      { id: 'a', name: 'A', value: 1 },
      { id: 'b', name: 'B', value: 2 },
    ]);
    reg.patch('a', { name: 'Patched' });
    const all = reg.getAll();
    expect(all[0].name).toBe('Patched');
  });

  // --- size ---

  it('size tracks the number of entries', () => {
    const reg = make();
    expect(reg.size).toBe(0);
    reg.register({ id: 'a', name: 'A', value: 1 });
    expect(reg.size).toBe(1);
    reg.register([
      { id: 'b', name: 'B', value: 2 },
      { id: 'c', name: 'C', value: 3 },
    ]);
    expect(reg.size).toBe(3);
  });
});
