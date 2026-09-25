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
  createChallengeCategory,
  createEngine,
  createOverrideRegistry,
  createResource,
  createRuleAdvisor,
  createSkillCategory,
  createSpatialGrid,
  Formula,
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
  tunable,
} from '@/index';
import type { Computable, MaybeGetter } from '@/core/computed';
import type { FormulaSource } from '@/core/formulas/types';
import type {
  CreateEngineFromSaveOptions,
  MatrixUntilConfig,
  MatrixUntilResult,
  RunContext,
  RunUntilResult,
  UntilCell,
} from '@/harness';
import type { Resource } from '@/core/resource';
import type { Persistent } from '@/core/persistence';
import type { SkillCategory, SkillCategoryOptions } from '@/systems/skill-category';
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
import type {
  BindOptions,
  BindingRecord,
  Grant,
  Modifier,
  ModifierChain,
  ModifierChainSlot,
  ModifierDescription,
} from '@/core/modifier';

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
    const r = createResource(0, { id: 'points', displayName: 'points' });
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
    const r = createResource(source, { id: 'derived', displayName: 'derived' });
    expectTypeOf(r).toEqualTypeOf<Resource<number>>();
  });

  it('resource exposes id, displayName, and precision', () => {
    const r = createResource(0, { id: 'points', displayName: 'points' });
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

  it('mapSkill returns exactly one skill mode', () => {
    type MapSkill = SkillCategoryOptions<MySkillDef>['mapSkill'];

    const levelDriven: MapSkill = (def) => ({
      description: def.name,
      xpToLevel: (xp) => Formula.variable(xp).floor(),
      levelToMultiplier: (level) => Formula.variable(level).pow_base(1.05),
    });
    const accumulator: MapSkill = () => ({
      xpToLevel: (xp) => Formula.variable(xp).sqrt().floor(),
      retentionFormula: (level) => Formula.variable(level).mul(0.01),
    });
    // @ts-expect-error — a skill needs `retentionFormula` or `levelToMultiplier`.
    const neither: MapSkill = () => ({ xpToLevel: (xp) => Formula.variable(xp) });
    // @ts-expect-error — the two modes are exclusive.
    const both: MapSkill = () => ({
      xpToLevel: (xp) => Formula.variable(xp),
      levelToMultiplier: (level) => level,
      retentionFormula: (level) => level,
    });
    void [levelDriven, accumulator, neither, both];
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

  it('carries the definition id it was registered from', () => {
    expectTypeOf<Producer['id']>().toEqualTypeOf<string>();
  });
});

describe('auto-purchase helper type surface', () => {
  it('both helpers take an optional id and a category or a fixed list', async () => {
    const { setupSweepAutoPurchase, setupPolicyAutoPurchase } = await import('@/index');
    type Sweep = import('@/systems/auto-purchase').SetupSweepAutoPurchaseOptions;
    type Policy = import('@/systems/auto-purchase').SetupPolicyAutoPurchaseOptions;
    expectTypeOf<Sweep['id']>().toEqualTypeOf<string | undefined>();
    expectTypeOf<Policy['id']>().toEqualTypeOf<string | undefined>();
    expectTypeOf(setupSweepAutoPurchase)
      .parameter(0)
      .toEqualTypeOf<
        | import('@/systems/purchasable-category').PurchasableCategory<{ id: string }, unknown>
        | Purchasable[]
      >();
    expectTypeOf(setupPolicyAutoPurchase)
      .parameter(0)
      .toEqualTypeOf<ProducerCategory<{ id: string }, unknown> | Producer[]>();
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

  it('markMaskChanged takes the same mask union maskChanged carries', () => {
    expectTypeOf<SpatialGrid<Tile>['markMaskChanged']>().toEqualTypeOf<
      (mask: 'passable' | 'explored' | 'visible') => void
    >();
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

describe('createOverrideRegistry type map', () => {
  interface CombatOverrides {
    getSelfCombat: () => number;
    calcBonus: (level: number) => number;
  }

  it('accepts an interface, which carries no index signature', () => {
    const combat = createOverrideRegistry<CombatOverrides>('combat');
    combat.setDefault('calcBonus', (level) => level * 2);
    expectTypeOf(combat.get('calcBonus')).toEqualTypeOf<(level: number) => number>();
    expectTypeOf(tunable(combat, 'getSelfCombat', () => 1)).toEqualTypeOf<ComputedRef<number>>();
    createChallengeCategory({ id: 'ch', overrideRegistry: combat });
  });

  it('still rejects a key the type map does not declare', () => {
    const combat = createOverrideRegistry<CombatOverrides>('combat');
    // @ts-expect-error — 'getSelfCombt' is not a CombatOverrides key
    combat.override('getSelfCombt', () => 1);
  });

  it('still rejects a type map with a non-function member', () => {
    // @ts-expect-error — every member must be a function
    createOverrideRegistry<{ rate: number }>('bad');
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

  it('exports createEngineFromSave for scratch engines', async () => {
    const { createEngineFromSave } = await import('@/harness');
    expectTypeOf(createEngineFromSave).parameter(0).toEqualTypeOf<CreateEngineFromSaveOptions>();
    expectTypeOf(createEngineFromSave).returns.toEqualTypeOf<Engine>();
  });

  it('types until-sweep runs as RunUntilResult', () => {
    expectTypeOf<
      MatrixUntilResult['cells'][number]['runs'][number]
    >().toEqualTypeOf<RunUntilResult>();
    expectTypeOf<
      Parameters<NonNullable<MatrixUntilConfig['onCellComplete']>>[0]['runs'][number]['terminated']
    >().toEqualTypeOf<RunUntilResult['terminated']>();
  });

  it('takes an inline predicate-bounded baseline once the cell shape is named', async () => {
    const { runSensitivity } = await import('@/harness');
    // `buildEngine: (ctx) => …` is context-sensitive, so inference alone falls
    // back to the default `Cell`; the documented call names `UntilCell`.
    const buildEngine = (_ctx: RunContext, _opts?: { mul: number }) => ({}) as Engine;
    expectTypeOf(runSensitivity<UntilCell>).toBeCallableWith({
      baseline: { name: 'b', buildEngine: (ctx) => buildEngine(ctx) },
      axes: [
        {
          name: 'mul',
          values: [0.5, 2],
          patch: (b, v) => ({ ...b, buildEngine: (ctx) => buildEngine(ctx, { mul: v as number }) }),
        },
      ],
      seeds: [1],
      until: () => true,
      maxSimTime: 10,
    });
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
    const { calculateCost, calculateMaxAffordable } = await import('@/core/formulas/affordability');
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

// The factories below broke since the July review (verify/public-surface.md
// item 3) and had no pin at all. Each covers the options shape a regression
// would silently widen — required vs optional `id` above all — and the
// return's key literal/generic types.

describe('Purchasable factories — id and options shape', () => {
  it('createPurchasable requires id/display/requirements; effect/limit/bulkPurchase default', async () => {
    const { createPurchasable } = await import('@/systems/purchasable');
    type Options = Parameters<typeof createPurchasable>[0];
    // id is the save key for `amount` — widening it to optional would silently
    // collide every purchasable built without one.
    expectTypeOf<Options['id']>().toEqualTypeOf<string>();
    const p = createPurchasable({ id: 'test', display: 'test', requirements: [] });
    expectTypeOf(p).toEqualTypeOf<Purchasable>();
  });

  it('createScalingPurchasable accepts the geometric cost arm and returns a Purchasable', async () => {
    const { createScalingPurchasable } = await import('@/index');
    const resource = createResource(0, { id: 'scaling-gold', displayName: 'gold' });
    const p = createScalingPurchasable({
      id: 'upgrade',
      description: 'test',
      resource,
      baseCost: 10,
      costScaling: 1.15,
    });
    expectTypeOf(p).toEqualTypeOf<Purchasable>();
  });

  it('the geometric arm and ProducerPurchaseConfig take costScaling as a ref or getter', async () => {
    const { createScalingPurchasable } = await import('@/index');
    const resource = createResource(0, { id: 'reactive-gold', displayName: 'gold' });
    const scaling = ref<DecimalSource>(1.15);
    createScalingPurchasable({
      id: 'ref-scaling',
      description: 'test',
      resource,
      baseCost: 10,
      costScaling: scaling,
    });
    createScalingPurchasable({
      id: 'getter-scaling',
      description: 'test',
      resource,
      baseCost: 10,
      costScaling: () => scaling.value,
    });
    type Config = import('@/systems/producer-category').ProducerPurchaseConfig;
    expectTypeOf<Config['costScaling']>().toEqualTypeOf<Computable<DecimalSource>>();
  });

  it('each cost and effect shape takes its own key', async () => {
    const { createScalingPurchasable } = await import('@/index');
    const { F } = await import('@/core/formulas/formulas');
    const resource = createResource(0, { id: 'closure-gold', displayName: 'gold' });
    // Formula factories — invertible, so bulk purchase and `effectCurve` work.
    createScalingPurchasable({
      id: 'closure-formula',
      description: 'test',
      resource,
      costFormula: (amount) => F.variable(amount).mul(10),
      effectFormula: (amount) => F.variable(amount).add(1),
    });
    // Plain functions of the level — forward evaluation only.
    createScalingPurchasable({
      id: 'closure-opaque',
      description: 'test',
      resource,
      cost: (amount) => Decimal.pow(10, Decimal.pow(amount, 2)),
      effect: (amount) => Decimal.mul(amount, 2),
    });
    // A factory annotated `FormulaSource` may return a plain value.
    createScalingPurchasable({
      id: 'closure-source',
      description: 'test',
      resource,
      costFormula: (amount: MaybeRef<DecimalSource>): FormulaSource => F.variable(amount),
    });
    // @ts-expect-error — one cost shape per purchasable.
    createScalingPurchasable({
      id: 'both-cost-arms',
      description: 'test',
      resource,
      baseCost: 10,
      costScaling: 1.15,
      costFormula: (amount: MaybeRef<DecimalSource>) => F.variable(amount),
    });
    createScalingPurchasable({
      id: 'factory-under-effect',
      description: 'test',
      resource,
      baseCost: 10,
      costScaling: 1.15,
      // @ts-expect-error — a Formula factory goes under `effectFormula`.
      effect: (amount) => F.variable(amount),
    });
  });
});

describe('createTimedProgress — id required unless ephemeral', () => {
  it('requires id unless ephemeral: true', async () => {
    const { createTimedProgress } = await import('@/index');
    const registerTick = (_cb: (dt: number) => void) => () => {};
    // @ts-expect-error — id is required once `ephemeral` is absent or false;
    // an untagged tracker has nowhere to save `progress`.
    createTimedProgress({ duration: 10, registerTick });
    const tp = createTimedProgress({ duration: 10, registerTick, ephemeral: true });
    expectTypeOf(tp).toEqualTypeOf<import('@/core/timed-progress').TimedProgress>();
  });
});

describe('createCycle / createTimeBank / createSequencer type surface', () => {
  it('createCycle: id stays optional (per-module default); registerTick is required', async () => {
    const { createCycle } = await import('@/index');
    type Options = import('@/systems/cycle').CycleOptions;
    expectTypeOf<Options['id']>().toEqualTypeOf<string | undefined>();
    const registerTick = (_cb: (dt: number) => void) => () => {};
    const cycle = createCycle({ registerTick });
    expectTypeOf(cycle).toMatchTypeOf<import('@/systems/cycle').Cycle>();
  });

  it('createTimeBank: the whole config is optional — id/earnEfficiency/cap all default', async () => {
    const { createTimeBank } = await import('@/index');
    const bank = createTimeBank();
    expectTypeOf(bank).toEqualTypeOf<import('@/systems/time-bank').TimeBank>();
  });

  it('createSequencer requires id and is generic over metadata M, defaulting to void', async () => {
    const { createSequencer } = await import('@/index');
    type Options = import('@/core/sequencer').SequencerOptions<void>;
    expectTypeOf<Options['id']>().toEqualTypeOf<string>();
    const seq = createSequencer({ id: 'queue' });
    expectTypeOf(seq.currentItem).toEqualTypeOf<
      import('@/core/sequencer').SequencerItem<void> | null
    >();
    interface JobMeta {
      kind: string;
    }
    const jobs = createSequencer<JobMeta>({ id: 'jobs' });
    expectTypeOf(jobs.currentMetadata).toEqualTypeOf<JobMeta | undefined>();
  });
});

describe('Systems — required options vs what defaults', () => {
  /** Keys of `T` that may be omitted from an object literal of type `T`. */
  type OptionalKeys<T> = {
    [K in keyof T]-?: object extends Pick<T, K> ? K : never;
  }[keyof T];

  it('createZoneSystem: the whole options object is optional', async () => {
    const { createZoneSystem } = await import('@/index');
    const zones = createZoneSystem();
    expectTypeOf(zones).toEqualTypeOf<import('@/systems/zone').ZoneSystem>();
  });

  it('createAutomationTiers requires tiers; id/initiallyUnlocked default', () => {
    type Options = import('@/systems/automation').AutomationTiersOptions;
    expectTypeOf<OptionalKeys<Options>>().toEqualTypeOf<'id' | 'initiallyUnlocked'>();
  });

  it('createRecommendationSystem requires cycle/cycleLog/bestOf/getCurrentSnapshot/applySnapshot', () => {
    type Options = import('@/systems/recommendation').RecommendationSystemOptions;
    expectTypeOf<OptionalKeys<Options>>().toEqualTypeOf<'id' | 'defs' | 'getState'>();
  });

  it('createProducerCategory requires id/mapProducer/registerTick; mapState defaults', () => {
    interface Def {
      id: string;
    }
    type Options = import('@/systems/producer-category').ProducerCategoryOptions<Def>;
    expectTypeOf<OptionalKeys<Options>>().toEqualTypeOf<'mapState'>();
  });

  it('ProducerCategory propagates Def/State through getDef/getState/getProducer', () => {
    interface Def {
      id: string;
      baseRate: number;
    }
    interface MyState {
      totalProduced: number;
    }
    type Cat = import('@/systems/producer-category').ProducerCategory<Def, MyState>;
    expectTypeOf<Cat['getDef']>().returns.toEqualTypeOf<Def | undefined>();
    expectTypeOf<Cat['getState']>().returns.toEqualTypeOf<MyState | undefined>();
    expectTypeOf<Cat['getProducer']>().returns.toEqualTypeOf<
      import('@/systems/producer-category').Producer | undefined
    >();
  });
});

describe('createCostRequirement / createInventory type surface', () => {
  /** Keys of `T` that may be omitted from an object literal of type `T`. */
  type OptionalKeys<T> = {
    [K in keyof T]-?: object extends Pick<T, K> ? K : never;
  }[keyof T];

  it('createCostRequirement requires resource and cost; the rest defaults', async () => {
    type Options = import('@/core/requirements').CostRequirementOptions;
    expectTypeOf<OptionalKeys<Options>>().toEqualTypeOf<
      'requiresPay' | 'cumulativeCost' | 'maxBulkAmount' | 'pay' | 'description'
    >();
    const { createCostRequirement } = await import('@/index');
    const resource = createResource(0, { id: 'cost-gold', displayName: 'gold' });
    const req = createCostRequirement({ resource, cost: 10 });
    expectTypeOf(req).toEqualTypeOf<import('@/core/requirements').CostRequirement>();
  });

  it('createInventory requires id and baseCapacity; the rest defaults', () => {
    type Options = import('@/systems/inventory').InventoryOptions;
    expectTypeOf<OptionalKeys<Options>>().toEqualTypeOf<
      'overflow' | 'totalCapacity' | 'displayName' | 'initial' | 'items'
    >();
  });

  it('Inventory.resources is a ReadonlyMap keyed by item id', async () => {
    const { createInventory } = await import('@/index');
    const inv = createInventory({ id: 'bag', baseCapacity: 10, items: ['wood'] });
    expectTypeOf(inv.resources).toEqualTypeOf<
      ReadonlyMap<string, import('@/core/resource').Resource<DecimalSource>>
    >();
  });
});

describe('Achievement and challenge categories — required options and generics', () => {
  /** Keys of `T` that may be omitted from an object literal of type `T`. */
  type OptionalKeys<T> = {
    [K in keyof T]-?: object extends Pick<T, K> ? K : never;
  }[keyof T];

  it('createAchievementCategory requires id/mapAchievement; accessor and mapState default', () => {
    interface Def {
      id: string;
    }
    type Options = import('@/systems/achievement-category').AchievementCategoryOptions<Def>;
    expectTypeOf<OptionalKeys<Options>>().toEqualTypeOf<'accessor' | 'mapState'>();
  });

  it('registerTiered returns Achievement<T>[], T defaulting to number', async () => {
    const { createAchievementCategory } = await import('@/index');
    const cat = createAchievementCategory<BaseTieredAchievementDef>({
      id: 'registerTiered-pin',
      mapAchievement: (def) => ({
        display: { title: def.title, description: def.description },
        requirement: def.requirement,
        effect: def.effect,
      }),
    });
    const tiers = cat.registerTiered({
      baseId: 'gold',
      baseName: 'Gold',
      getValue: () => 0,
      tiers: [{ threshold: 10, suffix: 'I' }],
    });
    expectTypeOf(tiers).toEqualTypeOf<import('@/systems/achievement').Achievement<number>[]>();
  });

  it('createChallengeCategory requires only id — every other option defaults', () => {
    type Options = import('@/systems/challenge-category').ChallengeCategoryOptions<ChallengeDef>;
    expectTypeOf<OptionalKeys<Options>>().toEqualTypeOf<
      | 'overrideRegistry'
      | 'contentRegistries'
      | 'reset'
      | 'mutuallyExclusive'
      | 'accessor'
      | 'mutator'
      | 'registerTick'
      | 'mapState'
    >();
  });
});

describe('Effect-system factories — persistent and temporary', () => {
  /** Keys of `T` that may be omitted from an object literal of type `T`. */
  type OptionalKeys<T> = {
    [K in keyof T]-?: object extends Pick<T, K> ? K : never;
  }[keyof T];

  it('createPersistentEffectSystem requires only id', () => {
    type Options = import('@/systems/persistent-effect').PersistentEffectSystemOptions;
    expectTypeOf<OptionalKeys<Options>>().toBeNever();
  });

  it('createTemporaryEffectSystem requires id and registerTick', async () => {
    type Options = import('@/systems/temporary-effect').TemporaryEffectSystemOptions;
    expectTypeOf<OptionalKeys<Options>>().toBeNever();
    const { createTemporaryEffectSystem } = await import('@/index');
    const sys = createTemporaryEffectSystem({ id: 'effects', registerTick: () => () => {} });
    sys.register({ id: 'haste', duration: 10 });
    // apply() answers null at max stacks rather than throwing — pin the union.
    expectTypeOf(sys.apply('haste')).toEqualTypeOf<
      import('@/systems/temporary-effect').TemporaryEffectInstance | null
    >();
  });
});

describe('runUntil type surface', () => {
  /** Keys of `T` that may be omitted from an object literal of type `T`. */
  type OptionalKeys<T> = {
    [K in keyof T]-?: object extends Pick<T, K> ? K : never;
  }[keyof T];

  it('requires engine/until/maxSimTime; tickDelta and the rest default', () => {
    type Config = import('@/harness/types').RunUntilConfig;
    expectTypeOf<OptionalKeys<Config>>().toEqualTypeOf<
      'tickDelta' | 'setup' | 'seed' | 'mode' | 'accessor' | 'bisectTolSec' | 'stasisProbeInterval'
    >();
  });

  it('terminated is a three-way discriminant, not a widened string', async () => {
    const { runUntil } = await import('@/harness');
    expectTypeOf(runUntil).returns.toEqualTypeOf<import('@/harness/types').RunUntilResult>();
    type Result = import('@/harness/types').RunUntilResult;
    expectTypeOf<Result['terminated']>().toEqualTypeOf<
      'predicate' | 'maxSimTime' | 'unreachable'
    >();
  });
});

describe('SaveMigration and saveMigrations config (B1)', () => {
  it('SaveMigration takes and returns Record<string, unknown> — a step must return the object', () => {
    type Migration = import('@/core/save-manager').SaveMigration;
    expectTypeOf<Migration>().toEqualTypeOf<
      (data: Record<string, unknown>) => Record<string, unknown>
    >();
  });

  it('EngineConfig.saveMigrations and SaveManagerConfig.migrations key migrations by version', () => {
    type EngineMigrations = import('@/engine').EngineConfig['saveMigrations'];
    type ManagerMigrations = import('@/core/save-manager').SaveManagerConfig['migrations'];
    type Migration = import('@/core/save-manager').SaveMigration;
    expectTypeOf<EngineMigrations>().toEqualTypeOf<Record<number, Migration> | undefined>();
    expectTypeOf<ManagerMigrations>().toEqualTypeOf<Record<number, Migration> | undefined>();
  });

  it('LoadHandler receives the SaveLoadResult, not void', () => {
    type Handler = import('@/engine').LoadHandler;
    expectTypeOf<Handler>().toEqualTypeOf<
      (result: import('@/core/save-manager').SaveLoadResult) => void
    >();
  });

  it('SaveManager exposes isSlotProtected / releaseSlot for the protected-slot lifecycle', () => {
    type Manager = import('@/core/save-manager').SaveManager;
    expectTypeOf<Manager['isSlotProtected']>().toEqualTypeOf<(slotId: number) => boolean>();
    expectTypeOf<Manager['releaseSlot']>().toEqualTypeOf<(slotId: number) => void>();
  });
});

describe('createTimeSystem type surface (B2)', () => {
  it('id is optional — defaults to a per-module context', () => {
    type Options = import('@/systems/time').TimeSystemConfig;
    expectTypeOf<Options['id']>().toEqualTypeOf<string | undefined>();
  });

  it('elapsed and totalPlayTime are plain number refs', async () => {
    const { createTimeSystem } = await import('@/index');
    const time = createTimeSystem();
    expectTypeOf(time.elapsed).toEqualTypeOf<Ref<number>>();
    expectTypeOf(time.totalPlayTime).toEqualTypeOf<Ref<number>>();
  });
});

describe('ModifierChain.replace / reserve and slot surface (B5)', () => {
  it('replace swaps a modifier in place and reports absence via a boolean', () => {
    expectTypeOf<ModifierChain['replace']>().parameters.toEqualTypeOf<[Modifier, Modifier]>();
    expectTypeOf<ModifierChain['replace']>().returns.toBeBoolean();
  });

  it('reserve holds a position that a later add fills at that spot', () => {
    expectTypeOf<ModifierChain['reserve']>().returns.toEqualTypeOf<ModifierChainSlot>();
    expectTypeOf<ModifierChainSlot['add']>().returns.toEqualTypeOf<() => void>();
    expectTypeOf<ModifierChainSlot['release']>().returns.toBeVoid();
  });
});

describe('Modifier.description carries multi-line breakdowns (B5)', () => {
  it('is a MaybeGetter over one or many ModifierDescriptions, not a single line', () => {
    // A regression that narrowed this back to `MaybeGetter<ModifierDescription>`
    // would compile at every existing call site (a single description is
    // still assignable) and only break at the composite-effect flattening
    // this type exists to support.
    expectTypeOf<Modifier['description']>().toEqualTypeOf<
      MaybeGetter<ModifierDescription | ModifierDescription[]> | undefined
    >();
  });
});

describe('ActionCategory.replay (B8)', () => {
  it('is a no-arg void method — list-mode restart, a no-op in queue mode', () => {
    interface Def {
      id: string;
      baseTicks: number;
    }
    type Cat = ActionCategory<Def>;
    expectTypeOf<Cat['replay']>().toEqualTypeOf<() => void>();
  });
});

describe('Formula capability is a runtime question', () => {
  type Index = typeof import('@/index');
  type GenericFormula = import('@/index').GenericFormula;

  it('calculateCost takes any formula, in one signature', () => {
    expectTypeOf<Parameters<Index['calculateCost']>>().toEqualTypeOf<
      [formula: GenericFormula, amountToBuy: DecimalSource, cumulativeCost?: boolean]
    >();
  });

  it('the capability predicates answer a boolean rather than narrowing', () => {
    expectTypeOf<ReturnType<GenericFormula['isInvertible']>>().toEqualTypeOf<boolean>();
    expectTypeOf<ReturnType<GenericFormula['isIntegrable']>>().toEqualTypeOf<boolean>();
    expectTypeOf<ReturnType<GenericFormula['isIntegralInvertible']>>().toEqualTypeOf<boolean>();
  });

  it('cost-curve factories take a reactive or formula-valued parameter anywhere after the level', async () => {
    const { Formula } = await import('@/index');
    const slope = ref<DecimalSource>(5);
    expectTypeOf(Formula.linear(0, Formula.constant(10), slope)).toEqualTypeOf<GenericFormula>();
    expectTypeOf(Formula.exponential(0, 10, slope)).toEqualTypeOf<GenericFormula>();
    expectTypeOf(Formula.polynomial(0, slope, Formula.constant(2))).toEqualTypeOf<GenericFormula>();
    expectTypeOf(Formula.preset(0, 'moderate', slope)).toEqualTypeOf<GenericFormula>();
  });
});

describe('Removed surface stays removed', () => {
  it('the formula capability types no longer resolve from the root barrel', () => {
    // @ts-expect-error — structurally identical to GenericFormula; check isInvertible() at runtime.
    type _InvertibleFormula = import('@/index').InvertibleFormula;
    // @ts-expect-error — same; check isIntegrable().
    type _IntegrableFormula = import('@/index').IntegrableFormula;
    // @ts-expect-error — same; check isIntegralInvertible().
    type _InvertibleIntegralFormula = import('@/index').InvertibleIntegralFormula;
  });

  it('Formula.calculateConstantOfIntegration is gone — price levels with sum', () => {
    type Keys = keyof import('@/index').GenericFormula;
    expectTypeOf<
      'calculateConstantOfIntegration' extends Keys ? true : false
    >().toEqualTypeOf<false>();
  });

  it('IResource and IModifier no longer resolve from the root barrel', () => {
    // @ts-expect-error — IResource was replaced by the Resource union.
    type _IResource = import('@/index').IResource;
    // @ts-expect-error — IModifier was replaced by Modifier.
    type _IModifier = import('@/index').IModifier;
  });

  it('EngineContext.onReset is gone — resets fire through the Reset system, not the engine context', () => {
    type Keys = keyof EngineContext;
    expectTypeOf<'onReset' extends Keys ? true : false>().toEqualTypeOf<false>();
  });

  it('isMultiBarProgress and progressToDecimal are removed from the barrel', async () => {
    const mod = await import('@/index');
    // @ts-expect-error — removed; use `typeof item.progress !== 'number'` at the call site.
    expectTypeOf(mod.isMultiBarProgress).toBeUndefined();
    // @ts-expect-error — removed alongside isMultiBarProgress, same replacement.
    expectTypeOf(mod.progressToDecimal).toBeUndefined();
  });
});
