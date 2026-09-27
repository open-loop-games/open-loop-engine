import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ref } from 'vue';
import { createRuleAdvisor, type Suggestion } from '@/systems/rule-advisor';
import { type CycleLog, type CycleLogEntry } from '@/systems/cycle-log';

beforeEach(() => {
  // Stateless primitive — no shared persistent state to reset.
});

// ----------------------------------------------------------------------------
// CycleLog stub — covers the CycleLog branch of historySource. Function-form
// historySource is exercised directly in the function-form tests below.
// ----------------------------------------------------------------------------

function fakeLoopLog<T = CycleLogEntry>(history: T[] = []): CycleLog {
  const h = ref<T[]>(history);
  return { history: h } as unknown as CycleLog;
}

// ============================================================================
// Aggregation + analyzers + emit
// ============================================================================

describe('createRuleAdvisor — aggregate + analyzers', () => {
  it('runs aggregate on history and passes the profile to each analyzer', () => {
    const history: { value: number }[] = [{ value: 1 }, { value: 2 }, { value: 3 }];
    const advisor = createRuleAdvisor({
      historySource: () => history,
      aggregate: (h) => h.reduce((acc, e) => acc + e.value, 0),
      analyzers: [
        (sum) => [
          { key: 'sum', severity: 'info' as const, summary: `sum=${sum}`, payload: { tag: 'sum' } },
        ],
        (sum) =>
          sum > 5
            ? [
                {
                  key: 'big',
                  severity: 'warning' as const,
                  summary: 'big',
                  payload: { tag: 'big' },
                },
              ]
            : [],
      ],
    });

    const out = advisor.reevaluate();
    expect(out.map((s) => s.key)).toEqual(['big', 'sum']); // warning sorts before info
    expect(out[0]!.summary).toBe('big');
    expect(out[1]!.summary).toBe('sum=6');
  });

  it('emits an empty list when no analyzer produces a suggestion', () => {
    const advisor = createRuleAdvisor({
      historySource: () => [],
      aggregate: () => undefined,
      analyzers: [() => []],
    });
    expect(advisor.reevaluate()).toEqual([]);
    expect(advisor.suggestions).toEqual([]);
  });

  it('default rank is severity-then-registration-order', () => {
    const advisor = createRuleAdvisor({
      historySource: () => [],
      aggregate: () => undefined,
      analyzers: [
        () => [
          { key: 'i1', severity: 'info' as const, summary: '', payload: undefined },
          { key: 'w1', severity: 'warning' as const, summary: '', payload: undefined },
        ],
        () => [
          { key: 'w2', severity: 'warning' as const, summary: '', payload: undefined },
          { key: 'i2', severity: 'info' as const, summary: '', payload: undefined },
        ],
      ],
    });
    expect(advisor.reevaluate().map((s) => s.key)).toEqual(['w1', 'w2', 'i1', 'i2']);
  });
});

// ============================================================================
// historySource branches: CycleLog form and function form
// ============================================================================

describe('createRuleAdvisor — historySource branches', () => {
  it('reads from a CycleLog when historySource is a CycleLog instance', () => {
    const log = fakeLoopLog([{ value: 1 }, { value: 2 }]);
    let seen: readonly CycleLogEntry[] = [];
    const advisor = createRuleAdvisor({
      historySource: log,
      aggregate: (h: readonly CycleLogEntry[]) => {
        seen = h;
        return h.length;
      },
      analyzers: [
        (n) => [{ key: 'count', severity: 'info' as const, summary: `n=${n}`, payload: undefined }],
      ],
    });
    advisor.reevaluate();
    expect(seen.length).toBe(2);
  });

  it('calls the function on each reevaluate (no memoization)', () => {
    let calls = 0;
    const advisor = createRuleAdvisor({
      historySource: () => {
        calls++;
        return [];
      },
      aggregate: () => undefined,
      analyzers: [() => []],
    });
    advisor.reevaluate();
    advisor.reevaluate();
    advisor.reevaluate();
    expect(calls).toBe(3);
  });
});

// ============================================================================
// Custom rank + cap
// ============================================================================

describe('createRuleAdvisor — rank + maxSuggestions', () => {
  it('honors a custom rank comparator', () => {
    type P = { weight: number };
    const advisor = createRuleAdvisor({
      historySource: () => [],
      aggregate: () => undefined,
      analyzers: [
        () =>
          [
            { key: 'a', severity: 'info' as const, summary: '', payload: { weight: 1 } },
            { key: 'b', severity: 'info' as const, summary: '', payload: { weight: 5 } },
            { key: 'c', severity: 'info' as const, summary: '', payload: { weight: 3 } },
          ] satisfies readonly Suggestion<P>[],
      ],
      rank: (a, b) => b.payload.weight - a.payload.weight,
    });
    expect(advisor.reevaluate().map((s) => s.key)).toEqual(['b', 'c', 'a']);
  });

  it('caps the emitted list at maxSuggestions (number form)', () => {
    const advisor = createRuleAdvisor({
      historySource: () => [],
      aggregate: () => undefined,
      analyzers: [
        () =>
          Array.from({ length: 5 }, (_, i) => ({
            key: `k${i}`,
            severity: 'info' as const,
            summary: '',
            payload: undefined,
          })),
      ],
      maxSuggestions: 2,
    });
    expect(advisor.reevaluate().map((s) => s.key)).toEqual(['k0', 'k1']);
  });

  it('reads maxSuggestions getter on each reevaluate', () => {
    const cap = ref(1);
    const advisor = createRuleAdvisor({
      historySource: () => [],
      aggregate: () => undefined,
      analyzers: [
        () => [
          { key: 'a', severity: 'info' as const, summary: '', payload: undefined },
          { key: 'b', severity: 'info' as const, summary: '', payload: undefined },
        ],
      ],
      maxSuggestions: () => cap.value,
    });
    expect(advisor.reevaluate().map((s) => s.key)).toEqual(['a']);
    cap.value = 2;
    expect(advisor.reevaluate().map((s) => s.key)).toEqual(['a', 'b']);
  });
});

// ============================================================================
// Analyzer context (TContext)
// ============================================================================

describe('createRuleAdvisor — analyzer context', () => {
  it('threads a static context value through to every analyzer', () => {
    interface Ctx {
      threshold: number;
    }
    const advisor = createRuleAdvisor({
      historySource: () => [10],
      aggregate: (h) => h[0] ?? 0,
      context: { threshold: 5 } as Ctx,
      analyzers: [
        (sum, ctx) =>
          sum > ctx.threshold
            ? [{ key: 'over', severity: 'warning' as const, summary: 'over', payload: undefined }]
            : [],
      ],
    });
    expect(advisor.reevaluate().map((s) => s.key)).toEqual(['over']);
  });

  it('re-reads a getter context on every reevaluate', () => {
    let threshold = 100;
    const advisor = createRuleAdvisor({
      historySource: () => [10],
      aggregate: (h) => h[0] ?? 0,
      context: () => ({ threshold }),
      analyzers: [
        (sum, ctx) =>
          sum > ctx.threshold
            ? [{ key: 'over', severity: 'info' as const, summary: '', payload: undefined }]
            : [],
      ],
    });
    expect(advisor.reevaluate()).toEqual([]); // 10 < 100
    threshold = 5;
    expect(advisor.reevaluate().map((s) => s.key)).toEqual(['over']); // 10 > 5
  });

  it('passes undefined when context is omitted (TContext defaults to undefined)', () => {
    let received: unknown = 'sentinel';
    const advisor = createRuleAdvisor({
      historySource: () => [],
      aggregate: () => undefined,
      analyzers: [
        (_profile, ctx) => {
          received = ctx;
          return [];
        },
      ],
    });
    advisor.reevaluate();
    expect(received).toBeUndefined();
  });
});

// ============================================================================
// Aggregator context (TContext) — same channel the analyzers receive
// ============================================================================

describe('createRuleAdvisor — aggregator context', () => {
  it('threads a static context value through to the aggregator', () => {
    interface Ctx {
      multiplier: number;
    }
    let seenCtx: Ctx | undefined;
    const advisor = createRuleAdvisor({
      historySource: () => [1, 2, 3],
      context: { multiplier: 10 } as Ctx,
      aggregate: (h, ctx) => {
        seenCtx = ctx;
        return h.reduce((a, b) => a + b, 0) * ctx.multiplier;
      },
      analyzers: [
        (sum) => [
          { key: 'sum', severity: 'info' as const, summary: `sum=${sum}`, payload: undefined },
        ],
      ],
    });
    const out = advisor.reevaluate();
    expect(seenCtx).toEqual({ multiplier: 10 });
    expect(out[0]!.summary).toBe('sum=60');
  });

  it('re-reads a getter context on every reevaluate', () => {
    let multiplier = 1;
    const advisor = createRuleAdvisor({
      historySource: () => [5],
      context: () => ({ multiplier }),
      aggregate: (h, ctx) => (h[0] ?? 0) * ctx.multiplier,
      analyzers: [
        (n) => [{ key: 'n', severity: 'info' as const, summary: `n=${n}`, payload: undefined }],
      ],
    });
    expect(advisor.reevaluate()[0]!.summary).toBe('n=5');
    multiplier = 4;
    expect(advisor.reevaluate()[0]!.summary).toBe('n=20');
  });

  it('passes undefined when context is omitted', () => {
    let received: unknown = 'sentinel';
    const advisor = createRuleAdvisor({
      historySource: () => [],
      aggregate: (_h, ctx) => {
        received = ctx;
        return undefined;
      },
      analyzers: [() => []],
    });
    advisor.reevaluate();
    expect(received).toBeUndefined();
  });
});

// ============================================================================
// Dismissal + reset
// ============================================================================

describe('createRuleAdvisor — dismiss + reset', () => {
  it('hides a suggestion until reset and emits dismissed + suggestions', () => {
    const advisor = createRuleAdvisor({
      historySource: () => [],
      aggregate: () => undefined,
      analyzers: [
        () => [
          { key: 'a', severity: 'info' as const, summary: '', payload: undefined },
          { key: 'b', severity: 'info' as const, summary: '', payload: undefined },
        ],
      ],
    });
    advisor.reevaluate();

    const onDismissed = vi.fn();
    const onSuggestions = vi.fn();
    advisor.on('dismissed', onDismissed);
    advisor.on('suggestionsUpdated', onSuggestions);

    advisor.dismiss('a');

    expect(advisor.suggestions.map((s) => s.key)).toEqual(['b']);
    expect(onDismissed).toHaveBeenCalledWith('a');
    expect(onSuggestions).toHaveBeenCalledWith([expect.objectContaining({ key: 'b' })]);

    // Survives reevaluate
    advisor.reevaluate();
    expect(advisor.suggestions.map((s) => s.key)).toEqual(['b']);

    // reset() restores
    advisor.reset();
    advisor.reevaluate();
    expect(advisor.suggestions.map((s) => s.key)).toEqual(['a', 'b']);
  });

  it('dismiss is idempotent and silent for repeat keys', () => {
    const advisor = createRuleAdvisor({
      historySource: () => [],
      aggregate: () => undefined,
      analyzers: [() => [{ key: 'a', severity: 'info' as const, summary: '', payload: undefined }]],
    });
    advisor.reevaluate();

    const onDismissed = vi.fn();
    advisor.on('dismissed', onDismissed);
    advisor.dismiss('a');
    advisor.dismiss('a');
    expect(onDismissed).toHaveBeenCalledTimes(1);
  });

  it("fills a dismissed suggestion's cap slot with the next-ranked one", () => {
    const advisor = createRuleAdvisor({
      historySource: () => [],
      aggregate: () => undefined,
      analyzers: [
        () => [
          { key: 'k1', severity: 'warning' as const, summary: '', payload: undefined },
          { key: 'k2', severity: 'info' as const, summary: '', payload: undefined },
        ],
      ],
      maxSuggestions: 1,
    });
    expect(advisor.reevaluate().map((s) => s.key)).toEqual(['k1']);
    advisor.dismiss('k1');
    expect(advisor.reevaluate().map((s) => s.key)).toEqual(['k2']);
  });

  it('backfills the dismissed slot at once, without waiting for reevaluate', () => {
    const advisor = createRuleAdvisor({
      historySource: () => [],
      aggregate: () => undefined,
      analyzers: [
        () => [
          { key: 'k1', severity: 'warning' as const, summary: '', payload: undefined },
          { key: 'k2', severity: 'info' as const, summary: '', payload: undefined },
        ],
      ],
      maxSuggestions: 1,
    });
    advisor.reevaluate();

    const onSuggestions = vi.fn();
    advisor.on('suggestionsUpdated', onSuggestions);
    advisor.dismiss('k1');

    expect(advisor.suggestions.map((s) => s.key)).toEqual(['k2']);
    expect(onSuggestions).toHaveBeenCalledWith([expect.objectContaining({ key: 'k2' })]);
  });
});

// ============================================================================
// Inferred-acceptance event (with trigger passthrough)
// ============================================================================

describe('createRuleAdvisor — accepted (inferred-acceptance)', () => {
  it('fires accepted with the trigger value passed to reevaluate', () => {
    let produceA = true;
    const advisor = createRuleAdvisor({
      historySource: () => [],
      aggregate: () => undefined,
      analyzers: [
        () => [
          ...(produceA
            ? [{ key: 'a', severity: 'info' as const, summary: '', payload: undefined }]
            : []),
          { key: 'b', severity: 'info' as const, summary: '', payload: undefined },
        ],
      ],
    });

    advisor.reevaluate('cycle');
    const onAccepted = vi.fn();
    advisor.on('accepted', onAccepted);

    produceA = false;
    advisor.reevaluate('edit');

    expect(onAccepted).toHaveBeenCalledWith({ keys: ['a'], trigger: 'edit' });
  });

  it('fires accepted with trigger=undefined when reevaluate is called with no argument', () => {
    let producing = true;
    const advisor = createRuleAdvisor({
      historySource: () => [],
      aggregate: () => undefined,
      analyzers: [
        () =>
          producing
            ? [{ key: 'a', severity: 'info' as const, summary: '', payload: undefined }]
            : [],
      ],
    });
    advisor.reevaluate();
    const onAccepted = vi.fn();
    advisor.on('accepted', onAccepted);
    producing = false;
    advisor.reevaluate();
    expect(onAccepted).toHaveBeenCalledWith({ keys: ['a'], trigger: undefined });
  });

  it('does NOT fire accepted for keys removed via dismiss()', () => {
    const advisor = createRuleAdvisor({
      historySource: () => [],
      aggregate: () => undefined,
      analyzers: [() => [{ key: 'a', severity: 'info' as const, summary: '', payload: undefined }]],
    });
    advisor.reevaluate();

    const onAccepted = vi.fn();
    advisor.on('accepted', onAccepted);
    advisor.dismiss('a');
    advisor.reevaluate();

    expect(onAccepted).not.toHaveBeenCalled();
  });

  it('does NOT fire accepted after reset() (caller signals "context changed, do not count")', () => {
    let analyzerOutput: readonly Suggestion<undefined>[] = [
      { key: 'a', severity: 'info' as const, summary: '', payload: undefined },
    ];
    const advisor = createRuleAdvisor({
      historySource: () => [],
      aggregate: () => undefined,
      analyzers: [() => analyzerOutput],
    });
    advisor.reevaluate();

    const onAccepted = vi.fn();
    advisor.on('accepted', onAccepted);

    advisor.reset();
    analyzerOutput = [];
    advisor.reevaluate();

    expect(onAccepted).not.toHaveBeenCalled();
  });

  it('does not double-count: a single reevaluate that removes 2 visible keys fires once with both', () => {
    let producing = true;
    const advisor = createRuleAdvisor({
      historySource: () => [],
      aggregate: () => undefined,
      analyzers: [
        () =>
          producing
            ? [
                { key: 'a', severity: 'info' as const, summary: '', payload: undefined },
                { key: 'b', severity: 'info' as const, summary: '', payload: undefined },
              ]
            : [],
      ],
    });
    advisor.reevaluate();

    const onAccepted = vi.fn();
    advisor.on('accepted', onAccepted);
    producing = false;
    advisor.reevaluate('cycle');

    expect(onAccepted).toHaveBeenCalledTimes(1);
    expect(onAccepted.mock.calls[0]![0]).toEqual({ keys: ['a', 'b'], trigger: 'cycle' });
  });

  it('does NOT fire accepted for a key pushed below the cap', () => {
    let urgent = false;
    const advisor = createRuleAdvisor({
      historySource: () => [],
      aggregate: () => undefined,
      analyzers: [
        () => [
          ...(urgent
            ? [{ key: 'k0', severity: 'warning' as const, summary: '', payload: undefined }]
            : []),
          { key: 'k1', severity: 'info' as const, summary: '', payload: undefined },
        ],
      ],
      maxSuggestions: 1,
    });
    advisor.reevaluate();

    const onAccepted = vi.fn();
    advisor.on('accepted', onAccepted);
    urgent = true;
    expect(advisor.reevaluate('edit').map((s) => s.key)).toEqual(['k0']);
    expect(onAccepted).not.toHaveBeenCalled();
  });
});

// ============================================================================
// onAggregate profiling hook
// ============================================================================

describe('createRuleAdvisor — onAggregate', () => {
  it('fires once per reevaluate with the post-rank/cap pre-dismissal list', () => {
    const seen: { profile: number; n: number }[] = [];
    const advisor = createRuleAdvisor({
      historySource: () => [],
      aggregate: () => 42,
      analyzers: [
        () => [
          { key: 'a', severity: 'info' as const, summary: '', payload: undefined },
          { key: 'b', severity: 'info' as const, summary: '', payload: undefined },
        ],
      ],
      maxSuggestions: 1,
      onAggregate: (profile, suggestions) => {
        seen.push({ profile, n: suggestions.length });
      },
    });
    advisor.dismiss('a');
    advisor.reevaluate();
    advisor.reevaluate();

    expect(seen).toEqual([
      { profile: 42, n: 1 },
      { profile: 42, n: 1 },
    ]);
  });
});

// ============================================================================
// Type guard
// ============================================================================

// ============================================================================
// Consumer callsite shapes — structural-generality tests for the design doc
// ============================================================================

describe('createRuleAdvisor — spell-compiler shape (windowed profile aggregation + rule-set context)', () => {
  // Mirrors aggregateRuleProfiles + heuristics from
  // spell-compiler/src/modules/advisor/rule-suggestions.ts. The aggregator
  // stays caller-side; the parallel rule-set rides as analyzer context.

  interface CycleEntry {
    encounterId: string;
    fingerprint: string;
    deadRuleIndices: readonly number[];
    otherwiseShare: number;
  }
  interface RuleProfile {
    totalCycles: number;
    deadRuleHits: Record<number, number>;
    avgOtherwiseShare: number;
  }
  interface RuleSet {
    rules: readonly { id: string }[];
  }
  type RuleSuggestionPayload =
    | { kind: 'dead-rule'; ruleIndex: number }
    | { kind: 'narrow-otherwise' };

  const KIND_RANK: Record<RuleSuggestionPayload['kind'], number> = {
    'narrow-otherwise': 0,
    'dead-rule': 1,
  };

  function aggregate(history: readonly CycleEntry[]): RuleProfile {
    const fingerprint = 'fp1';
    const encounterId = 'enc1';
    const deadRuleHits: Record<number, number> = {};
    let totalCycles = 0;
    let otherwiseSum = 0;
    for (let i = history.length - 1; i >= 0 && totalCycles < 10; i--) {
      const e = history[i]!;
      if (e.encounterId !== encounterId || e.fingerprint !== fingerprint) continue;
      for (const idx of e.deadRuleIndices) {
        deadRuleHits[idx] = (deadRuleHits[idx] ?? 0) + 1;
      }
      otherwiseSum += e.otherwiseShare;
      totalCycles++;
    }
    return {
      totalCycles,
      deadRuleHits,
      avgOtherwiseShare: totalCycles > 0 ? otherwiseSum / totalCycles : 0,
    };
  }

  it('produces a ranked list of dead-rule + narrow-otherwise suggestions, with rule-set context', () => {
    const history: CycleEntry[] = [
      { encounterId: 'enc1', fingerprint: 'fp1', deadRuleIndices: [2], otherwiseShare: 0.6 },
      { encounterId: 'enc1', fingerprint: 'fp1', deadRuleIndices: [2], otherwiseShare: 0.7 },
      { encounterId: 'enc1', fingerprint: 'fp1', deadRuleIndices: [2], otherwiseShare: 0.8 },
      { encounterId: 'enc2', fingerprint: 'fp1', deadRuleIndices: [99], otherwiseShare: 0.1 },
    ];
    const ruleSet: RuleSet = { rules: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] };

    let analyzerSawRules: readonly { id: string }[] = [];

    const advisor = createRuleAdvisor({
      historySource: () => history,
      context: ruleSet,
      aggregate,
      analyzers: [
        (profile, _ctx): readonly Suggestion<RuleSuggestionPayload>[] =>
          profile.avgOtherwiseShare > 0.5
            ? [
                {
                  key: 'narrow-otherwise',
                  severity: 'warning',
                  summary: `OTHERWISE handled ${Math.round(profile.avgOtherwiseShare * 100)}% of casts`,
                  payload: { kind: 'narrow-otherwise' },
                },
              ]
            : [],
        (profile, rs): readonly Suggestion<RuleSuggestionPayload>[] => {
          analyzerSawRules = rs.rules;
          return Object.entries(profile.deadRuleHits).map(([idxStr, hits]) => ({
            key: `dead-rule:${idxStr}`,
            severity: 'info' as const,
            summary: `Rule ${idxStr} dead across ${hits} cycles`,
            payload: { kind: 'dead-rule' as const, ruleIndex: Number(idxStr) },
          }));
        },
      ],
      rank: (a, b) => KIND_RANK[a.payload.kind] - KIND_RANK[b.payload.kind],
      maxSuggestions: 3,
    });

    const out = advisor.reevaluate();
    expect(out.map((s) => s.key)).toEqual(['narrow-otherwise', 'dead-rule:2']);
    expect(analyzerSawRules).toEqual(ruleSet.rules);
  });
});

describe('createRuleAdvisor — Cookie Monster shape (window=1 degenerate case)', () => {
  // From policy-primitive-surface.md §5.9 — the structural-generality test.
  // window=1 aggregator + per-candidate score advisory + no apply path.

  interface BuildingState {
    id: string;
    price: number;
    cps: number;
    bonus: number;
  }
  interface Snapshot {
    bank: number;
    buildings: BuildingState[];
  }

  function aggregate(history: readonly Snapshot[]): Snapshot | null {
    return history.length > 0 ? history[history.length - 1]! : null;
  }

  it('emits a per-building advisory ranked by PP ascending', () => {
    const snapshot: Snapshot = {
      bank: 100,
      buildings: [
        { id: 'cursor', price: 200, cps: 10, bonus: 1 },
        { id: 'grandma', price: 150, cps: 20, bonus: 2 },
        { id: 'farm', price: 500, cps: 5, bonus: 1 },
      ],
    };

    type PpPayload = { buildingId: string; pp: number };

    const advisor = createRuleAdvisor({
      historySource: () => [snapshot],
      aggregate,
      analyzers: [
        (snap): readonly Suggestion<PpPayload>[] => {
          if (!snap) return [];
          return snap.buildings.map((b) => {
            const pp = Math.max(b.price - snap.bank, 0) / b.cps + b.price / b.bonus;
            return {
              key: `pp:${b.id}`,
              severity: 'info' as const,
              summary: `${b.id}: PP ${pp.toFixed(1)}`,
              payload: { buildingId: b.id, pp },
            };
          });
        },
      ],
      rank: (a, b) => a.payload.pp - b.payload.pp,
    });

    const out = advisor.reevaluate();
    expect(out.map((s) => s.payload.buildingId)).toEqual(['grandma', 'cursor', 'farm']);
    expect(out.every((s) => s.apply === undefined)).toBe(true);
  });
});
