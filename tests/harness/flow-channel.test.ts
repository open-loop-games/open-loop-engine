import { describe, it, expect } from 'vitest';
import { classifyFlowChannel, getFlowChannelBoundaries } from '@/harness/flow-channel';

describe('classifyFlowChannel', () => {
  it('classifies durations into Csikszentmihalyi flow channels', () => {
    expect(classifyFlowChannel(2)).toBe('arousal');
    expect(classifyFlowChannel(10)).toBe('arousal');
    expect(classifyFlowChannel(60)).toBe('flow');
    expect(classifyFlowChannel(200)).toBe('flow-upper');
    expect(classifyFlowChannel(600)).toBe('boredom');
    expect(classifyFlowChannel(1800)).toBe('frustration');
    expect(classifyFlowChannel(7200)).toBe('breakdown');
  });

  it('boundary points fall into the upper channel', () => {
    expect(classifyFlowChannel(30)).toBe('flow');
    expect(classifyFlowChannel(120)).toBe('flow-upper');
    expect(classifyFlowChannel(300)).toBe('boredom');
    expect(classifyFlowChannel(900)).toBe('frustration');
    expect(classifyFlowChannel(3600)).toBe('breakdown');
  });
});

describe('getFlowChannelBoundaries', () => {
  it('returns the documented flow channel ranges', () => {
    const b = getFlowChannelBoundaries();
    // arousal starts at 0, not 5: classifyFlowChannel floors everything < 30
    // to arousal, so a [5, 30] pair would leave [0, 5) outside every boundary.
    expect(b.arousal).toEqual([0, 30]);
    expect(b.flow).toEqual([30, 120]);
    expect(b['flow-upper']).toEqual([120, 300]);
    expect(b.boredom).toEqual([300, 900]);
    expect(b.frustration).toEqual([900, 3600]);
    expect(b.breakdown).toEqual([3600, Infinity]);
  });

  it('boundaries agree with the classifier — every lower bound classifies into its channel', () => {
    const b = getFlowChannelBoundaries();
    for (const [channel, [min]] of Object.entries(b)) {
      expect(classifyFlowChannel(min)).toBe(channel);
    }
    // The [0, 5) region that the old [5, 30] arousal bound excluded:
    expect(classifyFlowChannel(2)).toBe('arousal');
  });
});
