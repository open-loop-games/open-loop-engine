import { describe, it, expect } from 'vitest';
import {
  getNested,
  setNested,
  renameField,
  retypeField,
  deleteField,
  addField,
  forEachDef,
} from '@/core/save-migrations';

describe('getNested', () => {
  it('reads single-segment paths', () => {
    expect(getNested({ a: 1 }, 'a')).toBe(1);
  });

  it('reads nested paths', () => {
    expect(getNested({ a: { b: { c: 42 } } }, 'a.b.c')).toBe(42);
  });

  it('returns undefined for missing intermediates', () => {
    expect(getNested({ a: {} }, 'a.b.c')).toBeUndefined();
  });

  it('returns undefined when an intermediate is null', () => {
    expect(getNested({ a: { b: null } } as Record<string, unknown>, 'a.b.c')).toBeUndefined();
  });

  it('returns undefined when an intermediate is a primitive', () => {
    expect(getNested({ a: { b: 'leaf' } } as Record<string, unknown>, 'a.b.c')).toBeUndefined();
  });

  it('returns undefined for missing leaf', () => {
    expect(getNested({ a: { b: {} } }, 'a.b.c')).toBeUndefined();
  });

  it('preserves falsy values that are not nullish', () => {
    expect(getNested({ a: 0 }, 'a')).toBe(0);
    expect(getNested({ a: false }, 'a')).toBe(false);
    expect(getNested({ a: '' }, 'a')).toBe('');
  });
});

describe('setNested', () => {
  it('writes single-segment paths', () => {
    const data: Record<string, unknown> = {};
    setNested(data, 'a', 1);
    expect(data).toEqual({ a: 1 });
  });

  it('creates intermediate objects', () => {
    const data: Record<string, unknown> = {};
    setNested(data, 'a.b.c', 42);
    expect(data).toEqual({ a: { b: { c: 42 } } });
  });

  it('preserves siblings under existing intermediates', () => {
    const data: Record<string, unknown> = { a: { b: { existing: 'keep' } } };
    setNested(data, 'a.b.c', 42);
    expect(data).toEqual({ a: { b: { existing: 'keep', c: 42 } } });
  });

  it('overwrites the leaf when present', () => {
    const data: Record<string, unknown> = { a: 1 };
    setNested(data, 'a', 2);
    expect(data).toEqual({ a: 2 });
  });

  it('replaces a non-object intermediate with a fresh object', () => {
    const data: Record<string, unknown> = { a: 'oops' };
    setNested(data, 'a.b', 42);
    expect(data).toEqual({ a: { b: 42 } });
  });

  it('replaces a null intermediate with a fresh object', () => {
    const data: Record<string, unknown> = { a: null };
    setNested(data, 'a.b', 42);
    expect(data).toEqual({ a: { b: 42 } });
  });
});

describe('renameField', () => {
  it('moves a single-segment field', () => {
    const data: Record<string, unknown> = { old: 1 };
    renameField(data, 'old', 'new');
    expect(data).toEqual({ new: 1 });
  });

  it('moves a nested field', () => {
    const data: Record<string, unknown> = { jobs: { warrior: { progress: 5 } } };
    renameField(data, 'jobs.warrior', 'jobs.fighter');
    expect(data).toEqual({ jobs: { fighter: { progress: 5 } } });
  });

  it('no-ops when the source path is missing', () => {
    const data: Record<string, unknown> = { other: 1 };
    renameField(data, 'missing.path', 'new');
    expect(data).toEqual({ other: 1 });
  });

  it('no-ops when an intermediate is missing', () => {
    const data: Record<string, unknown> = { jobs: {} };
    renameField(data, 'jobs.warrior.progress', 'jobs.fighter.progress');
    expect(data).toEqual({ jobs: {} });
  });

  it('returns the same data ref for chaining', () => {
    const data: Record<string, unknown> = { a: 1 };
    expect(renameField(data, 'a', 'b')).toBe(data);
  });

  it('preserves falsy values when moving', () => {
    const data: Record<string, unknown> = { a: 0 };
    renameField(data, 'a', 'b');
    expect(data).toEqual({ b: 0 });
  });
});

describe('retypeField', () => {
  it('applies the transform when the path exists', () => {
    const data: Record<string, unknown> = { gold: 100 };
    retypeField(data, 'gold', (v) => String(v));
    expect(data).toEqual({ gold: '100' });
  });

  it('no-ops when the path is missing', () => {
    const data: Record<string, unknown> = {};
    retypeField(data, 'gold', (v) => String(v));
    expect(data).toEqual({});
  });

  it('no-ops when an intermediate is missing', () => {
    const data: Record<string, unknown> = { stats: {} };
    retypeField(data, 'stats.gold', (v) => String(v));
    expect(data).toEqual({ stats: {} });
  });

  it('supports the Decimal-as-string migration pattern', () => {
    const data: Record<string, unknown> = { inventory: { gold: 1e15 } };
    retypeField(data, 'inventory.gold', (v) => String(v));
    expect(data).toEqual({ inventory: { gold: '1000000000000000' } });
  });
});

describe('deleteField', () => {
  it('removes the leaf', () => {
    const data: Record<string, unknown> = { a: 1, b: 2 };
    deleteField(data, 'a');
    expect(data).toEqual({ b: 2 });
  });

  it('removes a nested leaf and leaves siblings intact', () => {
    const data: Record<string, unknown> = { stats: { kills: 1, deaths: 2 } };
    deleteField(data, 'stats.deaths');
    expect(data).toEqual({ stats: { kills: 1 } });
  });

  it('no-ops when the path is missing', () => {
    const data: Record<string, unknown> = { a: 1 };
    deleteField(data, 'b');
    expect(data).toEqual({ a: 1 });
  });

  it('no-ops when an intermediate is missing', () => {
    const data: Record<string, unknown> = {};
    deleteField(data, 'a.b.c');
    expect(data).toEqual({});
  });
});

describe('addField', () => {
  it('writes when the leaf is missing', () => {
    const data: Record<string, unknown> = {};
    addField(data, 'stats.deaths', 0);
    expect(data).toEqual({ stats: { deaths: 0 } });
  });

  it('writes when the existing value is null', () => {
    const data: Record<string, unknown> = { stats: { deaths: null } };
    addField(data, 'stats.deaths', 0);
    expect(data).toEqual({ stats: { deaths: 0 } });
  });

  it('writes when the existing value is undefined', () => {
    const data: Record<string, unknown> = { stats: { deaths: undefined } };
    addField(data, 'stats.deaths', 0);
    expect(data).toEqual({ stats: { deaths: 0 } });
  });

  it('preserves an existing non-nullish value by default', () => {
    const data: Record<string, unknown> = { stats: { deaths: 7 } };
    addField(data, 'stats.deaths', 0);
    expect(data).toEqual({ stats: { deaths: 7 } });
  });

  it('preserves an existing falsy non-nullish value (0, false, "")', () => {
    const a: Record<string, unknown> = { v: 0 };
    addField(a, 'v', 99);
    expect(a).toEqual({ v: 0 });
    const b: Record<string, unknown> = { v: false };
    addField(b, 'v', true);
    expect(b).toEqual({ v: false });
    const c: Record<string, unknown> = { v: '' };
    addField(c, 'v', 'default');
    expect(c).toEqual({ v: '' });
  });

  it('overwrite:true replaces any existing value', () => {
    const data: Record<string, unknown> = { stats: { chapterTimes: { 1: 100, 2: 200 } } };
    addField(data, 'stats.chapterTimes', {}, { overwrite: true });
    expect(data).toEqual({ stats: { chapterTimes: {} } });
  });
});

describe('forEachDef', () => {
  it('iterates each entry in the context', () => {
    const data: Record<string, unknown> = {
      jobs: { warrior: { lv: 1 }, mage: { lv: 2 } },
    };
    const seen: string[] = [];
    forEachDef(data, 'jobs', (entry, id) => {
      seen.push(id);
      entry.touched = true;
    });
    expect(seen.sort()).toEqual(['mage', 'warrior']);
    expect(data).toEqual({
      jobs: { warrior: { lv: 1, touched: true }, mage: { lv: 2, touched: true } },
    });
  });

  it('no-ops when the context is missing', () => {
    const data: Record<string, unknown> = { other: 1 };
    forEachDef(data, 'jobs', () => {
      throw new Error('should not be called');
    });
    expect(data).toEqual({ other: 1 });
  });

  it('no-ops when the context is not an object', () => {
    const data: Record<string, unknown> = { jobs: 'oops' };
    forEachDef(data, 'jobs', () => {
      throw new Error('should not be called');
    });
    expect(data).toEqual({ jobs: 'oops' });
  });

  it('skips non-object entries within the context', () => {
    const data: Record<string, unknown> = {
      jobs: { warrior: { lv: 1 }, broken: null, scalar: 7 },
    };
    const seen: string[] = [];
    forEachDef(data, 'jobs', (_entry, id) => {
      seen.push(id);
    });
    expect(seen).toEqual(['warrior']);
  });
});

describe('composition', () => {
  it('chains via the returned data ref', () => {
    const data: Record<string, unknown> = { a: 1, c: 3 };
    const out = renameField(deleteField(data, 'c'), 'a', 'b');
    expect(out).toBe(data);
    expect(data).toEqual({ b: 1 });
  });
});

// Anchor: real migrations from /work/studio/incloneution/src/migrations.ts must
// behave identically when re-expressed with the new helpers. These tests pin
// that the engine helpers cover the existing real-world corpus.
describe('incloneution corpus regression', () => {
  it('v1→v2: adds genStartCompletions + hadEncounteredBeforeGeneration across action types', () => {
    const hand: Record<string, Record<string, Record<string, unknown>>> = {
      jobs: { warrior: { timesCompleted: 3, hasEncountered: true } },
      constructions: { hut: { timesCompleted: 0, hasEncountered: false } },
      exploration: { woods: { timesCompleted: 2 } },
    };
    const helper = structuredClone(hand);

    // Hand-rolled shape (verbatim from incloneution).
    for (const group of ['jobs', 'constructions', 'exploration']) {
      const section = hand[group];
      if (!section || typeof section !== 'object') continue;
      for (const id of Object.keys(section)) {
        const entry = section[id];
        if (!entry || typeof entry !== 'object') continue;
        entry.genStartCompletions ??= entry.timesCompleted ?? 0;
        entry.hadEncounteredBeforeGeneration ??= entry.hasEncountered ?? false;
      }
    }

    // Helper-composed shape.
    for (const group of ['jobs', 'constructions', 'exploration']) {
      forEachDef(helper as Record<string, unknown>, group, (entry) => {
        entry.genStartCompletions ??= entry.timesCompleted ?? 0;
        entry.hadEncounteredBeforeGeneration ??= entry.hasEncountered ?? false;
      });
    }

    expect(helper).toEqual(hand);
    // Spot-check a value to ensure the migration actually mutated.
    expect((helper.jobs.warrior as Record<string, unknown>).genStartCompletions).toBe(3);
    expect(
      (helper.exploration.woods as Record<string, unknown>).hadEncounteredBeforeGeneration,
    ).toBe(false);
  });

  it('v3→v4: clears chapterTimes via overwrite', () => {
    const hand: Record<string, Record<string, unknown>> = {
      stats: { chapterTimes: { 1: 100, 2: 200, 3: 300 }, other: 'keep' },
    };
    const helper = structuredClone(hand);

    // Hand-rolled.
    if (hand.stats && typeof hand.stats === 'object') {
      hand.stats.chapterTimes = {};
    }

    // Helper-composed.
    addField(helper as Record<string, unknown>, 'stats.chapterTimes', {}, { overwrite: true });

    expect(helper).toEqual(hand);
    expect(helper.stats.chapterTimes).toEqual({});
    expect(helper.stats.other).toBe('keep');
  });

  it('forward-compat: helpers tolerate the absent-section case the hand-rolled code also tolerates', () => {
    const data: Record<string, unknown> = { jobs: {} };
    expect(() =>
      forEachDef(data, 'constructions', () => {
        throw new Error('unreachable');
      }),
    ).not.toThrow();
    expect(() => addField(data, 'stats.chapterTimes', {}, { overwrite: true })).not.toThrow();
    expect(data).toEqual({ jobs: {}, stats: { chapterTimes: {} } });
  });
});
