// Guards for the renderer's user-facing copy conventions.
//
// These are the drift checks behind docs/agent-playbooks/ui-consistency.md:
// one ellipsis character, one empty-counter placeholder, one "unknown value"
// placeholder, one bulk-clear label, one empty-state punctuation style and one
// heading case. They exist because every one of these drifted silently across
// sibling surfaces (#252, #253, #257, #258, #260) and only a side-by-side
// screenshot ever caught it.

const fs = require('node:fs');
const path = require('node:path');

const RENDERER = path.join(__dirname);

// Every first-party renderer source file. `vendor/` is third-party minified
// code and `*.test.js` is this harness itself.
function rendererSources() {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'vendor' || entry.name === 'images') continue;
        walk(full);
      } else if (/\.(html|js)$/.test(entry.name) && !entry.name.endsWith('.test.js')) {
        out.push(full);
      }
    }
  };
  walk(RENDERER);
  return out.sort();
}

const rel = (file) => path.relative(path.join(__dirname, '..', '..'), file);
const read = (file) => fs.readFileSync(file, 'utf8');

const SOURCES = rendererSources();

// ---------------------------------------------------------------------------
// #257 — one ellipsis character
// ---------------------------------------------------------------------------

// Lines that are wholly a comment. Trailing `// ...` comments on a code line
// are rare enough that flagging one is the right outcome.
const COMMENT_LINE = /^\s*(\/\/|\*|\/\*|<!--)/;

// `...ident`, `...(`, `...[`, `...{` are spread/rest syntax. `...${` is NOT —
// that is a truncated value inside a template literal, which is user-facing.
const SPREAD = /\.\.\.(?!\$\{)(?=[A-Za-z_$([{])/g;

function asciiEllipsisHits(source, file) {
  const hits = [];
  source.split('\n').forEach((line, index) => {
    if (!line.includes('...')) return;
    if (COMMENT_LINE.test(line)) return;
    if (line.replace(SPREAD, '').includes('...')) {
      hits.push(`${rel(file)}:${index + 1}: ${line.trim()}`);
    }
  });
  return hits;
}

describe('ellipsis character (#257)', () => {
  test('no user-facing string uses three ASCII dots', () => {
    const hits = SOURCES.flatMap((file) => asciiEllipsisHits(read(file), file));
    expect(hits).toEqual([]);
  });

  test('the detector distinguishes spread syntax from a user-facing ellipsis', () => {
    // Mutation check: without this, the guard above could be passing because
    // it silently ignores everything.
    const fake = '/tmp/fake.js';
    expect(asciiEllipsisHits('const x = { ...rest, y: [...list] };\n', fake)).toEqual([]);
    expect(asciiEllipsisHits('// a comment with ... in it\n', fake)).toEqual([]);
    expect(asciiEllipsisHits("btn.textContent = 'Loading...';\n", fake)).toHaveLength(1);
    expect(asciiEllipsisHits('<span>Print...</span>\n', fake)).toHaveLength(1);
    expect(asciiEllipsisHits('placeholder="Search history..."\n', fake)).toHaveLength(1);
    expect(asciiEllipsisHits('`${a.slice(0, 6)}...${a.slice(-4)}`\n', fake)).toHaveLength(1);
  });

  test('the sibling surfaces named in the issue use U+2026', () => {
    const index = read(path.join(RENDERER, 'index.html'));
    for (const label of ['Create Profile…', 'Manage Profiles…', 'Print…', 'Check for Updates…']) {
      expect(index).toContain(label);
    }
    expect(read(path.join(RENDERER, 'pages/history.html'))).toContain('Search history…');
    expect(read(path.join(RENDERER, 'pages/downloads.html'))).toContain('Search downloads…');
    // The third variant: a search box with no ellipsis at all.
    expect(read(path.join(RENDERER, 'pages/settings.html'))).toContain('Search shortcuts…');
  });
});

// ---------------------------------------------------------------------------
// #252 / #253 — Nodes menu placeholders
// ---------------------------------------------------------------------------

describe('Nodes menu placeholders (#252, #253)', () => {
  const index = read(path.join(RENDERER, 'index.html'));
  const spanDefault = (id) => {
    const match = index.match(new RegExp(`<span id="${id}">([^<]*)</span>`));
    if (!match) throw new Error(`no <span id="${id}"> in index.html`);
    return match[1];
  };

  const COUNTERS = [
    'bee-peers-count',
    'bee-network-peers',
    'ipfs-active-requests-count',
    'myotis-peers-count',
    'myotis-finalized-block',
    'myotis-gnosis-peers-count',
    'myotis-gnosis-finalized-block',
    'radicle-peers-count',
    'radicle-repos-count',
  ];

  const VERSIONS = [
    'bee-version-text',
    'ipfs-version-text',
    'myotis-version-text',
    'myotis-gnosis-version-text',
    'radicle-version-text',
    'tor-version-text',
  ];

  test.each(COUNTERS)('%s defaults to 0, never --', (id) => {
    expect(spanDefault(id)).toBe('0');
  });

  test.each(VERSIONS)('%s defaults to the one Unknown placeholder', (id) => {
    expect(spanDefault(id)).toBe('Unknown');
  });

  test('the menu shows exactly one placeholder convention per row kind', () => {
    expect(new Set(COUNTERS.map(spanDefault)).size).toBe(1);
    expect(new Set(VERSIONS.map(spanDefault)).size).toBe(1);
  });

  // The markup default only covers the first paint. A second module holding
  // its own copy of the empty-state rules is how the runtime side drifts:
  // menus.js used to re-blank #bee-version-text when the Nodes menu closed,
  // undoing the 'Unknown' ant-ui.js had just written. Each readout gets
  // exactly one owning module.
  test('each Nodes menu readout has exactly one owner in the renderer', () => {
    const modules = fs
      .readdirSync(path.join(RENDERER, 'lib'))
      .filter((name) => name.endsWith('.js') && !name.endsWith('.test.js'));

    const owners = Object.fromEntries(
      [...COUNTERS, ...VERSIONS].map((id) => [
        id,
        modules.filter((name) => read(path.join(RENDERER, 'lib', name)).includes(id)),
      ])
    );

    expect(owners).toEqual({
      'bee-peers-count': ['ant-ui.js'],
      'bee-network-peers': ['ant-ui.js'],
      'bee-version-text': ['ant-ui.js'],
      'ipfs-active-requests-count': ['ipfs-ui.js'],
      'ipfs-version-text': ['ipfs-ui.js'],
      'myotis-peers-count': ['myotis-ui.js'],
      'myotis-finalized-block': ['myotis-ui.js'],
      'myotis-version-text': ['myotis-ui.js'],
      'myotis-gnosis-peers-count': ['myotis-ui.js'],
      'myotis-gnosis-finalized-block': ['myotis-ui.js'],
      'myotis-gnosis-version-text': ['myotis-ui.js'],
      'radicle-peers-count': ['radicle-ui.js'],
      'radicle-repos-count': ['radicle-ui.js'],
      'radicle-version-text': ['radicle-ui.js'],
      'tor-version-text': ['tor-ui.js'],
    });
  });
});

// ---------------------------------------------------------------------------
// #258 — empty-state punctuation and the bulk-clear label
// ---------------------------------------------------------------------------

// A short "nothing here" message pinned between a delimiter and a full stop:
// `>No payments yet.<`, `'No custom RPCs yet.'`. Prose sentences keep running
// after the stop, so they do not match.
const PUNCTUATED_EMPTY_STATE = /["'`>](No [A-Za-z0-9 ,'’-]+)\.(?=["'`<])/g;

describe('empty states and bulk-clear labels (#258)', () => {
  test('no empty-state message ends in a full stop', () => {
    const hits = [];
    for (const file of SOURCES) {
      const source = read(file);
      for (const match of source.matchAll(PUNCTUATED_EMPTY_STATE)) {
        hits.push(`${rel(file)}: ${match[1]}.`);
      }
    }
    expect(hits).toEqual([]);
  });

  test('the detector still fires on the pattern it was written for', () => {
    const sample = '<div class="empty-state"><p>No payments yet.</p></div>';
    expect([...sample.matchAll(PUNCTUATED_EMPTY_STATE)].map((m) => m[1])).toEqual([
      'No payments yet',
    ]);
    expect([...'<p>No payments yet</p>'.matchAll(PUNCTUATED_EMPTY_STATE)]).toEqual([]);
  });

  test.each([
    ['pages/history.html', 'No history yet'],
    ['pages/downloads.html', 'No downloads yet'],
    ['pages/payments.html', 'No payments yet'],
    ['pages/payments.html', 'No payments match your filters'],
    ['pages/publish.html', 'No publishes yet'],
    ['pages/rad-browser.html', 'No repositories seeded yet'],
    ['index.html', 'No publisher identities yet'],
    ['pages/settings.html', 'No custom search engines yet'],
    ['pages/settings.html', 'No custom RPCs yet'],
  ])('%s keeps its unpunctuated empty state: %s', (file, message) => {
    const source = read(path.join(RENDERER, file));
    expect(source).toContain(message);
    expect(source).not.toContain(`${message}.`);
  });

  test.each(['pages/history.html', 'pages/downloads.html', 'pages/payments.html'])(
    '%s labels its bulk clear "Clear All"',
    (file) => {
      const source = read(path.join(RENDERER, file));
      expect(source).toMatch(/id="clear-btn"[\s\S]*?Clear All\s*<\/button>/);
      expect(source).not.toMatch(/>\s*Clear all\s*</);
    }
  );

  test('publish labels its bulk clear "Clear All" too', () => {
    expect(read(path.join(RENDERER, 'pages/publish.html'))).toMatch(
      /id="publish-history-clear">Clear All</
    );
  });
});

// ---------------------------------------------------------------------------
// #260 — error page heading case
// ---------------------------------------------------------------------------

describe('error page heading case (#260)', () => {
  const errorHtml = read(path.join(RENDERER, 'pages/error.html'));

  test('the static <title> and <h1> share one sentence-case default', () => {
    const title = errorHtml.match(/<title>([^<]*)<\/title>/)[1];
    const heading = errorHtml.match(/<h1 id="title">([^<]*)<\/h1>/)[1];
    expect(title).toBe('Content unavailable');
    expect(heading).toBe(title);
  });

  test('every heading this page can show is sentence case', () => {
    const runtime = [...errorHtml.matchAll(/setErrorTitle\(\s*(['"])(.*?)\1\s*\)/g)].map(
      (m) => m[2]
    );
    expect(runtime.length).toBeGreaterThanOrEqual(2);
    const headings = ['Content unavailable', ...runtime];
    for (const heading of headings) {
      // Sentence case: only the first word (and any proper noun, of which
      // these have none) is capitalised.
      expect(
        heading
          .split(' ')
          .slice(1)
          .filter((w) => /^[A-Z]/.test(w))
      ).toEqual([]);
    }
  });
});
