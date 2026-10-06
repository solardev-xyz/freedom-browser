/**
 * Hash → section routing for `src/renderer/pages/settings.html` (#280, #268).
 *
 * The settings page is hash-routed and the outer chrome renders that hash as
 * `freedom://settings/<section>`, so the hash is what the address bar says
 * the user is looking at. Until #280 it was normalized exactly once, on first
 * load: every later arrival — a stale bookmark opened in an existing Settings
 * tab, a typo, a link from an older build — left a hash naming a section that
 * has never existed standing over the Appearance section the page fell back
 * to. `applyHashSection` is now the single path for both, so the two can no
 * longer disagree.
 *
 * Same extraction approach as `settings-search.test.js`: the page is one
 * classic script, so the routing block is lifted out of the shipped
 * source between the markers it keeps for this, and driven directly. The
 * block's only free names are `SECTIONS`, `DEFAULT_SECTION`, `PANEL_NAV`,
 * `location`, `history` and `showSection`, so a fake `location`/`history` pair modelling
 * what a browser does with `replaceState` is enough to drive the real code —
 * this repo has no jsdom. `test-e2e/settings.spec.js` drives the same code in
 * the running app, including the address bar it feeds.
 *
 * #268 regrouped 14 flat nav entries into 10, several of which own more than
 * one panel, so every hash the page answered to before — bookmarks, history,
 * and the app's own `freedom://settings/rpc` deep link — is pinned below to
 * the entry and panel it lands on now.
 */

const fs = require('fs');
const path = require('path');

// The page's markup plus the classic script it loads (`scripts/settings.js`,
// moved out of an inline <script> by #432 so the CSP can drop 'unsafe-inline').
const SOURCE = [
  fs.readFileSync(path.join(__dirname, 'settings.html'), 'utf8'),
  fs.readFileSync(path.join(__dirname, 'scripts', 'settings.js'), 'utf8'),
].join('\n');

const START = '/* settings-hash routing: start */';
const END = '/* settings-hash routing: end */';

function loadRouting({ hash, sections, defaultSection, panelNav }) {
  const start = SOURCE.indexOf(START);
  const end = SOURCE.indexOf(END);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  const body = SOURCE.slice(start + START.length, end);

  const replaced = [];
  const shown = [];
  // `replaceState` rewrites the URL the page reads back, which is the whole
  // point of the fix — model that rather than only recording the call.
  const location = { hash };
  const history = {
    replaceState(state, title, url) {
      replaced.push(url);
      location.hash = url;
    },
  };
  const routing = new Function(
    'SECTIONS',
    'DEFAULT_SECTION',
    'PANEL_NAV',
    'location',
    'history',
    'showSection',
    `${body}\nreturn { resolveRoute, resolveSection, canonicalizeHash, applyHashSection, LEGACY_ROUTES };`
  )(sections, defaultSection, panelNav, location, history, (route) => shown.push(route));

  return { ...routing, location, replaced, shown };
}

/** The `data-target` of every nav item the shipped page renders, in order. */
const shippedSections = () =>
  [...SOURCE.matchAll(/<button[^>]*class="nav-item"[^>]*data-target="([a-z]+)"/g)].map(
    ([, target]) => target
  );

/** Every panel the shipped page renders → the nav entry it names in `data-nav`. */
const shippedPanels = () =>
  Object.fromEntries(
    [...SOURCE.matchAll(/<section class="section[^"]*" id="([a-z]+)" data-nav="([a-z]+)"/g)].map(
      ([, id, nav]) => [id, nav]
    )
  );

const drive = (hash) => {
  const sections = shippedSections();
  const routing = loadRouting({
    hash,
    sections,
    defaultSection: sections[0],
    panelNav: shippedPanels(),
  });
  routing.applyHashSection();
  return routing;
};

describe('settings hash routing', () => {
  it('reads the shipped page as the grouped 10-entry nav (#268)', () => {
    expect(shippedSections()).toEqual([
      'profile',
      'appearance',
      'search',
      'downloads',
      'shortcuts',
      'privacy',
      'networks',
      'nodes',
      'advanced',
      'about',
    ]);
    const panels = shippedPanels();
    // Every panel names a real entry, and every entry has a panel.
    expect(new Set(Object.values(panels))).toEqual(new Set(shippedSections()));
    expect(panels).toMatchObject({
      adblock: 'privacy',
      permissions: 'privacy',
      chains: 'networks',
      rpc: 'networks',
      ens: 'networks',
      nodes: 'nodes',
      startup: 'nodes',
      experimental: 'advanced',
      updates: 'about',
    });
  });

  // ── The bug: a hash naming no section (#280) ───────────────────────────
  it('rewrites a hash that names no section to the section it shows', () => {
    const { location, replaced, shown } = drive('#nonsense');
    expect(shown).toEqual(['profile']);
    expect(replaced).toEqual(['#profile']);
    expect(location.hash).toBe('#profile');
  });

  it('rewrites a sub-route under an unknown section too', () => {
    const { location, shown } = drive('#nonsense/cookies');
    expect(shown).toEqual(['profile']);
    expect(location.hash).toBe('#profile');
  });

  it('drops a sub-route an entry does not have back to the entry', () => {
    for (const [hash, route] of [
      ['#privacy/cookies', 'privacy'],
      ['#nodes/rpc', 'nodes'],
      ['#appearance/x', 'appearance'],
    ]) {
      const { location, shown } = drive(hash);
      expect(shown).toEqual([route]);
      expect(location.hash).toBe(`#${route}`);
    }
  });

  it('names the section on an empty hash', () => {
    const { location, replaced } = drive('');
    expect(replaced).toEqual(['#profile']);
    expect(location.hash).toBe('#profile');
  });

  it('settles in one pass — the rewritten hash is itself canonical', () => {
    for (const hash of ['#nonsense', '#rpc', '#chains/1', '#experimental']) {
      const routing = loadRouting({
        hash,
        sections: shippedSections(),
        defaultSection: 'profile',
        panelNav: shippedPanels(),
      });
      routing.applyHashSection();
      routing.applyHashSection();
      expect(routing.replaced).toHaveLength(1);
      expect(routing.shown[0]).toBe(routing.shown[1]);
    }
  });

  // ── Every hash from before #268 lands where it used to point ───────────
  // [old hash, the route it is rewritten to]. The route's first segment is
  // the nav entry that opens; a second names the panel brought to the top
  // (or, under Networks, the chain whose page opens).
  const LEGACY = [
    ['#appearance', 'appearance'],
    ['#search', 'search'],
    ['#profile', 'profile'],
    ['#nodes', 'nodes'],
    ['#startup', 'nodes/startup'],
    ['#downloads', 'downloads'],
    ['#shortcuts', 'shortcuts'],
    ['#chains', 'networks'],
    ['#chains/1', 'networks/1'],
    ['#chains/100', 'networks/100'],
    ['#chains/424242', 'networks/424242'],
    ['#chains/', 'networks'],
    ['#rpc', 'networks/rpc'],
    ['#ens', 'networks/ens'],
    ['#adblock', 'privacy'],
    ['#permissions', 'privacy/permissions'],
    ['#experimental', 'advanced'],
    ['#updates', 'about/updates'],
    // Case never mattered to the old router either.
    ['#RPC', 'networks/rpc'],
    ['#Chains/1', 'networks/1'],
  ];

  it.each(LEGACY)('%s lands on %s', (hash, route) => {
    const { location, shown } = drive(hash);
    expect(shown).toEqual([route]);
    expect(location.hash).toBe(`#${route}`);
  });

  it('covers every entry the 14-item nav had', () => {
    const old = [
      'appearance',
      'search',
      'profile',
      'nodes',
      'startup',
      'downloads',
      'shortcuts',
      'chains',
      'rpc',
      'ens',
      'adblock',
      'permissions',
      'experimental',
      'updates',
    ];
    const covered = LEGACY.map(([hash]) => hash.slice(1));
    expect(old.filter((id) => !covered.includes(id))).toEqual([]);
    // …and each lands on its own panel's entry, not on the fallback.
    const panels = shippedPanels();
    for (const id of old) {
      const [entry] = drive(`#${id}`).shown[0].split('/');
      expect(entry).toBe(panels[id]);
    }
  });

  it('keeps the legacy map pointing only at routes that exist', () => {
    const { LEGACY_ROUTES } = drive('');
    const panels = shippedPanels();
    for (const route of Object.values(LEGACY_ROUTES)) {
      const [entry, panel] = route.split('/');
      expect(shippedSections()).toContain(entry);
      if (panel) expect(panels[panel]).toBe(entry);
    }
  });

  // The chrome's own links into Settings use the current routes, so none of
  // them leans on the legacy map. #87's hamburger update row was written
  // against the 14-item nav (`settings/updates`) and is the one a merge
  // would most easily leave behind.
  it('every freedom://settings/<route> the app opens is already canonical', () => {
    const walk = (dir) =>
      fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : walk(full);
        return /\.js$/.test(entry.name) && !/\.test\.js$/.test(entry.name) ? [full] : [];
      });
    const root = path.join(__dirname, '..', '..');
    const routes = new Map();
    for (const file of walk(root)) {
      // settings.js names the legacy addresses in the comments that explain them.
      if (file.endsWith(path.join('pages', 'scripts', 'settings.js'))) continue;
      const text = fs.readFileSync(file, 'utf8');
      for (const [, route] of text.matchAll(/freedom:\/\/settings\/([a-z0-9/-]+)/gi)) {
        routes.set(route, path.relative(root, file));
      }
    }
    expect([...routes.keys()]).toEqual(expect.arrayContaining(['about/updates', 'networks/rpc']));
    for (const [route, file] of routes) {
      const { replaced, shown } = drive(`#${route}`);
      expect([file, route, replaced]).toEqual([file, route, []]);
      expect([file, shown]).toEqual([file, [route]]);
    }
  });

  // ── Deep links that were already right stay untouched ──────────────────
  it('leaves every section the page ships exactly as linked', () => {
    for (const section of shippedSections()) {
      const { location, replaced, shown } = drive(`#${section}`);
      expect(shown).toEqual([section]);
      expect(replaced).toEqual([]);
      expect(location.hash).toBe(`#${section}`);
    }
  });

  it('leaves a panel route of a real entry alone', () => {
    for (const [panel, entry] of Object.entries(shippedPanels())) {
      const hash = `#${entry}/${panel}`;
      const { location, replaced, shown } = drive(hash);
      expect(shown).toEqual([`${entry}/${panel}`]);
      expect(replaced).toEqual([]);
      expect(location.hash).toBe(hash);
    }
  });

  it('leaves a chain detail under Networks alone', () => {
    for (const hash of ['#networks/1', '#networks/424242']) {
      const { location, replaced, shown } = drive(hash);
      expect(shown).toEqual([hash.slice(1)]);
      expect(replaced).toEqual([]);
      expect(location.hash).toBe(hash);
    }
  });

  it('treats a differently-cased hash as canonical rather than rewriting it', () => {
    const { location, replaced } = drive('#Networks/1');
    expect(replaced).toEqual([]);
    expect(location.hash).toBe('#Networks/1');
  });

  it('resolveSection names the entry a hash opens', () => {
    const { resolveSection } = drive('');
    expect(resolveSection('#rpc')).toBe('networks');
    expect(resolveSection('#networks/1')).toBe('networks');
    expect(resolveSection('#permissions')).toBe('privacy');
    expect(resolveSection('#nope')).toBe('profile');
  });

  // ── The wiring: one path for load and for every later hash change ──────
  it('runs the same entry point on first load and on hashchange', () => {
    expect(SOURCE).toContain("window.addEventListener('hashchange', applyHashSection);");
    // The first-load call is the bare invocation right after that listener.
    expect(SOURCE).toMatch(
      /window\.addEventListener\('hashchange', applyHashSection\);\n\s*applyHashSection\(\);/
    );
    // And nothing shows a section behind the canonicalisation's back.
    const block = SOURCE.slice(SOURCE.indexOf(START), SOURCE.indexOf(END));
    expect(block).toContain('canonicalizeHash(route);');
    expect(block).toContain('showSection(route);');
  });
});
