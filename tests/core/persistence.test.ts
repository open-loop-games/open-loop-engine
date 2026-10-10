import { describe, it, expect, vi } from 'vitest';
import {
  persistent,
  isPersistent,
  beginPersistentContext,
  endPersistentContext,
  resetPersistent,
  getAllPersistentRefs,
  serializePersistents,
  deserializePersistents,
  createDefStates,
  getPersistentRefs,
  getPersistentContextRefs,
  setPersistentId,
  PersistentId,
  isAtDefault,
  filterDefaultedRefs,
  resetAllPersistentContexts,
  withPersistenceNamespace,
  withPersistentContext,
} from '@/core/persistence';
import { Decimal, bn, type DecimalSource } from '@/primitives/decimal';

describe('Persistence', () => {
  it('persistent() creates a ref with default value', () => {
    beginPersistentContext('test-create');
    const p = persistent(42);
    endPersistentContext();
    expect(p.value).toBe(42);
  });
  it('persistent() ref is mutable', () => {
    beginPersistentContext('test-mutable');
    const p = persistent(0);
    endPersistentContext();
    p.value = 100;
    expect(p.value).toBe(100);
  });
  it('isPersistent() identifies persistent refs', () => {
    beginPersistentContext('test-ispersistent');
    const p = persistent(0);
    endPersistentContext();
    expect(isPersistent(p)).toBe(true);
  });
  it('resetPersistent restores default value', () => {
    beginPersistentContext('test-reset');
    const p = persistent(42);
    endPersistentContext();
    p.value = 999;
    resetPersistent(p);
    expect(p.value).toBe(42);
  });

  it('resetPersistent survives in-place mutation of a Decimal default', () => {
    // break_eternity Decimals expose in-place mutators (.fromNumber, direct
    // .sign/.mag/.layer writes). DefaultValue must be a snapshot, not an
    // alias of the live value — otherwise reset becomes a no-op after any
    // in-place mutation, including across repeated reset cycles.
    beginPersistentContext('test-reset-decimal-alias');
    const p = persistent<Decimal>(new Decimal(5));
    endPersistentContext();
    (p.value as Decimal).fromNumber(999);
    resetPersistent(p);
    expect(new Decimal(p.value).toNumber()).toBe(5);
    (p.value as Decimal).fromNumber(42);
    resetPersistent(p);
    expect(new Decimal(p.value).toNumber()).toBe(5);
  });

  it('resetPersistent survives in-place mutation of an array default', () => {
    beginPersistentContext('test-reset-array-alias');
    const p = persistent<number[]>([1, 2, 3]);
    endPersistentContext();
    (p.value as number[]).push(999);
    resetPersistent(p);
    expect(p.value).toEqual([1, 2, 3]);
  });

  describe('options object', () => {
    it('accepts an options object as the second argument', () => {
      beginPersistentContext('test-options');
      const p = persistent(7, { checkNaN: true });
      endPersistentContext();
      expect(p.value).toBe(7);
    });

    it('checkNaN: false allows NaN writes without refusing them', () => {
      beginPersistentContext('test-options-nancheck');
      const p = persistent(0, { checkNaN: false });
      endPersistentContext();
      p.value = NaN;
      expect(Number.isNaN(p.value)).toBe(true);
    });

    it('checkNaN defaults to true when options omits it', () => {
      beginPersistentContext('test-options-default');
      const p = persistent(0, {});
      endPersistentContext();
      p.value = NaN;
      // NaN write is refused — value stays at previous (0)
      expect(p.value).toBe(0);
    });
  });

  describe('non-finite number serialization', () => {
    it.each([
      ['Infinity', Infinity],
      ['-Infinity', -Infinity],
      ['NaN', NaN],
    ])('round-trips %s through serialize/deserialize', (label, value) => {
      beginPersistentContext(`test-nonfinite-${label}`);
      const p = persistent(value);
      endPersistentContext();

      const refs = getAllPersistentRefs();
      const serialized = serializePersistents(refs);
      const json = JSON.stringify(serialized);
      const parsed = JSON.parse(json);

      // Reset to 0 to prove deserialize restores the non-finite value
      p.value = 0;
      deserializePersistents(refs, parsed);

      if (Number.isNaN(value)) {
        expect(Number.isNaN(p.value)).toBe(true);
      } else {
        expect(p.value).toBe(value);
      }
    });

    it('serializes non-finite numbers as strings, not null', () => {
      beginPersistentContext('test-nonfinite-json');
      persistent(Infinity);
      endPersistentContext();

      const refs = getAllPersistentRefs();
      const serialized = serializePersistents(refs);
      const json = JSON.stringify(serialized);

      expect(json).not.toContain('null');
      expect(json).toContain('"Infinity"');
    });
  });

  describe('Decimal round-trip', () => {
    it('rehydrates string-encoded Decimals back into Decimal instances on load', () => {
      // serializePersistents writes Decimals as `value.toString()`. Without
      // rehydration, deserialize would leave a raw string in the ref, breaking
      // any consumer that calls instance methods (`.gte`, `.add`, etc.).
      beginPersistentContext('test-decimal-roundtrip');
      const score = persistent(bn(0));
      endPersistentContext();

      score.value = new Decimal('1e100');

      const refs = getAllPersistentRefs();
      const serialized = serializePersistents(refs);
      const parsed = JSON.parse(JSON.stringify(serialized));

      score.value = bn(0);
      deserializePersistents(refs, parsed);

      expect(score.value).toBeInstanceOf(Decimal);
      expect((score.value as Decimal).gte('1e99')).toBe(true);
      expect((score.value as Decimal).add(1).gte('1e100')).toBe(true);
    });

    it('revives a Decimal nested inside an object-valued ref (open-loop-engine#7)', () => {
      // break_eternity's Decimal.toJSON emits a string, so a Decimal stored one
      // level down (`{ hp }`) survives serialization only as a string. Revival
      // must reach it, or consumers storing a small struct in one ref get
      // strings back and break on the first Decimal method call.
      beginPersistentContext('test-nested-decimal');
      const stats = persistent({ hp: new Decimal(10), mana: new Decimal(5) }, { id: 'stats' });
      endPersistentContext();

      stats.value = { hp: new Decimal(99), mana: new Decimal('1e42') };

      const refs = getAllPersistentRefs();
      const parsed = JSON.parse(JSON.stringify(serializePersistents(refs)));

      stats.value = { hp: new Decimal(0), mana: new Decimal(0) };
      deserializePersistents(refs, parsed);

      expect(stats.value.hp).toBeInstanceOf(Decimal);
      expect(stats.value.mana).toBeInstanceOf(Decimal);
      expect(stats.value.hp.eq(99)).toBe(true);
      expect(stats.value.mana.eq('1e42')).toBe(true);
    });

    it('revives Decimals nested inside an array-valued ref', () => {
      // Array elements revive against default[i] (falling back to default[0]),
      // so a homogeneous Decimal array round-trips even when it grows past the
      // default's length.
      beginPersistentContext('test-nested-decimal-array');
      const bag = persistent<Decimal[]>([new Decimal(0)], { id: 'bag' });
      endPersistentContext();

      bag.value = [new Decimal(1), new Decimal(2), new Decimal('1e9')];

      const refs = getAllPersistentRefs();
      const parsed = JSON.parse(JSON.stringify(serializePersistents(refs)));

      bag.value = [new Decimal(0)];
      deserializePersistents(refs, parsed);

      expect(bag.value).toHaveLength(3);
      for (const el of bag.value) expect(el).toBeInstanceOf(Decimal);
      expect(bag.value[2].eq('1e9')).toBe(true);
    });
  });

  describe('DecimalSource refs with a number default', () => {
    it('revives a Decimal saved under a number default, past the number range too', () => {
      beginPersistentContext('test-decimalsource-number-default');
      const xp = persistent<DecimalSource>(0, { id: 'xp' });
      endPersistentContext();

      const refs = getAllPersistentRefs();
      for (const held of [new Decimal('1e500'), new Decimal(12.5)]) {
        xp.value = held;
        const parsed = JSON.parse(JSON.stringify(serializePersistents(refs)));
        xp.value = 0;
        deserializePersistents(refs, parsed);
        expect(xp.value).toBeInstanceOf(Decimal);
        expect(Decimal.eq(xp.value, held)).toBe(true);
      }
    });

    it('keeps a plain number a number, and non-finite markers numbers', () => {
      beginPersistentContext('test-decimalsource-plain');
      const n = persistent<DecimalSource>(0, { id: 'n' });
      endPersistentContext();

      const refs = getAllPersistentRefs();
      for (const held of [7, Infinity]) {
        n.value = held;
        const parsed = JSON.parse(JSON.stringify(serializePersistents(refs)));
        n.value = 0;
        deserializePersistents(refs, parsed);
        expect(n.value).toBe(held);
      }
    });

    it('leaves non-numeric text under a number default as text', () => {
      beginPersistentContext('test-number-default-text');
      const tag = persistent<number | string>(0, { id: 'tag' });
      endPersistentContext();

      tag.value = 'boss';
      const refs = getAllPersistentRefs();
      const parsed = JSON.parse(JSON.stringify(serializePersistents(refs)));
      tag.value = 0;
      deserializePersistents(refs, parsed);
      expect(tag.value).toBe('boss');
    });
  });

  describe('namespace stripping preserves `::` in context ids', () => {
    // resource.ts registers lifetime trackers under `${parent}::${id}` so two
    // same-named resources in different parents stay distinct. The earlier
    // stripNamespace implementation sliced on the first `::` unconditionally,
    // collapsing `modA::gold` and `modB::gold` to the same save key.
    it('two contexts sharing a tail id stay distinct in the unnamespaced case', () => {
      beginPersistentContext('strip-modA::gold');
      const aRef = persistent(bn(0), { id: 'cumulative' });
      endPersistentContext();

      beginPersistentContext('strip-modB::gold');
      const bRef = persistent(bn(0), { id: 'cumulative' });
      endPersistentContext();

      const refs = getAllPersistentRefs();
      expect(refs.get('strip-modA::gold.cumulative')).toBe(aRef);
      expect(refs.get('strip-modB::gold.cumulative')).toBe(bRef);
      // The collapsed bare-tail key must not exist.
      expect(refs.has('gold.cumulative')).toBe(false);
    });

    it('only the recorded namespace prefix is stripped, not arbitrary `::`', () => {
      withPersistenceNamespace('strip-ns', () => {
        beginPersistentContext('modX::gold');
        const ref = persistent(bn(0), { id: 'cumulative' });
        endPersistentContext();

        const refs = getAllPersistentRefs('strip-ns');
        expect(refs.get('modX::gold.cumulative')).toBe(ref);
      });
    });
  });

  describe('stable named keys', () => {
    it('persistent({ name }) stores the name on the ref', () => {
      beginPersistentContext('test-named-basic');
      const p = persistent(0, { id: 'score' });
      endPersistentContext();
      expect(p[PersistentId]).toBe('score');
    });

    it('getAllPersistentRefs keys named refs as `${context}.${name}`', () => {
      beginPersistentContext('test-named-keys');
      persistent(0, { id: 'score' });
      persistent(false, { id: 'alive' });
      endPersistentContext();

      const refs = getAllPersistentRefs();
      expect(refs.has('test-named-keys.score')).toBe(true);
      expect(refs.has('test-named-keys.alive')).toBe(true);
    });

    it('reordering named persistent() calls preserves save round-trip', () => {
      // Build v1: count then label
      beginPersistentContext('test-reorder');
      const count1 = persistent(0, { id: 'count' });
      const label1 = persistent('', { id: 'label' });
      endPersistentContext();
      count1.value = 42;
      label1.value = 'hello';

      const snapshot = serializePersistents(getAllPersistentRefs());

      // Simulate a rebuild where the context is recreated with refs in the
      // OPPOSITE order. Clear the context first by deleting the underlying set.
      const refs = getPersistentRefs('test-reorder');
      refs?.clear();

      beginPersistentContext('test-reorder');
      const label2 = persistent('', { id: 'label' });
      const count2 = persistent(0, { id: 'count' });
      endPersistentContext();

      deserializePersistents(getAllPersistentRefs(), snapshot);

      expect(count2.value).toBe(42);
      expect(label2.value).toBe('hello');
    });

    it('setPersistentId throws on collision within a context', () => {
      beginPersistentContext('test-collision');
      const a = persistent(0, { id: 'score' });
      const b = persistent(0);
      endPersistentContext();

      expect(() => setPersistentId(b, 'score')).toThrow(/collision.*test-collision.*score/);
      // a retains its name
      expect(a[PersistentId]).toBe('score');
    });

    it('setPersistentId is idempotent for the same name', () => {
      beginPersistentContext('test-idempotent');
      const p = persistent(0, { id: 'x' });
      endPersistentContext();
      expect(() => setPersistentId(p, 'x')).not.toThrow();
      expect(p[PersistentId]).toBe('x');
    });

    it('renaming frees the old name for reuse', () => {
      beginPersistentContext('test-rename');
      const a = persistent(0, { id: 'foo' });
      const b = persistent(0);
      endPersistentContext();

      setPersistentId(a, 'bar');
      // 'foo' is now free
      expect(() => setPersistentId(b, 'foo')).not.toThrow();
      expect(a[PersistentId]).toBe('bar');
      expect(b[PersistentId]).toBe('foo');
    });

    it('unnamed refs fall back to iteration-index keys with a dev warning', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      beginPersistentContext('test-unnamed-warn');
      persistent(0);
      persistent(0);
      endPersistentContext();

      const refs = getAllPersistentRefs();
      expect(refs.has('test-unnamed-warn.0')).toBe(true);
      expect(refs.has('test-unnamed-warn.1')).toBe(true);

      const matchingCalls = warn.mock.calls.filter((args) =>
        String(args[0] ?? '').includes('test-unnamed-warn'),
      );
      expect(matchingCalls.length).toBeGreaterThanOrEqual(1);

      warn.mockRestore();
    });

    it('createDefStates auto-names fields as `${defId}.${fieldName}`', () => {
      const defs = [{ id: 'warrior' }, { id: 'mage' }] as const;
      createDefStates('test-autoname', defs, () => ({
        progress: persistent(0),
        level: persistent(1),
      }));

      const refs = getAllPersistentRefs();
      expect(refs.has('test-autoname.warrior.progress')).toBe(true);
      expect(refs.has('test-autoname.warrior.level')).toBe(true);
      expect(refs.has('test-autoname.mage.progress')).toBe(true);
      expect(refs.has('test-autoname.mage.level')).toBe(true);
    });

    it('createDefStates auto-naming produces a nested serialized shape', () => {
      const defs = [{ id: 'warrior' }];
      const map = createDefStates('test-autoname-shape', defs, () => ({
        xp: persistent(0),
      }));
      map.get('warrior')!.xp.value = 123;

      const save = serializePersistents(getAllPersistentRefs()) as Record<
        string,
        Record<string, Record<string, unknown>>
      >;
      expect(save['test-autoname-shape'].warrior.xp).toBe(123);
    });
  });
});

describe('default-value pruning', () => {
  it('isAtDefault returns true for unchanged primitive defaults', () => {
    beginPersistentContext('prune-prim-true');
    const n = persistent(0);
    const s = persistent('');
    const b = persistent(false);
    const u = persistent(null as null);
    endPersistentContext();
    expect(isAtDefault(n)).toBe(true);
    expect(isAtDefault(s)).toBe(true);
    expect(isAtDefault(b)).toBe(true);
    expect(isAtDefault(u)).toBe(true);
  });

  it('isAtDefault returns false when primitive value diverges', () => {
    beginPersistentContext('prune-prim-false');
    const n = persistent(0);
    const s = persistent('hi');
    endPersistentContext();
    n.value = 1;
    s.value = 'bye';
    expect(isAtDefault(n)).toBe(false);
    expect(isAtDefault(s)).toBe(false);
  });

  it('isAtDefault treats NaN-vs-NaN as equal but NaN-vs-non-NaN as not equal', () => {
    beginPersistentContext('prune-nan');
    const nan = persistent(NaN, { checkNaN: false });
    const zero = persistent(0);
    endPersistentContext();
    expect(isAtDefault(nan)).toBe(true);
    expect(isAtDefault(zero)).toBe(true);
    zero.value = NaN;
    // Note: checkNaN refuses the write — value stays 0, still default. Use explicit fixture.
    beginPersistentContext('prune-nan-mixed');
    const mixed = persistent(NaN, { checkNaN: false });
    endPersistentContext();
    mixed.value = 1;
    expect(isAtDefault(mixed)).toBe(false);
  });

  it('isAtDefault handles Decimal-instance defaults via Decimal.eq', () => {
    beginPersistentContext('prune-decimal-instance');
    const gold = persistent(bn(0));
    endPersistentContext();
    // Different instance, same numeric value → equal
    gold.value = bn(0).add(0);
    expect(isAtDefault(gold)).toBe(true);
    // Different value → not equal
    gold.value = bn(5);
    expect(isAtDefault(gold)).toBe(false);
  });

  it('isAtDefault handles DecimalSource defaults flagged via { decimal: true }', () => {
    beginPersistentContext('prune-decimal-flag');
    const xp = persistent(0, { decimal: true });
    endPersistentContext();
    // String "0" equals numeric 0 under Decimal semantics
    xp.value = '0' as unknown as number;
    expect(isAtDefault(xp)).toBe(true);
    xp.value = 1;
    expect(isAtDefault(xp)).toBe(false);
  });

  it('isAtDefault handles plain-object defaults via deep equal', () => {
    interface S {
      a: number;
      b: boolean;
    }
    beginPersistentContext('prune-object');
    const o = persistent<S>({ a: 1, b: false });
    endPersistentContext();
    // Same shape, same values → equal
    o.value = { a: 1, b: false };
    expect(isAtDefault(o)).toBe(true);
    // Mutated → not equal
    o.value = { a: 2, b: false };
    expect(isAtDefault(o)).toBe(false);
  });

  it('isAtDefault handles array defaults via deep equal', () => {
    beginPersistentContext('prune-array');
    const arr = persistent<number[]>([1, 2, 3]);
    endPersistentContext();
    arr.value = [1, 2, 3];
    expect(isAtDefault(arr)).toBe(true);
    arr.value = [1, 2, 4];
    expect(isAtDefault(arr)).toBe(false);
    arr.value = [1, 2];
    expect(isAtDefault(arr)).toBe(false);
  });

  it('filterDefaultedRefs drops defaulted entries and keeps mutated ones', () => {
    beginPersistentContext('prune-filter');
    persistent(0, { id: 'def' });
    const set = persistent(0, { id: 'set' });
    endPersistentContext();
    set.value = 42;

    const all = getAllPersistentRefs();
    const filtered = filterDefaultedRefs(all);

    expect(filtered.has('prune-filter.def')).toBe(false);
    expect(filtered.has('prune-filter.set')).toBe(true);
  });
});

describe('createDefStates', () => {
  it('creates a Map keyed by def.id with state from factory', () => {
    const defs = [
      { id: 1, name: 'a' },
      { id: 2, name: 'b' },
      { id: 3, name: 'c' },
    ];

    const map = createDefStates('test-def-states', defs, (def) => ({
      progress: persistent(0),
      label: def.name,
    }));

    expect(map.size).toBe(3);
    expect(map.get(1)!.label).toBe('a');
    expect(map.get(2)!.progress.value).toBe(0);
    expect(map.get(3)).toBeDefined();
  });

  it('tracks persistent refs under the given contextId', () => {
    const defs = [{ id: 10 }, { id: 20 }];

    createDefStates('test-def-ctx', defs, () => ({
      value: persistent(0),
      flag: persistent(false),
    }));

    const refs = getPersistentRefs('test-def-ctx');
    expect(refs).toBeDefined();
    // 2 defs × 2 persistent refs each = 4
    expect(refs!.size).toBe(4);
  });

  it('supports custom key accessor', () => {
    const defs = [
      { code: 'alpha', id: 1 },
      { code: 'beta', id: 2 },
    ];

    const map = createDefStates(
      'test-def-custom-key',
      defs,
      () => ({ val: persistent(0) }),
      (def) => def.code,
    );

    expect(map.has('alpha')).toBe(true);
    expect(map.has('beta')).toBe(true);
    expect(map.size).toBe(2);
  });

  it('works with empty definitions array', () => {
    const map = createDefStates('test-def-empty', [], () => ({
      val: persistent(0),
    }));

    expect(map.size).toBe(0);
  });

  it('passes each definition to the factory', () => {
    const defs = [
      { id: 1, base: 100 },
      { id: 2, base: 200 },
    ];

    const map = createDefStates('test-def-factory-args', defs, (def) => ({
      progress: persistent(def.base),
    }));

    expect(map.get(1)!.progress.value).toBe(100);
    expect(map.get(2)!.progress.value).toBe(200);
  });
});

describe('SerializableConstraint — typed interfaces without index signatures', () => {
  interface LoadoutEntry {
    name: string;
    loops: number;
  }

  interface DungeonFloorState {
    completed: number;
    ssChance: number;
    lastStat: string | null;
  }

  interface NestedState {
    inner: { x: number; label: string };
    tags: string[];
  }

  it('accepts an interface without an index signature', () => {
    beginPersistentContext('test-iface');
    const entry = persistent<LoadoutEntry>({ name: 'default', loops: 0 });
    endPersistentContext();
    expect(entry.value.name).toBe('default');
    expect(entry.value.loops).toBe(0);
  });

  it('accepts a multi-field interface without an index signature', () => {
    beginPersistentContext('test-iface-dungeon');
    const floor = persistent<DungeonFloorState>({ completed: 0, ssChance: 0.1, lastStat: null });
    endPersistentContext();
    expect(floor.value.completed).toBe(0);
    expect(floor.value.lastStat).toBeNull();
  });

  it('accepts nested object interfaces', () => {
    beginPersistentContext('test-iface-nested');
    const state = persistent<NestedState>({ inner: { x: 1, label: 'a' }, tags: ['b'] });
    endPersistentContext();
    expect(state.value.inner.x).toBe(1);
    expect(state.value.tags).toEqual(['b']);
  });

  it('round-trips typed interfaces through serialize/deserialize', () => {
    beginPersistentContext('test-iface-roundtrip');
    const entry = persistent<LoadoutEntry>({ name: 'warrior', loops: 5 });
    endPersistentContext();

    const refs = getAllPersistentRefs();
    const saved = serializePersistents(refs);

    entry.value = { name: 'changed', loops: 99 };
    deserializePersistents(refs, saved);

    expect(entry.value.name).toBe('warrior');
    expect(entry.value.loops).toBe(5);
  });

  it('resetPersistent works with typed interfaces', () => {
    beginPersistentContext('test-iface-reset');
    const entry = persistent<LoadoutEntry>({ name: 'original', loops: 10 });
    endPersistentContext();

    entry.value = { name: 'modified', loops: 99 };
    resetPersistent(entry);

    expect(entry.value.name).toBe('original');
    expect(entry.value.loops).toBe(10);
  });

  // Type-level rejection: the following should NOT compile:
  // persistent({ fn: () => {} })        — function property
  // persistent({ data: new Map() })     — Map instance
  // persistent({ handler: class {} })   — class constructor
});

describe('getPersistentContextRefs', () => {
  it('returns refs from root context', () => {
    beginPersistentContext('mod-root');
    const a = persistent(0);
    const b = persistent(1);
    endPersistentContext();

    const refs = getPersistentContextRefs('mod-root');
    expect(refs.size).toBe(2);
    expect(refs.has(a)).toBe(true);
    expect(refs.has(b)).toBe(true);
  });

  it('returns refs from nested child contexts', () => {
    beginPersistentContext('mod-parent');
    const parentRef = persistent(0);

    // Simulate category pushing a nested context
    beginPersistentContext('mod-parent/skills');
    const childRef = persistent(1);
    endPersistentContext();

    // Simulate per-definition context
    beginPersistentContext('mod-parent/skills/warrior');
    const grandchildRef = persistent(2);
    endPersistentContext();

    endPersistentContext();

    const refs = getPersistentContextRefs('mod-parent');
    expect(refs.size).toBe(3);
    expect(refs.has(parentRef)).toBe(true);
    expect(refs.has(childRef)).toBe(true);
    expect(refs.has(grandchildRef)).toBe(true);
  });

  it('returns empty set for unknown module', () => {
    const refs = getPersistentContextRefs('nonexistent-module');
    expect(refs.size).toBe(0);
  });

  it('does not include refs from sibling modules', () => {
    beginPersistentContext('mod-a');
    const refA = persistent(0);
    endPersistentContext();

    beginPersistentContext('mod-b');
    const refB = persistent(0);
    endPersistentContext();

    const refsA = getPersistentContextRefs('mod-a');
    expect(refsA.has(refA)).toBe(true);
    expect(refsA.has(refB)).toBe(false);
  });

  it('works with namespaced contexts', () => {
    withPersistenceNamespace('ns1', () => {
      beginPersistentContext('mod-ns');
      const r1 = persistent(0);
      beginPersistentContext('mod-ns/child');
      const r2 = persistent(1);
      endPersistentContext();
      endPersistentContext();

      const refs = getPersistentContextRefs('mod-ns');
      expect(refs.size).toBe(2);
      expect(refs.has(r1)).toBe(true);
      expect(refs.has(r2)).toBe(true);
    });
  });

  it('a namespaced lookup never falls through to an unnamespaced module', () => {
    beginPersistentContext('mod-live-shop');
    persistent(42);
    endPersistentContext();

    withPersistenceNamespace('fork-1', () => {
      expect(getPersistentContextRefs('mod-live-shop').size).toBe(0);
      expect(getPersistentRefs('mod-live-shop')).toBeUndefined();
    });
  });

  it('resetAllPersistentContexts clears children', () => {
    beginPersistentContext('mod-cleartest');
    persistent(0);
    beginPersistentContext('mod-cleartest/child');
    persistent(1);
    endPersistentContext();
    endPersistentContext();

    expect(getPersistentContextRefs('mod-cleartest').size).toBe(2);

    resetAllPersistentContexts();

    expect(getPersistentContextRefs('mod-cleartest').size).toBe(0);
  });

  // Re-entering the same context (e.g. createTimedProgress calling
  // withPersistentContext(getCurrentPersistentContext()) when no nesting is intended)
  // used to register the context as its own child, causing the
  // reset-scope walker to loop indefinitely.
  it('does not register a context as its own child on same-id re-entry', () => {
    beginPersistentContext('mod-reentry');
    const outerRef = persistent(0);

    beginPersistentContext('mod-reentry');
    const innerRef = persistent(1);
    endPersistentContext();

    endPersistentContext();

    const refs = getPersistentContextRefs('mod-reentry');
    expect(refs.size).toBe(2);
    expect(refs.has(outerRef)).toBe(true);
    expect(refs.has(innerRef)).toBe(true);
  });
});

describe('save-key shape', () => {
  it('an unnamed ref keeps its index when a named ref joins its context', () => {
    resetAllPersistentContexts();
    withPersistentContext('mod', () => persistent(1));
    expect([...getAllPersistentRefs().keys()]).toEqual(['mod.0']);

    resetAllPersistentContexts();
    withPersistentContext('mod', () => {
      persistent(2, { id: 'gold' });
      persistent(1);
    });
    expect([...getAllPersistentRefs().keys()].sort()).toEqual(['mod.0', 'mod.gold']);
  });

  it('refuses a context id containing "." — the save path splits on it', () => {
    resetAllPersistentContexts();
    expect(() => withPersistentContext('upgrades/tier.1', () => persistent(0))).toThrow(/"\."/);
  });
});
