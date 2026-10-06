/**
 * The page-wide settings search (#281) — `src/renderer/pages/settings.html`.
 *
 * Settings had exactly one search field and it was scoped to one section
 * (`#shortcut-search`, the Shortcuts list). #281 added `#settings-search` in
 * the sidebar header, which indexes every section, so the two helpers behind
 * it are what decides whether "tor", "api key" or "restart" is findable.
 *
 * Same extraction approach as `settings-tor-rows.test.js` and
 * `settings-radicle-launch.test.js`: the settings page is one classic
 * script, so the helpers are lifted out of the shipped source (between the
 * markers the page keeps for exactly this) and driven directly, keeping the
 * assertions on the real code rather than on a copy.
 *
 * The index is built from a DOM, and this repo has no jsdom, so the reader
 * below turns the page's *own* `<main class="content">` markup into the small
 * element interface the helpers use — `children`, `tagName`, `id`,
 * `classList.contains`, `textContent`, nothing else. That keeps these tests
 * on the shipped sections and their real labels rather than on a fixture
 * that can drift from them; `test-e2e/settings.spec.js` drives the same
 * helpers over the real Chromium DOM, including the sections that only exist
 * once their view has rendered.
 */

const fs = require('fs');
const path = require('path');

// The page's markup plus the classic script it loads (`scripts/settings.js`,
// moved out of an inline <script> by #432 so the CSP can drop 'unsafe-inline').
const SOURCE = [
  fs.readFileSync(path.join(__dirname, 'settings.html'), 'utf8'),
  fs.readFileSync(path.join(__dirname, 'scripts', 'settings.js'), 'utf8'),
].join('\n');

const START = '/* settings-search helpers: start */';
const END = '/* settings-search helpers: end */';

function loadHelpers() {
  const start = SOURCE.indexOf(START);
  const end = SOURCE.indexOf(END);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  const body = SOURCE.slice(start + START.length, end);
  return new Function(
    `${body}\nreturn { settingsSearchText, settingsSearchCollect, settingsSearchFirst,` +
      ` buildSettingsSearchIndex, matchSettingsSearch, settingsSearchScrollBlock };`
  )();
}

const { buildSettingsSearchIndex, matchSettingsSearch, settingsSearchScrollBlock } = loadHelpers();

// ---------------------------------------------------------------------------
// A minimal element reader for the page's own markup.
// ---------------------------------------------------------------------------

// Tags that never have a close tag in this file, plus the SVG leaves, which
// appear both self-closed and with an explicit close.
const VOID_TAGS = new Set([
  'input',
  'img',
  'br',
  'hr',
  'meta',
  'link',
  'source',
  'col',
  'path',
  'circle',
  'line',
  'polyline',
  'polygon',
  'rect',
  'ellipse',
  'use',
  'stop',
]);

const ENTITIES = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&nbsp;': ' ',
  '&hellip;': '…',
  '&ldquo;': '“',
  '&rdquo;': '”',
  '&lsquo;': '‘',
  '&rsquo;': '’',
  '&mdash;': '—',
  '&ndash;': '–',
};

const decode = (text) => text.replace(/&[a-z]+;/g, (entity) => ENTITIES[entity] ?? entity);

const element = (tagName, attrs = '') => {
  const classes = new Set(((attrs.match(/\bclass="([^"]*)"/) || [])[1] || '').split(/\s+/));
  const style = {};
  for (const declaration of ((attrs.match(/\bstyle="([^"]*)"/) || [])[1] || '').split(';')) {
    const [property, ...value] = declaration.split(':');
    if (!value.length) continue;
    style[property.trim().replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value.join(':').trim();
  }
  const node = {
    tagName,
    id: (attrs.match(/\bid="([^"]*)"/) || [])[1] || '',
    classList: { contains: (name) => classes.has(name) },
    style,
    // The IDL property, which is what `el.hidden = true` writes and what the
    // attribute in this markup reflects — the other way a row is switched off.
    hidden: /(^|\s)hidden(\s|=|$)/.test(attrs),
    children: [],
    // Text and elements in source order, so `textContent` reads the way the
    // browser's does — a `<code>` inside a sentence has to stay put.
    nodes: [],
  };
  Object.defineProperty(node, 'textContent', {
    get: () => node.nodes.map((n) => (typeof n === 'string' ? n : n.textContent)).join(''),
  });
  return node;
};

/** Parse a fragment of the page's markup into the element interface above. */
function parseFragment(html) {
  const root = element('ROOT');
  const stack = [root];
  const token = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][-\w]*)((?:"[^"]*"|'[^']*'|[^>])*?)(\/?)>/g;
  let cursor = 0;
  let match;
  while ((match = token.exec(html)) !== null) {
    const top = stack[stack.length - 1];
    if (match.index > cursor) top.nodes.push(decode(html.slice(cursor, match.index)));
    cursor = match.index + match[0].length;
    if (match[0].startsWith('<!--')) continue;
    const [, closing, tag, attrs, selfClosed] = match;
    const tagName = tag.toUpperCase();
    if (closing) {
      for (let i = stack.length - 1; i > 0; i -= 1) {
        if (stack[i].tagName === tagName) {
          stack.length = i;
          break;
        }
      }
      continue;
    }
    const node = element(tagName, attrs);
    top.children.push(node);
    top.nodes.push(node);
    if (!selfClosed && !VOID_TAGS.has(tag.toLowerCase())) stack.push(node);
  }
  if (cursor < html.length) stack[stack.length - 1].nodes.push(decode(html.slice(cursor)));
  return root;
}

const CONTENT = parseFragment(SOURCE.match(/<main class="content">([\s\S]*)<\/main>/)[1]);
const RESULTS_PANEL = 'settings-search-results';

// The nav's label per section, the same map the page hands the builder for
// the sections whose heading comes from a view template.
const NAV_LABELS = Object.fromEntries(
  [
    ...SOURCE.matchAll(
      /<button[^>]*class="nav-item"[^>]*data-target="([a-z]+)"[^>]*>([\s\S]*?)<\/button>/g
    ),
  ].map(([, target, body]) => [
    target,
    body
      .replace(/<[^>]*>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim(),
  ])
);

// Since #268 a nav entry can own several sections ("panels"), each naming
// its entry in `data-nav`; the page hands the builder each panel's entry
// label, as the fallback name and as the group its rows are listed under.
// A panel whose heading is painted by a view template carries a
// `data-title` to be named by until then (Chains, RPC Providers).
const PANEL_TAGS = [
  ...SOURCE.matchAll(
    /<section class="section[^"]*" id="([a-z]+)" data-nav="([a-z]+)"(?: data-title="([^"]*)")?>/g
  ),
];
const PANEL_NAV = Object.fromEntries(PANEL_TAGS.map(([, id, nav]) => [id, nav]));
const PANEL_GROUPS = Object.fromEntries(
  Object.entries(PANEL_NAV).map(([id, nav]) => [id, NAV_LABELS[nav]])
);
const PANEL_LABELS = Object.fromEntries(
  PANEL_TAGS.map(([, id, nav, title]) => [id, title || NAV_LABELS[nav]])
);

const index = () =>
  buildSettingsSearchIndex(CONTENT, {
    sectionLabels: PANEL_LABELS,
    groups: PANEL_GROUPS,
    skip: [RESULTS_PANEL],
  });

// A section's own entry, as opposed to one of its rows (which are numbered).
const isSectionEntry = (entry) => entry.labelIndex === undefined;

const search = (query) => matchSettingsSearch(index(), query);
const labelsOf = (results) => results.map((result) => result.label);

describe('the markup reader these tests are built on', () => {
  test('sees the page the browser sees: every section, with its rows', () => {
    const sections = CONTENT.children.filter((child) => child.tagName === 'SECTION');
    // Every panel of the 10 nav entries plus the search-results panel, which
    // is not one.
    expect(new Set(sections.map((section) => section.id))).toEqual(
      new Set([RESULTS_PANEL, ...Object.keys(PANEL_NAV)])
    );
    expect(sections).toHaveLength(18);
    expect(Object.keys(NAV_LABELS)).toHaveLength(10);
    // Every panel names a real entry, and every entry has a panel.
    expect(new Set(Object.values(PANEL_NAV))).toEqual(new Set(Object.keys(NAV_LABELS)));

    const startup = sections.find((section) => section.id === 'startup');
    const rows = startup.children
      .flatMap((child) => child.children)
      .filter((child) => child.classList.contains('row'));
    expect(rows.length).toBe(6);
  });

  test('reads text in source order, through nested elements and entities', () => {
    const tor = index().find((entry) => entry.label.startsWith('Enable Tor'));
    // The `Beta` badge is part of the label; `<code>.onion</code>` sits at
    // the *start* of the help line, which a reader that appended its own text
    // before its children would move to the end.
    expect(tor.label).toBe('Enable Tor (.onion access) Beta');
    expect(tor.help).toBe(
      'Routes only .onion addresses through the bundled Tor (Arti) client. ' +
        'Clearnet traffic stays direct.'
    );
    expect(index().find((entry) => entry.label.includes('Identity')).label).toBe(
      'Enable Identity & Wallet Beta'
    );
  });
});

describe('buildSettingsSearchIndex', () => {
  test('indexes one entry per section, named by its own heading', () => {
    const sections = index().filter(isSectionEntry);
    expect(new Set(sections.map((entry) => entry.sectionId))).toEqual(
      new Set(Object.keys(PANEL_NAV))
    );
    expect(sections).toHaveLength(17);
    const named = (id) => sections.find((entry) => entry.sectionId === id);
    // A panel that shares its entry is named by its own heading, listed under
    // the entry that holds it (#268)…
    expect(named('ens')).toMatchObject({
      label: 'Name Resolution',
      section: 'Networks › Name Resolution',
    });
    expect(named('adblock')).toMatchObject({
      label: 'Ad Blocking',
      section: 'Privacy and security › Ad Blocking',
    });
    // …and an entry's own heading is found by the entry's name alone.
    expect(named('networks')).toMatchObject({ label: 'Networks', section: 'Networks' });
    expect(named('experimental')).toMatchObject({ label: 'Advanced', section: 'Advanced' });
    expect(named('about')).toMatchObject({ label: 'About Freedom', section: 'About Freedom' });
  });

  test('falls back to the nav label for a section whose view has not rendered', () => {
    // Chains and RPC Providers build their heading in a view template, so
    // before that paints the section carries no heading at all — only the
    // `data-title` it is named by meanwhile, listed under its entry.
    const entries = index();
    for (const [id, title] of [
      ['chains', 'Chains'],
      ['rpc', 'RPC Providers'],
    ]) {
      expect(SOURCE).toContain(
        `<section class="section panel" id="${id}" data-nav="networks" data-title="${title}">`
      );
      expect(entries.find((entry) => entry.sectionId === id)).toMatchObject({
        label: title,
        section: `Networks › ${title}`,
      });
    }
    const bare = buildSettingsSearchIndex(CONTENT, { skip: [RESULTS_PANEL] });
    expect(bare.find((entry) => entry.sectionId === 'chains').label).toBe('chains');
  });

  test('attributes every row to the section it is actually in, not the one you would guess', () => {
    const entries = index();
    const attribution = (label) =>
      entries.find((entry) => entry.label === label && entry.label !== entry.section)?.section;
    // The finding #281 was about Tor's startup toggle sitting under
    // Experimental, not Startup; #275 moved it, and the result says where.
    expect(attribution('Start Tor when Freedom opens')).toBe('Nodes › Startup');
    expect(attribution('Enable Tor (.onion access) Beta')).toBe('Advanced');
    expect(attribution('Theme')).toBe('Appearance');
    expect(attribution('Show IPFS load progress in the status bar')).toBe('Appearance');
    expect(attribution('Swarm publishing')).toBe('Nodes');
    expect(attribution('Block ads')).toBe('Privacy and security › Ad Blocking');
    expect(attribution('Prefer verified answers')).toBe('Networks › Name Resolution');
    expect(attribution('Automatically check for updates')).toBe('About Freedom › Updates');
    // #87's status row (the running version, Check now) is part of About's
    // Updates panel too.
    expect(attribution('Freedom')).toBe('About Freedom › Updates');
  });

  test('a section keeps its intro copy, and a row keeps the help under its own label', () => {
    const entries = index();
    const shortcuts = entries.find((entry) => entry.sectionId === 'shortcuts');
    expect(shortcuts.help).toContain('press the new key combination');
    // …and that intro does not leak onto the section's rows.
    const row = entries.find(
      (entry) => entry.sectionId === 'adblock' && entry.label === 'Block ads'
    );
    expect(row.help).not.toContain('press the new key combination');
    expect(entries.find((entry) => entry.label === 'Theme').help).toBe(
      'Applies to both the browser chrome and internal pages.'
    );
  });

  test('skips the result list itself, so a search cannot index its own output', () => {
    expect(SOURCE).toContain(`id="${RESULTS_PANEL}"`);
    expect(index().some((entry) => entry.sectionId === RESULTS_PANEL)).toBe(false);
    // Without the skip it would be in there — the guard is load-bearing.
    const unskipped = buildSettingsSearchIndex(CONTENT, { sectionLabels: PANEL_LABELS });
    expect(unskipped.some((entry) => entry.sectionId === RESULTS_PANEL)).toBe(true);
  });

  test('ignores a row this build has switched off', () => {
    // How the page hides the two `[data-tor]` rows when no Arti binary is
    // bundled, and the `[data-linux-only]` row off Linux: `style.display`.
    // Searching up a setting that is not there would jump to nothing.
    expect(SOURCE).toContain(".forEach((el) => (el.style.display = 'none'));");
    const fragment = parseFragment(
      '<section class="section" id="demo"><h2 class="section-title">Demo</h2>' +
        '<div class="card">' +
        '<div class="row" style="display: none"><div class="row-body">' +
        '<p class="row-label">Switched off</p></div></div>' +
        '<div class="row"><div class="row-body"><p class="row-label">Live</p></div></div>' +
        '</div></section>'
    );
    expect(buildSettingsSearchIndex(fragment).map((entry) => entry.label)).toEqual([
      'Demo',
      'Live',
    ]);
  });

  test('indexes the resolver rows too, which carry no `.row` class', () => {
    // Name Resolution's method list and a chain's read order are rendered as
    // `.resolver-method`, and they are where "Colibri", "RPC quorum" and
    // "Myotis" are named. Those views are built from IPC state, so the shape
    // is pinned here and the live rows in `test-e2e/settings.spec.js`.
    expect(SOURCE).toContain('<div class="resolver-method');
    const fragment = parseFragment(
      '<section class="section" id="ens"><h2 class="section-title">Name Resolution</h2>' +
        '<div class="card"><div class="resolver-list">' +
        '<div class="resolver-method" data-method="colibri"><span class="resolver-rank">2</span>' +
        '<div class="row-body"><div class="resolver-title-line">' +
        '<p class="row-label">Colibri</p><span class="resolver-badge">Ready</span></div>' +
        '<p class="row-help">Verifies the answer against a light-client proof.</p>' +
        '</div></div></div></div></section>'
    );
    const entries = buildSettingsSearchIndex(fragment);
    expect(entries.map((entry) => entry.label)).toEqual(['Name Resolution', 'Colibri']);
    expect(matchSettingsSearch(entries, 'colibri')[0]).toMatchObject({
      label: 'Colibri',
      section: 'Name Resolution',
      rank: 0,
    });
    expect(matchSettingsSearch(entries, 'light-client')[0]).toMatchObject({
      label: 'Colibri',
      rank: 2,
    });
  });

  test('ignores a row switched off through the `hidden` attribute as well', () => {
    // The other way this page switches a row off: the two Myotis startup rows
    // are hidden with the IDL property on a build where Myotis is
    // unsupported, which writes the attribute rather than `style.display`.
    // Offered as a result, they would open Startup and mark an invisible row.
    expect(SOURCE).toContain('launchRow.hidden = !supported;');
    expect(SOURCE).toContain('gnosisLaunchRow.hidden = !supported;');
    const fragment = parseFragment(
      '<section class="section" id="startup"><h2 class="section-title">Startup</h2>' +
        '<div class="card">' +
        '<div class="row" id="myotis-launch-row" hidden><div class="row-body">' +
        '<p class="row-label">Start Ethereum node</p></div></div>' +
        '<div class="row"><div class="row-body"><p class="row-label">Live</p></div></div>' +
        '</div></section>'
    );
    expect(buildSettingsSearchIndex(fragment).map((entry) => entry.label)).toEqual([
      'Startup',
      'Live',
    ]);
    // …and a class called `hidden`, or an `aria-hidden` decoration, is not
    // that attribute and must not take a row out of the index.
    const decorated = parseFragment(
      '<section class="section" id="startup"><h2 class="section-title">Startup</h2>' +
        '<div class="card"><div class="row" aria-hidden="false"><div class="row-body">' +
        '<p class="row-label">Still here</p></div></div></div></section>'
    );
    expect(buildSettingsSearchIndex(decorated).map((entry) => entry.label)).toContain('Still here');
  });

  test('indexes the config panel a resolver method keeps in its Advanced disclosure', () => {
    // Colibri's proof server and the quorum agreement threshold are the two
    // settings of the resolution policy itself. Since #270 they render as a
    // `.resolver-config` panel *inside* the method row's collapsed Advanced
    // disclosure — the one place a row nests in another — so the index has
    // to go on into a row for the rows inside it, and an index that stopped
    // at the method would answer "threshold" with nothing at all.
    expect(SOURCE).toContain('<div class="resolver-config" data-method-config="colibri">');
    expect(SOURCE).toContain('<div class="resolver-config" data-method-config="quorum">');
    expect(SOURCE).toContain('<p class="row-label">Proof server</p>');
    expect(SOURCE).toContain('<p class="row-label">Agreement threshold</p>');
    expect(SOURCE).toContain('extra: configRow');
    const fragment = parseFragment(
      '<section class="section" id="ens"><h2 class="section-title">Name Resolution</h2>' +
        '<div class="card"><div class="resolver-list">' +
        '<div class="resolver-method" data-method="quorum"><div class="row-body">' +
        '<div class="resolver-title-line"><p class="row-label">Several servers must agree</p></div>' +
        '<details class="row-advanced" data-advanced="quorum"><summary>Advanced</summary>' +
        '<p class="row-help">RPC quorum — several endpoints must agree.</p>' +
        '<div class="resolver-config" data-method-config="quorum">' +
        '<div class="resolver-config-line"><div class="row-body">' +
        '<p class="row-label">Agreement threshold</p>' +
        '<p class="row-help">How many servers must give the same answer.</p>' +
        '</div></div></div>' +
        '</details></div></div>' +
        '</div></div></section>'
    );
    const entries = buildSettingsSearchIndex(fragment);
    expect(entries.map((entry) => entry.label)).toEqual([
      'Name Resolution',
      'Several servers must agree',
      'Agreement threshold',
    ]);
    expect(matchSettingsSearch(entries, 'agreement')[0]).toMatchObject({
      label: 'Agreement threshold',
      section: 'Name Resolution',
      rank: 0,
    });
    // The method row's help does not swallow the panel nested in it, the way
    // a `.row-help` belongs to its own row everywhere else on the page…
    expect(entries.find((entry) => entry.label === 'Several servers must agree').help).toBe(
      'RPC quorum — several endpoints must agree.'
    );
    expect(entries.find((entry) => entry.label === 'Agreement threshold').help).toBe(
      'How many servers must give the same answer.'
    );
    // …but it does carry the collapsed technical text, so the name the row
    // went by before #270 still finds it.
    expect(matchSettingsSearch(entries, 'rpc quorum').map((hit) => hit.label)).toEqual([
      'Several servers must agree',
    ]);
  });

  test('a row nested in a switched-off row is switched off with it', () => {
    const fragment = parseFragment(
      '<section class="section" id="ens"><h2 class="section-title">Name Resolution</h2>' +
        '<div class="resolver-method" hidden><div class="row-body">' +
        '<p class="row-label">Proof check</p>' +
        '<details class="row-advanced"><div class="resolver-config"><div class="row-body">' +
        '<p class="row-label">Proof server</p></div></div></details>' +
        '</div></div></section>'
    );
    expect(buildSettingsSearchIndex(fragment).map((entry) => entry.label)).toEqual([
      'Name Resolution',
    ]);
  });

  test('numbers same-labelled rows so a jump can tell them apart', () => {
    // A chain's detail page lists "One server, unchecked" (Direct RPC) twice —
    // once in its read and verification order, once in its transaction
    // broadcast order. The reveal
    // re-finds the row after the view has repainted, so a result has to carry
    // which of the two it is or both jump to the first.
    expect(SOURCE).toContain("accessRows(cid, 'read', readOrder)");
    expect(SOURCE).toContain("accessRows(cid, 'broadcast', broadcastOrder)");
    const method = (kind, label) =>
      `<div class="resolver-method" data-access-kind="${kind}"><div class="row-body">` +
      `<p class="row-label">${label}</p></div></div>`;
    const fragment = parseFragment(
      '<section class="section" id="chains"><h2 class="section-title">Ethereum</h2>' +
        `<div class="card">${method('read', 'Local node')}${method('read', 'One server, unchecked')}</div>` +
        `<div class="card">${method('broadcast', 'One server, unchecked')}</div>` +
        '</section>'
    );
    const entries = buildSettingsSearchIndex(fragment);
    expect(
      entries
        .filter((entry) => entry.label === 'One server, unchecked')
        .map((entry) => entry.labelIndex)
    ).toEqual([0, 1]);
    // The first of a label is 0, not undefined — `locateRow` indexes with it.
    expect(entries.find((entry) => entry.label === 'Local node').labelIndex).toBe(0);
    // And the numbering is per section, so an unrelated section's same label
    // would start over at 0 rather than continuing this one's count.
    expect(entries.filter((entry) => entry.labelIndex === 0)).toHaveLength(2);
  });

  test('ignores a row with no label of its own', () => {
    const fragment = parseFragment(
      '<section class="section" id="demo"><h2 class="section-title">Demo</h2>' +
        '<div class="card"><div class="row"><div class="row-body">' +
        '<p class="row-label">Labelled</p></div></div>' +
        '<div class="row"><div class="row-control"><button>Do</button></div></div>' +
        '</div></section>'
    );
    expect(buildSettingsSearchIndex(fragment).map((entry) => entry.label)).toEqual([
      'Demo',
      'Labelled',
    ]);
  });

  test('indexes the chain master list, where a chain is the only thing named', () => {
    // Chains renders its list as `.net-row` buttons carrying `.net-row-name`
    // / `.net-row-sub` instead of the `.row-label` / `.row-help` pair the
    // rest of the page uses. A custom chain the user added exists nowhere
    // else in this page's markup, so an index blind to these rows answers
    // "base" with "No settings match".
    expect(SOURCE).toContain('<span class="net-row-name">');
    expect(SOURCE).toContain('<span class="net-row-sub">');
    const netRow = (name, sub) =>
      `<button type="button" class="net-row" data-action="open-chain"><span class="net-row-text">` +
      `<span class="net-row-name">${name}</span><span class="net-row-sub">${sub}</span></span>` +
      '<span class="net-chevron">›</span></button>';
    const fragment = parseFragment(
      '<section class="section" id="chains"><div id="chains-view">' +
        '<h2 class="section-title">Chains</h2>' +
        `<div class="card">${netRow('Gnosis', 'chain 100')}${netRow('Base', 'chain 8453')}</div>` +
        '</div></section>'
    );
    const entries = buildSettingsSearchIndex(fragment);
    expect(entries.map((entry) => entry.label)).toEqual(['Chains', 'Gnosis', 'Base']);
    expect(matchSettingsSearch(entries, 'base')[0]).toMatchObject({
      label: 'Base',
      section: 'Chains',
      rank: 0,
    });
    // The sub-line describes the row, the way a `.row-help` does — so a
    // chain is findable by its id as well as by its name.
    expect(entries.find((entry) => entry.label === 'Gnosis').help).toBe('chain 100');
    expect(matchSettingsSearch(entries, 'chain 8453')[0]).toMatchObject({
      label: 'Base',
      rank: 2,
    });
  });

  test('leaves out markup marked as not a setting, and everything under it', () => {
    // `settings-search-skip`: Site Permissions' empty and error states are
    // status messages written as rows ("No saved permissions"), and offering
    // one as a result jumps to and accent-marks a sentence.
    expect(SOURCE).toContain('<div class="row settings-search-skip">');
    const fragment = parseFragment(
      '<section class="section" id="permissions"><h2 class="section-title">Site Permissions</h2>' +
        '<div class="card"><div class="row settings-search-skip"><div class="row-body">' +
        '<p class="row-label">No saved permissions</p>' +
        '<p class="row-help">Sites you allow or block appear here.</p>' +
        '</div></div></div></section>'
    );
    expect(buildSettingsSearchIndex(fragment).map((entry) => entry.label)).toEqual([
      'Site Permissions',
    ]);
    expect(matchSettingsSearch(buildSettingsSearchIndex(fragment), 'saved permissions')).toEqual(
      []
    );
  });

  test('a marked wrapper hides a whole transient view, heading included', () => {
    // The in-place add-a-chain flow renders into the Chains section without a
    // hash of its own, so while it is open its `<h2>` is the only
    // `.section-title` that section has: unmarked, "chains" stops finding
    // Chains and "add a chain" offers a form as a section to open.
    expect(SOURCE).toContain('<div class="settings-search-skip">');
    expect(SOURCE).toContain('<h2 class="section-title">Add a chain</h2>');
    const fragment = parseFragment(
      '<section class="section" id="chains"><div id="chains-view">' +
        '<div class="settings-search-skip">' +
        '<h2 class="section-title">Add a chain</h2>' +
        '<p class="row-help">Search the public chain catalogue.</p>' +
        '<div class="card"><div class="row"><div class="row-body">' +
        '<p class="row-label">Chain ID</p></div></div></div>' +
        '</div></div></section>'
    );
    const entries = buildSettingsSearchIndex(fragment, { sectionLabels: { chains: 'Chains' } });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ sectionId: 'chains', label: 'Chains', help: '' });
    expect(matchSettingsSearch(entries, 'chains')[0].label).toBe('Chains');
    expect(matchSettingsSearch(entries, 'add a chain')).toEqual([]);
  });
});

describe('matchSettingsSearch', () => {
  test('an empty or whitespace query matches nothing', () => {
    expect(search('')).toEqual([]);
    expect(search('   ')).toEqual([]);
    expect(matchSettingsSearch(index(), undefined)).toEqual([]);
  });

  test('case-insensitive substring, and no fuzzy matching', () => {
    const lower = labelsOf(search('tor'));
    expect(labelsOf(search('TOR'))).toEqual(lower);
    expect(labelsOf(search('  ToR  '))).toEqual(lower);
    expect(lower).toContain('Enable Tor (.onion access) Beta');
    expect(lower).toContain('Start Tor when Freedom opens');
    // A transposition is a miss, not a near-match.
    expect(search('tro')).toEqual([]);
  });

  test('ranks a label the query starts above one that contains it, and both above help text', () => {
    const results = search('tor');
    const ranks = new Map(results.map((result) => [result.label, result.rank]));
    // "Tor" opens neither label, so both toggles rank as label-substring…
    expect(ranks.get('Enable Tor (.onion access) Beta')).toBe(1);
    expect(ranks.get('Start Tor when Freedom opens')).toBe(1);
    // …and every help-text-only hit sorts after them.
    expect(results.map((result) => result.rank)).toEqual(
      [...results.map((result) => result.rank)].sort((a, b) => a - b)
    );
    const firstHelpHit = results.findIndex((result) => result.rank === 2);
    const lastLabelHit = results.map((result) => result.rank).lastIndexOf(1);
    expect(firstHelpHit).toBeGreaterThan(lastLabelHit);

    // A prefix beats a substring: "Block ads" opens with the query, the
    // three "Block …" siblings and "Ad Blocking" only contain it.
    const blocking = search('block a');
    expect(blocking[0].label).toBe('Block ads');
    expect(blocking[0].rank).toBe(0);
  });

  test('the section a setting is in is searchable too, and answers first', () => {
    const results = search('downloads');
    expect(results[0].label).toBe('Downloads');
    expect(results[0].sectionId).toBe('downloads');
    expect(results[0].rank).toBe(0);
    // Its rows are not dragged in by their section's name — the section
    // entry is the answer to "where is Downloads". Every other hit in that
    // section earned its place in its own label or help line.
    for (const result of results.filter((entry) => entry.sectionId === 'downloads').slice(1)) {
      expect(`${result.label} ${result.help}`.toLowerCase()).toContain('downloads');
    }
    expect(search('advanced').filter((entry) => entry.sectionId === 'experimental')).toHaveLength(
      1
    );
  });

  test('ties keep document order, so results read the way the page does', () => {
    const order = index().map((entry) => entry.label);
    const results = search('e'); // matches nearly everything
    const ranked = results.filter((result) => result.rank === 1).map((result) => result.label);
    const expected = order.filter((label) => ranked.includes(label));
    expect(ranked).toEqual(expected.filter((label, i) => expected.indexOf(label) === i));
  });

  test('every match is listed — no silent top-N', () => {
    const entries = index();
    const query = 'e';
    const matching = entries.filter(
      (entry) =>
        entry.label.toLowerCase().includes(query) ||
        (entry.help || '').toLowerCase().includes(query)
    );
    expect(matchSettingsSearch(entries, query)).toHaveLength(matching.length);
    expect(matching.length).toBeGreaterThan(30);
  });

  test('a real query that needs the help text: "restart" is in no label', () => {
    const results = search('restart');
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((result) => result.rank === 2)).toBe(true);
    expect(labelsOf(results)).toContain('Tabs in title bar');
  });
});

// ---------------------------------------------------------------------------
// What docs/features.md promises the field does.
// ---------------------------------------------------------------------------

// The index is the live DOM, so what it can answer for is whatever each
// section currently has painted. That is invisible for the sections whose
// rows are static markup, and it is the whole story for the chain master list:
// a chain is named on this page only as a `.net-row`, and Chains replaces that
// list with a chain's own page or with the add-chain form. So "a chain is
// findable by its own name" holds in list state and nowhere else, and the
// feature doc has to say which — an unscoped claim reads as "search cannot
// find the chain I am looking at", the exact silent miss the field exists to
// stop. The gap self-heals on leaving Chains, which is what makes documenting
// it the right answer rather than a second, cached source of chain names.
describe('docs/features.md "Search settings"', () => {
  const DOC_PATH = path.join(__dirname, '..', '..', '..', 'docs', 'features.md');
  const bullet = fs
    .readFileSync(DOC_PATH, 'utf8')
    .split('\n')
    .find((line) => line.startsWith('- **Search settings**:'));

  test('the bullet is there to be checked', () => {
    expect(bullet).toBeTruthy();
  });

  test('it scopes the chain-by-name claim to the list the rows live in', () => {
    expect(bullet).toMatch(/chain is findable by its own name from the Chains list/i);
    // …and says when it is not, naming both views that replace that list.
    expect(bullet).toMatch(/add-chain form/i);
    expect(bullet).toMatch(/not while/i);
  });

  test('the two searches on the page are still told apart', () => {
    expect(bullet).toMatch(/Shortcuts section keeps its own search field/i);
  });
});

// The release notes describe the same field to the same reader, so they must
// not promise more than the feature doc above: a CHANGELOG that promises every
// setting unconditionally sends a user searching a chain's name from that
// chain's own page straight into "No settings match". The scope itself lives in
// docs/features.md; the release edit condenses the entry, so this checks only
// that the condensed text makes no unconditional "every/all" promise.
describe('CHANGELOG "Settings search" entry', () => {
  const CHANGELOG_PATH = path.join(__dirname, '..', '..', '..', 'CHANGELOG.md');
  const lines = fs.readFileSync(CHANGELOG_PATH, 'utf8').split('\n');
  const start = lines.findIndex((line) =>
    /^- (Settings search|A "Search settings" field)/.test(line)
  );
  // The entry is that bullet plus its own indented sub-bullets.
  const entry = lines.slice(start + 1).findIndex((line) => !line.startsWith('  '));
  const text = start === -1 ? '' : lines.slice(start, start + 1 + entry).join('\n');

  test('the entry is there to be checked', () => {
    expect(start).toBeGreaterThan(-1);
  });

  test('it does not promise every setting unconditionally', () => {
    expect(text).not.toMatch(/\b(every|all) (setting|section)s?\b/i);
  });
});

// ---------------------------------------------------------------------------
// Where a revealed result is scrolled to.
// ---------------------------------------------------------------------------

describe('settingsSearchScrollBlock', () => {
  const sized = (height, tagName = 'DIV') => ({
    tagName,
    getBoundingClientRect: () => ({ height }),
  });

  test('a row is centred, with its neighbours around it', () => {
    expect(settingsSearchScrollBlock(sized(64), 712)).toBe('center');
    // Right up to the point where it stops fitting.
    expect(settingsSearchScrollBlock(sized(712), 712)).toBe('center');
  });

  // The bug: `center` lines an element's own middle up with the viewport's, so
  // a section taller than the window lands with the `<h2>` that names it above
  // the fold — `#ens` is 845px against a 712px viewport.
  test('a section entry is aligned to its top, so its heading stays on screen', () => {
    expect(settingsSearchScrollBlock(sized(845, 'SECTION'), 712)).toBe('start');
    // A section entry reveals a place, so its title leads the view whether or
    // not the section happens to fit today.
    expect(settingsSearchScrollBlock(sized(200, 'SECTION'), 712)).toBe('start');
  });

  test('so is any other element too tall to fit, section or not', () => {
    expect(settingsSearchScrollBlock(sized(713), 712)).toBe('start');
  });

  test('an element it cannot measure is centred rather than throwing', () => {
    expect(settingsSearchScrollBlock(null, 712)).toBe('center');
    expect(settingsSearchScrollBlock({ tagName: 'DIV' }, 712)).toBe('center');
  });
});
