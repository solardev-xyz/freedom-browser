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
 *   #268 one nav entry grew several panels, each needing exactly one page
 *        heading between them and a panel heading for each;
 *   #284 seven destructive actions split three/four with no rule behind it;
 *   #269 the four network sources named and explained twice, differently, by
 *        Name Resolution and a chain's detail page;
 *   #270 Ethereum-internals jargon (quorum, prover, light client, beacon head,
 *        WNS/GNS, corpus.core) in the visible labels and helper lines.
 *
 * Each of those is a string (or a class) that reads fine on its own and is only
 * wrong next to its siblings, so the sweeps below are written per *set* — every
 * nav item, every startup row, every button label, every removal — rather than
 * per site. `settings-styles.test.js` covers the same page's stylesheet;
 * `test-e2e/settings.spec.js` covers what the running app renders.
 */

const fs = require('fs');
const path = require('path');

// The page's markup plus the classic script it loads (`scripts/settings.js`,
// moved out of an inline <script> by #432 so the CSP can drop 'unsafe-inline').
const SOURCE = [
  fs.readFileSync(path.join(__dirname, 'settings.html'), 'utf8'),
  fs.readFileSync(path.join(__dirname, 'scripts', 'settings.js'), 'utf8'),
].join('\n');

/** Tag-stripped, whitespace-collapsed text of a markup fragment. */
const textOf = (html) =>
  html
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** The nav's `data-target` → its visible label. */
const navItems = () =>
  [
    ...SOURCE.matchAll(
      /<button[^>]*class="nav-item"[^>]*data-target="([a-z]+)"[^>]*>([\s\S]*?)<\/button>/g
    ),
  ].map(([, target, body]) => ({ target, label: textOf(body) }));

/**
 * Every static panel `<section>` (#268: one nav entry can own several, each
 * naming its entry in `data-nav`) → its entry and body.
 */
const panels = () =>
  [
    ...SOURCE.matchAll(
      /<section class="section[^"]*" id="([a-z]+)" data-nav="([a-z]+)"[^>]*>([\s\S]*?)<\/section>/g
    ),
  ].map(([, id, nav, body]) => ({ id, nav, body }));

/** A nav entry → the text of every `<h2 class="section-title">` its panels ship. */
const entryTitles = () => {
  const titles = new Map();
  for (const { nav, body } of panels()) {
    for (const [, heading] of body.matchAll(/<h2 class="section-title">([\s\S]*?)<\/h2>/g)) {
      titles.set(nav, [...(titles.get(nav) || []), textOf(heading)]);
    }
  }
  return titles;
};

/** A panel → the text of the `<h3 class="panel-title">` it ships, if any. */
const panelTitle = (id) => {
  const heading = section(id).match(/<h3 class="panel-title">([\s\S]*?)<\/h3>/);
  return heading ? textOf(heading[1]) : null;
};

/** The body of one static `<section id=…>`. */
const section = (id) => {
  const match = panels().find((panel) => panel.id === id);
  expect(match).toBeDefined();
  return match.body;
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
  test('every nav entry carries exactly one page heading, and it is the nav label', () => {
    const titles = entryTitles();
    const items = navItems();
    expect(items.length).toBe(10);
    // One `<h2>` per entry however many panels it owns (#268) — a second
    // would put two page headings on one route.
    const mismatches = items
      .filter((item) => JSON.stringify(titles.get(item.target)) !== JSON.stringify([item.label]))
      .map((item) => ({ nav: item.label, titles: titles.get(item.target) }));
    expect(mismatches).toEqual([]);
  });

  test('every panel sharing an entry is named by a panel heading, not a second h2', () => {
    // The panels whose heading is in the markup; Chains and RPC Providers
    // render theirs from a view template, pinned end-to-end in
    // `test-e2e/settings.spec.js`.
    expect(panelTitle('adblock')).toBe('Ad Blocking');
    expect(panelTitle('permissions')).toBe('Site Permissions');
    expect(panelTitle('ens')).toBe('Name Resolution');
    expect(panelTitle('startup')).toBe('Startup');
    expect(panelTitle('updates')).toBe('Updates');
    expect(SOURCE).toContain('<h3 class="panel-title">Chains</h3>');
    expect(SOURCE).toContain('<h3 class="panel-title">RPC Providers</h3>');
  });

  test('the two headings the finding named carry the nav label, not the longer form', () => {
    expect(panelTitle('startup')).toBe('Startup');
    expect(panelTitle('ens')).toBe('Name Resolution');
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
    const headings = [...SOURCE.matchAll(/<h3[^>]*class="subsection-title"[^>]*>/g)].map(
      ([tag]) => tag
    );
    expect(headings.length).toBeGreaterThanOrEqual(2);
    expect(headings.filter((tag) => tag.includes('style='))).toEqual([]);
  });
});

describe('settings.html button labels carry no glyphs (#278)', () => {
  test('no button label is prefixed with a literal `+`', () => {
    expect(buttonLabels().filter((label) => label.startsWith('+'))).toEqual([]);
  });

  test('no button or link label is suffixed with a literal `→`', () => {
    // `</a\n>` is how Prettier wraps a long anchor; without `\s*` the match
    // runs on to the next anchor's `</a>` and sweeps the page in between.
    const anchors = [...SOURCE.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a\s*>/g)].map(([, body]) =>
      textOf(body)
    );
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
  test('the five data-discarding removals are the danger-styled ones', () => {
    expect(SOURCE).toMatch(/class="btn danger" id="permissions-revoke-all"/);
    expect(SOURCE).toMatch(/class="btn danger" data-action="revoke-origin"/);
    expect(SOURCE).toMatch(/class="btn danger" data-search-action="remove"/);
    expect(SOURCE).toContain("cardButton('Remove this chain', 'remove-chain', 'danger')");
    // A saved provider API key: write-only once stored, so "Add key" is a
    // fresh paste from the provider's dashboard, not an undo.
    expect(SOURCE).toMatch(/class="btn danger" data-action="remove-key"/);
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
    expect(SOURCE).toMatch(
      /Sites you allow or block with\s+“Remember for this site” appear here\./
    );
  });

  test('`Remove all` sits beside the heading, where section-level actions live', () => {
    const permissions = section('permissions');
    expect(permissions).toMatch(
      /<div class="section-header">\s*<h3 class="panel-title">Site Permissions<\/h3>\s*<button[^>]*id="permissions-revoke-all"[^>]*disabled>/
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

  test('the six startup rows agree on whether they get a helper, and what it says', () => {
    // Tor's joined the other five under Nodes in #275.
    const helpers = startupHelpers();
    expect(helpers.length).toBe(6);
    expect(helpers).toEqual(Array(6).fill('Restart to apply.'));
  });

  test('the two Myotis rows say Beta in a badge instead of in a paragraph', () => {
    const startup = section('startup');
    for (const label of ['Start Ethereum node', 'Start Gnosis node']) {
      expect(startup).toMatch(new RegExp(`${label}\\s*<span class="resolver-badge">Beta</span>`));
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

describe('settings.html Advanced holds only the experiments (#275)', () => {
  const rowLabels = (html) =>
    [...html.matchAll(/<p class="row-label">([\s\S]*?)<\/p>/g)].map(([, body]) => textOf(body));

  test('the two Beta features are all that is left, each badged rather than parenthesised', () => {
    const advanced = section('experimental');
    expect(rowLabels(advanced)).toEqual([
      'Enable Identity &amp; Wallet Beta',
      'Enable Tor (.onion access) Beta',
    ]);
    for (const label of ['Enable Identity &amp; Wallet', 'Enable Tor \\(\\.onion access\\)']) {
      expect(advanced).toMatch(new RegExp(`${label}\\s*<span class="resolver-badge">Beta</span>`));
    }
    expect(SOURCE).not.toContain('(Beta)</span>');
  });

  test('the three rows that were not experiments moved where they belong', () => {
    // A status-bar preference is Appearance…
    expect(rowLabels(section('appearance'))).toContain('Show IPFS load progress in the status bar');
    expect(section('appearance')).toContain('id="show-ipfs-progress-status"');
    // …Tor's startup toggle sits with the other startup toggles…
    expect(section('startup')).toContain('id="start-tor-at-launch"');
    expect(rowLabels(section('startup'))).toContain('Start Tor when Freedom opens');
    // …and the Swarm publishing readout sits with the Swarm node.
    expect(section('nodes')).toContain('id="swarm-publishing-row"');
    // Its "turn this on first" line points at where the toggle is now.
    expect(SOURCE).not.toContain('in Experimental, above');
    expect(SOURCE).toContain('Enable Identity & Wallet under Advanced to publish on Swarm.');
  });
});

/**
 * The shared network-source table, evaluated out of the shipped script. It is
 * a plain object literal of strings, so lifting it out keeps the assertions on
 * the real copy rather than on a duplicate of it.
 */
const networkSourceCopy = () => {
  const match = SOURCE.match(/const NETWORK_SOURCE_COPY = (Object\.freeze\(\{[\s\S]*?\n\}\));/);
  expect(match).not.toBeNull();
  return new Function(`return ${match[1]};`)();
};

describe('settings.html names each network source once (#269)', () => {
  test('one table, four sources, each with a label, a help line and Advanced text', () => {
    const copy = networkSourceCopy();
    expect(Object.keys(copy)).toEqual(['myotis', 'colibri', 'quorum', 'direct']);
    for (const entry of Object.values(copy)) {
      expect(typeof entry.label).toBe('string');
      expect(entry.label).not.toBe('');
      expect(typeof entry.help).toBe('string');
      expect(entry.advanced).toMatch(/\S/);
    }
    expect(SOURCE.match(/const NETWORK_SOURCE_COPY = /g)).toHaveLength(1);
  });

  test('Name Resolution and the chain detail both read it, and neither keeps its own', () => {
    // The chain detail's private table is gone…
    expect(SOURCE).not.toMatch(/\baccessMeta\b/);
    expect(SOURCE).toContain('const meta = NETWORK_SOURCE_COPY[source];');
    // …and Name Resolution's methods carry only their links, the copy spread
    // in from the shared table.
    const methods = SOURCE.match(/const METHODS = \[([\s\S]*?)\]\.map\(/);
    expect(methods).not.toBeNull();
    expect(methods[1]).not.toMatch(/\b(label|help|advanced):/);
    expect(SOURCE).toContain('...NETWORK_SOURCE_COPY[method.id]');
    // Both renderers go through the same help and disclosure helpers.
    expect(SOURCE.match(/networkSourceHelp\((source, kind|id)\)/g)).toHaveLength(2);
    expect(SOURCE.match(/networkSourceAdvanced\((source|id),/g)).toHaveLength(2);
  });

  test('broadcast rows get broadcast help, not the read help (R2-M1)', () => {
    const copy = networkSourceCopy();
    // Both broadcast sources carry their own line; the read help talks about
    // verifying an answer a broadcast does not have.
    expect(copy.myotis.broadcastHelp).toBe('');
    expect(copy.direct.broadcastHelp).toMatch(/\S/);
    expect(copy.direct.broadcastHelp).not.toMatch(/answer|verif|fastest/i);
    expect(SOURCE).toContain('${networkSourceHelp(source, kind)}');
    // The broadcast intro is derived from the chain's order, not hard-coded.
    expect(SOURCE).not.toContain('>Signed transactions go out through the local node first');
    expect(SOURCE).toContain('${esc(broadcastIntro(broadcastOrder))}');
  });

  test('the help line is omitted where the badge already carries it', () => {
    const copy = networkSourceCopy();
    expect(copy.myotis.help).toBe('');
    expect(copy.quorum.help).toBe('');
    expect(SOURCE).toContain('return help ? `<p class="row-help">${esc(help)}</p>` : \'\';');
  });
});

describe('settings.html keeps jargon out of the visible layer (#270)', () => {
  // Terms a daily-driver user would have to look up. They may appear in a
  // source's Advanced text, which is collapsed by default, and nowhere a user
  // reads without asking for it.
  const JARGON =
    /quorum|prover|light client|beacon|finalized|WNS|GNS|byte-identical|anchored|P2P|\bRPC\b|corpus|endpoint|Myotis|Colibri/i;

  test('every source label and help line is plain language', () => {
    for (const [source, entry] of Object.entries(networkSourceCopy())) {
      expect([source, entry.label]).toEqual([source, expect.not.stringMatching(JARGON)]);
      expect([source, entry.help]).toEqual([source, expect.not.stringMatching(JARGON)]);
      if ('broadcastHelp' in entry) {
        expect([source, entry.broadcastHelp]).toEqual([source, expect.not.stringMatching(JARGON)]);
      }
    }
  });

  test("the technical name is kept behind each row's Advanced disclosure", () => {
    const copy = networkSourceCopy();
    expect(copy.myotis.advanced).toMatch(/^Myotis — /);
    // WNS/GNS go through Myotis's generic eth_call, pinned to the optimistic
    // head (ens-resolver.js tryMyotisContractPath), not finalized state.
    expect(copy.myotis.advanced).toMatch(/\.wei\/\.gwei names .*optimistic/);
    expect(copy.colibri.advanced).toMatch(/^Colibri — /);
    expect(copy.quorum.advanced).toMatch(/^RPC quorum — /);
    expect(copy.direct.advanced).toMatch(/^Direct RPC — /);
    expect(SOURCE).toContain('<details class="row-advanced"');
    expect(SOURCE).toContain('<summary>Advanced</summary>');
    // `open` only when the user left it open — collapsed is the default.
    expect(SOURCE).toContain("${open ? ' open' : ''}");
  });

  test('the proof server and agreement threshold live inside the disclosure', () => {
    expect(SOURCE).toContain(
      'networkSourceAdvanced(id, { open: openAdvanced.has(id), extra: configRow })'
    );
    // Rendered only there, not again as a sibling of the method row.
    expect(SOURCE.match(/\$\{configRow\}/g) || []).toHaveLength(0);
  });

  test('the strings the audit named are gone from the page', () => {
    for (const gone of [
      'WNS/GNS',
      "Myotis light client'",
      'Myotis P2P light client',
      'Colibri cryptographic verification',
      'Prover endpoint',
      'Colibri prover endpoint',
      'corpus.core default',
      'Local P2P resolution',
      'use P2P first',
      'byte-identical answers',
      'Required matching RPC answers',
      'RPC providers queried',
      'manage RPC endpoints',
      'manage its RPC and prover endpoints',
      "'No prover'",
      "'Public endpoint'",
      "'User endpoint'",
      'RPC quorum saved.',
    ]) {
      expect([gone, SOURCE.includes(gone)]).toEqual([gone, false]);
    }
  });

  test('the replacements say the same thing in plain words', () => {
    expect(SOURCE).toContain('<p class="row-label">Proof server</p>');
    expect(SOURCE).toContain('<p class="row-help">Leave empty to use the default.</p>');
    expect(SOURCE).toContain('How many servers must give the same answer.');
    // The broadcast intro is assembled from the chain's order (R2-M1).
    expect(SOURCE).toContain("myotis: 'the local node', direct: 'a server'");
    expect(SOURCE).toContain(
      'Signed transactions go out through ${named[0]} first, with ${named[1]} as the fallback.'
    );
    expect(section('ens')).toContain('choose which servers Freedom');
  });
});
