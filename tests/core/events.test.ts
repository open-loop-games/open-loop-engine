import { describe, it, expect, vi } from 'vitest';
import { createEmitHandle } from '@/core/events';

interface TestEvents {
  ping: () => void;
  data: (value: number) => void;
  multi: (a: string, b: number) => void;
}

describe('createEmitHandle', () => {
  it('emits and receives events', () => {
    const handle = createEmitHandle<TestEvents>();
    const cb = vi.fn();
    handle.on('ping', cb);
    handle.emit('ping');
    expect(cb).toHaveBeenCalledOnce();
  });

  it('passes arguments through emit', () => {
    const handle = createEmitHandle<TestEvents>();
    const cb = vi.fn();
    handle.on('data', cb);
    handle.emit('data', 42);
    expect(cb).toHaveBeenCalledWith(42);
  });

  it('passes multiple arguments', () => {
    const handle = createEmitHandle<TestEvents>();
    const cb = vi.fn();
    handle.on('multi', cb);
    handle.emit('multi', 'hello', 7);
    expect(cb).toHaveBeenCalledWith('hello', 7);
  });

  it('returns unsubscribe function', () => {
    const handle = createEmitHandle<TestEvents>();
    const cb = vi.fn();
    const unsub = handle.on('ping', cb);
    handle.emit('ping');
    unsub();
    handle.emit('ping');
    expect(cb).toHaveBeenCalledOnce();
  });

  it('supports multiple listeners on same event', () => {
    const handle = createEmitHandle<TestEvents>();
    const cb1 = vi.fn();
    const cb2 = vi.fn();
    handle.on('ping', cb1);
    handle.on('ping', cb2);
    handle.emit('ping');
    expect(cb1).toHaveBeenCalledOnce();
    expect(cb2).toHaveBeenCalledOnce();
  });

  it('does not throw when emitting with no listeners', () => {
    const handle = createEmitHandle<TestEvents>();
    expect(() => handle.emit('ping')).not.toThrow();
  });

  it('isolates different event types', () => {
    const handle = createEmitHandle<TestEvents>();
    const pingCb = vi.fn();
    const dataCb = vi.fn();
    handle.on('ping', pingCb);
    handle.on('data', dataCb);
    handle.emit('ping');
    expect(pingCb).toHaveBeenCalledOnce();
    expect(dataCb).not.toHaveBeenCalled();
  });
});
