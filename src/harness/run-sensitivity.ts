/**
 * Sensitivity runner — baseline-vs-variants delta sweep. Works over both
 * fixed-tick {@link Cell} (via {@link runMatrix}) and predicate-bounded
 * {@link UntilCell} (via {@link runMatrixUntil}); the cell shape picks the
 * runner. Variants can be supplied flat or axis-grouped (cartesian-expanded
 * per `SweepAxis`).
 *
 * @cluster runners
 */

import { diffAggregates } from './aggregate';
import { runMatrix } from './run-matrix';
import { runMatrixUntil } from './run-matrix-until';
import type {
  Cell,
  SensitivityOptions,
  SensitivityResult,
  SensitivityVariantResult,
  SweepAxis,
  UntilCell,
  Variant,
} from './types';

/**
 * Run baseline plus every variant, then compute per-variant
 * `{ absolute, relative }` deltas against the baseline per metric. Each
 * variant's cell id is set to the variant's id (axis-expanded variants get
 * `${axisId}=${value}` × … ids). So the variant's identity comes from the
 * options, not from what the `patch` function set.
 *
 * Cell shape picks the runner: a {@link Cell} baseline drives
 * {@link runMatrix} (fixed-tick), an {@link UntilCell} baseline drives
 * {@link runMatrixUntil} (predicate-bounded). A predicate-bounded sweep
 * requires {@link SensitivityOptions.until} and `maxSimTime`.
 *
 * @param options - {@link SensitivityOptions} — baseline cell, flat variants
 *   and/or axes, seeds, optional option callbacks, histogram opt-in, and (for
 *   a predicate-bounded sweep) the shared predicate + sim-time cap.
 * @returns {@link SensitivityResult} — baseline {@link CellResult} plus
 *   one {@link SensitivityVariantResult} per variant in expansion order
 *   (flat variants first, then axis-expanded cartesian product).
 *
 * @example Fixed-tick
 * ```ts
 * const result = runSensitivity({
 *   baseline: { id: 'baseline', setup: () => [createGoldAnalyzer()], tick, iterations: 1000 },
 *   variants: [
 *     { id: 'fast-gold', patch: (b) => ({ ...b, setup: () => [createFastGoldAnalyzer()] }) },
 *   ],
 *   seeds: [1, 2, 3],
 * });
 * result.variants[0].deltas['gold-analyzer.peak'].relative; // e.g. +0.42
 * ```
 *
 * @example Predicate-bounded with axis-grouped variants
 * An inline baseline whose `buildEngine` reads its context can't be inferred
 * as an `UntilCell`, so name the shape; axis values reach `patch` untyped.
 * ```ts
 * const result = runSensitivity<UntilCell>({
 *   baseline: { id: 'baseline', buildEngine: (ctx) => buildEngine(ctx) },
 *   axes: [{
 *     id: 'meta-cost',
 *     values: [0.85, 1.15],
 *     patch: (b, v) => ({
 *       ...b,
 *       buildEngine: (ctx) => buildEngine(ctx, { metaCostMul: v as number }),
 *     }),
 *   }],
 *   seeds: [1, 2, 3, 4, 5],
 *   until: (ctx) => ctx.simTime >= minutes(120),
 *   maxSimTime: minutes(150),
 * });
 * result.variants[0].deltas['termination.time'].relative; // e.g. -0.08, fires 8% sooner
 * ```
 */
export function runSensitivity<C extends Cell | UntilCell = Cell>(
  options: SensitivityOptions<C>,
): SensitivityResult {
  const variants = expandVariants(options);
  if (options.until !== undefined) {
    return runUntilPath(options, variants);
  }
  if (options.maxSimTime !== undefined || options.mode !== undefined) {
    throw new Error(
      'runSensitivity: `maxSimTime` / `mode` require `until`, which makes the sweep predicate-bounded',
    );
  }
  return runFixedTickPath(
    options as unknown as SensitivityOptions<Cell>,
    variants as unknown as Variant<Cell>[],
  );
}

/**
 * Flatten `variants` and `axes` into a single ordered variant list. Flat
 * variants come first (in declaration order), then axis-expanded variants
 * in cartesian product order over `axes`. Empty axes are skipped.
 *
 * @internal
 */
function expandVariants<C extends Cell | UntilCell>(options: SensitivityOptions<C>): Variant<C>[] {
  const out: Variant<C>[] = [...(options.variants ?? [])];
  const axes = options.axes;
  if (!axes || axes.length === 0) return out;

  type AxisEntry = { axisName: string; value: unknown; patch: SweepAxis<unknown, C>['patch'] };
  const product: AxisEntry[][] = [[]];
  for (const axis of axes) {
    if (axis.values.length === 0) continue;
    const next: AxisEntry[][] = [];
    for (const prefix of product) {
      for (const value of axis.values) {
        next.push([...prefix, { axisName: axis.id, value, patch: axis.patch }]);
      }
    }
    product.length = 0;
    product.push(...next);
  }
  if (product.length === 1 && product[0].length === 0) return out;

  for (const combo of product) {
    const name = combo.map((e) => `${e.axisName}=${String(e.value)}`).join(' × ');
    out.push({
      id: name,
      patch: (baseline) => {
        let cell = baseline;
        for (const entry of combo) {
          cell = entry.patch(cell, entry.value);
        }
        return cell;
      },
    });
  }
  return out;
}

/**
 * Fixed-tick path — variants apply to a {@link Cell} baseline, run via
 * {@link runMatrix}.
 *
 * @internal
 */
function runFixedTickPath(
  options: SensitivityOptions<Cell>,
  variants: Variant<Cell>[],
): SensitivityResult {
  const variantCells: Cell[] = variants.map((v) => ({ ...v.patch(options.baseline), id: v.id }));
  const cells: Cell[] = [options.baseline, ...variantCells];
  const matrix = runMatrix({
    cells,
    seeds: options.seeds,
    onRunComplete: options.onRunComplete,
    onCellComplete: options.onCellComplete,
    aggregate: options.aggregate,
  });
  const baselineResult = matrix.cells[0];
  const variantResults: SensitivityVariantResult[] = variants.map((v, i) => {
    const cell = matrix.cells[i + 1];
    return { id: v.id, cell, deltas: diffAggregates(cell.aggregate, baselineResult.aggregate) };
  });
  return { baseline: baselineResult, variants: variantResults };
}

/**
 * Predicate-bounded path — variants apply to an {@link UntilCell} baseline,
 * run via {@link runMatrixUntil}.
 *
 * @internal
 */
function runUntilPath<C extends Cell | UntilCell>(
  options: SensitivityOptions<C>,
  variants: Variant<C>[],
): SensitivityResult {
  if (options.maxSimTime === undefined) {
    throw new Error('runSensitivity: a predicate-bounded sweep requires `maxSimTime`');
  }
  const untilBaseline = options.baseline as unknown as UntilCell;
  const untilVariants = variants as unknown as Variant<UntilCell>[];
  const variantCells: UntilCell[] = untilVariants.map((v) => ({
    ...v.patch(untilBaseline),
    id: v.id,
  }));
  const cells: UntilCell[] = [untilBaseline, ...variantCells];
  const matrix = runMatrixUntil({
    cells,
    seeds: options.seeds,
    until: options.until!,
    maxSimTime: options.maxSimTime,
    onRunComplete: options.onRunComplete as never,
    onCellComplete: options.onCellComplete,
    aggregate: options.aggregate,
    mode: options.mode,
    bisectTolSec: options.bisectTolSec,
    stasisCheckInterval: options.stasisCheckInterval,
  });
  const baselineResult = matrix.cells[0];
  const variantResults: SensitivityVariantResult[] = variants.map((v, i) => {
    const cell = matrix.cells[i + 1];
    return { id: v.id, cell, deltas: diffAggregates(cell.aggregate, baselineResult.aggregate) };
  });
  return { baseline: baselineResult, variants: variantResults };
}
