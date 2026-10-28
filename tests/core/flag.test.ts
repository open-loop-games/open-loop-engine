import { describe, it, expect, beforeEach } from 'vitest';
import { computed, ref } from 'vue';
import {
  getAllPersistentRefs,
  resetAllPersistentContexts,
  serializePersistents,
  withPersistentContext,
} from '@/core/persistence';
import { createFlag } from '@/core/flag';
import { createFlagRegistry, withFlagRegistry } from '@/core/registries';
import { createReset } from '@/systems/reset';

beforeEach(() => resetAllPersistentContexts());

describe('createFlag', () => {
  it('a saved flag starts unset, can be set, and registers into the ambient flag registry', () => {
    const flags = createFlagRegistry();
    const seen = withFlagRegistry(flags, () => createFlag({ id: 'seen-shop' }));
    const read = computed(() => seen.value);

    expect(seen.derived).toBe(false);
    expect(read.value).toBe(false);
    seen.value = true;
    expect(read.value).toBe(true);
    expect(flags.get('seen-shop')).toBe(seen);
  });

  it('a derived flag reads its value and is marked derived', () => {
    const flags = createFlagRegistry();
    const gold = ref(5);
    const rich = withFlagRegistry(flags, () =>
      createFlag({ id: 'rich', value: () => gold.value >= 10 }),
    );

    expect(rich.derived).toBe(true);
    expect(rich.value).toBe(false);
    gold.value = 12;
    expect(rich.value).toBe(true);
    expect(flags.get('rich')).toBe(rich);
  });

  it('a duplicate id in one flag registry throws', () => {
    const flags = createFlagRegistry();
    withFlagRegistry(flags, () => {
      withPersistentContext('a', () => createFlag({ id: 'seen' }));
      expect(() => withPersistentContext('b', () => createFlag({ id: 'seen' }))).toThrow(/seen/);
    });
  });

  it('outside a flag registry it still works, unregistered', () => {
    const seen = createFlag({ id: 'loose' });
    seen.value = true;
    expect(seen.value).toBe(true);
  });

  it('saves under the enclosing persistent context', () => {
    const seen = withPersistentContext('story', () => createFlag({ id: 'seen-shop' }));
    seen.value = true;
    const saved = serializePersistents(getAllPersistentRefs()) as Record<
      string,
      Record<string, unknown>
    >;
    expect(saved.story['seen-shop']).toBe(true);
  });

  it('a reset of its persistent context leaves it set', () => {
    const seen = withPersistentContext('story', () => createFlag({ id: 'seen-shop' }));
    seen.value = true;
    createReset({ resetPersistentContexts: ['story'] }).reset();
    expect(seen.value).toBe(true);
  });
});
