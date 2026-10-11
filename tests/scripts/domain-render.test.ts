/**
 * Tests for `scripts/lib/domain-render.mjs` — the markdown renderer. Confirms
 * the hybrid shape: generated surface (vocabulary / definitions / relationships
 * / thin spots) followed by the curated disambiguator block, plus the
 * do-not-edit banner that signals the generated sections are drift-proof.
 */
import { describe, it, expect } from 'vitest';
// @ts-expect-error — JS module without types, fine for tests
import { renderDomainMap } from '../../scripts/lib/domain-render.mjs';

const result = {
  defs: ['FooDef', 'BarDef'],
  vocabulary: [
    { owner: 'Size', kind: 'union', arms: ['small', 'large'] },
    { owner: 'ActionDef.kind', kind: 'discriminator', arms: ['move', 'wait'] },
  ],
  edges: [
    { from: 'FooDef.barId', to: 'bar' },
    { from: 'FooDef.widgetId', to: 'widget' },
    { from: 'SampleData.foos', to: 'foo' },
  ],
  thinSpots: ['ModDef'],
  fileCount: 1,
};

const config = {
  title: 'Sample — domain language',
  description: 'A blurb.',
  curated: [{ term: 'loop', note: 'A run is a rehearsal.' }],
};

describe('renderDomainMap', () => {
  const md = renderDomainMap(result, config);

  it('renders title, description, and the do-not-edit banner', () => {
    expect(md).toMatch(/^# Sample — domain language/);
    expect(md).toContain('A blurb.');
    expect(md).toContain('do not edit by hand');
  });

  it('renders all generated sections in order, then the curated block', () => {
    const order = [
      '## Vocabulary',
      '## Defs',
      '## Relationships',
      '## Thin spots',
      '## Disambiguators (curated)',
    ];
    let last = -1;
    for (const h of order) {
      const idx = md.indexOf(h);
      expect(idx, h).toBeGreaterThan(last);
      last = idx;
    }
  });

  it('groups edges by source owner and shows discriminator arms', () => {
    expect(md).toContain('- **FooDef** → `bar`, `widget`');
    expect(md).toContain('- **SampleData** → `foo`');
    expect(md).toContain('**ActionDef.kind**');
    expect(md).toContain('`move` · `wait`');
  });

  it('renders the curated disambiguator entries', () => {
    expect(md).toContain('- **loop** — A run is a rehearsal.');
  });

  it('omits the thin-spots section when there are none, and notes empty curated', () => {
    const md2 = renderDomainMap({ ...result, thinSpots: [] }, { title: 'X' });
    expect(md2).not.toContain('## Thin spots');
    expect(md2).toContain('_(none yet');
  });
});
