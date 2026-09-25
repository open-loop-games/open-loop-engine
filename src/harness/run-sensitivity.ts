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
  SensitivityConfig,
  SensitivityResult,
  SensitivityVariantResult,
  SweepAxis,
  UntilCell,
  Variant,
} from './types';

/**
 * Run baseline plus every variant, then compute per-variant
 * `{ absolute, relative }` deltas against the baseline per metric. Each
 * variant's cell name is forced to the variant identity (axis-expanded
 * variants get `${axisName}=${value}` × … names) — the variant's identity
 * comes from the config, not whatever the `patch` function chose.
 *
 * Cell shape picks the runner: a {@link Cell} baseline drives
 * {@link runMatrix} (fixed-tick), an {@link UntilCell} baseline drives
 * {@link runMatrixUntil} (predicate-bounded). Until-mode requires
 * {@link SensitivityConfig.until} and `maxSimTime`.
 *
 * @param config - {@link SensitivityConfig} — baseline cell, flat variants
 *   and/or axes, seeds, optional callbacks, histogram opt-in, and (for
 *   until-mode) the shared predicate + ceiling.
 * @returns {@link SensitivityResult} — baseline {@link CellResult} plus
 *   one {@link SensitivityVariantResult} per variant in expansion order
 *   (flat variants first, then axis-expanded cartesian product).
 *
 * @example Fixed-tick
 * ```ts
 * const result = runSensitivity({
 *   baseline: { name: 'baseline', setup: () => [createGoldTracker()], tick, ticks: 1000 },
 *   variants: [
 *     { name: 'fast-gold', patch: (b) => ({ ...b, setup: () => [createFastGoldTracker()] }) },
 *   ],
 *   seeds: [1, 2, 3],
 * });
 * result.variants[0].deltas['gold-tracker.peak'].relative; // e.g. +0.42
 * ```
 *
 * @example Predicate-bounded with axis-grouped variants
 * An inline baseline whose `buildEngine` reads its context can't be inferred
 * as an `UntilCell`, so name the shape; axis values reach `patch` untyped.
 * ```ts
 * const result = runSensitivity<UntilCell>({
 *   baseline: { name: 'baseline', buildEngine: (ctx) => buildEngine(ctx) },
 *   axes: [{
 *     name: 'meta-cost',
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
 * result.variants[0].cell.aggregate.terminationTime!.avg;
 * ```
 */
export function runSensitivity<C extends Cell | UntilCell = Cell>(
  config: SensitivityConfig<C>,
): SensitivityResult {
  const variants = expandVariants(config);
  if (config.until !== undefined) {
    return runUntilPath(config, variants);
  }
  if (config.maxSimTime !== undefined || config.mode !== undefined) {
    throw new Error(
      'runSensitivity: `maxSimTime` / `mode` require `until` to switch the sweep to predicate-bounded mode',
    );
  }
  return runFixedTickPath(
    config as unknown as SensitivityConfig<Cell>,
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
function expandVariants<C extends Cell | UntilCell>(config: SensitivityConfig<C>): Variant<C>[] {
  const out: Variant<C>[] = [...(config.variants ?? [])];
  const axes = config.axes;
  if (!axes || axes.length === 0) return out;

  type AxisEntry = { axisName: string; value: unknown; patch: SweepAxis<unknown, C>['patch'] };
  const product: AxisEntry[][] = [[]];
  for (const axis of axes) {
    if (axis.values.length === 0) continue;
    const next: AxisEntry[][] = [];
    for (const prefix of product) {
      for (const value of axis.values) {
        next.push([...prefix, { axisName: axis.name, value, patch: axis.patch }]);
      }
    }
    product.length = 0;
    product.push(...next);
  }
  if (product.length === 1 && product[0].length === 0) return out;

  for (const combo of product) {
    const name = combo.map((e) => `${e.axisName}=${String(e.value)}`).join(' × ');
    out.push({
      name,
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
  config: SensitivityConfig<Cell>,
  variants: Variant<Cell>[],
): SensitivityResult {
  const variantCells: Cell[] = variants.map((v) => ({ ...v.patch(config.baseline), name: v.name }));
  const cells: Cell[] = [config.baseline, ...variantCells];
  const matrix = runMatrix({
    cells,
    seeds: config.seeds,
    onRunComplete: config.onRunComplete,
    onCellComplete: config.onCellComplete,
    aggregate: config.aggregate,
  });
  const baselineResult = matrix.cells[0];
  const variantResults: SensitivityVariantResult[] = variants.map((v, i) => {
    const cell = matrix.cells[i + 1];
    return { name: v.name, cell, deltas: diffAggregates(cell.aggregate, baselineResult.aggregate) };
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
  config: SensitivityConfig<C>,
  variants: Variant<C>[],
): SensitivityResult {
  if (config.maxSimTime === undefined) {
    throw new Error('runSensitivity: predicate-bounded mode requires `maxSimTime`');
  }
  const untilBaseline = config.baseline as unknown as UntilCell;
  const untilVariants = variants as unknown as Variant<UntilCell>[];
  const variantCells: UntilCell[] = untilVariants.map((v) => ({
    ...v.patch(untilBaseline),
    name: v.name,
  }));
  const cells: UntilCell[] = [untilBaseline, ...variantCells];
  const matrix = runMatrixUntil({
    cells,
    seeds: config.seeds,
    until: config.until!,
    maxSimTime: config.maxSimTime,
    onRunComplete: config.onRunComplete as never,
    onCellComplete: config.onCellComplete,
    aggregate: config.aggregate,
    mode: config.mode,
    bisectTolSec: config.bisectTolSec,
    stasisProbeInterval: config.stasisProbeInterval,
  });
  const baselineResult = matrix.cells[0];
  const variantResults: SensitivityVariantResult[] = variants.map((v, i) => {
    const cell = matrix.cells[i + 1];
    return { name: v.name, cell, deltas: diffAggregates(cell.aggregate, baselineResult.aggregate) };
  });
  return { baseline: baselineResult, variants: variantResults };
}
