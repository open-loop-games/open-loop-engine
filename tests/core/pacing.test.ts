import { describe, it, expect } from 'vitest';
import { classifyFlowChannel, getFlowChannelBoundaries } from '@/core/pacing';

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
    expect(b.arousal).toEqual([5, 30]);
    expect(b.flow).toEqual([30, 120]);
    expect(b['flow-upper']).toEqual([120, 300]);
    expect(b.boredom).toEqual([300, 900]);
    expect(b.frustration).toEqual([900, 3600]);
    expect(b.breakdown).toEqual([3600, Infinity]);
  });
});
