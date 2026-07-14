import { afterEach } from 'vitest';
import { resetAllPersistentContexts } from '@/core/persistence';

// The persistent-ref registry is process-global. Drivers, modules, and
// categories that register a stable context id (e.g. the engine's namespaced
// `tick-driver` accumulator) would otherwise leak across test files and collide
// on the next same-namespace registration. Clearing between cases mirrors the
// per-engine `dispose()` lifecycle without demanding every test dispose by hand.
afterEach(() => {
  resetAllPersistentContexts();
});
