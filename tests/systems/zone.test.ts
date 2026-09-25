import { describe, it, expect } from 'vitest';
import { createZoneSystem } from '@/systems/zone';

describe('ZoneSystem', () => {
  // --- Factory ---

  it('creates with default options', () => {
    const zs = createZoneSystem();
    expect(zs.registry.size).toBe(0);
    expect(zs.current.value).toBe('');
    expect(zs.unlocked.value).toEqual([]);
  });

  it('registers initial zones', () => {
    const zs = createZoneSystem({
      zones: [
        { id: 'town', name: 'Town', order: 0 },
        { id: 'forest', name: 'Forest', order: 1 },
      ],
    });
    expect(zs.registry.size).toBe(2);
    expect(zs.registry.has('town')).toBe(true);
    expect(zs.registry.has('forest')).toBe(true);
  });

  it('defaults first zone as initially unlocked and current', () => {
    const zs = createZoneSystem({
      zones: [
        { id: 'town', name: 'Town' },
        { id: 'forest', name: 'Forest' },
      ],
    });
    expect(zs.unlocked.value).toEqual(['town']);
    expect(zs.current.value).toBe('town');
  });

  it('respects explicit initiallyUnlocked', () => {
    const zs = createZoneSystem({
      zones: [
        { id: 'town', name: 'Town' },
        { id: 'forest', name: 'Forest' },
      ],
      initiallyUnlocked: ['town', 'forest'],
    });
    expect(zs.unlocked.value).toEqual(['town', 'forest']);
    expect(zs.current.value).toBe('town');
  });

  // --- unlock ---

  it('unlocks a zone', () => {
    const zs = createZoneSystem({
      zones: [
        { id: 'town', name: 'Town' },
        { id: 'forest', name: 'Forest' },
      ],
    });
    expect(zs.isUnlocked('forest')).toBe(false);
    zs.unlock('forest');
    expect(zs.isUnlocked('forest')).toBe(true);
    expect(zs.unlocked.value).toEqual(['town', 'forest']);
  });

  it('unlock is idempotent', () => {
    const zs = createZoneSystem({
      zones: [{ id: 'town', name: 'Town' }],
    });
    zs.unlock('town');
    zs.unlock('town');
    expect(zs.unlocked.value).toEqual(['town']);
  });

  it('emits unlocked event', () => {
    const zs = createZoneSystem({
      zones: [
        { id: 'town', name: 'Town' },
        { id: 'forest', name: 'Forest' },
      ],
    });
    const unlocked: string[] = [];
    zs.on('unlocked', (id) => unlocked.push(id));

    zs.unlock('forest');
    expect(unlocked).toEqual(['forest']);

    // No event for idempotent unlock
    zs.unlock('forest');
    expect(unlocked).toEqual(['forest']);
  });

  // --- select ---

  it('selects an unlocked zone', () => {
    const zs = createZoneSystem({
      zones: [
        { id: 'town', name: 'Town' },
        { id: 'forest', name: 'Forest' },
      ],
      initiallyUnlocked: ['town', 'forest'],
    });
    const result = zs.select('forest');
    expect(result).toBe(true);
    expect(zs.current.value).toBe('forest');
  });

  it('rejects selecting a locked zone', () => {
    const zs = createZoneSystem({
      zones: [
        { id: 'town', name: 'Town' },
        { id: 'forest', name: 'Forest' },
      ],
    });
    const result = zs.select('forest');
    expect(result).toBe(false);
    expect(zs.current.value).toBe('town');
  });

  it('selecting current zone returns true without emitting', () => {
    const zs = createZoneSystem({
      zones: [{ id: 'town', name: 'Town' }],
    });
    const selected: string[] = [];
    zs.on('selected', (id) => selected.push(id));

    const result = zs.select('town');
    expect(result).toBe(true);
    expect(selected).toEqual([]);
  });

  it('emits selected event with previous zone', () => {
    const zs = createZoneSystem({
      zones: [
        { id: 'town', name: 'Town' },
        { id: 'forest', name: 'Forest' },
      ],
      initiallyUnlocked: ['town', 'forest'],
    });
    const events: [string, string][] = [];
    zs.on('selected', (id, prev) => events.push([id, prev]));

    zs.select('forest');
    expect(events).toEqual([['forest', 'town']]);
  });

  // --- ordered ---

  it('returns zones sorted by order', () => {
    const zs = createZoneSystem({
      zones: [
        { id: 'c', name: 'C', order: 2 },
        { id: 'a', name: 'A', order: 0 },
        { id: 'b', name: 'B', order: 1 },
      ],
    });
    expect(zs.ordered.value.map((z) => z.id)).toEqual(['a', 'b', 'c']);
  });

  it('zones without order sort after those with order', () => {
    const zs = createZoneSystem({
      zones: [
        { id: 'no-order', name: 'No Order' },
        { id: 'first', name: 'First', order: 0 },
      ],
    });
    expect(zs.ordered.value.map((z) => z.id)).toEqual(['first', 'no-order']);
  });

  it('ordered picks up a zone registered or patched after its first read', () => {
    const zs = createZoneSystem({
      zones: [
        { id: 'town', name: 'Town', order: 0 },
        { id: 'wild', name: 'Wild', order: 1 },
      ],
    });
    expect(zs.ordered.value.map((z) => z.id)).toEqual(['town', 'wild']);

    zs.registry.register({ id: 'volcano', name: 'Volcano', order: -1 });
    expect(zs.ordered.value.map((z) => z.id)).toEqual(['volcano', 'town', 'wild']);

    zs.registry.patch('wild', { order: -5 });
    expect(zs.ordered.value.map((z) => z.id)).toEqual(['wild', 'volcano', 'town']);
  });

  it('zones without order keep registration order among themselves', () => {
    const zs = createZoneSystem({
      zones: [
        { id: 'b', name: 'B' },
        { id: 'a', name: 'A' },
        { id: 'first', name: 'First', order: 0 },
      ],
    });
    expect(zs.ordered.value.map((z) => z.id)).toEqual(['first', 'b', 'a']);
  });

  // --- resetUnlocks ---

  it('resets unlocked zones to initial set', () => {
    const zs = createZoneSystem({
      zones: [
        { id: 'town', name: 'Town' },
        { id: 'forest', name: 'Forest' },
        { id: 'caves', name: 'Caves' },
      ],
      initiallyUnlocked: ['town'],
    });
    zs.unlock('forest');
    zs.unlock('caves');
    expect(zs.unlocked.value).toEqual(['town', 'forest', 'caves']);

    zs.resetUnlocks();
    expect(zs.unlocked.value).toEqual(['town']);
  });

  it('resetUnlocks moves selection to first unlocked if current becomes locked', () => {
    const zs = createZoneSystem({
      zones: [
        { id: 'town', name: 'Town' },
        { id: 'forest', name: 'Forest' },
      ],
    });
    zs.unlock('forest');
    zs.select('forest');
    expect(zs.current.value).toBe('forest');

    zs.resetUnlocks();
    expect(zs.current.value).toBe('town');
  });

  it('resetUnlocks keeps selection if still unlocked', () => {
    const zs = createZoneSystem({
      zones: [
        { id: 'town', name: 'Town' },
        { id: 'forest', name: 'Forest' },
      ],
      initiallyUnlocked: ['town'],
    });
    // town is current and stays unlocked after reset
    zs.unlock('forest');
    zs.resetUnlocks();
    expect(zs.current.value).toBe('town');
  });

  // --- Registry access for mods ---

  it('registry is accessible for mod extension', () => {
    const zs = createZoneSystem({
      zones: [{ id: 'town', name: 'Town' }],
    });
    zs.registry.register({ id: 'volcano', name: 'Volcano', order: 10 });
    expect(zs.registry.size).toBe(2);
    expect(zs.registry.get('volcano')?.name).toBe('Volcano');
  });

  it('mods can patch zone definitions', () => {
    const zs = createZoneSystem({
      zones: [{ id: 'town', name: 'Town', order: 0 }],
    });
    zs.registry.patch('town', { name: 'Enchanted Town' });
    expect(zs.registry.get('town')?.name).toBe('Enchanted Town');
  });

  // --- Type guard ---
});
