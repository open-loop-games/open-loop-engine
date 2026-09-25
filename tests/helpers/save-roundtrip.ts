import {
  getAllPersistentRefs,
  resetAllPersistentContexts,
  serializePersistents,
} from '@/core/persistence';

/**
 * The save half of a save → forget → rebuild → load round trip: serializes
 * every persistent ref, then clears every persistent context so a rebuild
 * starts from defaults.
 */
export function saveAndClear(): Record<string, unknown> {
  const save = serializePersistents(getAllPersistentRefs());
  resetAllPersistentContexts();
  return save;
}
