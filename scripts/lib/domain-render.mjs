/**
 * Domain-map renderer — turns an extractor result into the committed markdown
 * map. Mirrors build-api-docs.mjs's hybrid: always-fresh GENERATED sections
 * (vocabulary, defs, relationships, thin spots) followed by a small
 * CURATED disambiguator block copied verbatim from the per-game config.
 *
 * Anti-drift depends on three properties, not on generation alone: the curated
 * block is small, it is stored in the versioned config (not a sidecar doc), and
 * it renders next to the generated sections, so staleness is visible on every
 * regenerate. These are exactly what a hand-maintained
 * glossary lacks.
 */

// === HELPERS ===

const KIND_NOTE = {
  enum: 'enum members',
  union: 'string-literal union',
  discriminator: 'discriminated-union arm',
};

/** Group edges by their source owner, preserving first-seen order. */
function groupEdges(edges) {
  const out = new Map();
  for (const e of edges) {
    if (!out.has(e.from.split('.')[0])) out.set(e.from.split('.')[0], []);
    out.get(e.from.split('.')[0]).push(e);
  }
  return out;
}

// === RENDER ===

/**
 * Render the full map.
 *
 * @param {object} result  Output of extractDomain().
 * @param {object} config  The dialect config (for title/description/curated).
 * @returns {string} markdown, newline-terminated.
 */
export function renderDomainMap(result, config) {
  const { defs, vocabulary, edges, thinSpots } = result;
  const title = config.title ?? 'Domain language map';
  const lines = [];

  lines.push(`# ${title}`, '');
  if (config.description) lines.push(config.description, '');
  lines.push(
    '> Generated from code structure by `ol-domain-map` — do not edit by hand;',
    '> regenerate with `pnpm domain-map`. The generated sections below re-derive',
    '> from the source types every run, so they cannot drift. The curated',
    '> disambiguators at the end are the only hand-authored part.',
    '',
  );

  // --- VOCABULARY (is-a) ---
  lines.push('## Vocabulary', '');
  if (vocabulary.length) {
    lines.push(
      'Enum / union membership is an is-a relation — each arm *is a* kind of its owner.',
      '',
    );
    for (const v of vocabulary) {
      const arms = v.arms.map((a) => `\`${a}\``).join(' · ');
      lines.push(`- **${v.owner}** _(${KIND_NOTE[v.kind] ?? v.kind})_ — ${arms}`);
    }
  } else {
    lines.push('_(no enums or string-literal unions in scope)_');
  }
  lines.push('');

  // --- DEFS ---
  lines.push('## Defs', '');
  lines.push(defs.length ? defs.map((d) => `\`${d}\``).join(', ') : '_(no def types in scope)_');
  lines.push('');

  // --- RELATIONSHIPS ---
  lines.push('## Relationships', '');
  if (edges.length) {
    lines.push(
      'Field-name reference edges: untyped ids in named fields that point at',
      'another domain noun. These are name-encoded, not type-encoded, so',
      'type-graph tools such as dependency-cruiser and findReferences miss them.',
      '',
    );
    for (const [owner, group] of groupEdges(edges)) {
      const targets = [...new Set(group.map((e) => e.to))].map((t) => `\`${t}\``).join(', ');
      lines.push(`- **${owner}** → ${targets}`);
    }
  } else {
    lines.push('_(no field-name reference edges mined)_');
  }
  lines.push('');

  // --- THIN SPOTS ---
  if (thinSpots.length) {
    lines.push('## Thin spots', '');
    lines.push(
      'Defs with no structural signal (no vocabulary, no incident edge).',
      'These are candidates for a curated note below — or for richer typing.',
      '',
      thinSpots.map((d) => `\`${d}\``).join(', '),
      '',
    );
  }

  // --- CURATED DISAMBIGUATORS (next to the generated sections) ---
  lines.push('## Disambiguators (curated)', '');
  const curated = config.curated ?? [];
  if (curated.length) {
    lines.push(
      'Hand-authored: the game-level concepts no single type owns, which',
      'structure cannot derive. Kept small and stored in the config, so',
      'staleness stays visible against the generated sections above.',
      '',
    );
    for (const c of curated) {
      lines.push(`- **${c.term}** — ${c.note}`);
    }
  } else {
    lines.push(
      '_(none yet — add `curated` entries to the config as cross-symbol concepts appear)_',
    );
  }
  lines.push('');

  return lines.join('\n').replace(/\n+$/, '\n');
}
