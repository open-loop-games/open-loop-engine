import { describe, it, expect, vi } from 'vitest';
import {
  createSpatialGrid,
  createInfluenceLayer,
  composeInfluenceLayers,
  linearFalloff,
  gaussianFalloff,
  exponentialFalloff,
  type InfluenceLayerReader,
} from '@/core/spatial';

const numericGrid = (width: number, height: number) =>
  createSpatialGrid<number>({ width, height, initializer: () => 0 });

describe('falloff functions', () => {
  it('linearFalloff: 1 at d=0, 0 at d>=r, halfway at d=r/2', () => {
    expect(linearFalloff(0, 4)).toBeCloseTo(1);
    expect(linearFalloff(2, 4)).toBeCloseTo(0.5);
    expect(linearFalloff(4, 4)).toBeCloseTo(0);
    expect(linearFalloff(5, 4)).toBe(0);
    expect(linearFalloff(0, 0)).toBe(0);
  });

  it('gaussianFalloff: 1 at d=0, exp(-2) at d=r, never zero', () => {
    expect(gaussianFalloff(0, 5)).toBeCloseTo(1);
    expect(gaussianFalloff(5, 5)).toBeCloseTo(Math.exp(-2));
    expect(gaussianFalloff(10, 5)).toBeCloseTo(Math.exp(-8));
    expect(gaussianFalloff(0, 0)).toBe(0);
  });

  it('exponentialFalloff: 1 at d=0, exp(-1) at d=r', () => {
    expect(exponentialFalloff(0, 3)).toBeCloseTo(1);
    expect(exponentialFalloff(3, 3)).toBeCloseTo(Math.exp(-1));
    expect(exponentialFalloff(6, 3)).toBeCloseTo(Math.exp(-2));
    expect(exponentialFalloff(0, 0)).toBe(0);
  });
});

describe('createInfluenceLayer — construction & validation', () => {
  it('rejects non-positive defaultRadius', () => {
    const grid = numericGrid(4, 4);
    expect(() =>
      createInfluenceLayer(grid, { defaultRadius: 0, falloff: linearFalloff }),
    ).toThrow();
    expect(() =>
      createInfluenceLayer(grid, { defaultRadius: -1, falloff: linearFalloff }),
    ).toThrow();
    expect(() =>
      createInfluenceLayer(grid, { defaultRadius: NaN, falloff: linearFalloff }),
    ).toThrow();
  });
});

describe('InfluenceLayer — source registry', () => {
  it('addSource returns the source by reference; getSource recovers it', () => {
    const layer = createInfluenceLayer(numericGrid(8, 8), {
      defaultRadius: 3,
      falloff: linearFalloff,
    });
    const src = layer.addSource({ id: 'a', x: 2, y: 2, strength: 5 });
    expect(layer.getSource('a')).toBe(src);
  });

  it('rejects duplicate source ids', () => {
    const layer = createInfluenceLayer(numericGrid(8, 8), {
      defaultRadius: 3,
      falloff: linearFalloff,
    });
    layer.addSource({ id: 'a', x: 0, y: 0, strength: 1 });
    expect(() => layer.addSource({ id: 'a', x: 1, y: 1, strength: 2 })).toThrow(/duplicate/);
  });

  it('rejects NaN/infinite strength and negative radius', () => {
    const layer = createInfluenceLayer(numericGrid(8, 8), {
      defaultRadius: 3,
      falloff: linearFalloff,
    });
    expect(() => layer.addSource({ id: 'a', x: 0, y: 0, strength: NaN })).toThrow();
    expect(() => layer.addSource({ id: 'a', x: 0, y: 0, strength: Infinity })).toThrow();
    expect(() => layer.addSource({ id: 'a', x: 0, y: 0, strength: 1, radius: -1 })).toThrow();
  });

  it('rejects out-of-bounds source coordinates', () => {
    const layer = createInfluenceLayer(numericGrid(4, 4), {
      defaultRadius: 1,
      falloff: linearFalloff,
    });
    expect(() => layer.addSource({ id: 'a', x: 4, y: 0, strength: 1 })).toThrow(RangeError);
    expect(() => layer.addSource({ id: 'b', x: -1, y: 0, strength: 1 })).toThrow(RangeError);
  });

  it('removeSource returns true when present, false when absent', () => {
    const layer = createInfluenceLayer(numericGrid(4, 4), {
      defaultRadius: 1,
      falloff: linearFalloff,
    });
    layer.addSource({ id: 'a', x: 1, y: 1, strength: 1 });
    expect(layer.removeSource('a')).toBe(true);
    expect(layer.removeSource('a')).toBe(false);
    expect(layer.getSource('a')).toBeUndefined();
  });
});

describe('InfluenceLayer — update & accumulation', () => {
  it('accumulates linear falloff to neighboring cells', () => {
    const grid = numericGrid(7, 7);
    const layer = createInfluenceLayer(grid, {
      defaultRadius: 3,
      falloff: linearFalloff,
    });
    layer.addSource({ id: 'a', x: 3, y: 3, strength: 6 });
    layer.update();
    // At source: full strength.
    expect(layer.read().at(3, 3)).toBeCloseTo(6);
    // Adjacent (Euclidean distance 1, radius 3): 6 * (1 - 1/3) = 4.
    expect(layer.read().at(4, 3)).toBeCloseTo(4);
    // Diagonal (distance sqrt(2) ≈ 1.414): 6 * (1 - 1.414/3) ≈ 3.172.
    expect(layer.read().at(4, 4)).toBeCloseTo(6 * (1 - Math.SQRT2 / 3));
    // Beyond radius (distance 4 > radius 3): 0.
    expect(layer.read().at(0, 3)).toBe(0);
  });

  it('respects per-source radius override', () => {
    const grid = numericGrid(9, 9);
    const layer = createInfluenceLayer(grid, {
      defaultRadius: 2,
      falloff: linearFalloff,
    });
    layer.addSource({ id: 'a', x: 4, y: 4, strength: 4, radius: 1 });
    layer.update();
    expect(layer.read().at(4, 4)).toBeCloseTo(4);
    // distance 1 with r=1: 4 * (1 - 1) = 0.
    expect(layer.read().at(5, 4)).toBe(0);
  });

  it('multiple sources accumulate additively', () => {
    const grid = numericGrid(7, 7);
    const layer = createInfluenceLayer(grid, {
      defaultRadius: 2,
      falloff: linearFalloff,
    });
    layer.addSource({ id: 'a', x: 3, y: 3, strength: 4 });
    layer.addSource({ id: 'b', x: 3, y: 3, strength: 2 });
    layer.update();
    expect(layer.read().at(3, 3)).toBeCloseTo(6);
  });

  it('decay=0 (default) zero-fills before accumulation; sources do not stack across ticks', () => {
    const grid = numericGrid(5, 5);
    const layer = createInfluenceLayer(grid, {
      defaultRadius: 2,
      falloff: linearFalloff,
    });
    layer.addSource({ id: 'a', x: 2, y: 2, strength: 5 });
    layer.update();
    layer.update();
    // After two ticks at full reset, value should be 5 (not 10).
    expect(layer.read().at(2, 2)).toBeCloseTo(5);
  });

  it('decay=1.0 keeps prior values; sources stack across ticks', () => {
    const grid = numericGrid(5, 5);
    const layer = createInfluenceLayer(grid, {
      defaultRadius: 2,
      falloff: linearFalloff,
      decay: 1,
    });
    layer.addSource({ id: 'a', x: 2, y: 2, strength: 3 });
    layer.update();
    layer.update();
    expect(layer.read().at(2, 2)).toBeCloseTo(6);
  });

  it('decay=0.5 retains half between ticks (partial evaporation)', () => {
    const grid = numericGrid(5, 5);
    const layer = createInfluenceLayer(grid, {
      defaultRadius: 1,
      falloff: linearFalloff,
      decay: 0.5,
    });
    layer.addSource({ id: 'a', x: 2, y: 2, strength: 4 });
    layer.update(); // value = 4
    expect(layer.read().at(2, 2)).toBeCloseTo(4);
    layer.removeSource('a');
    layer.update(); // value = 4 * 0.5 = 2
    expect(layer.read().at(2, 2)).toBeCloseTo(2);
    layer.update(); // value = 2 * 0.5 = 1
    expect(layer.read().at(2, 2)).toBeCloseTo(1);
  });

  it('respectPassability=true skips impassable cells during accumulation', () => {
    const grid = numericGrid(5, 5);
    // Make (3, 2) impassable; everything else passable.
    for (let y = 0; y < 5; y++) {
      for (let x = 0; x < 5; x++) {
        grid.passable[y * 5 + x] = 1;
      }
    }
    grid.passable[2 * 5 + 3] = 0;
    const layer = createInfluenceLayer(grid, {
      defaultRadius: 2,
      falloff: linearFalloff,
      respectPassability: true,
    });
    layer.addSource({ id: 'a', x: 2, y: 2, strength: 4 });
    layer.update();
    expect(layer.read().at(3, 2)).toBe(0);
    expect(layer.read().at(2, 2)).toBeCloseTo(4);
    expect(layer.read().at(1, 2)).toBeCloseTo(2);
  });

  it('source mutation between ticks (mutable x/y) propagates to next update', () => {
    const grid = numericGrid(7, 7);
    const layer = createInfluenceLayer(grid, {
      defaultRadius: 2,
      falloff: linearFalloff,
    });
    const src = layer.addSource({ id: 'a', x: 1, y: 3, strength: 4 });
    layer.update();
    expect(layer.read().at(1, 3)).toBeCloseTo(4);
    expect(layer.read().at(5, 3)).toBe(0);
    src.x = 5;
    layer.update();
    expect(layer.read().at(1, 3)).toBe(0);
    expect(layer.read().at(5, 3)).toBeCloseTo(4);
  });

  it('profileHook fires once per update with cells-touched count', () => {
    const grid = numericGrid(5, 5);
    const profileHook = vi.fn();
    const layer = createInfluenceLayer(grid, {
      defaultRadius: 1,
      falloff: linearFalloff,
      profileHook,
    });
    layer.addSource({ id: 'a', x: 2, y: 2, strength: 1 });
    layer.update();
    expect(profileHook).toHaveBeenCalledTimes(1);
    // 3x3 Chebyshev box centered at (2,2) → 9 samples.
    expect(profileHook).toHaveBeenCalledWith(9);
  });

  it('zero-strength source contributes no samples', () => {
    const grid = numericGrid(5, 5);
    const profileHook = vi.fn();
    const layer = createInfluenceLayer(grid, {
      defaultRadius: 1,
      falloff: linearFalloff,
      profileHook,
    });
    layer.addSource({ id: 'a', x: 2, y: 2, strength: 0 });
    layer.update();
    expect(profileHook).toHaveBeenCalledWith(0);
    expect(layer.read().at(2, 2)).toBe(0);
  });
});

describe('InfluenceLayer — reset', () => {
  it('reset() zeroes every cell', () => {
    const grid = numericGrid(4, 4);
    const layer = createInfluenceLayer(grid, {
      defaultRadius: 2,
      falloff: linearFalloff,
      decay: 1,
    });
    layer.addSource({ id: 'a', x: 1, y: 1, strength: 5 });
    layer.update();
    expect(layer.read().at(1, 1)).toBeCloseTo(5);
    layer.reset();
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 4; x++) {
        expect(grid.cells[y * 4 + x]).toBe(0);
      }
    }
  });
});

describe('InfluenceLayerReader — sum / peak / cells / at', () => {
  it('at() returns 0 out of bounds', () => {
    const grid = numericGrid(3, 3);
    const layer = createInfluenceLayer(grid, {
      defaultRadius: 1,
      falloff: linearFalloff,
    });
    expect(layer.read().at(-1, 0)).toBe(0);
    expect(layer.read().at(3, 0)).toBe(0);
  });

  it('sum() aggregates Chebyshev region', () => {
    const grid = numericGrid(5, 5);
    const layer = createInfluenceLayer(grid, {
      defaultRadius: 2,
      falloff: linearFalloff,
    });
    layer.addSource({ id: 'a', x: 2, y: 2, strength: 10 });
    layer.update();
    const total = layer.read().sum(2, 2, 2);
    let manual = 0;
    for (let y = 0; y <= 4; y++) {
      for (let x = 0; x <= 4; x++) {
        manual += grid.cells[y * 5 + x];
      }
    }
    expect(total).toBeCloseTo(manual);
  });

  it('peak() returns max-value cell, null when center OOB', () => {
    const grid = numericGrid(5, 5);
    const layer = createInfluenceLayer(grid, {
      defaultRadius: 2,
      falloff: linearFalloff,
    });
    layer.addSource({ id: 'a', x: 1, y: 1, strength: 8 });
    layer.update();
    const peak = layer.read().peak(2, 2, 2);
    expect(peak).not.toBeNull();
    expect(peak!.x).toBe(1);
    expect(peak!.y).toBe(1);
    expect(peak!.value).toBeCloseTo(8);
    expect(layer.read().peak(-5, -5, 1)).toBeNull();
  });

  it('cells() yields every cell in row-major order', () => {
    const grid = numericGrid(2, 2);
    const layer = createInfluenceLayer(grid, {
      defaultRadius: 1,
      falloff: linearFalloff,
    });
    layer.addSource({ id: 'a', x: 0, y: 0, strength: 4 });
    layer.update();
    const seen: Array<[number, number, number]> = [];
    for (const cell of layer.read().cells()) seen.push(cell);
    expect(seen).toHaveLength(4);
    expect(seen[0][0]).toBe(0);
    expect(seen[0][1]).toBe(0);
    expect(seen[3][0]).toBe(1);
    expect(seen[3][1]).toBe(1);
  });
});

describe('composeInfluenceLayers', () => {
  it('combines per-cell values via the combine function (additive)', () => {
    const gridA = numericGrid(5, 5);
    const gridB = numericGrid(5, 5);
    const a = createInfluenceLayer(gridA, { defaultRadius: 1, falloff: linearFalloff });
    const b = createInfluenceLayer(gridB, { defaultRadius: 1, falloff: linearFalloff });
    a.addSource({ id: 's', x: 2, y: 2, strength: 3 });
    b.addSource({ id: 's', x: 2, y: 2, strength: 5 });
    a.update();
    b.update();
    const total = composeInfluenceLayers([a.read(), b.read()], (vs) =>
      vs.reduce((p, v) => p + v, 0),
    );
    expect(total.at(2, 2)).toBeCloseTo(8);
  });

  it('combines via max for CThreatMap-style stratified queries', () => {
    const gridGround = numericGrid(5, 5);
    const gridAir = numericGrid(5, 5);
    const ground = createInfluenceLayer(gridGround, { defaultRadius: 1, falloff: linearFalloff });
    const air = createInfluenceLayer(gridAir, { defaultRadius: 1, falloff: linearFalloff });
    ground.addSource({ id: 's', x: 2, y: 2, strength: 4 });
    air.addSource({ id: 's', x: 2, y: 2, strength: 7 });
    ground.update();
    air.update();
    const effective = composeInfluenceLayers([ground.read(), air.read()], (vs) => Math.max(...vs));
    expect(effective.at(2, 2)).toBeCloseTo(7);
  });

  it('re-reads each frame (no caching)', () => {
    const grid = numericGrid(3, 3);
    const layer = createInfluenceLayer(grid, { defaultRadius: 1, falloff: linearFalloff });
    const src = layer.addSource({ id: 'a', x: 1, y: 1, strength: 2 });
    layer.update();
    const composed = composeInfluenceLayers([layer.read()], (vs) => vs[0]);
    expect(composed.at(1, 1)).toBeCloseTo(2);
    src.strength = 9;
    layer.update();
    expect(composed.at(1, 1)).toBeCloseTo(9);
  });

  it('sum and peak walk a Chebyshev box and tolerate OOB via at()=0', () => {
    const grid = numericGrid(3, 3);
    const layer = createInfluenceLayer(grid, { defaultRadius: 1, falloff: linearFalloff });
    layer.addSource({ id: 'a', x: 1, y: 1, strength: 4 });
    layer.update();
    const composed = composeInfluenceLayers([layer.read()], (vs) => vs[0]);
    // sum over a box that extends past the grid boundary.
    const reader: InfluenceLayerReader = composed;
    const totalInside = layer.read().sum(1, 1, 1);
    expect(reader.sum(1, 1, 1)).toBeCloseTo(totalInside);
    const peak = reader.peak(1, 1, 1);
    expect(peak).not.toBeNull();
    expect(peak!.value).toBeCloseTo(4);
  });

  it("cells() iterates the first reader's cells with combine applied", () => {
    const gridA = numericGrid(2, 2);
    const gridB = numericGrid(2, 2);
    const a = createInfluenceLayer(gridA, { defaultRadius: 1, falloff: linearFalloff });
    const b = createInfluenceLayer(gridB, { defaultRadius: 1, falloff: linearFalloff });
    a.addSource({ id: 's', x: 0, y: 0, strength: 1 });
    b.addSource({ id: 's', x: 0, y: 0, strength: 10 });
    a.update();
    b.update();
    const total = composeInfluenceLayers([a.read(), b.read()], (vs) => vs[0] + vs[1]);
    const seen: number[] = [];
    for (const [, , v] of total.cells()) seen.push(v);
    expect(seen).toHaveLength(4);
    expect(seen[0]).toBeCloseTo(11);
  });

  it('rejects empty readers array', () => {
    expect(() => composeInfluenceLayers([], (vs) => vs[0] ?? 0)).toThrow();
  });
});
