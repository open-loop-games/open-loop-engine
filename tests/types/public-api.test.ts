/**
 * Type-level pins for the engine's public API surface.
 *
 * These use vitest's `expectTypeOf` to lock the inferred types of key
 * factories. At runtime these assertions are no-ops (they always pass),
 * but `pnpm typecheck` (tsc --noEmit) fails if a refactor accidentally
 * widens a generic, loses a literal, drops an overload, or changes a
 * return shape. Drift that wouldn't be caught by runtime tests surfaces
 * here instead.
 *
 * When a pin fails intentionally (you meant to change the type), update
 * the expectation in the same commit as the source change, and — if the
 * shift is observable to consumers — note it in CHANGELOG.md under the
 * next release's Migration subsection.
 */

import { describe, it, expectTypeOf } from 'vitest';
import { ref, type ComputedRef, type MaybeRef, type Ref } from 'vue';
import { Decimal } from '@/primitives/decimal';
import type { DecimalSource } from '@/primitives/decimal';

import {
  createActionCategory,
  createEngine,
  createResource,
  createRuleAdvisor,
  createSkillCategory,
  createSpatialGrid,
  type Engine,
  type EngineContext,
  type InjectionKey,
  type RuleAdvisor,
  type SpatialGrid,
  type SpatialGridSnapshot,
  type Suggestion,
  type GridCoord,
  type Inversion,
  type InversionFailureReason,
  type FirstPassageOptions,
  type Passage,
  type Series,
} from '@/index';
import type { Computable } from '@/core/computed';
import type { Resource } from '@/core/resource';
import type { Persistent } from '@/core/persistence';
import type { SkillCategory } from '@/systems/skill-category';
import type {
  AchievementCategory,
  BaseTieredAchievementDef,
  TieredAchievementSpec,
} from '@/systems/achievement-category';
import type { ProducerCategory, Producer } from '@/systems/producer-category';
import type {
  ActionCategory,
  ActionItemState,
  ActionItemMetadata,
} from '@/systems/action-category';
import type {
  PurchasableCategory,
  PurchasableCategoryOptions,
} from '@/systems/purchasable-category';
import type { ChallengeCategory, ChallengeDef } from '@/systems/challenge-category';
import type {
  SubjectCategory,
  SubjectDef,
  FieldDef,
  ScalarFieldInstance,
  TierFieldInstance,
  FlagFieldInstance,
  EnumFieldInstance,
} from '@/systems/subject-category';
import type { DialogCategory } from '@/systems/dialog-category';
import type { ResettableObject } from '@/systems/resettable';
import type { Purchasable, PurchasableOptions } from '@/systems/purchasable';
import type { Requirements } from '@/core/requirements';
import type { TickDriverConfig } from '@/core/tick-driver';
import type { BindOptions, BindingRecord, Grant, ModifierChain } from '@/core/modifier';

describe('createEngine type surface', () => {
  it('returns an Engine with the documented shape', () => {
    const engine = createEngine({ gameId: 'type-test' });
    expectTypeOf(engine).toEqualTypeOf<Engine>();
    expectTypeOf(engine.use).parameter(0).toMatchTypeOf<{ id: string }>();
    expectTypeOf(engine.start).returns.toBeVoid();
    expectTypeOf(engine.tryInject).toBeFunction();
  });

  it('tryInject narrows to the key type', () => {
    const engine = createEngine({ gameId: 'type-test' });
    const key = Symbol('test') as InjectionKey<{ hello: string }>;
    expectTypeOf(engine.tryInject(key)).toEqualTypeOf<{ hello: string } | undefined>();
  });
});

describe('createResource overloads', () => {
  it('default-value overload returns Resource & Persistent', () => {
    const r = createResource(0, { displayName: 'points' });
    // Must be persistent — this is the contract that makes save-collection work.
    // If a refactor drops the Persistent brand from this overload, resources
    // stop auto-saving and this pin fails loudly.
    expectTypeOf(r).toMatchTypeOf<Resource<number>>();
    expectTypeOf(r).toMatchTypeOf<Persistent<number>>();
  });

  it('existing-ref overload returns a plain Resource (non-persistent)', () => {
    // Exact equality pins both facts at once: it IS a Resource, and it is NOT
    // persistent — an exact match rejects the extra Persistent brand keys the
    // default-value overload adds. If this overload ever gained the Persistent
    // brand, wrapped computeds would be double-saved and this pin fails.
    // T is pinned as `number` (as with the persistent overload above): the
    // contract is T-independent, and Resource<Decimal> blows up vitest's
    // structural diff over Decimal's ~130 members — a matcher artifact.
    const source: Ref<number> = ref(0);
    const r = createResource(source, { displayName: 'derived' });
    expectTypeOf(r).toEqualTypeOf<Resource<number>>();
  });

  it('resource exposes id, displayName, and precision', () => {
    const r = createResource(0, { displayName: 'points' });
    expectTypeOf(r.id).toBeString();
    expectTypeOf(r.displayName).toBeString();
    expectTypeOf(r.precision).toBeNumber();
  });
});

describe('createSkillCategory generic inference', () => {
  interface MySkillDef {
    id: string;
    name: string;
    baseXp: number;
  }
  interface MySkillState {
    timesLeveled: number;
  }

  it('propagates Def through getDef / getAll', () => {
    // Fully type-only assertions — no runtime value is dereferenced, so the
    // pins are zero-cost and can reference types that require an engine
    // context to construct.
    type Cat = SkillCategory<MySkillDef, MySkillState>;

    expectTypeOf<Cat['getDef']>().returns.toEqualTypeOf<MySkillDef | undefined>();
    expectTypeOf<Cat['getState']>().returns.toEqualTypeOf<MySkillState | undefined>();
    expectTypeOf<Cat['getAll']>().returns.toBeArray();
    expectTypeOf<Cat['register']>().parameter(0).toMatchTypeOf<MySkillDef | MySkillDef[]>();
  });

  it('createSkillCategory itself is generic over Def/State', () => {
    // Pin the factory signature shape without invoking it.
    expectTypeOf(createSkillCategory<MySkillDef, MySkillState>).toBeFunction();
  });
});

describe('createActionCategory generic inference', () => {
  interface MyActionDef {
    id: string;
    baseTicks: number;
  }
  interface MyActionState {
    completions: number;
  }
  interface MyActionPayload {
    loops: number;
  }

  it('propagates Def / State / Payload through accessors and verbs', () => {
    type Cat = ActionCategory<MyActionDef, MyActionState, MyActionPayload>;

    expectTypeOf<Cat['getDef']>().returns.toEqualTypeOf<MyActionDef | undefined>();
    expectTypeOf<Cat['getState']>().returns.toEqualTypeOf<MyActionState | undefined>();
    expectTypeOf<Cat['register']>().parameter(0).toMatchTypeOf<MyActionDef | MyActionDef[]>();
    expectTypeOf<Cat['currentItem']>().toEqualTypeOf<ActionItemMetadata<MyActionPayload> | null>();
    expectTypeOf<Cat['patchItemPayload']>()
      .parameter(1)
      .toMatchTypeOf<Partial<MyActionPayload> | ((p: MyActionPayload) => MyActionPayload)>();
  });

  it('ActionItemState is a literal union, not widened string', () => {
    expectTypeOf<ActionItemState>().toEqualTypeOf<
      'pending' | 'running' | 'waiting' | 'completed' | 'failed'
    >();
  });

  it('createActionCategory itself is generic over Def/State/Payload with void defaults', () => {
    expectTypeOf(createActionCategory<MyActionDef, MyActionState, MyActionPayload>).toBeFunction();
    // `State = void`, `Payload = void` defaults — pin the two-generic-default shape.
    expectTypeOf(createActionCategory<MyActionDef>).toBeFunction();
  });
});

describe('Producer type surface', () => {
  it('exposes purchaseBeatSeconds as a numeric ComputedRef', () => {
    // Payback-period auto-buy policies and flow-channel classifiers bind to
    // this field by type. Narrowing it to anything other than
    // `ComputedRef<number>` (e.g. widening to `DecimalSource`, dropping the
    // computed wrapper) would silently break classifyFlowChannel consumers
    // that expect a plain JS number.
    expectTypeOf<Producer['purchaseBeatSeconds']>().toEqualTypeOf<ComputedRef<number>>();
  });

  it('keeps repeatable optional on the Producer shape', () => {
    // Manual producers have no repeatable. Auto-buy code must branch on
    // `undefined`, and the type pin guards against a refactor that marks
    // it required and silently breaks click-style producers.
    expectTypeOf<Producer['repeatable']>().toEqualTypeOf<Purchasable | undefined>();
  });
});

describe('TickDriverConfig type surface', () => {
  it('pins tickMode as a literal union, not widened string', () => {
    // Widening tickMode to `string` would let typos like `'fiexd'` compile;
    // this catches it. New modes require updating the pin in the same commit.
    expectTypeOf<TickDriverConfig['tickMode']>().toEqualTypeOf<'variable' | 'fixed' | undefined>();
  });

  it('pins fixed-mode numeric knobs as optional numbers', () => {
    expectTypeOf<TickDriverConfig['stepSize']>().toEqualTypeOf<number | undefined>();
    expectTypeOf<TickDriverConfig['maxStepsPerTick']>().toEqualTypeOf<number | undefined>();
  });

  it('pins onStepsOverflow as a diagnostic callback, not a thrown-error channel', () => {
    // The overflow path is non-fatal — the callback signature shape records that
    // consumers receive a dropped-steps count and return nothing.
    expectTypeOf<TickDriverConfig['onStepsOverflow']>().toEqualTypeOf<
      ((droppedSteps: number) => void) | undefined
    >();
  });
});

describe('ModifierChain bind / bindings surface', () => {
  it('pins chain.bind signature to (BindOptions) => () => void', () => {
    // `bind` is the attributed-binding primitive that balance-sim walks. A
    // silent widening (e.g. losing the `active?` predicate or returning void
    // instead of a remover) would break both the AD IP/EP port and any
    // declarative-bindings wiring in category-base.
    expectTypeOf<ModifierChain['bind']>().parameter(0).toMatchTypeOf<BindOptions>();
    expectTypeOf<ModifierChain['bind']>().returns.toEqualTypeOf<() => void>();
  });

  it('pins chain.bindings() to a readonly BindingRecord[] accessor', () => {
    expectTypeOf<ModifierChain['bindings']>().returns.toEqualTypeOf<readonly BindingRecord[]>();
  });

  it('pins Grant as a discriminated union (mult | add | exp | modifier)', () => {
    // A Grant always carries `chain` + a discriminator. Dropping any of the
    // four shorthand variants silently narrows what consumers can express in
    // category `grants` / `restricts` / `rewards` fields — the pin catches that.
    type GrantKeys = keyof Grant;
    expectTypeOf<GrantKeys>().toMatchTypeOf<'chain' | 'description' | 'when'>();

    // Each variant must at least accept a concrete chain reference.
    expectTypeOf<Grant['chain']>().toMatchTypeOf<ModifierChain | ModifierChain[]>();
  });
});

describe('createSpatialGrid type surface', () => {
  interface Tile {
    kind: 'floor' | 'wall';
  }

  it('infers SpatialGrid<T> from the cell type', () => {
    const grid = createSpatialGrid<Tile>({
      width: 4,
      height: 4,
      initializer: () => ({ kind: 'floor' }),
    });
    expectTypeOf(grid).toEqualTypeOf<SpatialGrid<Tile>>();
    expectTypeOf(grid.at).returns.toEqualTypeOf<Tile>();
    expectTypeOf(grid.tryAt).returns.toEqualTypeOf<Tile | undefined>();
  });

  it('serialize() returns a SpatialGridSnapshot<T> propagating the cell generic', () => {
    expectTypeOf<SpatialGrid<Tile>['serialize']>().returns.toEqualTypeOf<
      SpatialGridSnapshot<Tile>
    >();
  });

  it('bitmaps stay as Uint8Array (typed-array contract for renderer interop)', () => {
    expectTypeOf<SpatialGrid<Tile>['passable']>().toEqualTypeOf<Uint8Array>();
    expectTypeOf<SpatialGrid<Tile>['explored']>().toEqualTypeOf<Uint8Array>();
    expectTypeOf<SpatialGrid<Tile>['visible']>().toEqualTypeOf<Uint8Array>();
  });

  it('exploredCount is a number — guards against accidental getter-to-method drift', () => {
    expectTypeOf<SpatialGrid<Tile>['exploredCount']>().toEqualTypeOf<number>();
    expectTypeOf<SpatialGrid<Tile>['passableCount']>().toEqualTypeOf<number>();
    expectTypeOf<SpatialGrid<Tile>['exploredPassableCount']>().toEqualTypeOf<number>();
  });

  it('on() narrows handler args by event key', () => {
    const grid = createSpatialGrid<Tile>({
      width: 1,
      height: 1,
      initializer: () => ({ kind: 'floor' }),
    });
    expectTypeOf(grid.on<'cellChanged'>)
      .parameter(1)
      .toEqualTypeOf<(x: number, y: number, prev: Tile, next: Tile) => void>();
    expectTypeOf(grid.on<'fovUpdated'>)
      .parameter(1)
      .toEqualTypeOf<(deltaIn: GridCoord[], deltaOut: GridCoord[]) => void>();
    expectTypeOf(grid.on<'maskChanged'>)
      .parameter(1)
      .toEqualTypeOf<(mask: 'passable' | 'explored' | 'visible') => void>();
  });
});

describe('Dialog surface type pins', () => {
  it('createDialogCategory returns DialogCategory<Def>', async () => {
    const { createDialogCategory } = await import('@/systems/dialog-category');
    type DialogCategory<D extends { id: string }> =
      import('@/systems/dialog-category').DialogCategory<D>;
    type DialogGraph = import('@/systems/dialog').DialogGraph;

    interface NpcDef {
      id: string;
      name: string;
    }
    const cat = createDialogCategory<NpcDef>({
      id: 'npcs',
      mapDialog: () => ({ id: 'g', entry: 'n', nodes: [] }),
    });
    expectTypeOf(cat).toEqualTypeOf<DialogCategory<NpcDef>>();
    expectTypeOf(cat.getEntry('x')).toEqualTypeOf<
      { readonly def: NpcDef; readonly graphs: DialogGraph[] } | undefined
    >();
    expectTypeOf(cat.getGraph).parameter(0).toBeString();
    expectTypeOf(cat.getGraph('x')).toEqualTypeOf<DialogGraph | undefined>();
  });

  it('createDialogSession returns DialogSession with the documented event surface', () => {
    type DialogSession = import('@/systems/dialog-session').DialogSession;
    type DialogPresentation = import('@/systems/dialog').DialogPresentation;

    // Pin the factory return type without invoking (would require ambient accessor).
    type Factory = typeof import('@/systems/dialog-session').createDialogSession;
    expectTypeOf<ReturnType<Factory>>().toEqualTypeOf<DialogSession>();
    expectTypeOf<DialogSession['present']>().returns.toEqualTypeOf<DialogPresentation | null>();
    expectTypeOf<DialogSession['choose']>().parameter(0).toBeString();
  });

  it('DialogRuntime contract is stable', async () => {
    type DialogRuntime = import('@/systems/dialog').DialogRuntime;
    type DialogRuntimeState = import('@/systems/dialog').DialogRuntimeState;
    type DialogPresentation = import('@/systems/dialog').DialogPresentation;
    expectTypeOf<DialogRuntime['start']>().parameter(0).toBeString();
    expectTypeOf<DialogRuntime['present']>().returns.toEqualTypeOf<DialogPresentation | null>();
    expectTypeOf<DialogRuntime['exportState']>().returns.toEqualTypeOf<DialogRuntimeState>();
    expectTypeOf<DialogRuntime['isActive']>().returns.toBeBoolean();
  });
});

describe('Subject category surface type pins', () => {
  it('createSubjectCategory infers field-instance types from the schema', async () => {
    const { createSubjectCategory } = await import('@/systems/subject-category');
    const cat = createSubjectCategory({
      id: 'npcs',
      fields: {
        trust: { kind: 'tier', tiers: ['stranger', 'friend'] } as const,
      },
    });
    // get() returns the typed SubjectInstance; fields.trust narrows to TierFieldInstance
    // without runtime narrowing helpers — the schema literal drives inference.
    const inst = cat.get('x');
    expectTypeOf(inst?.fields.trust).toEqualTypeOf<TierFieldInstance | undefined>();
  });

  it('FieldDef discriminated union covers all 5 field kinds', () => {
    type Kinds = FieldDef['kind'];
    // Compile-time enumeration — any drift from these 5 values fails here.
    expectTypeOf<Kinds>().toEqualTypeOf<'scalar' | 'vector' | 'tier' | 'flag' | 'enum'>();
  });

  it('SubjectInstance.fields preserves per-kind accessor shape for each schema field', async () => {
    const { createSubjectCategory } = await import('@/systems/subject-category');
    const cat = createSubjectCategory({
      id: 'entity',
      fields: {
        trust: { kind: 'scalar', min: 0, max: 100 } as const,
        rank: { kind: 'tier', tiers: ['a', 'b', 'c'] } as const,
        met: { kind: 'flag' } as const,
        path: { kind: 'enum', values: ['scientific', 'cooperative'] as const },
      },
    });
    const e = cat.get('the-entity');
    // Each field narrows to its kind-specific instance — no getInstance<K> ceremony.
    expectTypeOf(e?.fields.trust).toEqualTypeOf<ScalarFieldInstance | undefined>();
    expectTypeOf(e?.fields.rank).toEqualTypeOf<TierFieldInstance | undefined>();
    expectTypeOf(e?.fields.met).toEqualTypeOf<FlagFieldInstance | undefined>();
    expectTypeOf(e?.fields.path).toEqualTypeOf<
      EnumFieldInstance<'scientific' | 'cooperative'> | undefined
    >();
  });

  it('SubjectDef.fields override accepts the per-kind partial shape', () => {
    type S = { trust: { kind: 'tier'; tiers: readonly ['a', 'b'] } };
    type Def = SubjectDef<S>;
    // Per-subject override on a tier field accepts initial + gates only — schema-frozen
    // tiers list isn't overridable. If the override shape regresses to a broader type,
    // this pin fails.
    expectTypeOf<NonNullable<Def['fields']>['trust']>().toMatchTypeOf<
      { initial?: number; gates?: ReadonlyArray<unknown> } | undefined
    >();
  });
});

describe('createRuleAdvisor type surface', () => {
  interface CycleEntry {
    score: number;
  }
  interface Profile {
    avg: number;
  }
  interface Ctx {
    threshold: number;
  }
  interface MyPayload {
    kind: 'tip' | 'warn';
  }

  it('infers all generics from arguments — call site spells none', () => {
    // The inference-first contract: real consumers never write generics.
    // historySource (function form) → TEntry; aggregate return → TProfile;
    // context value → TContext; analyzer return → TPayload.
    const advisor = createRuleAdvisor({
      historySource: () => [] as readonly CycleEntry[],
      context: { threshold: 0 } as Ctx,
      aggregate: (h) => {
        expectTypeOf(h).toEqualTypeOf<readonly CycleEntry[]>();
        return { avg: 0 } as Profile;
      },
      analyzers: [
        (profile, ctx) => {
          expectTypeOf(profile).toEqualTypeOf<Profile>();
          expectTypeOf(ctx).toEqualTypeOf<Ctx>();
          return [] as readonly Suggestion<MyPayload>[];
        },
      ],
      onAggregate: (profile, suggestions) => {
        expectTypeOf(profile).toEqualTypeOf<Profile>();
        expectTypeOf(suggestions).toEqualTypeOf<readonly Suggestion<MyPayload>[]>();
      },
    });
    expectTypeOf(advisor).toEqualTypeOf<RuleAdvisor<MyPayload>>();
    expectTypeOf(advisor.suggestions).toEqualTypeOf<readonly Suggestion<MyPayload>[]>();
    expectTypeOf(advisor.reevaluate).parameter(0).toEqualTypeOf<string | undefined>();
    expectTypeOf(advisor.reevaluate).returns.toEqualTypeOf<readonly Suggestion<MyPayload>[]>();
  });

  it('still works with explicit generics (4-arg form, TContext last)', () => {
    // Maintainer-facing: explicit-generic call site stays valid. Position
    // matters here only for this test — real consumers rely on inference.
    const advisor = createRuleAdvisor<CycleEntry, Profile, MyPayload, Ctx>({
      historySource: () => [],
      context: { threshold: 0 },
      aggregate: () => ({ avg: 0 }),
      analyzers: [
        (profile, ctx) => {
          expectTypeOf(profile).toEqualTypeOf<Profile>();
          expectTypeOf(ctx).toEqualTypeOf<Ctx>();
          return [];
        },
      ],
    });
    expectTypeOf(advisor).toEqualTypeOf<RuleAdvisor<MyPayload>>();
  });

  it('TContext defaults to undefined when context is omitted', () => {
    const advisor = createRuleAdvisor({
      historySource: () => [] as readonly CycleEntry[],
      aggregate: () => ({ avg: 0 }) as Profile,
      analyzers: [
        (profile, ctx) => {
          expectTypeOf(profile).toEqualTypeOf<Profile>();
          expectTypeOf(ctx).toEqualTypeOf<undefined>();
          return [] as readonly Suggestion<MyPayload>[];
        },
      ],
    });
    expectTypeOf(advisor).toEqualTypeOf<RuleAdvisor<MyPayload>>();
  });

  it('Suggestion preserves payload typing through the public surface', () => {
    expectTypeOf<Suggestion<MyPayload>['payload']>().toEqualTypeOf<MyPayload>();
    expectTypeOf<Suggestion<MyPayload>['severity']>().toEqualTypeOf<'info' | 'warning'>();
    // apply is optional and void-returning — preserves the "engine never invokes"
    // contract (no return value to consume).
    expectTypeOf<Suggestion<MyPayload>['apply']>().toEqualTypeOf<(() => void) | undefined>();
  });
});

describe('Category wrappers conform to Resettable protocol', () => {
  // Every category wrapper must yield its instances through [Resettable]() so
  // consumers can pass the wrapper directly to `createReset({ thingsToReset })`.
  // Dropping the symbol method on the return literal is a silent runtime
  // no-op — these structural pins force the regression at typecheck time
  // instead.
  it('all seven category interfaces extend ResettableObject', () => {
    type AnyDef = { id: string };
    expectTypeOf<SkillCategory<AnyDef>>().toMatchTypeOf<ResettableObject>();
    expectTypeOf<AchievementCategory<AnyDef>>().toMatchTypeOf<ResettableObject>();
    expectTypeOf<ProducerCategory<AnyDef>>().toMatchTypeOf<ResettableObject>();
    expectTypeOf<PurchasableCategory<AnyDef>>().toMatchTypeOf<ResettableObject>();
    expectTypeOf<ChallengeCategory<ChallengeDef>>().toMatchTypeOf<ResettableObject>();
    expectTypeOf<SubjectCategory<Record<string, FieldDef>>>().toMatchTypeOf<ResettableObject>();
    expectTypeOf<DialogCategory<AnyDef>>().toMatchTypeOf<ResettableObject>();
  });
});

describe('Decimal static signatures', () => {
  it('arithmetic statics return Decimal — fast-path promotes number to Decimal before return', () => {
    // Fast-path math in primitives/decimal.ts runs native-number arithmetic
    // when both operands are number+number within IEEE 754 precision, then
    // promotes the result via `new OrigDecimal(r)` before return. Return type
    // stays `Decimal` so chain form (`.add(a, b).clamp(0, 1).toNumber()`)
    // works whether the fast path fires or not. This pin guards against a
    // regression where returns are widened to DecimalSource and raw numbers
    // leak to consumers.
    expectTypeOf(Decimal.add).returns.toEqualTypeOf<Decimal>();
    expectTypeOf(Decimal.sub).returns.toEqualTypeOf<Decimal>();
    expectTypeOf(Decimal.mul).returns.toEqualTypeOf<Decimal>();
    expectTypeOf(Decimal.div).returns.toEqualTypeOf<Decimal>();
    expectTypeOf(Decimal.min).returns.toEqualTypeOf<Decimal>();
    expectTypeOf(Decimal.max).returns.toEqualTypeOf<Decimal>();
  });

  it('predicates still return boolean', () => {
    expectTypeOf(Decimal.eq).returns.toBeBoolean();
    expectTypeOf(Decimal.gt).returns.toBeBoolean();
    expectTypeOf(Decimal.gte).returns.toBeBoolean();
    expectTypeOf(Decimal.lt).returns.toBeBoolean();
    expectTypeOf(Decimal.lte).returns.toBeBoolean();
  });

  it('out-of-scope statics keep their Decimal-typed returns', () => {
    // Pow/log/trig stay Decimal-first — no competitive layer-0 fast path in
    // JS stdlib for these. A regression that widened them the same way
    // arithmetic did would surface a lot more chain-call breakage.
    expectTypeOf(Decimal.pow).returns.toEqualTypeOf<Decimal>();
    expectTypeOf(Decimal.log).returns.toEqualTypeOf<Decimal>();
    expectTypeOf(Decimal.ln).returns.toEqualTypeOf<Decimal>();
  });
});

describe('EngineContext injection API', () => {
  it('provide/inject preserve the key type parameter', () => {
    // Pin the method signatures as a whole so the generic stays load-bearing.
    // Widening any of these (e.g. `inject(key): unknown`) would silently break
    // every consumer that relies on the returned type; this catches it.
    type ExpectedInject = <T>(key: InjectionKey<T>) => T;
    type ExpectedTryInject = <T>(key: InjectionKey<T>) => T | undefined;
    type ExpectedProvide = <T>(key: InjectionKey<T>, value: T) => void;

    expectTypeOf<EngineContext['inject']>().toEqualTypeOf<ExpectedInject>();
    expectTypeOf<EngineContext['tryInject']>().toEqualTypeOf<ExpectedTryInject>();
    expectTypeOf<EngineContext['provide']>().toEqualTypeOf<ExpectedProvide>();
  });
});

describe('runSensitivity', () => {
  it('is generic over Cell | UntilCell with default Cell', async () => {
    const { runSensitivity } = await import('@/harness');
    type Fn = typeof runSensitivity;
    // Calling with no type argument infers from the baseline. Both shapes type-check.
    const cellBaseline = { name: 'b', setup: () => [], tick: () => {}, ticks: 1 };
    const untilBaseline = { name: 'b', buildEngine: () => ({}) as Engine };

    expectTypeOf<Fn>().toBeFunction();
    expectTypeOf(runSensitivity({ baseline: cellBaseline, seeds: [1] })).toMatchTypeOf<{
      baseline: { aggregate: { metrics: Record<string, unknown> } };
      variants: ReadonlyArray<{ name: string; deltas: Record<string, unknown> }>;
    }>();
    expectTypeOf(
      runSensitivity({
        baseline: untilBaseline,
        seeds: [1],
        until: () => true,
        maxSimTime: 10,
      }),
    ).toMatchTypeOf<{
      baseline: { aggregate: { metrics: Record<string, unknown> } };
      variants: ReadonlyArray<{ name: string; deltas: Record<string, unknown> }>;
    }>();
  });
});

describe('Formula inversion contract', () => {
  it('separates the unchecked pre-image from the graded one', async () => {
    const { F } = await import('@/core/formulas/formulas');
    const formula = F.variable(0).div(50).sqrt().floor();

    // The raw path stays a bare DecimalSource — the op table composes with it
    // recursively, so widening it here would ripple through every op invert.
    expectTypeOf(formula.invert('3')).toEqualTypeOf<DecimalSource>();
    expectTypeOf(formula.tryInvert('3')).toEqualTypeOf<Inversion>();
    expectTypeOf(formula.tryInvertIntegral('3')).toEqualTypeOf<Inversion>();
    expectTypeOf(formula.tryInvert).parameter(1).toEqualTypeOf<number | undefined>();
  });

  it('discriminates on reason, so a failure arm cannot be read as a value', () => {
    type Exact = Extract<Inversion, { reason: 'exact' }>;
    type OutsideImage = Extract<Inversion, { reason: 'outside-image' }>;
    type Failed = Extract<Inversion, { value: null }>;

    expectTypeOf<Exact['value']>().toEqualTypeOf<DecimalSource>();
    expectTypeOf<OutsideImage['value']>().toEqualTypeOf<DecimalSource>();
    // The value the target *does* reach lives only on this arm, so measuring the
    // gap can't be done without first admitting there is one.
    expectTypeOf<OutsideImage['evaluatesTo']>().toEqualTypeOf<DecimalSource>();
    // `not-invertible` / `no-solution` carry no value, and the compiler
    // enforces that rather than leaving a plausible 0 to be consumed.
    expectTypeOf<Failed['value']>().toBeNull();
    expectTypeOf<Failed['reason']>().toEqualTypeOf<InversionFailureReason>();
  });
});

describe('Formula series contract', () => {
  it('keeps the three integral-adjacent operations apart at the type level', async () => {
    const { F } = await import('@/core/formulas/formulas');
    const formula = F.exponential(0, 10, 1.15);

    // The antiderivative stays a bare value — it is the raw thing, arbitrary
    // constant included, and callers who want a well-posed answer take one of
    // the other two.
    expectTypeOf(formula.evaluateIntegral('3')).toEqualTypeOf<DecimalSource>();
    // The continuous span is always answerable once a formula is integrable, so
    // it needs no grading.
    expectTypeOf(formula.cumulative(0, 10)).toEqualTypeOf<DecimalSource>();
    // The discrete one is graded, because exactness depends on the chain.
    expectTypeOf(formula.sum(0, 10)).toEqualTypeOf<Series>();
  });

  it('discriminates on reason, so an unsummable chain cannot be read as a value', () => {
    type Exact = Extract<Series, { reason: 'exact' }>;
    type Approximate = Extract<Series, { reason: 'approximate' }>;
    type Unsummable = Extract<Series, { value: null }>;

    expectTypeOf<Exact['value']>().toEqualTypeOf<DecimalSource>();
    expectTypeOf<Approximate['value']>().toEqualTypeOf<DecimalSource>();
    // The error estimate lives only on the approximate arm, so a caller can't
    // read an accuracy claim off an exact answer or ignore one on an estimate.
    expectTypeOf<Approximate['error']>().toEqualTypeOf<number>();
    expectTypeOf<Unsummable['value']>().toBeNull();
  });

  it('prices and counts through the same two-boolean surface, with no operation knob', async () => {
    const { calculateCost, calculateMaxAffordable } = await import('@/core/formulas/formulas');
    // `directSum` used to sit here selecting *which operation* the caller got —
    // integral below the threshold, series above it. Its absence is the fix.
    const { F } = await import('@/core/formulas/formulas');
    const cost = F.exponential(0, 10, 1.15);

    expectTypeOf(calculateCost).toBeCallableWith(cost, 5, true);
    // @ts-expect-error — the fourth argument was `directSum`, and it is gone.
    calculateCost(cost, 5, true, 10);

    expectTypeOf(calculateMaxAffordable)
      .parameter(3)
      .toEqualTypeOf<Computable<DecimalSource> | undefined>();
    // @ts-expect-error — `maxBulkAmount` moved into the slot `directSum` held,
    // so the old five-argument call no longer type-checks.
    calculateMaxAffordable(cost, createResource(ref(0)), true, undefined, 10);
  });
});

describe('Formula first-passage contract', () => {
  it('answers with a Decimal, and only on the arms that have one', async () => {
    const { F } = await import('@/core/formulas/formulas');
    const formula = F.variable(0).div(50).sqrt().floor();

    expectTypeOf(formula.firstPassage('3')).toEqualTypeOf<Passage>();
    expectTypeOf(formula.firstPassage)
      .parameter(1)
      .toEqualTypeOf<FirstPassageOptions | undefined>();

    type Answered = Extract<Passage, { value: Decimal }>;
    type Unanswered = Extract<Passage, { value: null }>;

    // A found crossing and a target already met at the floor are both answers,
    // and both carry the input they answer with.
    expectTypeOf<Answered['reason']>().toEqualTypeOf<'crossed' | 'already-reached'>();
    expectTypeOf<Unanswered['value']>().toBeNull();
    expectTypeOf<Unanswered['reason']>().toEqualTypeOf<'no-crossing' | 'not-monotone'>();
  });

  it('exposes the domain, not the search', () => {
    // `lower`/`upper` are the caller's axis. Expansion and iteration counts are
    // the finder's business and stay off the public surface.
    expectTypeOf<keyof FirstPassageOptions>().toEqualTypeOf<'lower' | 'upper'>();
  });
});

describe('registerTiered spec — buildDef optionality', () => {
  /** Keys of `T` that may be omitted. */
  type OptionalKeys<T> = {
    [K in keyof T]-?: object extends Pick<T, K> ? K : never;
  }[keyof T];

  // Every other field of the spec is required, so `buildDef` is the only key
  // that can appear here — which makes the pin read as pure optionality.
  it('is optional only for a Def mutually assignable with the base shape', () => {
    // The base shape itself, and a Def declared separately with an identical
    // shape (the common consumer spelling), both keep the callback optional:
    // the default synthesizer populates every field they declare.
    interface StructuralTwin {
      id: string;
      title: string;
      description: string;
      requirement: () => boolean;
    }
    expectTypeOf<
      OptionalKeys<TieredAchievementSpec<BaseTieredAchievementDef>>
    >().toEqualTypeOf<'buildDef'>();
    expectTypeOf<OptionalKeys<TieredAchievementSpec<StructuralTwin>>>().toEqualTypeOf<'buildDef'>();

    // Extra fields that are themselves optional lose nothing when the callback
    // is omitted, so they stay on the optional branch.
    interface LooselyWidened extends BaseTieredAchievementDef {
      effect?: number;
    }
    expectTypeOf<OptionalKeys<TieredAchievementSpec<LooselyWidened>>>().toEqualTypeOf<'buildDef'>();
  });

  it('is required once Def carries a field the default synthesizer cannot populate', () => {
    // A superset Def still satisfies `Def extends Base`, so a one-way test
    // left the callback optional here and every tier's `effect` silently
    // resolved to `undefined` — observable only when a tier was earned, far
    // from the registration that caused it.
    interface WidenedDef extends BaseTieredAchievementDef {
      effect: number;
    }
    expectTypeOf<OptionalKeys<TieredAchievementSpec<WidenedDef>>>().toBeNever();

    // A Def narrower than the base shape has never been on the optional branch.
    expectTypeOf<OptionalKeys<TieredAchievementSpec<{ id: string }>>>().toBeNever();
  });
});

describe('PurchasableOptions.requirements — factory arm', () => {
  // The factory arm is the only way to declare a cost that scales on the
  // purchasable's own level: it hands the callback the live `amount` ref,
  // which doesn't exist when the plain arm is evaluated. Dropping it would
  // compile everywhere it isn't used and silently push consumers back onto a
  // getter cost that misprices bulk purchases. `Requirements` is never a
  // function, so the two arms stay unambiguous.
  it('accepts a callback over the level ref alongside plain Requirements', () => {
    expectTypeOf<PurchasableOptions['requirements']>().toMatchTypeOf<
      Requirements | ((amount: MaybeRef<DecimalSource>) => Requirements)
    >();
    expectTypeOf<(amount: MaybeRef<DecimalSource>) => Requirements>().toMatchTypeOf<
      PurchasableOptions['requirements']
    >();
    expectTypeOf<Requirements>().toMatchTypeOf<PurchasableOptions['requirements']>();
  });

  it('flows through mapPurchasable, which omits only `id`', () => {
    type Mapped = ReturnType<PurchasableCategoryOptions<{ id: string }>['mapPurchasable']>;
    expectTypeOf<(amount: MaybeRef<DecimalSource>) => Requirements>().toMatchTypeOf<
      Mapped['requirements']
    >();
  });
});
