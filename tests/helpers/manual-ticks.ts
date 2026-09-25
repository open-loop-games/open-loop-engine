/** A tick source a test steps by hand, standing in for a real TickDriver's registerTick. */
export function createManualTicks() {
  const callbacks = new Set<(dt: number) => void>();
  return {
    registerTick(cb: (dt: number) => void): () => void {
      callbacks.add(cb);
      return () => callbacks.delete(cb);
    },
    tick(dt = 1) {
      for (const cb of Array.from(callbacks)) cb(dt);
    },
    subscriberCount() {
      return callbacks.size;
    },
  };
}
