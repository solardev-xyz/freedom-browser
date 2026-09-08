// Guards for the renderer's user-facing copy conventions.
//
// These are the drift checks behind docs/agent-playbooks/ui-consistency.md:
// one ellipsis character, one empty-counter placeholder, one "unknown value"
// placeholder, one bulk-clear label, one empty-state punctuation style and one
// heading case. They exist because every one of these drifted silently across
// sibling surfaces (#252, #253, #257, #258, #260) and only a side-by-side
// screenshot ever caught it.
//
// Scope: src/renderer only. The native application menu labels the same
// actions from src/main and drifts as a pair with the hamburger flyout — that
// half is guarded by src/main/main-copy.test.js.

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
    // Whitespace-tolerant like the sibling assertion above: Prettier wraps the
    // label onto its own line once the button's attributes get long enough.
    expect(read(path.join(RENDERER, 'pages/publish.html'))).toMatch(
      /id="publish-history-clear"[\s\S]*?Clear All\s*<\/button>/
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

// ---------------------------------------------------------------------------
// #239 — approval screens: one secondary verb, one callout glyph per kind
// ---------------------------------------------------------------------------

// The four Swarm approvals and their dApp siblings answer the same question —
// does this site get to do the thing it asked for? — so they answer it with
// the same word. "Cancel" belongs to a form or an unlock prompt, where there
// is no request to reject.
describe('approval screens (#239)', () => {
  const index = read(path.join(RENDERER, 'index.html'));

  // Sidebar sub-screens are laid out one after another, so a screen runs from
  // its own `id="sidebar-…"` to the next one.
  const screen = (id) => {
    const start = index.indexOf(`id="${id}"`);
    if (start < 0) throw new Error(`no ${id} in index.html`);
    const next = index.indexOf('id="sidebar-', start + 1);
    return index.slice(start, next < 0 ? index.length : next);
  };

  const SWARM_SCREENS = [
    ['sidebar-swarm-connect', 'swarm-connect-reject'],
    ['sidebar-swarm-publish-approve', 'swarm-publish-reject'],
    ['sidebar-swarm-messaging-approve', 'swarm-messaging-reject'],
    ['sidebar-swarm-feed-approve', 'swarm-feed-reject'],
  ];

  const label = (html, id) => {
    const match = html.match(new RegExp(`id="${id}"[^>]*>\\s*([^<]*?)\\s*<`));
    if (!match) throw new Error(`no button #${id}`);
    return match[1];
  };

  test.each(SWARM_SCREENS)('%s rejects, it does not cancel', (id, rejectId) => {
    expect(label(screen(id), rejectId)).toBe('Reject');
  });

  test('the dApp siblings the verb comes from still say it', () => {
    expect(label(screen('sidebar-dapp-tx'), 'dapp-tx-reject')).toBe('Reject');
    expect(label(screen('sidebar-dapp-sign'), 'dapp-sign-reject')).toBe('Reject');
    expect(label(screen('sidebar-dapp-connect'), 'dapp-connect-reject')).toBe('Reject');
  });

  // Callout kind and glyph are set in two places — the class in the markup,
  // the `<path>`/`<circle>` inside it — so they drift as a pair. Amber
  // (`.swarm-connect-warning`, `.dapp-tx-warning`) carries the warning
  // triangle; blue (`.swarm-connect-note`, `.dapp-sign-warning`) carries "i".
  const TRIANGLE = /M10\.29 3\.86L1\.82 18/;
  const INFO_CIRCLE = /<circle cx="12" cy="12" r="10"/;

  const callouts = (html) => [
    ...html.matchAll(
      /<div class="(swarm-connect-warning|swarm-connect-note)"[^>]*>([\s\S]*?)<\/svg>/g
    ),
  ];

  test.each(SWARM_SCREENS)('%s pairs its callout class with the matching glyph', (id) => {
    const found = callouts(screen(id));
    expect(found).toHaveLength(1);
    const [, kind, body] = found[0];
    if (kind === 'swarm-connect-warning') {
      expect(body).toMatch(TRIANGLE);
      expect(body).not.toMatch(INFO_CIRCLE);
    } else {
      expect(body).toMatch(INFO_CIRCLE);
      expect(body).not.toMatch(TRIANGLE);
    }
  });

  test('the confirm-an-action screens warn and the grant-access screens inform', () => {
    const kindOf = (id) => callouts(screen(id))[0][1];
    expect(kindOf('sidebar-swarm-publish-approve')).toBe('swarm-connect-warning');
    expect(kindOf('sidebar-swarm-messaging-approve')).toBe('swarm-connect-warning');
    expect(kindOf('sidebar-swarm-connect')).toBe('swarm-connect-note');
    expect(kindOf('sidebar-swarm-feed-approve')).toBe('swarm-connect-note');
  });

  test('the dApp screens the two kinds are copied from keep their glyphs', () => {
    const tx = screen('sidebar-dapp-tx');
    expect(tx.match(/class="dapp-tx-warning hidden"[\s\S]*?<\/svg>/)[0]).toMatch(TRIANGLE);
    const sign = screen('sidebar-dapp-sign');
    expect(sign.match(/class="dapp-sign-warning"[\s\S]*?<\/svg>/)[0]).toMatch(INFO_CIRCLE);
  });

  // The playbook used to state the "Reject" verb as a settled rule with the
  // Swarm screens as its one exception, which was never true: three approval
  // surfaces word the same decision differently. Rather than restate a rule the
  // markup does not follow, the playbook now names those three, and this pins
  // the naming in both directions so neither side can drift alone.
  describe('ui-consistency.md on the reject verb', () => {
    const playbook = fs
      .readFileSync(path.join(__dirname, '../../docs/agent-playbooks/ui-consistency.md'), 'utf8')
      .replace(/\s+/g, ' ');

    // Straight vs. typographic apostrophes differ between prose and markup.
    const norm = (text) => text.replace(/[’‘]/g, "'").trim();

    // Every `… says "Verb" (`#id`)` the playbook lists as unpinned drift.
    const documented = [...playbook.matchAll(/"([^"]+)" \(`#([a-z0-9-]+)`\)/g)].map((match) => [
      match[2],
      norm(match[1]),
    ]);

    // A secondary that is legitimately "Cancel"/not a reject at all: a form, an
    // unlock prompt, the middle "ask each time" choice.
    const NOT_A_REJECT = new Set([
      'vault-unlock-cancel',
      'publisher-identity-create-cancel',
      'swarm-manifest-individual',
    ]);

    test('the playbook names exactly the three it says it does', () => {
      expect(documented.map(([id]) => id).sort()).toEqual([
        'permission-prompt-block',
        'radicle-consent-reject',
        'swarm-manifest-reject',
      ]);
    });

    // doc -> markup: each documented verb is the one actually rendered.
    test.each(documented)('#%s still reads "%s"', (id, verb) => {
      expect(norm(label(index, id))).toBe(verb);
    });

    // markup -> doc: any other approval secondary that stops saying "Reject" is
    // new drift, and has to be documented (or fixed) rather than land silently.
    test('no undocumented approval secondary has drifted off "Reject"', () => {
      const drifted = [];
      for (const match of index.matchAll(
        /class="(?:swarm-connect|dapp-tx|dapp-sign|dapp-connect)-reject-btn"\s+id="([a-z0-9-]+)"[^>]*>\s*([^<]*?)\s*</g
      )) {
        const [, id, text] = match;
        if (NOT_A_REJECT.has(id) || norm(text) === 'Reject') continue;
        if (documented.some(([documentedId]) => documentedId === id)) continue;
        drifted.push(`#${id} says "${norm(text)}"`);
      }
      expect(drifted).toEqual([]);
    });
  });
});
