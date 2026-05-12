import { describe, it, expect, vi } from 'vitest';
import { createSaveManager, createMemoryStorage } from '@/core/save-manager';
import {
  persistent,
  beginPersistentContext,
  endPersistentContext,
  resetPersistent,
  createDefinitionStates,
} from '@/core/persistence';
import { bn } from '@/primitives/decimal';

function createMapStorage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => m.set(k, v),
    removeItem: (k: string) => m.delete(k),
    /** Expose map for test inspection */
    _map: m,
  };
}

describe('SaveManager', () => {
  // --- Basic save/load (operates on active slot) ---

  it('save and load round-trips', () => {
    const mgr = createSaveManager({ gameId: 'test', storageAdapter: createMapStorage() });
    beginPersistentContext('sm-test');
    const gold = persistent(0);
    endPersistentContext();
    gold.value = 500;
    mgr.save();
    resetPersistent(gold);
    expect(gold.value).toBe(0);
    const result = mgr.load();
    expect(result.success).toBe(true);
    expect(gold.value).toBe(500);
  });

  it('load returns timestamp', () => {
    const storage = createMapStorage();
    const mgr = createSaveManager({ gameId: 'test', storageAdapter: storage });
    beginPersistentContext('sm-ts');
    persistent(0);
    endPersistentContext();
    const before = Date.now();
    mgr.save();
    const result = mgr.load();
    expect(result.success).toBe(true);
    expect(result.timestamp).toBeGreaterThanOrEqual(before);
    expect(result.timestamp).toBeLessThanOrEqual(Date.now());
  });

  it('load returns failure for missing save', () => {
    const mgr = createSaveManager({ gameId: 'test', storageAdapter: createMapStorage() });
    const result = mgr.load();
    expect(result.success).toBe(false);
    expect(result.timestamp).toBeUndefined();
  });

  it('exportSave returns string', () => {
    const mgr = createSaveManager({ gameId: 'test', storageAdapter: createMapStorage() });
    beginPersistentContext('sm-export');
    persistent(42);
    endPersistentContext();
    expect(typeof mgr.exportSave()).toBe('string');
  });

  it('importSave restores state and returns timestamp', () => {
    const mgr = createSaveManager({ gameId: 'test', storageAdapter: createMapStorage() });
    beginPersistentContext('sm-import');
    const v = persistent(0);
    endPersistentContext();
    v.value = 999;
    const exported = mgr.exportSave();
    resetPersistent(v);
    const result = mgr.importSave(exported);
    expect(result.success).toBe(true);
    expect(result.timestamp).toBeDefined();
    expect(v.value).toBe(999);
  });

  it('save includes version', () => {
    const storage = createMapStorage();
    const mgr = createSaveManager({ gameId: 'test', storageAdapter: storage, version: 2 });
    beginPersistentContext('sm-version');
    persistent(0);
    endPersistentContext();
    mgr.save();
    // Save goes to slot 0
    expect(JSON.parse(storage.getItem('test-slot-0')!).version).toBe(2);
  });

  it('save includes modId when set', () => {
    const storage = createMapStorage();
    const mgr = createSaveManager({ gameId: 'test', storageAdapter: storage });
    beginPersistentContext('sm-mod');
    persistent(0);
    endPersistentContext();
    mgr.modId = 'omsi';
    mgr.save();
    expect(JSON.parse(storage.getItem('test-slot-0')!).modId).toBe('omsi');
  });

  it('save omits modId when not set', () => {
    const storage = createMapStorage();
    const mgr = createSaveManager({ gameId: 'test', storageAdapter: storage });
    beginPersistentContext('sm-nomod');
    persistent(0);
    endPersistentContext();
    mgr.save();
    expect(JSON.parse(storage.getItem('test-slot-0')!).modId).toBeUndefined();
  });

  it('peek returns metadata without loading', () => {
    const storage = createMapStorage();
    const mgr = createSaveManager({ gameId: 'test', storageAdapter: storage, version: 3 });
    beginPersistentContext('sm-peek');
    const v = persistent(0);
    endPersistentContext();
    v.value = 42;
    mgr.modId = 'squirrel';
    mgr.save();
    resetPersistent(v);
    const peek = mgr.peek();
    expect(peek).not.toBeNull();
    expect(peek!.version).toBe(3);
    expect(peek!.modId).toBe('squirrel');
    expect(peek!.timestamp).toBeDefined();
    // Value should NOT be loaded
    expect(v.value).toBe(0);
  });

  it('peek returns null when no save exists', () => {
    const mgr = createSaveManager({ gameId: 'test', storageAdapter: createMapStorage() });
    expect(mgr.peek()).toBeNull();
  });
});

describe('SaveManager — slot management', () => {
  it('creates default slot 0 on construction', () => {
    const mgr = createSaveManager({ gameId: 'test', storageAdapter: createMapStorage() });
    expect(mgr.slots).toHaveLength(1);
    expect(mgr.slots[0]).toEqual({ id: 0, name: 'Autosave' });
    expect(mgr.activeSlotId).toBe(0);
  });

  it('respects custom default slot name', () => {
    const mgr = createSaveManager({
      gameId: 'test',
      storageAdapter: createMapStorage(),
      defaultSlotName: 'Main',
    });
    expect(mgr.slots[0].name).toBe('Main');
  });

  it('createSlot adds a new slot with auto-increment ID', () => {
    const mgr = createSaveManager({ gameId: 'test', storageAdapter: createMapStorage() });
    const id = mgr.createSlot('Manual Save');
    expect(id).toBe(1);
    expect(mgr.slots).toHaveLength(2);
    expect(mgr.slots[1]).toEqual({ id: 1, name: 'Manual Save' });
  });

  it('createSlot uses default name if none provided', () => {
    const mgr = createSaveManager({ gameId: 'test', storageAdapter: createMapStorage() });
    const id = mgr.createSlot();
    expect(mgr.slots.find((s) => s.id === id)?.name).toBe('Save 1');
  });

  it('createSlot throws when max slots reached', () => {
    const mgr = createSaveManager({
      gameId: 'test',
      storageAdapter: createMapStorage(),
      maxSlots: 2,
    });
    mgr.createSlot('Second');
    expect(() => mgr.createSlot('Third')).toThrow('Maximum save slots (2) reached');
  });

  it('createSlot IDs skip deleted slots', () => {
    const mgr = createSaveManager({ gameId: 'test', storageAdapter: createMapStorage() });
    const id1 = mgr.createSlot('A');
    const id2 = mgr.createSlot('B');
    expect(id1).toBe(1);
    expect(id2).toBe(2);
    mgr.deleteSlot(id1); // delete slot 1
    const id3 = mgr.createSlot('C');
    expect(id3).toBe(3); // should be 3, not reuse 1
  });

  it('selectSlot switches the active slot', () => {
    const storage = createMapStorage();
    const mgr = createSaveManager({ gameId: 'test', storageAdapter: storage });
    beginPersistentContext('sm-slot-switch');
    const v = persistent(0);
    endPersistentContext();

    // Save to slot 0
    v.value = 100;
    mgr.save();

    // Create and switch to slot 1
    const id1 = mgr.createSlot('Other');
    mgr.selectSlot(id1);
    expect(mgr.activeSlotId).toBe(id1);

    // Save different value to slot 1
    v.value = 200;
    mgr.save();

    // Switch back to slot 0 and load
    mgr.selectSlot(0);
    mgr.load();
    expect(v.value).toBe(100);

    // Switch to slot 1 and load
    mgr.selectSlot(id1);
    mgr.load();
    expect(v.value).toBe(200);
  });

  it('selectSlot throws for unknown slot', () => {
    const mgr = createSaveManager({ gameId: 'test', storageAdapter: createMapStorage() });
    expect(() => mgr.selectSlot(99)).toThrow('Save slot 99 not found');
  });

  it('deleteSlot removes slot and its data', () => {
    const storage = createMapStorage();
    const mgr = createSaveManager({ gameId: 'test', storageAdapter: storage });
    beginPersistentContext('sm-slot-del');
    persistent(0);
    endPersistentContext();
    const id = mgr.createSlot('Temp');
    mgr.selectSlot(id);
    mgr.save();
    expect(storage.getItem(`test-slot-${id}`)).not.toBeNull();

    mgr.selectSlot(0); // switch away first
    mgr.deleteSlot(id);
    expect(mgr.slots.find((s) => s.id === id)).toBeUndefined();
    expect(storage.getItem(`test-slot-${id}`)).toBeNull();
  });

  it('deleteSlot throws when deleting active slot', () => {
    const mgr = createSaveManager({ gameId: 'test', storageAdapter: createMapStorage() });
    expect(() => mgr.deleteSlot(0)).toThrow('Cannot delete the active save slot');
  });

  it('deleteSlot throws for unknown slot', () => {
    const mgr = createSaveManager({ gameId: 'test', storageAdapter: createMapStorage() });
    expect(() => mgr.deleteSlot(99)).toThrow('Save slot 99 not found');
  });

  it('renameSlot changes the slot name', () => {
    const mgr = createSaveManager({ gameId: 'test', storageAdapter: createMapStorage() });
    mgr.renameSlot(0, 'My Save');
    expect(mgr.slots[0].name).toBe('My Save');
  });

  it('renameSlot throws for unknown slot', () => {
    const mgr = createSaveManager({ gameId: 'test', storageAdapter: createMapStorage() });
    expect(() => mgr.renameSlot(99, 'X')).toThrow('Save slot 99 not found');
  });

  it('peekSlot reads any slot without switching', () => {
    const storage = createMapStorage();
    const mgr = createSaveManager({ gameId: 'test', storageAdapter: storage });
    beginPersistentContext('sm-peekslot');
    persistent(0);
    endPersistentContext();

    mgr.save(); // save to slot 0
    const id = mgr.createSlot('Other');
    mgr.selectSlot(id);
    mgr.modId = 'omsi';
    mgr.save(); // save to slot 1

    mgr.selectSlot(0); // back to slot 0
    const peek1 = mgr.peekSlot(id);
    expect(peek1).not.toBeNull();
    expect(peek1!.modId).toBe('omsi');
    expect(mgr.activeSlotId).toBe(0); // didn't switch
  });

  it('peekSlot returns null for empty slot', () => {
    const mgr = createSaveManager({ gameId: 'test', storageAdapter: createMapStorage() });
    mgr.createSlot('Empty');
    expect(mgr.peekSlot(1)).toBeNull();
  });

  it('slot index persists across instances', () => {
    const storage = createMapStorage();
    const mgr1 = createSaveManager({ gameId: 'test', storageAdapter: storage });
    mgr1.createSlot('Saved Slot');
    mgr1.renameSlot(0, 'Main');

    const mgr2 = createSaveManager({ gameId: 'test', storageAdapter: storage });
    expect(mgr2.slots).toHaveLength(2);
    expect(mgr2.slots[0].name).toBe('Main');
    expect(mgr2.slots[1].name).toBe('Saved Slot');
  });
});

describe('SaveManager — legacy migration', () => {
  it('migrates single-slot save to slot 0', () => {
    const storage = createMapStorage();
    // Simulate old save format
    const legacyEnvelope = JSON.stringify({
      version: 1,
      gameId: 'test',
      timestamp: 1000,
      data: {},
    });
    storage.setItem('test-save', legacyEnvelope);

    const mgr = createSaveManager({ gameId: 'test', storageAdapter: storage });

    // Legacy key should be removed
    expect(storage.getItem('test-save')).toBeNull();
    // Data should be in slot 0
    expect(storage.getItem('test-slot-0')).toBe(legacyEnvelope);
    // Slot index should exist
    expect(mgr.slots).toHaveLength(1);
    expect(mgr.slots[0]).toEqual({ id: 0, name: 'Autosave' });
  });

  it('does not migrate if slot index already exists', () => {
    const storage = createMapStorage();
    storage.setItem('test-save', 'old-data');
    storage.setItem('test-slots', JSON.stringify([{ id: 0, name: 'Existing' }]));

    const mgr = createSaveManager({ gameId: 'test', storageAdapter: storage });

    // Legacy key should NOT be touched
    expect(storage.getItem('test-save')).toBe('old-data');
    expect(mgr.slots[0].name).toBe('Existing');
  });
});

describe('SaveManager — engine v1→v2 legacy key migration', () => {
  it('writes _engine.version + compression on new saves', () => {
    const storage = createMapStorage();
    const mgr = createSaveManager({ gameId: 'ev', storageAdapter: storage });
    beginPersistentContext('ev-ctx');
    const score = persistent(0, { name: 'score' });
    endPersistentContext();
    score.value = 1; // avoid pruning so data stays non-empty
    mgr.save();

    const raw = storage.getItem('ev-slot-0')!;
    const envelope = JSON.parse(raw);
    expect(envelope._engine?.version).toBe(3);
    expect(envelope._engine?.compression).toBe('lz');
    expect(typeof envelope.data).toBe('string');
  });

  it('loads a v1 (iteration-index) save into a v2 named-key build', () => {
    const storage = createMapStorage();
    // Hand-craft a v1 envelope: no _engine field, data keyed by numeric index.
    const v1Envelope = {
      version: 1,
      gameId: 'v1legacy',
      timestamp: 1,
      data: {
        'v1legacy-ctx': { '0': 42, '1': 'hello' },
      },
    };
    storage.setItem('v1legacy-slot-0', JSON.stringify(v1Envelope));
    storage.setItem('v1legacy-slots', JSON.stringify([{ id: 0, name: 'Autosave' }]));

    const mgr = createSaveManager({ gameId: 'v1legacy', storageAdapter: storage });
    beginPersistentContext('v1legacy-ctx');
    const score = persistent(0, { name: 'score' });
    const label = persistent('', { name: 'label' });
    endPersistentContext();

    const result = mgr.load();
    expect(result.success).toBe(true);
    expect(score.value).toBe(42);
    expect(label.value).toBe('hello');
  });

  it('type-mismatched legacy slots fall back to default + warn', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const storage = createMapStorage();
    const v1Envelope = {
      version: 1,
      gameId: 'v1mismatch',
      timestamp: 1,
      data: {
        // Registry iteration order will be: score, label. Swap the values in
        // the save so types don't line up (number slot gets an array).
        'v1mismatch-ctx': { '0': [1, 2, 3], '1': 'ok' },
      },
    };
    storage.setItem('v1mismatch-slot-0', JSON.stringify(v1Envelope));
    storage.setItem('v1mismatch-slots', JSON.stringify([{ id: 0, name: 'Autosave' }]));

    const mgr = createSaveManager({ gameId: 'v1mismatch', storageAdapter: storage });
    beginPersistentContext('v1mismatch-ctx');
    const score = persistent(0, { name: 'score' });
    const label = persistent('default', { name: 'label' });
    endPersistentContext();

    const result = mgr.load();
    expect(result.success).toBe(true);
    // score's slot had an array → mismatch → default
    expect(score.value).toBe(0);
    // label's slot matched
    expect(label.value).toBe('ok');

    const msg = warn.mock.calls.flat().join(' ');
    expect(msg).toMatch(/type mismatch/i);
    warn.mockRestore();
  });

  it('nested named keys from createDefinitionStates round-trip through save/load', () => {
    const storage = createMapStorage();
    // compressSave: false so we can assert on the on-disk envelope shape directly.
    const mgr = createSaveManager({ gameId: 'nd', storageAdapter: storage, compressSave: false });

    const defs = [{ id: 'warrior' }, { id: 'mage' }] as const;
    const states = createDefinitionStates('nd-jobs', defs, () => ({
      xp: persistent(0),
      level: persistent(1),
    }));
    states.get('warrior')!.xp.value = 500;
    states.get('warrior')!.level.value = 7;
    states.get('mage')!.xp.value = 250;

    mgr.save();
    states.get('warrior')!.xp.value = 0;
    states.get('warrior')!.level.value = 1;
    states.get('mage')!.xp.value = 0;

    const result = mgr.load();
    expect(result.success).toBe(true);
    expect(states.get('warrior')!.xp.value).toBe(500);
    expect(states.get('warrior')!.level.value).toBe(7);
    expect(states.get('mage')!.xp.value).toBe(250);

    // Confirm disk shape is nested, not numeric. mage.level is at default (1)
    // so it's pruned from the envelope; the surviving keys keep their nested shape.
    const envelope = JSON.parse(storage.getItem('nd-slot-0')!);
    expect(envelope.data['nd-jobs'].warrior.xp).toBe(500);
    expect(envelope.data['nd-jobs'].warrior.level).toBe(7);
    expect(envelope.data['nd-jobs'].mage.xp).toBe(250);
    expect(envelope.data['nd-jobs'].mage.level).toBeUndefined();
  });
});

describe('SaveManager — default-value pruning round-trip', () => {
  it('drops defaulted leaves from envelope.data', () => {
    const storage = createMapStorage();
    const mgr = createSaveManager({ gameId: 'pr', storageAdapter: storage, compressSave: false });
    beginPersistentContext('pr-ctx');
    persistent(0, { name: 'score' });
    persistent('hero', { name: 'name' });
    endPersistentContext();
    mgr.save();

    const envelope = JSON.parse(storage.getItem('pr-slot-0')!);
    expect(envelope.data['pr-ctx']).toBeUndefined();
  });

  it('restores defaulted leaves from absent keys on load', () => {
    const storage = createMapStorage();
    const mgr = createSaveManager({ gameId: 'pr2', storageAdapter: storage });
    beginPersistentContext('pr2-ctx');
    const score = persistent(0, { name: 'score' });
    const name = persistent('hero', { name: 'name' });
    endPersistentContext();
    mgr.save();

    score.value = 999;
    name.value = 'corrupted';

    const result = mgr.load();
    expect(result.success).toBe(true);
    expect(score.value).toBe(0);
    expect(name.value).toBe('hero');
  });

  it('keeps mutated leaves and prunes defaulted ones in the same context', () => {
    const storage = createMapStorage();
    const mgr = createSaveManager({ gameId: 'pr3', storageAdapter: storage, compressSave: false });
    beginPersistentContext('pr3-ctx');
    const a = persistent(0, { name: 'a' });
    const b = persistent(0, { name: 'b' });
    endPersistentContext();
    a.value = 42;
    mgr.save();

    const envelope = JSON.parse(storage.getItem('pr3-slot-0')!);
    expect(envelope.data['pr3-ctx'].a).toBe(42);
    expect(envelope.data['pr3-ctx'].b).toBeUndefined();

    a.value = 0;
    b.value = 99;
    mgr.load();
    expect(a.value).toBe(42);
    expect(b.value).toBe(0);
  });

  it('prunes Decimal-defaulted refs that match by value', () => {
    const storage = createMapStorage();
    const mgr = createSaveManager({ gameId: 'pr4', storageAdapter: storage, compressSave: false });
    beginPersistentContext('pr4-ctx');
    const gold = persistent(bn(0), { name: 'gold' });
    const xp = persistent(bn(0), { name: 'xp' });
    endPersistentContext();
    // Different Decimal instance, same value — should still prune
    gold.value = bn(0).add(0);
    xp.value = bn(100);
    mgr.save();

    const envelope = JSON.parse(storage.getItem('pr4-slot-0')!);
    expect(envelope.data['pr4-ctx'].gold).toBeUndefined();
    expect(envelope.data['pr4-ctx'].xp).toBe('100');
  });

  it('createDefinitionStates with all-defaulted entries yields empty bucket', () => {
    const storage = createMapStorage();
    const mgr = createSaveManager({ gameId: 'pr5', storageAdapter: storage, compressSave: false });
    const defs = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    createDefinitionStates('pr5-jobs', defs, () => ({
      progress: persistent(0),
      level: persistent(1),
    }));
    mgr.save();

    const envelope = JSON.parse(storage.getItem('pr5-slot-0')!);
    expect(envelope.data['pr5-jobs']).toBeUndefined();
  });

  it('createDefinitionStates with one mutated field yields one nested key', () => {
    const storage = createMapStorage();
    const mgr = createSaveManager({ gameId: 'pr6', storageAdapter: storage, compressSave: false });
    const defs = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    const states = createDefinitionStates('pr6-jobs', defs, () => ({
      progress: persistent(0),
      level: persistent(1),
    }));
    states.get('b')!.progress.value = 7;
    mgr.save();

    const envelope = JSON.parse(storage.getItem('pr6-slot-0')!);
    expect(envelope.data['pr6-jobs']).toEqual({ b: { progress: 7 } });
  });
});

describe('SaveManager — engine v3 compression', () => {
  it('writes envelope with compression marker and string data by default', () => {
    const storage = createMapStorage();
    const mgr = createSaveManager({ gameId: 'cz', storageAdapter: storage });
    beginPersistentContext('cz-ctx');
    const v = persistent(0, { name: 'x' });
    endPersistentContext();
    v.value = 42;
    mgr.save();

    const envelope = JSON.parse(storage.getItem('cz-slot-0')!);
    expect(envelope._engine.version).toBe(3);
    expect(envelope._engine.compression).toBe('lz');
    expect(typeof envelope.data).toBe('string');
    expect(envelope.data.length).toBeGreaterThan(0);
  });

  it('round-trips compressed envelope through save/load', () => {
    const storage = createMapStorage();
    const mgr = createSaveManager({ gameId: 'cz2', storageAdapter: storage });
    beginPersistentContext('cz2-ctx');
    const score = persistent(0, { name: 'score' });
    const name = persistent('hero', { name: 'name' });
    endPersistentContext();
    score.value = 999;
    name.value = 'archer';
    mgr.save();

    score.value = 0;
    name.value = 'corrupted';
    expect(mgr.load().success).toBe(true);
    expect(score.value).toBe(999);
    expect(name.value).toBe('archer');
  });

  it('round-trips compressed envelope through exportSave/importSave', () => {
    const mgr = createSaveManager({ gameId: 'cz3', storageAdapter: createMapStorage() });
    beginPersistentContext('cz3-ctx');
    const v = persistent(0, { name: 'v' });
    endPersistentContext();
    v.value = 13;

    const exported = mgr.exportSave();
    // Outer envelope is JSON; data field is compressed string
    const parsed = JSON.parse(exported);
    expect(typeof parsed.data).toBe('string');
    expect(parsed._engine.compression).toBe('lz');

    v.value = 0;
    const result = mgr.importSave(exported);
    expect(result.success).toBe(true);
    expect(v.value).toBe(13);
  });

  it('compressSave: false skips compression and writes data as object', () => {
    const storage = createMapStorage();
    const mgr = createSaveManager({ gameId: 'cz4', storageAdapter: storage, compressSave: false });
    beginPersistentContext('cz4-ctx');
    const v = persistent(0, { name: 'v' });
    endPersistentContext();
    v.value = 7;
    mgr.save();

    const envelope = JSON.parse(storage.getItem('cz4-slot-0')!);
    expect(envelope._engine.version).toBe(3);
    expect(envelope._engine.compression).toBeUndefined();
    expect(typeof envelope.data).toBe('object');

    v.value = 0;
    mgr.load();
    expect(v.value).toBe(7);
  });

  it('peek works on compressed envelope without decompression', () => {
    const storage = createMapStorage();
    const mgr = createSaveManager({ gameId: 'cz5', storageAdapter: storage, version: 4 });
    beginPersistentContext('cz5-ctx');
    const v = persistent(0, { name: 'v' });
    endPersistentContext();
    v.value = 99;
    mgr.modId = 'modA';
    mgr.save();

    const peek = mgr.peek();
    expect(peek).not.toBeNull();
    expect(peek!.version).toBe(4);
    expect(peek!.modId).toBe('modA');
    expect(typeof peek!.timestamp).toBe('number');
    // Confirm peek did not deserialize state
    v.value = 0;
    expect(v.value).toBe(0);
  });

  it('corrupted compressed payload emits parse-error', () => {
    const storage = createMapStorage();
    storage.setItem(
      'cz6-slot-0',
      JSON.stringify({
        version: 1,
        gameId: 'cz6',
        timestamp: 1,
        data: '!!! not lz-string compressed !!!',
        _engine: { version: 3, compression: 'lz' },
      }),
    );
    const mgr = createSaveManager({ gameId: 'cz6', storageAdapter: storage });
    beginPersistentContext('cz6-ctx');
    persistent(0, { name: 'v' });
    endPersistentContext();

    const failed = vi.fn();
    mgr.on('save:load-failed', failed);
    const result = mgr.load();
    expect(result.success).toBe(false);
    expect(failed).toHaveBeenCalledTimes(1);
    expect(failed.mock.calls[0][0].reason).toBe('parse-error');
  });

  it('legacy v2 envelope (uncompressed object data) loads under v3 engine', () => {
    const storage = createMapStorage();
    storage.setItem(
      'lv2-slot-0',
      JSON.stringify({
        version: 1,
        gameId: 'lv2',
        timestamp: 1,
        data: { 'lv2-ctx': { score: 200 } },
        _engine: { version: 2 },
      }),
    );
    const mgr = createSaveManager({ gameId: 'lv2', storageAdapter: storage });
    beginPersistentContext('lv2-ctx');
    const score = persistent(0, { name: 'score' });
    endPersistentContext();

    const result = mgr.load();
    expect(result.success).toBe(true);
    expect(score.value).toBe(200);
  });

  it('legacy v1 envelope (numeric keys) still migrates and loads under v3 engine', () => {
    const storage = createMapStorage();
    storage.setItem(
      'lv1-slot-0',
      JSON.stringify({
        version: 1,
        gameId: 'lv1',
        timestamp: 1,
        data: { 'lv1-ctx': { '0': 77 } },
      }),
    );
    storage.setItem('lv1-slots', JSON.stringify([{ id: 0, name: 'Autosave' }]));
    const mgr = createSaveManager({ gameId: 'lv1', storageAdapter: storage });
    beginPersistentContext('lv1-ctx');
    const score = persistent(0, { name: 'score' });
    endPersistentContext();

    const result = mgr.load();
    expect(result.success).toBe(true);
    expect(score.value).toBe(77);
  });

  it('pruned-and-compressed envelope round-trips end-to-end', () => {
    const storage = createMapStorage();
    const mgr = createSaveManager({ gameId: 'pcz', storageAdapter: storage });
    const defs = Array.from({ length: 50 }, (_, i) => ({ id: `d${i}` }));
    const states = createDefinitionStates('pcz-jobs', defs, () => ({
      progress: persistent(0),
      level: persistent(0),
    }));
    states.get('d7')!.progress.value = 100;
    states.get('d23')!.level.value = 5;
    mgr.save();

    const raw = storage.getItem('pcz-slot-0')!;
    // Compressed envelope of 50 defs × 2 fields, mostly defaulted, should be compact
    expect(raw.length).toBeLessThan(500);

    states.get('d7')!.progress.value = 0;
    states.get('d23')!.level.value = 0;
    expect(mgr.load().success).toBe(true);
    expect(states.get('d7')!.progress.value).toBe(100);
    expect(states.get('d23')!.level.value).toBe(5);
  });
});

describe('SaveManager — events', () => {
  describe('events', () => {
    it('emits save:loaded on successful load', () => {
      const mgr = createSaveManager({ gameId: 'evt', storageAdapter: createMapStorage() });
      beginPersistentContext('evt-loaded');
      const gold = persistent(0);
      endPersistentContext();
      gold.value = 7;
      mgr.save();

      const handler = vi.fn();
      mgr.on('save:loaded', handler);
      const result = mgr.load();

      expect(result.success).toBe(true);
      expect(handler).toHaveBeenCalledTimes(1);
      const [arg] = handler.mock.calls[0];
      expect(arg.slotId).toBe(0);
      expect(arg.version).toBe(1);
      expect(typeof arg.timestamp).toBe('number');
    });

    it('emits save:load-failed with reason "not-found" when no save exists', () => {
      const mgr = createSaveManager({ gameId: 'evt-nf', storageAdapter: createMapStorage() });
      const handler = vi.fn();
      mgr.on('save:load-failed', handler);

      const result = mgr.load();

      expect(result.success).toBe(false);
      expect(handler).toHaveBeenCalledWith({ slotId: 0, reason: 'not-found' });
    });

    it('emits save:load-failed with reason "parse-error" for invalid JSON', () => {
      const storage = createMapStorage();
      storage.setItem('evt-pe-slot-0', '{not valid json');
      const mgr = createSaveManager({ gameId: 'evt-pe', storageAdapter: storage });

      const handler = vi.fn();
      mgr.on('save:load-failed', handler);

      const result = mgr.load();

      expect(result.success).toBe(false);
      expect(handler).toHaveBeenCalledTimes(1);
      const [arg] = handler.mock.calls[0];
      expect(arg.reason).toBe('parse-error');
      expect(arg.slotId).toBe(0);
      expect(arg.detail).toBeInstanceOf(Error);
    });

    it('emits save:load-failed with reason "wrong-game-id" for mismatched gameId', () => {
      const storage = createMapStorage();
      storage.setItem(
        'evt-wg-slot-0',
        JSON.stringify({ version: 1, gameId: 'other-game', timestamp: 1, data: {} }),
      );
      const mgr = createSaveManager({ gameId: 'evt-wg', storageAdapter: storage });

      const handler = vi.fn();
      mgr.on('save:load-failed', handler);

      const result = mgr.load();

      expect(result.success).toBe(false);
      expect(handler).toHaveBeenCalledWith({ slotId: 0, reason: 'wrong-game-id' });
    });

    it('emits save:load-failed with reason "parse-error" on importSave with bad data', () => {
      const mgr = createSaveManager({ gameId: 'evt-imp', storageAdapter: createMapStorage() });

      const failed = vi.fn();
      const loaded = vi.fn();
      mgr.on('save:load-failed', failed);
      mgr.on('save:loaded', loaded);

      const result = mgr.importSave('{not valid');

      expect(result.success).toBe(false);
      expect(failed).toHaveBeenCalledTimes(1);
      expect(failed.mock.calls[0][0].reason).toBe('parse-error');
      expect(loaded).not.toHaveBeenCalled();
    });

    it('emits save:loaded on successful importSave', () => {
      const mgr = createSaveManager({ gameId: 'evt-imp2', storageAdapter: createMapStorage() });
      beginPersistentContext('evt-imp2-ctx');
      const v = persistent(0);
      endPersistentContext();
      v.value = 42;
      const exported = mgr.exportSave();

      const handler = vi.fn();
      mgr.on('save:loaded', handler);

      const result = mgr.importSave(exported);

      expect(result.success).toBe(true);
      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler.mock.calls[0][0].slotId).toBe(0);
    });

    it('emits save:migration-step for each user migration that runs', () => {
      const storage = createMapStorage();
      storage.setItem(
        'evt-mig-slot-0',
        JSON.stringify({
          version: 1,
          gameId: 'evt-mig',
          timestamp: 1,
          data: {},
          _engine: { version: 2 },
        }),
      );
      const mgr = createSaveManager({
        gameId: 'evt-mig',
        version: 3,
        storageAdapter: storage,
        migrations: {
          1: (d) => d,
          2: (d) => d,
        },
      });

      const handler = vi.fn();
      mgr.on('save:migration-step', handler);

      mgr.load();

      expect(handler).toHaveBeenCalledTimes(2);
      expect(handler.mock.calls[0][0]).toEqual({ from: 1, to: 2 });
      expect(handler.mock.calls[1][0]).toEqual({ from: 2, to: 3 });
    });

    // --- Validation layer ---

    it('emits save:future-version and fails load when envelope version exceeds current', () => {
      const storage = createMapStorage();
      storage.setItem(
        'evt-fv-slot-0',
        JSON.stringify({
          version: 5,
          gameId: 'evt-fv',
          timestamp: 1,
          data: {},
          _engine: { version: 2 },
        }),
      );
      const mgr = createSaveManager({ gameId: 'evt-fv', version: 2, storageAdapter: storage });

      const fv = vi.fn();
      const failed = vi.fn();
      mgr.on('save:future-version', fv);
      mgr.on('save:load-failed', failed);

      const result = mgr.load();

      expect(result.success).toBe(false);
      expect(fv).toHaveBeenCalledWith({ slotId: 0, saveVersion: 5, currentVersion: 2 });
      expect(failed).toHaveBeenCalledWith({
        slotId: 0,
        reason: 'future-version',
        detail: undefined,
      });
    });

    it('emits save:validation-error and self-heals in non-strict mode', () => {
      const storage = createMapStorage();
      const mgr = createSaveManager({
        gameId: 'evt-val-heal',
        storageAdapter: storage,
        strictValidation: false,
        compressSave: false,
      });
      beginPersistentContext('evt-val-heal-ctx');
      const count = persistent(0, { name: 'count' });
      endPersistentContext();
      count.value = 10;
      mgr.save();

      // Corrupt the stored leaf to a wrong type
      const raw = JSON.parse(storage.getItem('evt-val-heal-slot-0')!);
      raw.data['evt-val-heal-ctx'].count = { not: 'a number' };
      storage.setItem('evt-val-heal-slot-0', JSON.stringify(raw));

      const errs = vi.fn();
      mgr.on('save:validation-error', errs);

      // Poison the in-memory value so we can see the self-heal reset it
      count.value = 999;
      const result = mgr.load();

      expect(result.success).toBe(true);
      expect(errs).toHaveBeenCalledTimes(1);
      expect(errs.mock.calls[0][0]).toMatchObject({
        path: 'evt-val-heal-ctx.count',
        action: 'self-heal',
      });
      // Self-heal reset to default (0)
      expect(count.value).toBe(0);
    });

    it('emits save:validation-error and fails load with reason "validation" in strict mode', () => {
      const storage = createMapStorage();
      const mgr = createSaveManager({
        gameId: 'evt-val-strict',
        storageAdapter: storage,
        strictValidation: true,
        compressSave: false,
      });
      beginPersistentContext('evt-val-strict-ctx');
      const count = persistent(0, { name: 'count' });
      endPersistentContext();
      count.value = 10;
      mgr.save();

      const raw = JSON.parse(storage.getItem('evt-val-strict-slot-0')!);
      raw.data['evt-val-strict-ctx'].count = { not: 'a number' };
      storage.setItem('evt-val-strict-slot-0', JSON.stringify(raw));

      const errs = vi.fn();
      const failed = vi.fn();
      mgr.on('save:validation-error', errs);
      mgr.on('save:load-failed', failed);

      // Pre-load in-memory value stays untouched in strict mode
      count.value = 777;
      const result = mgr.load();

      expect(result.success).toBe(false);
      expect(errs).toHaveBeenCalledTimes(1);
      expect(errs.mock.calls[0][0].action).toBe('fail');
      expect(failed).toHaveBeenCalledWith({
        slotId: 0,
        reason: 'validation',
        detail: undefined,
      });
      // Strict: no writes to refs happened
      expect(count.value).toBe(777);
    });

    it('clean save with matching types validates successfully in strict mode', () => {
      const mgr = createSaveManager({
        gameId: 'evt-val-clean',
        storageAdapter: createMapStorage(),
        strictValidation: true,
      });
      beginPersistentContext('evt-val-clean-ctx');
      const count = persistent(0, { name: 'count' });
      const label = persistent('', { name: 'label' });
      endPersistentContext();
      count.value = 42;
      label.value = 'hello';
      mgr.save();

      count.value = 0;
      label.value = '';
      const errs = vi.fn();
      mgr.on('save:validation-error', errs);

      const result = mgr.load();
      expect(result.success).toBe(true);
      expect(errs).not.toHaveBeenCalled();
      expect(count.value).toBe(42);
      expect(label.value).toBe('hello');
    });

    it('unsubscribe stops further event delivery', () => {
      const mgr = createSaveManager({ gameId: 'evt-unsub', storageAdapter: createMapStorage() });
      beginPersistentContext('evt-unsub-ctx');
      persistent(0);
      endPersistentContext();
      mgr.save();

      const handler = vi.fn();
      const off = mgr.on('save:loaded', handler);
      mgr.load();
      off();
      mgr.load();

      expect(handler).toHaveBeenCalledTimes(1);
    });
  });
});

describe('createMemoryStorage', () => {
  it('round-trips set/get/remove with localStorage-compatible semantics', () => {
    const storage = createMemoryStorage();
    expect(storage.getItem('missing')).toBeNull();
    storage.setItem('k', 'v1');
    expect(storage.getItem('k')).toBe('v1');
    storage.setItem('k', 'v2');
    expect(storage.getItem('k')).toBe('v2');
    storage.removeItem('k');
    expect(storage.getItem('k')).toBeNull();
    // removeItem on a missing key is a no-op, matching localStorage
    expect(() => storage.removeItem('k')).not.toThrow();
  });

  it('returns independent stores per invocation', () => {
    const a = createMemoryStorage();
    const b = createMemoryStorage();
    a.setItem('shared', 'from-a');
    expect(b.getItem('shared')).toBeNull();
    b.setItem('shared', 'from-b');
    expect(a.getItem('shared')).toBe('from-a');
    expect(b.getItem('shared')).toBe('from-b');
  });

  it('drives a SaveManager round-trip end-to-end', () => {
    const mgr = createSaveManager({ gameId: 'mem', storageAdapter: createMemoryStorage() });
    beginPersistentContext('mem-test');
    const gold = persistent(0, { name: 'gold' });
    endPersistentContext();
    gold.value = 42;
    mgr.save();
    resetPersistent(gold);
    expect(gold.value).toBe(0);
    expect(mgr.load().success).toBe(true);
    expect(gold.value).toBe(42);
  });
});
