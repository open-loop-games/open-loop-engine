import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { Decimal } from '@/primitives/decimal';
import {
  decimalSchema,
  deriveSchema,
  getSchemaForRef,
  validateSaveData,
} from '@/core/save-validation';
import {
  beginPersistentContext,
  endPersistentContext,
  persistent,
  getAllPersistentRefs,
  resetAllPersistentContexts,
  serializePersistents,
} from '@/core/persistence';

describe('save-validation', () => {
  describe('decimalSchema', () => {
    it('accepts Decimal instances, numbers, and numeric strings', () => {
      expect(decimalSchema.safeParse(new Decimal(42)).success).toBe(true);
      expect(decimalSchema.safeParse(42).success).toBe(true);
      expect(decimalSchema.safeParse('1e100').success).toBe(true);
      expect(decimalSchema.safeParse('Infinity').success).toBe(true);
    });

    it('rejects non-numeric strings, null, undefined, and objects', () => {
      expect(decimalSchema.safeParse('banana').success).toBe(false);
      expect(decimalSchema.safeParse(null).success).toBe(false);
      expect(decimalSchema.safeParse(undefined).success).toBe(false);
      expect(decimalSchema.safeParse({}).success).toBe(false);
      expect(decimalSchema.safeParse(true).success).toBe(false);
    });
  });

  describe('deriveSchema', () => {
    it('returns decimal schema for Decimal defaults', () => {
      const s = deriveSchema(new Decimal(0));
      expect(s.safeParse('1e50').success).toBe(true);
      expect(s.safeParse('banana').success).toBe(false);
    });

    it('returns decimal schema when decimal flag is true', () => {
      const s = deriveSchema(0, true);
      expect(s.safeParse('1e50').success).toBe(true);
      expect(s.safeParse('banana').success).toBe(false);
    });

    it('lenient number schema accepts number and string', () => {
      const s = deriveSchema(0);
      expect(s.safeParse(42).success).toBe(true);
      expect(s.safeParse('Infinity').success).toBe(true);
      expect(s.safeParse(true).success).toBe(false);
      expect(s.safeParse(null).success).toBe(false);
    });

    it('string default → z.string', () => {
      const s = deriveSchema('hello');
      expect(s.safeParse('world').success).toBe(true);
      expect(s.safeParse(42).success).toBe(false);
    });

    it('boolean default → z.boolean', () => {
      const s = deriveSchema(true);
      expect(s.safeParse(false).success).toBe(true);
      expect(s.safeParse(1).success).toBe(false);
    });

    it('nested object default → partial nested schema', () => {
      const s = deriveSchema({ x: 0, y: 'label', z: true });
      expect(s.safeParse({ x: 1, y: 'hi', z: false }).success).toBe(true);
      // Partial: missing sub-fields are allowed
      expect(s.safeParse({ x: 1 }).success).toBe(true);
      // Truly wrong types still fail (boolean where lenient number schema
      // accepts number | string — a boolean is neither)
      expect(s.safeParse({ z: 42 }).success).toBe(false);
    });

    it('array default → z.array of first-element shape', () => {
      const s = deriveSchema([1, 2, 3]);
      expect(s.safeParse([10, 20]).success).toBe(true);
      expect(s.safeParse([true]).success).toBe(false);
    });

    it('empty array default → z.array of unknown', () => {
      const s = deriveSchema([]);
      expect(s.safeParse([1, 'mixed', true]).success).toBe(true);
    });
  });

  describe('getSchemaForRef', () => {
    it('uses explicit schema override when provided', () => {
      resetAllPersistentContexts();
      beginPersistentContext('ref-override');
      const r = persistent(0, { schema: z.literal(42) });
      endPersistentContext();

      const s = getSchemaForRef(r);
      expect(s.safeParse(42).success).toBe(true);
      expect(s.safeParse(7).success).toBe(false);
    });

    it('auto-derives when no explicit schema is set', () => {
      resetAllPersistentContexts();
      beginPersistentContext('ref-auto');
      const r = persistent('hello');
      endPersistentContext();

      const s = getSchemaForRef(r);
      expect(s.safeParse('world').success).toBe(true);
      expect(s.safeParse(42).success).toBe(false);
    });

    it('honors decimal flag from PersistentOptions', () => {
      resetAllPersistentContexts();
      beginPersistentContext('ref-decimal');
      const r = persistent(0, { decimal: true });
      endPersistentContext();

      const s = getSchemaForRef(r);
      expect(s.safeParse('1e100').success).toBe(true);
      expect(s.safeParse('banana').success).toBe(false);
    });
  });

  describe('validateSaveData', () => {
    it('passes clean data through unchanged', () => {
      resetAllPersistentContexts();
      beginPersistentContext('vd-clean');
      const a = persistent(0, { name: 'a' });
      const b = persistent('x', { name: 'b' });
      endPersistentContext();
      a.value = 5;
      b.value = 'y';

      const refs = getAllPersistentRefs();
      const data = serializePersistents(refs);
      const result = validateSaveData(refs, data, { strict: true });

      expect(result.ok).toBe(true);
      expect(result.issues).toHaveLength(0);
    });

    it('self-heals bad leaves in non-strict mode by deleting them', () => {
      resetAllPersistentContexts();
      beginPersistentContext('vd-heal');
      const n = persistent(0, { name: 'n' });
      endPersistentContext();

      const refs = getAllPersistentRefs();
      // Craft a data object with the wrong type at the leaf.
      const data = { 'vd-heal': { n: true } as Record<string, unknown> };
      const onIssue = vi.fn();
      const result = validateSaveData(refs, data, { strict: false, onIssue });

      expect(result.ok).toBe(true);
      expect(result.issues).toHaveLength(1);
      expect(result.issues[0].path).toBe('vd-heal.n');
      expect(result.issues[0].action).toBe('self-heal');
      expect(onIssue).toHaveBeenCalledTimes(1);
      // Self-heal: leaf was deleted
      expect((result.data['vd-heal'] as Record<string, unknown>).n).toBeUndefined();
      // Reference equality — mutated in place
      expect(result.data).toBe(data);
      void n;
    });

    it('strict mode marks ok:false but still reports all issues in one pass', () => {
      resetAllPersistentContexts();
      beginPersistentContext('vd-strict');
      persistent(0, { name: 'a' });
      persistent('x', { name: 'b' });
      endPersistentContext();

      const refs = getAllPersistentRefs();
      const data = {
        'vd-strict': {
          a: { bad: 'object' },
          b: 123,
        },
      };
      const onIssue = vi.fn();
      const result = validateSaveData(refs, data, { strict: true, onIssue });

      expect(result.ok).toBe(false);
      expect(result.issues.length).toBeGreaterThanOrEqual(2);
      expect(result.issues.every((i) => i.action === 'fail')).toBe(true);
      expect(onIssue.mock.calls.length).toBe(result.issues.length);
    });

    it('missing leaves are not an error (new-ref self-heal via deserialize default)', () => {
      resetAllPersistentContexts();
      beginPersistentContext('vd-missing');
      persistent(0, { name: 'existing' });
      persistent(0, { name: 'added-later' });
      endPersistentContext();

      const refs = getAllPersistentRefs();
      // Old save only has `existing`, not `added-later`
      const data = { 'vd-missing': { existing: 10 } as Record<string, unknown> };
      const result = validateSaveData(refs, data, { strict: true });

      expect(result.ok).toBe(true);
      expect(result.issues).toHaveLength(0);
    });

    it('validates Decimal refs with Decimal-instance default', () => {
      resetAllPersistentContexts();
      beginPersistentContext('vd-decimal');
      persistent<Decimal>(new Decimal(0), { name: 'gold' });
      endPersistentContext();

      const refs = getAllPersistentRefs();
      const data = { 'vd-decimal': { gold: '1e100' } };
      const result = validateSaveData(refs, data, { strict: true });
      expect(result.ok).toBe(true);

      const bad = { 'vd-decimal': { gold: { not: 'a decimal' } } };
      const result2 = validateSaveData(refs, bad, { strict: true });
      expect(result2.ok).toBe(false);
      expect(result2.issues[0].path).toBe('vd-decimal.gold');
    });
  });
});
