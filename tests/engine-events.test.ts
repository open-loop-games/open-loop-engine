import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { createEngine } from '@/index';
import type { EngineModule, EngineContext } from '@/index';

// Extend EngineEvents for testing
declare module '@/index' {
  interface EngineEvents {
    testPing: () => void;
    testData: (value: number) => void;
    testMulti: (a: string, b: number) => void;
  }
}

beforeAll(() => {
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    setTimeout(() => cb(performance.now()), 0);
    return 0;
  });
  vi.stubGlobal('cancelAnimationFrame', (_id: number) => {});
});
afterAll(() => {
  vi.unstubAllGlobals();
});

function createTestEngine() {
  return createEngine({ gameId: 'test', persistence: false });
}

describe('engine event bus', () => {
  it('exposes on and emit on EngineContext', () => {
    let ctx: EngineContext | null = null;
    const mod: EngineModule = {
      id: 'probe',
      install(c) {
        ctx = c;
      },
    };
    const engine = createTestEngine();
    engine.use(mod);
    engine.start();
    expect(ctx!.on).toBeTypeOf('function');
    expect(ctx!.emit).toBeTypeOf('function');
    engine.stop();
  });

  it('module subscribes and receives events emitted by another module', () => {
    const handler = vi.fn();

    const subscriber: EngineModule = {
      id: 'subscriber',
      install(ctx) {
        ctx.on('testPing', handler);
      },
    };

    const emitter: EngineModule = {
      id: 'emitter',
      dependencies: ['subscriber'],
      install(ctx) {
        ctx.emit('testPing');
      },
    };

    const engine = createTestEngine();
    engine.use(emitter);
    engine.use(subscriber);
    engine.start();
    expect(handler).toHaveBeenCalledOnce();
    engine.stop();
  });

  it('passes arguments through events', () => {
    const handler = vi.fn();

    const subscriber: EngineModule = {
      id: 'sub',
      install(ctx) {
        ctx.on('testData', handler);
      },
    };

    const emitter: EngineModule = {
      id: 'emit',
      dependencies: ['sub'],
      install(ctx) {
        ctx.emit('testData', 42);
      },
    };

    const engine = createTestEngine();
    engine.use(emitter);
    engine.use(subscriber);
    engine.start();
    expect(handler).toHaveBeenCalledWith(42);
    engine.stop();
  });

  it('passes multiple arguments through events', () => {
    const handler = vi.fn();

    const subscriber: EngineModule = {
      id: 'sub',
      install(ctx) {
        ctx.on('testMulti', handler);
      },
    };

    const emitter: EngineModule = {
      id: 'emit',
      dependencies: ['sub'],
      install(ctx) {
        ctx.emit('testMulti', 'hello', 7);
      },
    };

    const engine = createTestEngine();
    engine.use(emitter);
    engine.use(subscriber);
    engine.start();
    expect(handler).toHaveBeenCalledWith('hello', 7);
    engine.stop();
  });

  it('supports multiple subscribers on same event', () => {
    const handler1 = vi.fn();
    const handler2 = vi.fn();

    const sub1: EngineModule = {
      id: 'sub1',
      install(ctx) {
        ctx.on('testPing', handler1);
      },
    };

    const sub2: EngineModule = {
      id: 'sub2',
      install(ctx) {
        ctx.on('testPing', handler2);
      },
    };

    const emitter: EngineModule = {
      id: 'emitter',
      dependencies: ['sub1', 'sub2'],
      install(ctx) {
        ctx.emit('testPing');
      },
    };

    const engine = createTestEngine();
    engine.use(emitter);
    engine.use(sub1);
    engine.use(sub2);
    engine.start();
    expect(handler1).toHaveBeenCalledOnce();
    expect(handler2).toHaveBeenCalledOnce();
    engine.stop();
  });

  it('on() returns unsubscribe function for manual cleanup', () => {
    const handler = vi.fn();
    let unsub: (() => void) | null = null;
    let emitFn: EngineContext['emit'] | null = null;

    const sub: EngineModule = {
      id: 'sub',
      install(ctx) {
        unsub = ctx.on('testPing', handler);
        emitFn = ctx.emit;
      },
    };

    const engine = createTestEngine();
    engine.use(sub);
    engine.start();

    emitFn!('testPing');
    expect(handler).toHaveBeenCalledOnce();

    unsub!();
    emitFn!('testPing');
    expect(handler).toHaveBeenCalledOnce(); // not called again
    engine.stop();
  });

  it('emit with no subscribers does not throw', () => {
    const mod: EngineModule = {
      id: 'lonely',
      install(ctx) {
        expect(() => ctx.emit('testPing')).not.toThrow();
      },
    };

    const engine = createTestEngine();
    engine.use(mod);
    engine.start();
    engine.stop();
  });

  it('events work across module boundaries post-install (runtime emit)', () => {
    const handler = vi.fn();
    let emitFn: EngineContext['emit'] | null = null;

    const sub: EngineModule = {
      id: 'sub',
      install(ctx) {
        ctx.on('testData', handler);
      },
    };

    const emitter: EngineModule = {
      id: 'emitter',
      dependencies: ['sub'],
      install(ctx) {
        emitFn = ctx.emit;
      },
    };

    const engine = createTestEngine();
    engine.use(emitter);
    engine.use(sub);
    engine.start();

    // Emit after install, simulating runtime event
    emitFn!('testData', 99);
    expect(handler).toHaveBeenCalledWith(99);
    engine.stop();
  });

  it('shared event bus — all modules see same bus', () => {
    const handler = vi.fn();
    let emitFn: EngineContext['emit'] | null = null;

    const modA: EngineModule = {
      id: 'a',
      install(ctx) {
        ctx.on('testPing', handler);
      },
    };

    const modB: EngineModule = {
      id: 'b',
      install(ctx) {
        emitFn = ctx.emit;
      },
    };

    const engine = createTestEngine();
    engine.use(modA);
    engine.use(modB);
    engine.start();

    // B emits, A receives — no dependency required for event flow
    emitFn!('testPing');
    expect(handler).toHaveBeenCalledOnce();
    engine.stop();
  });
});

describe('engine event bus — per-module auto-cleanup', () => {
  it('tracks subscriptions per module', () => {
    const handler1 = vi.fn();
    const handler2 = vi.fn();
    let emitFn: EngineContext['emit'] | null = null;

    const modA: EngineModule = {
      id: 'a',
      install(ctx) {
        ctx.on('testPing', handler1);
        emitFn = ctx.emit;
      },
    };

    const modB: EngineModule = {
      id: 'b',
      install(ctx) {
        ctx.on('testPing', handler2);
      },
    };

    const engine = createTestEngine();
    engine.use(modA);
    engine.use(modB);
    engine.start();

    emitFn!('testPing');
    expect(handler1).toHaveBeenCalledOnce();
    expect(handler2).toHaveBeenCalledOnce();
    engine.stop();
  });
});
