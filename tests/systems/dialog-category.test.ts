import { describe, it, expect, beforeEach } from 'vitest';
import { resetAllPersistentContexts } from '@/core/persistence';
import { createDialogCategory } from '@/systems/dialog-category';
import type { DialogGraph } from '@/systems/dialog';

beforeEach(() => {
  resetAllPersistentContexts();
});

interface NpcDef {
  id: string;
  name: string;
}

function buildGraph(id: string, text: string): DialogGraph {
  return {
    id,
    entry: 'root',
    nodes: [{ id: 'root', text }],
  };
}

describe('createDialogCategory', () => {
  it('registers definitions and exposes graphs per entry', () => {
    const cat = createDialogCategory<NpcDef>({
      id: 'npcs',
      mapDialog: (def) => buildGraph(`${def.id}-greeting`, `Hello, I'm ${def.name}.`),
    });

    cat.register([
      { id: 'rask', name: 'Rask' },
      { id: 'kael', name: 'Kael' },
    ]);

    expect(cat.size).toBe(2);
    expect(cat.getEntry('rask')?.graphs[0].entry).toBe('root');
    expect(cat.getEntry('rask')?.graphs[0].nodes[0].text).toBe("Hello, I'm Rask.");
  });

  it('supports multiple graphs per def', () => {
    const cat = createDialogCategory<NpcDef>({
      id: 'npcs',
      mapDialog: (def) => [
        buildGraph(`${def.id}-greeting`, 'Hi.'),
        buildGraph(`${def.id}-farewell`, 'Bye.'),
      ],
    });

    cat.register({ id: 'rask', name: 'Rask' });

    expect(cat.getEntry('rask')?.graphs).toHaveLength(2);
  });

  it('looks up graphs by id across entries via getGraph', () => {
    const cat = createDialogCategory<NpcDef>({
      id: 'npcs',
      mapDialog: (def) => buildGraph(`${def.id}-greeting`, def.name),
    });

    cat.register([
      { id: 'rask', name: 'Rask' },
      { id: 'kael', name: 'Kael' },
    ]);

    expect(cat.getGraph('kael-greeting')?.nodes[0].text).toBe('Kael');
    expect(cat.getGraph('nonexistent')).toBeUndefined();
  });

  it('a graph id repeated across defs throws, naming both defs', () => {
    const cat = createDialogCategory<NpcDef>({
      id: 'npcs',
      mapDialog: () => buildGraph('greeting', 'Hi.'),
    });

    cat.register({ id: 'rask', name: 'Rask' });
    expect(() => cat.register({ id: 'kael', name: 'Kael' })).toThrow(
      /duplicate dialog graph id "greeting".*"rask".*"kael"/,
    );
    expect(cat.getDef('kael')).toBeUndefined();
    expect(cat.getGraph('greeting')?.nodes[0].text).toBe('Hi.');
  });

  it('a graph id repeated within one def throws', () => {
    const cat = createDialogCategory<NpcDef>({
      id: 'npcs',
      mapDialog: () => [buildGraph('greeting', 'Hi.'), buildGraph('greeting', 'Hey.')],
    });

    expect(() => cat.register({ id: 'rask', name: 'Rask' })).toThrow(
      /duplicate dialog graph id "greeting"/,
    );
  });

  it('exposes registry for mod patches', () => {
    const cat = createDialogCategory<NpcDef>({
      id: 'npcs',
      mapDialog: (def) => buildGraph(`${def.id}-g`, def.name),
    });

    cat.register({ id: 'rask', name: 'Rask' });
    expect(cat.registry.get('rask')?.name).toBe('Rask');
  });
});
