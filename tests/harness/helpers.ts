import { createEngine, type Engine, type EngineModule } from '@/index';

/** Creates, installs and starts a no-persistence engine under a random namespace. */
export function startEngine(gameId: string, mod: EngineModule): Engine {
  const engine = createEngine({
    gameId,
    persistence: false,
    persistenceNamespace: `${gameId}-${Math.random().toString(36).slice(2)}`,
  });
  engine.use(mod);
  engine.start();
  return engine;
}
