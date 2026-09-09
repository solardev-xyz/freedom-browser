/**
 * Copy and control-style guards for `src/renderer/pages/settings.html`.
 *
 * The settings-UX audit (`docs/audits/settings-ux-2026-09.md`) found the page
 * disagreeing with itself in ways no existing guard could see, because they
 * live in the markup's strings rather than in its CSS:
 *
 *   #272 an intro paragraph that said, permanently, what the empty state under
 *        it said again;
 *   #273 helper lines restating their label, and identical rows disagreeing on
 *        whether they get one at all;
 *   #276 two section headings that did not match the nav label that reached
 *        them;
 *   #278 `+` and `→` glyphs baked into some button labels and not their
 *        siblings, where they are part of the accessible name;
 *   #283 a sub-heading rendered as a row label with hand-written margins;
 *   #284 seven destructive actions split three/four with no rule behind it.
 *
 * Each of those is a string (or a class) that reads fine on its own and is only
 * wrong next to its siblings, so the sweeps below are written per *set* — every
 * nav item, every startup row, every button label, every removal — rather than
 * per site. `settings-styles.test.js` covers the same page's stylesheet;
 * `test-e2e/settings.spec.js` covers what the running app renders.
 */

const fs = require('fs');
const path = require('path');

const SOURCE = fs.readFileSync(path.join(__dirname, 'settings.html'), 'utf8');

/** Tag-stripped, whitespace-collapsed text of a markup fragment. */
const textOf = (html) =>
  html
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** The nav's `data-target` → its visible label. */
const navItems = () =>
  [...SOURCE.matchAll(/<button[^>]*class="nav-item"[^>]*data-target="([a-z]+)"[^>]*>([\s\S]*?)<\/button>/g)].map(
    ([, target, body]) => ({ target, label: textOf(body) })
  );

/** A static `<section id=…>` → the text of the `<h2 class="section-title">` it ships. */
const staticSectionTitles = () => {
  const titles = new Map();
  const sections = [...SOURCE.matchAll(/<section class="section" id="([a-z]+)">([\s\S]*?)<\/section>/g)];
  for (const [, id, body] of sections) {
    const heading = body.match(/<h2 class="section-title">([\s\S]*?)<\/h2>/);
    if (heading) titles.set(id, textOf(heading[1]));
  }
  return titles;
};

/** The body of one static `<section id=…>`. */
const section = (id) => {
  const match = SOURCE.match(new RegExp(`<section class="section" id="${id}">([\\s\\S]*?)</section>`));
  expect(match).not.toBeNull();
  return match[1];
};

/**
 * Every `<button>` label the page ships, static markup and view templates
 * alike — plus the labels passed to the two helpers that build a button
 * without writing a `<button>` tag at the call site. Both of those carried a
 * `+` glyph before #278, so a sweep that only read markup would have watched
 * the wrong half of the set.
 */
const buttonLabels = () => [
  ...[...SOURCE.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/g)]
    .map(([, body]) => textOf(body))
    .filter(Boolean),
  // `cardButton(label, action[, variant])` — a standalone action in its own card.
  ...[...SOURCE.matchAll(/cardButton\(\s*'([^']*)'/g)].map(([, label]) => label),
  // `showAction(label, onClick)` — the Swarm-mode row's inline action.
  ...[...SOURCE.matchAll(/showAction\(\s*'([^']*)'/g)].map(([, label]) => label),
];

describe('settings.html section headings match their nav label (#276)', () => {
  test('every nav item whose heading is in the markup agrees with it', () => {
    const titles = staticSectionTitles();
    const items = navItems();
    expect(items.length).toBe(14);

    // `chains` and `rpc` render their own `<h2>` from a view template, so they
    // are pinned end-to-end in `test-e2e/settings.spec.js` instead.
    const covered = items.filter((item) => titles.has(item.target));
    expect(covered.length).toBe(12);
    const mismatches = covered
      .filter((item) => titles.get(item.target) !== item.label)
      .map((item) => ({ nav: item.label, title: titles.get(item.target) }));
    expect(mismatches).toEqual([]);
  });

  test('the two headings the finding named carry the nav label, not the longer form', () => {
    const titles = staticSectionTitles();
    expect(titles.get('startup')).toBe('Startup');
    expect(titles.get('ens')).toBe('Name Resolution');
    expect(SOURCE).not.toContain('>Automatic Startup<');
    expect(SOURCE).not.toContain('>Ethereum Name Resolution<');
  });
});

describe('settings.html sub-headings use the house style (#283)', () => {
  test('Name Resolution has no heading rendered as a row label', () => {
    const ens = section('ens');
    for (const title of ['Resolution order', 'Safety']) {
      expect(ens).toContain(`<h3 class="subsection-title">${title}</h3>`);
    }
  });

  test('no heading anywhere on the page is an `h3.row-label`', () => {
    // `.row-label` is a *row* style, which is why the two ENS sub-headings
    // needed a hand-written `style="margin: …"` at each call site.
    expect([...SOURCE.matchAll(/<h3[^>]*class="row-label"/g)]).toEqual([]);
  });

  test('the sub-headings carry no inline margin override', () => {
    const headings = [...SOURCE.matchAll(/<h3[^>]*class="subsection-title"[^>]*>/g)].map(([tag]) => tag);
    expect(headings.length).toBeGreaterThanOrEqual(2);
    expect(headings.filter((tag) => tag.includes('style='))).toEqual([]);
  });
});

describe('settings.html button labels carry no glyphs (#278)', () => {
  test('no button label is prefixed with a literal `+`', () => {
    expect(buttonLabels().filter((label) => label.startsWith('+'))).toEqual([]);
  });

  test('no button or link label is suffixed with a literal `→`', () => {
    const anchors = [...SOURCE.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/g)].map(([, body]) => textOf(body));
    // The ENS method rows render their link text from a `linkLabel` field
    // rather than as markup, so it is swept from the registry too.
    const linkLabels = [...SOURCE.matchAll(/linkLabel:\s*'([^']*)'/g)].map(([, label]) => label);
    const labels = [...buttonLabels(), ...anchors, ...linkLabels];
    expect(labels.filter((label) => label.includes('→'))).toEqual([]);
    // …while prose is still free to spell a settings path with one.
    expect(SOURCE).toContain('Settings → Nodes');
  });

  test('the add buttons all read as the same control', () => {
    const labels = buttonLabels();
    for (const label of ['Add search engine', 'Add chain', 'Add RPC', 'Add', 'Add key']) {
      expect(labels).toContain(label);
    }
  });

  test('the chain-row chevron is decorative, so the row announces as the chain', () => {
    expect(SOURCE).toContain('<span class="net-chevron" aria-hidden="true">›</span>');
    expect(SOURCE).not.toMatch(/<span class="net-chevron">/);
  });
});

describe('settings.html destructive actions follow one rule (#284)', () => {
  // Danger: discards stored data and cannot be undone from this screen.
  // Plain: a single-row removal, one click from being re-added in the view it
  // was removed from. `docs/agent-playbooks/ui-consistency.md` carries the rule.
  test('the four data-discarding removals are the danger-styled ones', () => {
    expect(SOURCE).toMatch(/class="btn danger" id="permissions-revoke-all"/);
    expect(SOURCE).toMatch(/class="btn danger" data-action="revoke-origin"/);
    expect(SOURCE).toMatch(/class="btn danger" data-search-action="remove"/);
    expect(SOURCE).toContain("cardButton('Remove this chain', 'remove-chain', 'danger')");
  });

  test('the three re-addable removals are plain', () => {
    // A remembered permission, one at a time…
    expect(SOURCE).toMatch(/<button class="btn" data-action="revoke"/);
    // …an RPC endpoint…
    expect(SOURCE).toMatch(/<button type="button" class="btn" data-action="delete-source"/);
    // …and an ad-blocking allowlist host, whose button is built in JS.
    expect(SOURCE).toContain("removeBtn.className = 'btn';");
  });

  test('every destructive control says its verb rather than a glyph', () => {
    expect(SOURCE).not.toContain('✕');
    expect(buttonLabels()).toContain('Remove');
  });
});

describe('settings.html Site Permissions says it once (#272)', () => {
  test('the intro card is gone', () => {
    for (const phrase of [
      'Decisions you asked Freedom to remember',
      'Everything else is denied',
      'No stored site permissions',
    ]) {
      expect(SOURCE).not.toContain(phrase);
    }
  });

  test('one empty state, pointing at the checkbox that creates a row', () => {
    expect(SOURCE).toContain('<p class="row-label">No saved permissions</p>');
    expect(SOURCE).toMatch(/Sites you allow or block with\s+“Remember for this site” appear here\./);
  });

  test('`Remove all` sits beside the heading, where section-level actions live', () => {
    const permissions = section('permissions');
    expect(permissions).toMatch(
      /<div class="section-header">\s*<h2 class="section-title">Site Permissions<\/h2>\s*<button[^>]*id="permissions-revoke-all"[^>]*disabled>/
    );
    // Outside the list means it survives every re-render, so its enabled state
    // is set rather than re-created.
    expect(SOURCE).toContain('if (revokeAll) revokeAll.disabled = origins.length === 0;');
    expect(SOURCE).not.toContain('data-action="revoke-all"');
  });
});

describe('settings.html helper lines earn their place (#273)', () => {
  const startupHelpers = () => {
    const rows = [...section('startup').matchAll(/<div class="row-body">([\s\S]*?)<\/div>/g)];
    return rows.map(([, body]) => {
      const help = body.match(/<p class="row-help"[^>]*>([\s\S]*?)<\/p>/);
      return help ? textOf(help[1]) : null;
    });
  };

  test('the five startup rows agree on whether they get a helper, and what it says', () => {
    const helpers = startupHelpers();
    expect(helpers.length).toBe(5);
    expect(helpers).toEqual(Array(5).fill('Restart to apply.'));
  });

  test('the two Myotis rows say Beta in a badge instead of in a paragraph', () => {
    const startup = section('startup');
    for (const label of ['Start Ethereum node', 'Start Gnosis node']) {
      expect(startup).toMatch(
        new RegExp(`${label}\\s*<span class="resolver-badge">Beta</span>`)
      );
    }
    expect(SOURCE).not.toContain('light client (Myotis)');
    expect(SOURCE).not.toContain('Takes effect on next launch');
  });

  test('a helper that only restated its label is gone', () => {
    expect(section('profile')).toContain('<p class="row-label">Name</p>');
    expect(SOURCE).not.toContain('The display name for the current profile.');
    expect(SOURCE).not.toContain("Starts this profile's embedded Radicle node when Freedom opens.");
  });

  test('the two rewritten helpers add a fact the label does not carry', () => {
    // The destination, rather than a restatement of the toggle's off state…
    expect(section('downloads')).toContain('<p class="row-help">Otherwise: ~/Downloads</p>');
    // …and the scope of the exemption, without the reload caveat Chrome's own
    // exceptions list does not carry either.
    expect(section('adblock')).toContain(
      '<p class="row-help">Ad blocking is off on these sites and their subdomains.</p>'
    );
    expect(SOURCE).not.toContain('reload open tabs');
  });
});
