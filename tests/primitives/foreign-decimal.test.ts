/**
 * Foreign Decimals — a dev build warns when a Decimal from a second
 * break_eternity copy reaches the engine, which reads it as 0.
 *
 * Under vitest the engine loads break_eternity's `main` build, so its ESM
 * build is a second class, as a consumer's is under vite-node. The warning is
 * once per foreign class, so each test below brings its own class.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error — break_eternity types its package root, not this file
import ForeignDecimal from 'break_eternity.js/dist/break_eternity.esm.js';
import { Decimal, bn, toFinalDecimal } from '@/primitives/decimal';
import { addResource, createResource, hasResource } from '@/core/resource';
import { createModifierChain, createMultiplicativeModifier } from '@/core/modifier';

/** An instance of a fresh Decimal-shaped class, so its warning is not spent yet. */
function foreignInstance(): Decimal {
  class Foreign {
    sign = 1;
    layer = 0;
    mag = 5;
  }
  return new Foreign() as unknown as Decimal;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('a Decimal from a second break_eternity copy', () => {
  it('warns once when a modifier chain applies to it', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(ForeignDecimal).not.toBe(Decimal);
    const chain = createModifierChain('foreign-apply');
    chain.add(createMultiplicativeModifier({ multiplier: 2 }));

    chain.apply(new ForeignDecimal(5));
    chain.apply(new ForeignDecimal(7));

    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]![0]).toContain("import { Decimal } from '@open-loop/engine'");
    expect(warn.mock.calls[0]![0]).toContain("ssr: { noExternal: ['@open-loop/engine'] }");
  });

  it('warns when an empty modifier chain applies to it', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    createModifierChain('foreign-empty').apply(foreignInstance());

    expect(warn).toHaveBeenCalledOnce();
  });

  it('warns when bn coerces it', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    bn(foreignInstance());

    expect(warn).toHaveBeenCalledOnce();
  });

  it('warns when a resource is added to, checked or written with it', () => {
    const gold = createResource(bn(10), { id: 'Gold', displayName: 'Gold' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    addResource(gold, foreignInstance());
    hasResource(gold, foreignInstance());
    gold.value = foreignInstance();
    addResource(gold, 1);

    expect(warn).toHaveBeenCalledTimes(3);
  });

  it('stays silent for an engine Decimal, a number, a string and a non-Decimal object', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    Decimal.add(bn(1), 2);
    Decimal.mul('3', 4);
    toFinalDecimal(5);
    bn('1e400');
    Decimal.add({ value: 1 } as unknown as Decimal, 1);

    expect(warn).not.toHaveBeenCalled();
  });
});

describe('in a production build', () => {
  // Reloading the module patches break_eternity's statics again, over the dev
  // build's, so only `bn` and `toFinalDecimal` show the production gate here.
  it('checks nothing', async () => {
    vi.stubEnv('DEV', false);
    vi.resetModules();
    const prod = await import('@/primitives/decimal');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    prod.bn(foreignInstance());
    prod.toFinalDecimal(foreignInstance());

    expect(warn).not.toHaveBeenCalled();
  });
});
