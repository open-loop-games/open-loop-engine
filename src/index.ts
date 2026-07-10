/**
 * Engine entrypoint — top-level facade composing every layer.
 *
 * Re-exports the full API surface from primitives, core, systems, harness, and
 * the engine-assembly module ({@link createEngine}, {@link EngineContext},
 * {@link EngineModule}) that consumers import to assemble a game.
 *
 * @cluster engine
 */
export * from './primitives';
export * from './core';
export * from './systems';
export * from './harness';
export * from './reactivity-reexports';
export * from './engine';
