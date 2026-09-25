/**
 * Hash → section routing for `src/renderer/pages/settings.html` (#280).
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
 * inline classic script, so the routing block is lifted out of the shipped
 * source between the markers it keeps for this, and driven directly. The
 * block's only free names are `SECTIONS`, `DEFAULT_SECTION`, `location`,
 * `history` and `showSection`, so a fake `location`/`history` pair modelling
 * what a browser does with `replaceState` is enough to drive the real code —
 * this repo has no jsdom. `test-e2e/settings.spec.js` drives the same code in
 * the running app, including the address bar it feeds.
 */

const fs = require('fs');
const path = require('path');

const SOURCE = fs.readFileSync(path.join(__dirname, 'settings.html'), 'utf8');

const START = '/* settings-hash routing: start */';
const END = '/* settings-hash routing: end */';

function loadRouting({ hash, sections, defaultSection }) {
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
    'location',
    'history',
    'showSection',
    `${body}\nreturn { resolveSection, canonicalizeHash, applyHashSection };`
  )(sections, defaultSection, location, history, (section) => shown.push(section));

  return { ...routing, location, replaced, shown };
}

/** The `data-target` of every nav item the shipped page renders, in order. */
const shippedSections = () =>
  [...SOURCE.matchAll(/<button[^>]*class="nav-item"[^>]*data-target="([a-z]+)"/g)].map(
    ([, target]) => target
  );

const drive = (hash, sections = shippedSections()) => {
  const routing = loadRouting({ hash, sections, defaultSection: sections[0] });
  routing.applyHashSection();
  return routing;
};

describe('settings hash routing', () => {
  it('reads the shipped page as a real 14-section nav', () => {
    const sections = shippedSections();
    expect(sections.length).toBeGreaterThanOrEqual(10);
    expect(sections[0]).toBe('appearance');
    expect(sections).toEqual(expect.arrayContaining(['chains', 'shortcuts', 'nodes']));
    // The section the bug report used has to genuinely not be one.
    expect(sections).not.toContain('privacy');
  });

  // ── The bug: a hash naming no section (#280) ───────────────────────────
  it('rewrites a hash that names no section to the section it shows', () => {
    const { location, replaced, shown } = drive('#privacy');
    expect(shown).toEqual(['appearance']);
    expect(replaced).toEqual(['#appearance']);
    expect(location.hash).toBe('#appearance');
  });

  it('rewrites a sub-route under an unknown section too', () => {
    const { location, shown } = drive('#privacy/cookies');
    expect(shown).toEqual(['appearance']);
    expect(location.hash).toBe('#appearance');
  });

  it('names the section on an empty hash', () => {
    const { location, replaced } = drive('');
    expect(replaced).toEqual(['#appearance']);
    expect(location.hash).toBe('#appearance');
  });

  it('settles in one pass — the rewritten hash is itself canonical', () => {
    const routing = loadRouting({
      hash: '#nonsense',
      sections: shippedSections(),
      defaultSection: 'appearance',
    });
    routing.applyHashSection();
    routing.applyHashSection();
    expect(routing.replaced).toEqual(['#appearance']);
    expect(routing.shown).toEqual(['appearance', 'appearance']);
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

  it('leaves a sub-route of a real section alone', () => {
    for (const hash of ['#chains/1', '#chains/424242', '#chains/']) {
      const { location, replaced, shown } = drive(hash);
      expect(shown).toEqual(['chains']);
      expect(replaced).toEqual([]);
      expect(location.hash).toBe(hash);
    }
  });

  it('treats a differently-cased hash as canonical rather than rewriting it', () => {
    const { location, replaced } = drive('#Chains/1');
    expect(replaced).toEqual([]);
    expect(location.hash).toBe('#Chains/1');
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
    expect(block).toContain('canonicalizeHash(section);');
    expect(block).toContain('showSection(section);');
  });
});
