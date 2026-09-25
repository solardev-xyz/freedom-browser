/**
 * `applyAdblockGating` (src/renderer/pages/settings.html), #274.
 *
 * With no filter lists the engine cannot run, so the Ad Blocking section
 * disables its toggles and says so once instead of leaving them live under a
 * status line that says blocking is inactive. The one exception is a control
 * whose switching-on is how lists can still arrive (the Swarm list updater
 * needs the master and auto-update switches on and at least one category):
 * that control must stay usable, or the section locks itself out for good.
 * And the auto-update switch is never frozen, so the user can always stop the
 * updater's background Swarm fetches.
 *
 * Same extraction approach as settings-tor-rows.test.js: the helper is lifted
 * out of the shipped inline script and evaluated with fake collaborators, so
 * the assertions run against the real code.
 */

const fs = require('fs');
const path = require('path');

const SOURCE = fs.readFileSync(path.join(__dirname, 'settings.html'), 'utf8');

function slice(start, end = '\n      };\n') {
  const from = SOURCE.indexOf(start);
  expect(from).toBeGreaterThanOrEqual(0);
  const to = SOURCE.indexOf(end, from);
  expect(to).toBeGreaterThan(from);
  return SOURCE.slice(from, to + end.length);
}

const fakeRow = () => {
  const classes = new Set();
  return {
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)),
      contains: (c) => classes.has(c),
    },
  };
};

const CATS = ['ads', 'privacy', 'cookies', 'annoyances'];

// Build the section (`checked`: control name → checkbox state), run the real
// gating once, and return control name → whether its input ended up disabled.
function section({ unavailable, checked }) {
  const names = ['enabled', ...CATS, 'autoupdate'];
  const rows = {};
  const inputs = {};
  for (const name of names) {
    rows[name] = fakeRow();
    inputs[name] = { checked: checked[name] === true, disabled: false };
  }
  const byId = Object.fromEntries(names.map((n) => [`adblock-${n}-row`, rows[n]]));
  const fields = { adblockEnabled: inputs.enabled, adblockAutoUpdate: inputs.autoupdate };
  const categories = CATS.map((id) => ({ id, field: inputs[id] }));

  const body = [
    slice('const setFieldEnabled = (checkbox, container, ...inputs) => {'),
    slice('const applyAdblockGating = () => {'),
  ].join('\n');
  const apply = new Function(
    'fields',
    '$',
    'ADBLOCK_CATEGORIES',
    'adblockUnavailable',
    `${body}\nreturn applyAdblockGating;`
  )(fields, (id) => byId[id], categories, unavailable);
  apply();

  const state = {};
  for (const name of names) {
    state[name] = {
      disabled: inputs[name].disabled,
      rowDisabled: rows[name].classList.contains('disabled'),
    };
    // The row's look and the input's state must always agree.
    expect(state[name].rowDisabled).toBe(state[name].disabled);
  }
  return Object.fromEntries(Object.entries(state).map(([k, v]) => [k, v.disabled]));
}

const DEFAULTS = {
  enabled: true,
  ads: true,
  privacy: true,
  cookies: false,
  annoyances: false,
  autoupdate: true,
};

describe('applyAdblockGating', () => {
  test('lists present: only the master switch gates the rows (unchanged)', () => {
    expect(section({ unavailable: false, checked: DEFAULTS })).toEqual({
      enabled: false,
      ads: false,
      privacy: false,
      cookies: false,
      annoyances: false,
      autoupdate: false,
    });
    expect(section({ unavailable: false, checked: { ...DEFAULTS, enabled: false } })).toEqual({
      enabled: false,
      ads: true,
      privacy: true,
      cookies: true,
      annoyances: true,
      autoupdate: true,
    });
  });

  test('no lists, default settings: the master and categories are disabled, auto-update is not', () => {
    // Auto-update stays usable so the updater's Swarm fetches can be stopped.
    expect(section({ unavailable: true, checked: DEFAULTS })).toEqual({
      enabled: true,
      ads: true,
      privacy: true,
      cookies: true,
      annoyances: true,
      autoupdate: false,
    });
  });

  test('no lists, master off: the master stays usable so the updater can run', () => {
    const state = section({ unavailable: true, checked: { ...DEFAULTS, enabled: false } });
    expect(state.enabled).toBe(false);
    for (const name of [...CATS, 'autoupdate']) expect(state[name]).toBe(true);
  });

  test('no lists, auto-update off: auto-update stays usable, the rest is frozen', () => {
    const state = section({ unavailable: true, checked: { ...DEFAULTS, autoupdate: false } });
    expect(state.autoupdate).toBe(false);
    expect(state.enabled).toBe(true);
    for (const name of CATS) expect(state[name]).toBe(true);
  });

  test('no lists, no category on: the categories stay usable, the rest is frozen', () => {
    const none = { ...DEFAULTS, ads: false, privacy: false };
    const state = section({ unavailable: true, checked: none });
    for (const name of CATS) expect(state[name]).toBe(false);
    expect(state.enabled).toBe(true);
    expect(state.autoupdate).toBe(false);
  });

  test('lists arriving re-enables everything the master allows', () => {
    // A second pass with lists present must undo the first pass's freeze.
    const names = ['enabled', ...CATS, 'autoupdate'];
    const rows = Object.fromEntries(names.map((n) => [n, fakeRow()]));
    const inputs = Object.fromEntries(
      names.map((n) => [n, { checked: DEFAULTS[n], disabled: false }])
    );
    const byId = Object.fromEntries(names.map((n) => [`adblock-${n}-row`, rows[n]]));
    const body = [
      slice('const setFieldEnabled = (checkbox, container, ...inputs) => {'),
      'let adblockUnavailable = true;',
      slice('const applyAdblockGating = () => {'),
    ].join('\n');
    const { apply, setUnavailable } = new Function(
      'fields',
      '$',
      'ADBLOCK_CATEGORIES',
      `${body}\nreturn { apply: applyAdblockGating, setUnavailable: (v) => (adblockUnavailable = v) };`
    )(
      { adblockEnabled: inputs.enabled, adblockAutoUpdate: inputs.autoupdate },
      (id) => byId[id],
      CATS.map((id) => ({ id, field: inputs[id] }))
    );

    apply();
    for (const n of names) expect(inputs[n].disabled).toBe(n !== 'autoupdate');
    setUnavailable(false);
    apply();
    for (const n of names) {
      expect(inputs[n].disabled).toBe(false);
      expect(rows[n].classList.contains('disabled')).toBe(false);
    }
  });
});

describe('renderAdblockStatus before the first engine build', () => {
  test('lists not yet resolved do not count as "no lists"', () => {
    const body = slice('const renderAdblockStatus = async () => {');
    expect(body).toContain('const listsPending = status.listsResolved === false;');
    expect(body).toMatch(/adblockUnavailable = !listsPending && /);
    expect(body).toContain("'Checking filter lists…'");
  });
});

describe('Ad Blocking copy (#274)', () => {
  test('the no-lists status states the consequence once', () => {
    expect(SOURCE).toContain("'No filter lists available. Ad blocking cannot run.'");
    expect(SOURCE).not.toContain('blocking is inactive');
  });

  test('category rows carry no filter-list brand names as helpers', () => {
    for (const id of CATS) {
      expect(SOURCE).toMatch(new RegExp(`<p class="row-help" id="adblock-${id}-help"></p>`));
    }
  });

  test('the attribution footnote links the EasyList authors', () => {
    expect(SOURCE).toMatch(
      /<a href="https:\/\/easylist\.to\/" target="_blank" rel="noreferrer">EasyList authors<\/a>/
    );
    expect(SOURCE).not.toContain('(https://easylist.to/)');
  });
});
