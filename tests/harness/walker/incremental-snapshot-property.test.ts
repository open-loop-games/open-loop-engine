/**
 * Property test for {@link createIncrementalSnapshot}.
 *
 * A seeded RNG generates random mutation sequences against the shared mixed
 * engine fixture (one category per walker leaf, challenge gates on every dep
 * axis). Accessor mutations are followed by a targeted `invalidate*` call on
 * the axis that changed; entity mutations (levels, resets, challenge entry
 * and completions) by none, since the cache reads gating state itself. After
 * each step `inc.rebuild()` is asserted deep-equal to a fresh
 * `createTransitionSnapshot(...)` call.
 *
 * Catches invalidation gaps the scripted equivalence suite misses: scripted
 * sequences can only probe shapes the author thought of, whereas random
 * sequences cross compound mutation orderings (a-b-a, b-c-a-b, etc.) and
 * are the honest stress test for the selective-rebuild path.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { resetAllPersistentContexts } from '@/core/persistence';
import { createSeededRNG } from '@/primitives/rng';
import { createTransitionSnapshot, createIncrementalSnapshot } from '@/harness/walker';
import {
  buildMixedEngine,
  expectSnapshotsEquivalent,
  mutableAccessor,
  type MutableAccessorConfig,
} from './incremental-snapshot-fixture';

beforeEach(() => {
  resetAllPersistentContexts();
});

type Fixture = ReturnType<typeof buildMixedEngine>;

type MutationAxis = 'resource' | 'rate' | 'unlock' | 'state' | 'entity';

interface Mutation {
  axis: MutationAxis;
  key: string;
  apply: (config: MutableAccessorConfig, fixture: Fixture) => void;
}

// Candidate mutations. Accessor keys span every id the fixture's gates and
// costs read; entity mutations move each leaf's gating state. Random values
// cover both equal-to-last (no-op) and strictly-different.
function makeMutationPool(rng: () => number): Mutation[] {
  const resourceKeys = ['gold', 'gems'];
  const rateKeys = ['gold', 'gems'];
  const unlockKeys = ['bronze-unlock', 'silver-unlock'];
  const stateKeys = ['trial.seen', 'trial.retired'];
  const pool: Mutation[] = [];
  for (const key of resourceKeys) {
    pool.push({
      axis: 'resource',
      key,
      apply: (c) => {
        c.resources[key] = Math.floor(rng() * 2000);
      },
    });
  }
  for (const key of rateKeys) {
    pool.push({
      axis: 'rate',
      key,
      apply: (c) => {
        c.rates[key] = Math.floor(rng() * 20);
      },
    });
  }
  for (const key of unlockKeys) {
    pool.push({
      axis: 'unlock',
      key,
      apply: (c) => {
        c.unlocks[key] = rng() < 0.5;
      },
    });
  }
  for (const key of stateKeys) {
    pool.push({
      axis: 'state',
      key,
      apply: (c) => {
        c.state[key] = rng() < 0.5;
      },
    });
  }
  for (const id of ['slow', 'fast']) {
    pool.push({
      axis: 'entity',
      key: `upgrades.${id}`,
      apply: (_c, f) => {
        f.upgrades.getPurchasable(id)!.amount.value = rng() < 0.5 ? 0 : 1;
      },
    });
  }
  pool.push({
    axis: 'entity',
    key: 'upgrades.limit',
    apply: (_c, f) => {
      f.upgradeLimit.value = 1 + Math.floor(rng() * 3);
    },
  });
  for (const id of ['wheat', 'mill']) {
    pool.push({
      axis: 'entity',
      key: `farms.${id}`,
      apply: (_c, f) => {
        f.buildings.getProducer(id)!.repeatable!.amount.value = Math.floor(rng() * 3);
      },
    });
  }
  for (const id of ['bronze', 'silver']) {
    pool.push({
      axis: 'entity',
      key: `trials.${id}.active`,
      apply: (_c, f) => {
        const challenge = f.trials.getChallenge(id)!;
        challenge.active.value = !challenge.active.value;
      },
    });
    pool.push({
      axis: 'entity',
      key: `trials.${id}.completions`,
      apply: (_c, f) => {
        f.trials.getChallenge(id)!.completions.value = Math.floor(rng() * 3);
      },
    });
  }
  return pool;
}

function applyMutation(
  mutation: Mutation,
  config: MutableAccessorConfig,
  fixture: Fixture,
  inc: ReturnType<typeof createIncrementalSnapshot>,
): void {
  mutation.apply(config, fixture);
  switch (mutation.axis) {
    case 'resource':
      inc.invalidateResource(mutation.key);
      break;
    case 'rate':
      inc.invalidateRate(mutation.key);
      break;
    case 'unlock':
      inc.invalidateUnlock(mutation.key);
      break;
    case 'state':
      inc.invalidateState(mutation.key);
      break;
    case 'entity':
      break;
  }
}

describe('createIncrementalSnapshot — random-mutation equivalence', () => {
  // Multiple seeds exercise different mutation orderings. 6 seeds × 60 steps
  // = 360 rebuilds per run — well inside vitest's default timeout and
  // meaningfully broader coverage than the scripted equivalence suite.
  const SEEDS = [1, 2, 3, 17, 42, 99];
  const STEPS_PER_SEED = 60;

  for (const seed of SEEDS) {
    it(`equivalent across ${STEPS_PER_SEED} random mutations (seed ${seed})`, () => {
      const rng = createSeededRNG(seed);
      const { accessor, config } = mutableAccessor({
        resources: { gold: 0, gems: 0 },
        rates: { gold: 2, gems: 1 },
        unlocks: { 'bronze-unlock': false, 'silver-unlock': false },
        state: { 'trial.seen': false, 'trial.retired': false },
      });
      const fixture = buildMixedEngine(`inc-property-${seed}`, accessor);
      const { engine } = fixture;
      const inc = createIncrementalSnapshot(engine, accessor);
      const pool = makeMutationPool(rng);

      expectSnapshotsEquivalent(inc, engine, accessor, `seed ${seed} initial`);

      for (let step = 0; step < STEPS_PER_SEED; step++) {
        const mutation = pool[Math.floor(rng() * pool.length)]!;
        applyMutation(mutation, config, fixture, inc);
        expectSnapshotsEquivalent(
          inc,
          engine,
          accessor,
          `seed ${seed} step ${step} axis=${mutation.axis} key=${mutation.key}`,
        );
      }
    });
  }

  it('a missed invalidation stays stale until invalidateAll recovers it', () => {
    const { accessor, config } = mutableAccessor({
      resources: { gold: 0, gems: 0 },
      rates: { gold: 2, gems: 1 },
      unlocks: { 'bronze-unlock': false },
      state: { 'trial.seen': false },
    });
    const { engine } = buildMixedEngine('inc-property-recovery', accessor);
    const inc = createIncrementalSnapshot(engine, accessor);
    const before = inc.rebuild();

    // Dep-slot moves that flip no gate: the rates feed every distance, but
    // only an unrelated id is invalidated, so the selective path keeps the
    // cached entries.
    config.rates.gold = 7;
    config.rates.gems = 3;
    inc.invalidateUnlock('silver-unlock');
    const stale = inc.rebuild();
    expect(stale.all).toEqual(before.all);
    expect(stale.all).not.toEqual(createTransitionSnapshot(engine, accessor).all);

    inc.invalidateAll();
    expectSnapshotsEquivalent(inc, engine, accessor, 'post-invalidateAll-recovery');
  });
});
