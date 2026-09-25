// A consumer typechecked against the built dist, which the package's own
// `exports` resolves `@open-loop/engine` to. Run by `pnpm check:nodenext`
// under both `nodenext` and `bundler` resolution, after `pnpm build`.
import { Decimal, createResource, type DecimalSource } from '@open-loop/engine';

const cost = new Decimal(10);
const doubled: Decimal = Decimal.mul(cost, 2);
const source: DecimalSource = doubled;
const gold = createResource(source, { id: 'gold' });

// @ts-expect-error — goes unused, failing the check, if `Decimal` degrades to `any`
const n: number = doubled;

export { gold, n };
