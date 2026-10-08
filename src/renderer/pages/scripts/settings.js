// freedomAPI is exposed globally by webview-preload.js via contextBridge.
const $ = (id) => document.getElementById(id);

const fields = {
  themeMode: $('theme-mode'),
  searchProvider: $('search-provider'),
  tabsInTitlebar: $('tabs-in-titlebar'),
  startAnt: $('start-ant-at-launch'),
  startIpfs: $('start-ipfs-at-launch'),
  startMyotis: $('start-myotis-at-launch'),
  startMyotisGnosis: $('start-myotis-gnosis-at-launch'),
  unverifiedEnsAction: $('unverified-ens-action'),
  askWhereToSave: $('ask-where-to-save'),
  startRadicle: $('start-radicle-at-launch'),
  enableTor: $('enable-tor-integration'),
  startTorRow: $('start-tor-row'),
  startTor: $('start-tor-at-launch'),
  enableIdentity: $('enable-identity-wallet'),
  showIpfsProgressStatus: $('show-ipfs-progress-status'),
  autoUpdate: $('auto-update'),
  adblockEnabled: $('adblock-enabled'),
  adblockAds: $('adblock-ads'),
  adblockPrivacy: $('adblock-privacy'),
  adblockCookies: $('adblock-cookies'),
  adblockAnnoyances: $('adblock-annoyances'),
  adblockAutoUpdate: $('adblock-autoupdate'),
};
const radicleLaunchRow = $('radicle-launch-row');
const radicleLaunchHelp = $('radicle-launch-help');
const defaultRadicleLaunchHelp = radicleLaunchHelp?.textContent || '';
const refreshRadicleLaunchStatus = async () => {
  try {
    const [profile, binary] = await Promise.all([
      freedomAPI.getActiveProfile?.(),
      freedomAPI.checkRadicleBinary?.(),
    ]);
    const disabled = profile?.nodes?.radicle?.mode === 'disabled';
    const available = binary?.available !== false;
    fields.startRadicle.disabled = disabled || !available;
    if (radicleLaunchHelp) {
      radicleLaunchHelp.textContent = disabled
        ? 'Disabled for this profile under Settings → Nodes.'
        : !available
          ? 'libradicle addon not installed for this platform.'
          : defaultRadicleLaunchHelp;
    }
    if (radicleLaunchRow) radicleLaunchRow.classList.toggle('disabled', disabled || !available);
  } catch {
    // Every piece of row state a previous successful run may have set
    // has to come back with the checkbox — otherwise a transient status
    // failure leaves the row greyed out around a live control.
    fields.startRadicle.disabled = false;
    if (radicleLaunchHelp) {
      radicleLaunchHelp.textContent =
        'Radicle status could not be read. The startup preference can still be saved.';
    }
    if (radicleLaunchRow) radicleLaunchRow.classList.remove('disabled');
  }
};

// id ties together the manifest category, the #adblock-<id>-row
// element, and the status field; field is the checkbox input. `lists`
// names the manifest categories the toggle covers when there's more
// than one: "Block ads" also switches the uBlock filters (#410).
const ADBLOCK_CATEGORIES = [
  { id: 'ads', field: fields.adblockAds, lists: ['ads', 'ublock'] },
  { id: 'privacy', field: fields.adblockPrivacy },
  { id: 'cookies', field: fields.adblockCookies },
  { id: 'annoyances', field: fields.adblockAnnoyances },
];
const searchFields = {
  customOptions: $('custom-search-provider-options'),
  customList: $('custom-search-provider-list'),
  addButton: $('add-search-provider'),
  form: $('search-provider-form'),
  name: $('custom-search-provider-name'),
  template: $('custom-search-provider-template'),
  saveButton: $('save-search-provider'),
  cancelButton: $('cancel-search-provider'),
  status: $('search-provider-status'),
};

const swarmPublishingHelp = $('swarm-publishing-help');
const swarmPublishingBtn = $('swarm-publishing-btn');
const profileFields = {
  nameInput: $('profile-name-input'),
  saveStatus: $('profile-save-status'),
  nodesCard: $('profile-nodes-card'),
  nodesStatus: $('profile-nodes-status'),
};
// Open the profile manager in its own tab, reusing an existing
// freedom://profiles tab if one is already open (same as the hamburger
// and system menus). window.open routes through the main process'
// setWindowOpenHandler → tab:new-with-url → openInNewTabWithTarget,
// which focuses an existing singleton internal-page tab instead of
// duplicating it. A plain location.href would instead navigate the
// Settings tab in place — never reusing, and orphaning any profiles
// tab already open.
$('manage-profiles-link')?.addEventListener('click', () => {
  window.open('freedom://profiles', '_blank');
});
let activeProfileId = null;
// Nodes: the last stored per-protocol config, uncommitted row edits
// (protocol → { mode, values, invalid, error }), and the commit queue.
let storedProfileNodes = {};
const nodeDrafts = new Map();
let nodeSave = Promise.resolve();
// Bumped by every refresh that goes on to fetch. A refresh's reply is only
// rendered if no later refresh started meanwhile: the 5s timer, a commit's
// forced refresh and the profile-updated broadcast can overlap, and an older
// fetch landing last would repaint the old mode and leave storedProfileNodes
// (which the commit no-op check compares against) behind the catalog.
let profileRefreshSeq = 0;
// The committed profile name — the baseline an in-progress edit reverts
// to (Esc, an empty/unchanged value, or a failed save).
let savedProfileName = '';

// Whether this build ships an Arti (Tor) binary. Assumed present until
// the check answers, so the markup's own state is what a normal build
// shows and only a build without one repaints.
let torBundled = true;
let profileRefreshTimer = null;
let setProfileRefreshActive = () => {};
// Starts or stops the Swarm cache usage poll to match whether its row is on
// screen (defined with the row, below; #579).
let syncSwarmCacheUsage = () => {};

const esc = (s) =>
  String(s == null ? '' : s).replace(
    /[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]
  );

// The four network sources, named and explained once (#269). Name
// Resolution's method list and a chain's read/broadcast order both read
// this table, so the same source can no longer reach the user under two
// names with two explanations. `label` and `help` are the visible layer
// and carry no term a user would have to look up (#270); a help line is
// kept only where the row's badge does not already say it (`Ready` /
// `Syncing` / `Off` for the local node, `2 of 3` for the servers that
// must agree). `advanced` is the technical name and the mechanism, shown
// collapsed under each row's Advanced disclosure — and still indexed by
// the settings search, so "Myotis", "Colibri", "RPC quorum" and "Direct
// RPC" keep finding the row they used to label. `broadcastHelp` replaces
// `help` on a chain's Transaction broadcast rows: a broadcast hands a
// signed transaction on and gets nothing back to verify, so the read
// help ("nothing verifying the answer") does not describe it.
const NETWORK_SOURCE_COPY = Object.freeze({
  myotis: Object.freeze({
    label: 'Local node',
    help: '',
    broadcastHelp: '',
    advanced:
      'Myotis — a peer-to-peer Ethereum and Gnosis light client running inside Freedom. It checks answers against the chain itself, with no server involved. ENS lookups prefer finalized state; newer ENS record types and .wei/.gwei names (WNS, GNS) use a verified optimistic beacon head.',
  }),
  colibri: Object.freeze({
    label: 'Proof check',
    help: 'A server answers; Freedom checks the proof itself.',
    advanced:
      "Colibri — a remote prover sends a cryptographic proof with each answer, and Freedom verifies that proof locally against the chain's consensus.",
  }),
  quorum: Object.freeze({
    label: 'Several servers must agree',
    help: '',
    advanced:
      'RPC quorum — several independently configured RPC endpoints are asked at one anchored block, and the answer counts only if enough of them return byte-identical results.',
  }),
  direct: Object.freeze({
    label: 'One server, unchecked',
    help: 'Fastest, and the only option with nothing verifying the answer.',
    broadcastHelp: 'Hands the signed transaction to the first working server.',
    advanced:
      'Direct RPC — the first working configured RPC endpoint answers and nothing verifies the response.',
  }),
});

// A source row's help line, omitted rather than left empty when the
// table gives it none. Broadcast rows read `broadcastHelp` where the
// table has one.
const networkSourceHelp = (source, kind = 'read') => {
  const meta = NETWORK_SOURCE_COPY[source];
  const help =
    kind === 'broadcast' && meta && 'broadcastHelp' in meta ? meta.broadcastHelp : meta?.help;
  return help ? `<p class="row-help">${esc(help)}</p>` : '';
};

// A source row's collapsed Advanced disclosure (#270): the technical name
// and mechanism, plus `extra` — the settings only someone who knows what
// a prover or a quorum is needs to touch. `key` names the disclosure so a
// controller that repaints its list can put it back the way the user left
// it.
const networkSourceAdvanced = (source, { key = source, open = false, extra = '' } = {}) => {
  const advanced = NETWORK_SOURCE_COPY[source]?.advanced;
  if (!advanced && !extra) return '';
  return `<details class="row-advanced" data-advanced="${esc(key)}"${open ? ' open' : ''}>
      <summary>Advanced</summary>
      ${advanced ? `<p class="row-help">${esc(advanced)}</p>` : ''}
      ${extra}
    </details>`;
};

const DEFAULT_SEARCH_PROVIDER = 'duckduckgo';
const SEARCH_TERMS_PLACEHOLDER = '{searchTerms}';
const LOOPBACK_SEARCH_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
let customSearchProviders = [];
let editingSearchProviderId = null;
let searchProviderFormDirty = false;
// Keep in sync with CUSTOM_SEARCH_PROVIDER_LIMIT in src/main/settings-store.js —
// main silently drops anything past it, so the form must refuse first.
const CUSTOM_SEARCH_PROVIDER_LIMIT = 50;

// Latest cross-window provider list. cachedSettings is refreshed by every
// settings broadcast even while this form is dirty (applySearchSettings
// skips only the re-render), so writes rebase on it rather than on this
// window's render snapshot — otherwise a save here would resurrect
// entries another settings window removed meanwhile.
const latestCustomSearchProviders = () =>
  (Array.isArray(cachedSettings?.customSearchProviders)
    ? cachedSettings.customSearchProviders
    : customSearchProviders
  ).map((provider) => ({ ...provider }));

const setSearchProviderStatus = (message, kind) => {
  searchFields.status.textContent = message || '';
  searchFields.status.className = 'rpc-status' + (kind ? ' ' + kind : '');
};

const normalizeSearchTemplateInput = (value) => {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (!trimmed || trimmed.length > 2048) return null;
  const openSearchCount = trimmed.split(SEARCH_TERMS_PLACEHOLDER).length - 1;
  const percentCount = trimmed.split('%s').length - 1;
  if (openSearchCount + percentCount !== 1) return null;
  const normalized = percentCount === 1 ? trimmed.replace('%s', SEARCH_TERMS_PLACEHOLDER) : trimmed;

  try {
    const parsed = new URL(normalized.replace(SEARCH_TERMS_PLACEHOLDER, 'test'));
    const secure = parsed.protocol === 'https:';
    const loopbackHttp = parsed.protocol === 'http:' && LOOPBACK_SEARCH_HOSTS.has(parsed.hostname);
    if ((!secure && !loopbackHttp) || parsed.username || parsed.password) return null;
  } catch {
    return null;
  }

  return normalized;
};

const renderSearchProviderOptions = (selectedId) => {
  searchFields.customOptions.innerHTML = customSearchProviders
    .map((provider) => `<option value="custom:${esc(provider.id)}">${esc(provider.name)}</option>`)
    .join('');
  searchFields.customOptions.hidden = customSearchProviders.length === 0;

  const available = [...fields.searchProvider.options].some(
    (option) => option.value === selectedId
  );
  fields.searchProvider.value = available ? selectedId : DEFAULT_SEARCH_PROVIDER;
};

const renderCustomSearchProviders = () => {
  searchFields.customList.innerHTML = customSearchProviders.length
    ? customSearchProviders
        .map(
          (provider) => `
            <div class="row">
              <div class="row-body">
                <p class="row-label">${esc(provider.name)}</p>
                <p class="row-help" style="overflow-wrap: anywhere">
                  ${esc(provider.searchUrlTemplate)}
                </p>
              </div>
              <div class="search-provider-actions">
                <button type="button" class="btn" data-search-action="edit" data-id="${esc(provider.id)}">Edit</button>
                <button type="button" class="btn danger" data-search-action="remove" data-id="${esc(provider.id)}">Remove</button>
              </div>
            </div>`
        )
        .join('')
    : '<div class="profile-node-empty">No custom search engines yet</div>';
};

const applySearchSettings = (settings) => {
  if (!settings || searchProviderFormDirty) return;
  customSearchProviders = Array.isArray(settings.customSearchProviders)
    ? settings.customSearchProviders.map((provider) => ({ ...provider }))
    : [];
  renderSearchProviderOptions(settings.searchProvider || DEFAULT_SEARCH_PROVIDER);
  renderCustomSearchProviders();
};

const closeSearchProviderForm = () => {
  editingSearchProviderId = null;
  searchProviderFormDirty = false;
  searchFields.name.value = '';
  searchFields.template.value = '';
  searchFields.form.hidden = true;
};

const openSearchProviderForm = (provider = null) => {
  editingSearchProviderId = provider?.id || null;
  searchProviderFormDirty = false;
  searchFields.name.value = provider?.name || '';
  searchFields.template.value = provider?.searchUrlTemplate || '';
  searchFields.form.hidden = false;
  searchFields.name.focus();
};

searchFields.addButton.addEventListener('click', () => {
  setSearchProviderStatus('', null);
  openSearchProviderForm();
});

searchFields.cancelButton.addEventListener('click', closeSearchProviderForm);
for (const input of [searchFields.name, searchFields.template]) {
  input.addEventListener('input', () => {
    searchProviderFormDirty = true;
  });
}

searchFields.saveButton.addEventListener('click', async () => {
  const name = searchFields.name.value.trim();
  const searchUrlTemplate = normalizeSearchTemplateInput(searchFields.template.value);
  if (!name) {
    setSearchProviderStatus('Enter a search engine name.', 'error');
    return;
  }
  if (!searchUrlTemplate) {
    setSearchProviderStatus(
      'Enter a valid HTTPS search URL with one {searchTerms} placeholder.',
      'error'
    );
    return;
  }

  const baseProviders = latestCustomSearchProviders();
  if (!editingSearchProviderId && baseProviders.length >= CUSTOM_SEARCH_PROVIDER_LIMIT) {
    setSearchProviderStatus(
      `Limit of ${CUSTOM_SEARCH_PROVIDER_LIMIT} custom search engines reached. Remove one first.`,
      'error'
    );
    return;
  }
  const id = editingSearchProviderId || crypto.randomUUID();
  const nextProvider = { id, name, searchUrlTemplate };
  const nextProviders = editingSearchProviderId
    ? baseProviders.some((provider) => provider.id === editingSearchProviderId)
      ? baseProviders.map((provider) =>
          provider.id === editingSearchProviderId ? nextProvider : provider
        )
      : [...baseProviders, nextProvider]
    : [...baseProviders, nextProvider];
  const selectedProvider = editingSearchProviderId ? fields.searchProvider.value : `custom:${id}`;

  searchFields.saveButton.disabled = true;
  const ok = await freedomAPI.saveSettings({
    searchProvider: selectedProvider,
    customSearchProviders: nextProviders,
  });
  searchFields.saveButton.disabled = false;
  if (!ok) {
    setSearchProviderStatus('The search engine could not be saved.', 'error');
    return;
  }

  customSearchProviders = nextProviders;
  renderSearchProviderOptions(selectedProvider);
  renderCustomSearchProviders();
  closeSearchProviderForm();
  setSearchProviderStatus('Search engine saved.', 'success');
});

searchFields.customList.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-search-action]');
  if (!button) return;
  const provider = customSearchProviders.find((candidate) => candidate.id === button.dataset.id);
  if (!provider) return;

  if (button.dataset.searchAction === 'edit') {
    setSearchProviderStatus('', null);
    openSearchProviderForm(provider);
    return;
  }

  if (button.dataset.searchAction !== 'remove') return;
  if (!confirm(`Remove ${provider.name}?`)) return;

  const nextProviders = latestCustomSearchProviders().filter(
    (candidate) => candidate.id !== provider.id
  );
  const removedProviderId = `custom:${provider.id}`;
  const selectedProvider =
    fields.searchProvider.value === removedProviderId
      ? DEFAULT_SEARCH_PROVIDER
      : fields.searchProvider.value;
  const ok = await freedomAPI.saveSettings({
    searchProvider: selectedProvider,
    customSearchProviders: nextProviders,
  });
  if (!ok) {
    setSearchProviderStatus('The search engine could not be removed.', 'error');
    return;
  }

  customSearchProviders = nextProviders;
  renderSearchProviderOptions(selectedProvider);
  renderCustomSearchProviders();
  if (editingSearchProviderId === provider.id) closeSearchProviderForm();
  setSearchProviderStatus('Search engine removed.', 'success');
});

fields.searchProvider.addEventListener('change', async () => {
  const selectedProvider = fields.searchProvider.value || DEFAULT_SEARCH_PROVIDER;
  const ok = await freedomAPI.saveSettings({ searchProvider: selectedProvider });
  if (!ok) {
    renderSearchProviderOptions(cachedSettings?.searchProvider || DEFAULT_SEARCH_PROVIDER);
    setSearchProviderStatus('The default search engine could not be changed.', 'error');
    return;
  }
  setSearchProviderStatus('Default search engine updated.', 'success');
});

// Each sidebar entry owns one or more `<section>` panels; the active entry
// is driven by location.hash so the URL is the source of truth and the
// outer chrome can render freedom://settings/<entry> in the address bar.
// Since #268 an entry can own several panels — Privacy and security is
// Ad Blocking + Site Permissions, Networks is Chains + RPC Providers +
// Name Resolution, Nodes is Nodes + Startup, About Freedom is the version
// + Updates — and each panel names its entry in the markup (`data-nav`),
// so the panel ids every controller below keys on did not have to move.
const navItems = [...document.querySelectorAll('.nav-item')];
const SECTIONS = navItems.map((i) => i.dataset.target).filter(Boolean);
const DEFAULT_SECTION = SECTIONS[0] || 'profile';
const PANEL_NAV = Object.fromEntries(
  [...document.querySelectorAll('main.content > section[data-nav]')].map((el) => [
    el.id,
    el.dataset.nav,
  ])
);
const PANELS = Object.keys(PANEL_NAV);

// A route that names one of its entry's panels (`#networks/rpc`) opens the
// entry and brings that panel to the top. The panels above it can still
// grow after this runs — the chain list and RPC Providers paint from IPC a
// beat later — so the panel is re-aligned a few times over the next second,
// until the user scrolls or presses a key, which hands the scroll back.
//
// Only `.layout` scrolls, so the panel is aligned by setting that one
// container's offset. `scrollIntoView` scrolled every scrollable ancestor,
// the document included, which painted the page blank or shifted down
// under a seam (#604).
const contentScroller = document.querySelector('.layout') || document.scrollingElement;

/* settings panel scroll: start */
// Where `scroller` has to be for `panel` to sit at its top, keeping the
// panel's `scroll-margin-top` above it as `scrollIntoView` did.
const panelScrollTop = (panel, scroller) => {
  const margin = parseFloat(getComputedStyle(panel).scrollMarginTop) || 0;
  const offset = panel.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
  return Math.max(0, Math.round(scroller.scrollTop + offset - margin));
};

// With the document no longer scrolling, Chromium sends PageDown, Space
// and End nowhere until something inside `.layout` has focus. Give the
// scroller focus whenever nothing else holds it: on a section change, once
// the page has loaded, and when the tab gains focus. A field or nav button
// that has focus keeps it.
const focusScrollerIfIdle = () => {
  if (document.activeElement && document.activeElement !== document.body) return;
  contentScroller.focus({ preventScroll: true });
};
window.addEventListener('focus', focusScrollerIfIdle);
window.addEventListener('load', () => setTimeout(focusScrollerIfIdle, 0));

let stopPanelScroll = () => {};
const scrollToPanel = (id) => {
  stopPanelScroll();
  const panel = document.getElementById(id);
  if (!panel) return;
  const align = () => contentScroller.scrollTo({ top: panelScrollTop(panel, contentScroller) });
  align();
  const timers = [100, 250, 500, 1000].map((ms) => setTimeout(align, ms));
  const userTookOver = new AbortController();
  stopPanelScroll = () => {
    timers.forEach(clearTimeout);
    userTookOver.abort();
    stopPanelScroll = () => {};
  };
  for (const type of ['wheel', 'touchstart', 'keydown', 'mousedown']) {
    window.addEventListener(type, () => stopPanelScroll(), {
      passive: true,
      signal: userTookOver.signal,
    });
  }
};
/* settings panel scroll: end */

const showSection = (route) => {
  const [section, sub] = String(route).split('/');
  for (const id of PANELS) {
    const el = document.getElementById(id);
    if (el) el.classList.toggle('hidden', PANEL_NAV[id] !== section);
  }
  navItems.forEach((item) => item.classList.toggle('active', item.dataset.target === section));
  setProfileRefreshActive(section === 'profile' || section === 'nodes');
  syncSwarmCacheUsage();
  // Always scroll the content area to the top when switching — avoids a
  // stale scroll offset from a taller prior section.
  stopPanelScroll();
  contentScroller.scrollTo({ top: 0 });
  if (sub && PANEL_NAV[sub] === section) scrollToPanel(sub);
  focusScrollerIfIdle();
};

navItems.forEach((item) => {
  item.addEventListener('click', () => {
    const target = item.dataset.target;
    if (!target) return;
    // Clicking a section's nav item resets any sub-route (e.g. a
    // chain detail) back to the section root.
    if (location.hash.replace(/^#/, '').toLowerCase() === target) return;
    location.hash = target;
  });
});

/* settings-hash routing: start */
// Every hash the page answered to before #268 regrouped the nav, mapped to
// the entry that holds it now and the panel to bring up. Bookmarks, history
// and older builds' links carry these, and so did the app itself
// (`freedom://settings/rpc` from the wallet and the onchain-app
// interstitial), so each still lands where it used to point and is then
// rewritten to its new name. A panel that heads its entry needs no `/panel`.
const LEGACY_ROUTES = {
  chains: 'networks',
  rpc: 'networks/rpc',
  ens: 'networks/ens',
  adblock: 'privacy',
  permissions: 'privacy/permissions',
  startup: 'nodes/startup',
  experimental: 'advanced',
  updates: 'about/updates',
};

// The canonical route for a hash: `<entry>`, or `<entry>/<panel>` for a
// panel of that entry. Under Networks any other sub-route is a chain detail
// (`#networks/1`) — whether that chain exists is the Chains controller's
// call, since only it has the registry. Anything else is dropped back to the
// entry, and a hash naming no entry at all to the first one.
const resolveRoute = (hash) => {
  const raw = (hash || '').replace(/^#/, '').toLowerCase();
  const [head, ...rest] = raw.split('/');
  const sub = rest.join('/');
  if (Object.prototype.hasOwnProperty.call(LEGACY_ROUTES, head)) {
    // A chain detail (#chains/1) keeps its chain under Networks.
    return head === 'chains' && sub ? `networks/${sub}` : LEGACY_ROUTES[head];
  }
  if (!SECTIONS.includes(head)) return DEFAULT_SECTION;
  if (!sub) return head;
  if (PANEL_NAV[sub] === head || head === 'networks') return `${head}/${sub}`;
  return head;
};

// The nav entry a hash opens.
const resolveSection = (hash) => resolveRoute(hash).split('/')[0];

// Normalize the URL onto the route that is actually on screen, so
// freedom://settings becomes freedom://settings/profile, an old name like
// freedom://settings/rpc becomes freedom://settings/networks/rpc, and a hash
// naming no section at all — a stale bookmark, a typo — stops promising one.
// history.replaceState keeps the rewrite out of the back/forward stack.
const canonicalizeHash = (route) => {
  if (location.hash.replace(/^#/, '').toLowerCase() === route) return;
  history.replaceState(null, '', `#${route}`);
};

// One path for every arrival at a hash — first load, a nav click, a
// back/forward, an outer-chrome deep link opened in an existing
// Settings tab (#280) — so no navigation can leave a hash the page
// resolved somewhere else standing in the address bar.
const applyHashSection = () => {
  const route = resolveRoute(location.hash);
  canonicalizeHash(route);
  showSection(route);
};
/* settings-hash routing: end */

window.addEventListener('hashchange', applyHashSection);
applyHashSection();

// ── Search settings (#281) ──────────────────────────────────────────
// Chrome has kept a persistent "Search settings" field in its header
// since 2016, and on a page this size that is how most people
// navigate. Freedom's page is the harder case, not the easier one:
// several settings are not under the heading their subject suggests
// (a chain's API keys are under RPC Providers, Ethereum name lookups
// under Networks), so "I know the word, I don't know the section" is
// the normal state. Until #281 the page's only search box was the
// Shortcuts one, which searches that list and nothing else.
//
// The two helpers below are pure — an element and a query in, ranked
// entries out — so `settings-search.test.js` can lift them out of this
// file (it slices between the markers) and drive them over the shipped
// markup. They walk the tree with `children`, `classList.contains` and
// `textContent` only: no selector engine and nothing from this page's
// scope, which is what keeps that test reading the real code.
/* settings-search helpers: start */
const settingsSearchText = (el) => (el?.textContent || '').replace(/\s+/g, ' ').trim();

// Markup that wears a setting's clothes without being one, marked by
// whoever renders it: a status message written as a row ("No saved
// permissions"), and the transient add-a-chain flow, whose own `<h2>`
// would otherwise answer for the Chains section it renders inside. The
// marker covers the whole subtree under it, so one on a wrapper takes
// a view out of the index entirely.
const SETTINGS_SEARCH_SKIP = 'settings-search-skip';

// Every element under `el` carrying one of `names` (a class, or a list
// of them), not descending into a match. Stopping at a match is what
// makes a nested row a barrier: `settingsSearchOwn` passes the row
// classes in alongside the label/help ones, so a `.row-help` belongs to
// the nearest row it is under, never to a row further out.
const settingsSearchCollect = (el, names, out = []) => {
  const wanted = Array.isArray(names) ? names : [names];
  for (const child of Array.from(el?.children || [])) {
    if (child.classList?.contains(SETTINGS_SEARCH_SKIP)) continue;
    if (wanted.some((name) => child.classList?.contains(name))) out.push(child);
    else settingsSearchCollect(child, names, out);
  }
  return out;
};

const settingsSearchFirst = (el, names) => settingsSearchCollect(el, names)[0] || null;

// What counts as one setting: a card row, the drag-to-reorder rows of
// Name Resolution's method list and a chain's read/broadcast order, and
// the `.resolver-config` panel inside a method row's Advanced disclosure
// (the proof server URL, the agreement threshold) — all of which carry
// the same `.row-label` / `.row-help` pair without the `.row` class.
// Those are where the four sources and the two resolver settings are
// named (and, through the indexed Advanced text, where "Colibri", "RPC
// quorum" and "Myotis" still are), so leaving them out would make the
// whole resolution policy unsearchable.
// The chain master list is the fourth: its `.net-row` buttons are the
// only place a chain — a custom one above all, which exists nowhere
// else on the page — is named, so leaving them out makes a chain
// unfindable by the name the user gave it.
// Since #270 a method's `.resolver-config` panel sits inside the method
// row's own Advanced disclosure — the one place on the page where a row
// nests in another — so the walk below goes on into a row for the rows
// inside it, and a row's own label and help stop at a nested row.
const SETTINGS_SEARCH_ROWS = ['row', 'resolver-method', 'resolver-config', 'net-row'];

// What names a row, and what describes it under that name. A `.net-row`
// carries the same pair under its own class names (`Gnosis` / `chain
// 100`) rather than the `.row-label` / `.row-help` every other row on
// the page uses.
const SETTINGS_SEARCH_LABELS = ['row-label', 'net-row-name'];
const SETTINGS_SEARCH_HELP = ['row-help', 'net-row-sub'];

// The elements carrying one of `names` that belong to `row` itself: a
// row nested inside it is a barrier, so the proof server's label and
// help answer for the proof server rather than for the method around it.
const settingsSearchOwn = (row, names) =>
  settingsSearchCollect(row, [...names, ...SETTINGS_SEARCH_ROWS]).filter((el) =>
    names.some((name) => el.classList?.contains(name))
  );

// A row this build has switched off is not a setting the user has, and
// offering it would jump to nothing: the `[data-tor]` rows on a build
// that bundles no Arti binary and the `[data-linux-only]` row off Linux
// are hidden by writing `style.display`, while the Myotis startup rows
// on a build with no Myotis support are hidden through the `hidden`
// attribute (`launchRow.hidden = !supported`). Both shapes read here.
const settingsSearchHidden = (row) => Boolean(row?.hidden) || row?.style?.display === 'none';

// Every row under `el` in document order, a row nested in another
// included right after it. A row switched off takes the rows inside it
// with it.
const settingsSearchAllRows = (el, out = []) => {
  for (const child of Array.from(el?.children || [])) {
    if (child.classList?.contains(SETTINGS_SEARCH_SKIP)) continue;
    const isRow = SETTINGS_SEARCH_ROWS.some((name) => child.classList?.contains(name));
    if (isRow) {
      if (settingsSearchHidden(child)) continue;
      out.push(child);
    }
    settingsSearchAllRows(child, out);
  }
  return out;
};

// The rows a section contributes to the index, in document order, each
// with the label it is found by. Shared with the page's `locateRow` so
// the two walk the same rows: a result is "the nth row in this section
// labelled X", which is the only thing that tells two same-labelled
// rows apart (a chain lists "One server, unchecked" in both its read
// order and its broadcast order) once the view they came from has
// repainted.
const settingsSearchRows = (section) =>
  settingsSearchAllRows(section)
    .map((row) => ({
      row,
      label: settingsSearchText(settingsSearchOwn(row, SETTINGS_SEARCH_LABELS)[0]),
    }))
    .filter((entry) => entry.label);

// One entry per section plus one per labelled row, in document order.
// `sectionLabels` maps a section id to its nav label, the fallback for
// the sections whose heading comes from a view template that has not
// rendered yet (Chains, RPC Providers, Site Permissions).
//
// A section is one panel of a nav entry (#268), named by its own heading:
// the entry's `h2.section-title`, or the `h3.panel-title` of a panel that
// shares its entry with others. `groups` maps a panel to the nav entry it
// sits under, so a row in one of those reads "Privacy and security ›
// Ad Blocking" — the entry to click as well as the heading to look for.
//
// The heading is read from the section's *live* DOM, which is only the
// right answer if a hidden section's markup still describes where its
// rows are. That is the controllers' side of the contract: a view
// rendered per sub-route has to render itself back when the sub-route
// is left, or its heading and its rows both go on answering for the
// section after the user has gone (see Chains' `hashchange` below).
const buildSettingsSearchIndex = (content, { sectionLabels = {}, groups = {}, skip = [] } = {}) => {
  const index = [];
  for (const section of Array.from(content?.children || [])) {
    if (section.tagName !== 'SECTION' || !section.classList?.contains('section')) continue;
    if (!section.id || skip.includes(section.id)) continue;
    const title =
      settingsSearchText(settingsSearchFirst(section, ['section-title', 'panel-title'])) ||
      sectionLabels[section.id] ||
      section.id;
    const group = groups[section.id];
    const sectionLabel = group && group !== title ? `${group} › ${title}` : title;
    // A section's own intro paragraph is a direct child, outside every
    // card, so it describes the section rather than any one row.
    const intro = Array.from(section.children)
      .filter((child) => child.classList?.contains('row-help'))
      .map(settingsSearchText)
      .join(' ');
    index.push({
      sectionId: section.id,
      section: sectionLabel,
      label: title,
      help: intro,
      element: section,
    });
    const seen = new Map();
    for (const { row, label } of settingsSearchRows(section)) {
      const labelIndex = seen.get(label) || 0;
      seen.set(label, labelIndex + 1);
      index.push({
        sectionId: section.id,
        section: sectionLabel,
        label,
        labelIndex,
        help: settingsSearchOwn(row, SETTINGS_SEARCH_HELP).map(settingsSearchText).join(' '),
        element: row,
      });
    }
  }
  return index;
};

// Case-insensitive substring, no fuzzy matching. A label the query
// starts ranks above a label that merely contains it, which ranks above
// a hit in the help line under it; ties keep document order, so the
// list reads in the order the page does. Every match is listed — a
// silent top-N would read as "that setting does not exist".
const matchSettingsSearch = (index, rawQuery) => {
  const query = (rawQuery || '').trim().toLowerCase();
  if (!query) return [];
  const hits = [];
  index.forEach((entry, order) => {
    const label = (entry.label || '').toLowerCase();
    const rank = label.startsWith(query)
      ? 0
      : label.includes(query)
        ? 1
        : (entry.help || '').toLowerCase().includes(query)
          ? 2
          : -1;
    if (rank >= 0) hits.push({ entry, rank, order });
  });
  hits.sort((a, b) => a.rank - b.rank || a.order - b.order);
  return hits.map(({ entry, rank }) => ({ ...entry, rank }));
};

// Where a revealed element should sit in the view. `center` is right for
// a row — the answer lands in the middle with its neighbours around it.
// It is wrong for anything taller than the window: `center` lines the
// element's own middle up with the viewport's, so the top goes above the
// fold. A section entry reveals the whole `<section>`, and Name
// Resolution is already taller than a default window — centring it put
// the `<h2>` that names it off screen, leaving the user who asked where
// that section is looking at a view with no title on it. Those are
// aligned to their top instead, which is where clicking the nav item
// puts them.
const settingsSearchScrollBlock = (element, viewportHeight) => {
  if (element?.tagName === 'SECTION') return 'start';
  const height = element?.getBoundingClientRect?.().height;
  return height > viewportHeight ? 'start' : 'center';
};
/* settings-search helpers: end */

// A section that filters rows out of its own DOM has to put them back
// before the index is read, and not only on the way out (`hashchange`):
// the page-wide field can be used without leaving the section at all —
// the results panel hides the sections without touching the hash — and
// a row the index cannot see is a setting this page reports as missing.
// Shortcuts' "Search shortcuts…" is the one view like that; it registers
// its reset here and the search calls it before every index build. Only
// a filter belongs in this list: it is a query the page-wide field is
// superseding, so dropping it loses nothing, which is not true of the
// half-filled forms Chains and RPC Providers park in the same way.
const settingsSearchResets = [];

(() => {
  const input = $('settings-search');
  const panel = $('settings-search-results');
  const list = $('settings-search-list');
  const summary = $('settings-search-summary');
  const content = document.querySelector('main.content');
  if (!input || !panel || !list || !summary || !content) return;

  const NAV_LABELS = Object.fromEntries(
    navItems.map((item) => [item.dataset.target, settingsSearchText(item)])
  );
  // Each panel's entry label, the group a row is listed under…
  const PANEL_GROUPS = Object.fromEntries(PANELS.map((id) => [id, NAV_LABELS[PANEL_NAV[id]]]));
  // …and the name for a panel whose view has not painted its heading yet:
  // its own `data-title` (Chains, RPC Providers), else its entry's label.
  const PANEL_LABELS = Object.fromEntries(
    PANELS.map((id) => [id, document.getElementById(id)?.dataset.title || PANEL_GROUPS[id]])
  );

  let results = [];
  let showing = false;
  let highlighted = null;
  let pending = null; // reveal waiting on the hash change it asked for
  let revealToken = 0; // invalidates the retries of an earlier reveal

  // The highlight stays up while it is still the answer to the query on
  // screen — the way Chrome keeps its own — and is dropped on the next
  // search, on Escape, and when the user navigates somewhere else.
  const clearHighlight = () => {
    highlighted?.classList.remove('settings-search-hit');
    highlighted = null;
  };

  const resultRow = (result, position) => {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'row settings-search-result';
    row.dataset.result = String(position);
    const body = document.createElement('div');
    body.className = 'row-body';
    const label = document.createElement('p');
    label.className = 'row-label';
    label.textContent = result.label;
    body.appendChild(label);
    if (result.help) {
      const help = document.createElement('p');
      help.className = 'row-help';
      help.textContent = result.help;
      body.appendChild(help);
    }
    const section = document.createElement('span');
    section.className = 'settings-search-section';
    section.textContent = result.section;
    row.append(body, section);
    return row;
  };

  // The index is rebuilt from the live DOM on every keystroke, so a
  // section that paints later from IPC state is searchable as soon as
  // it is there. It is a few hundred elements — cheaper than keeping a
  // cache honest against four views that repaint on their own.
  const render = () => {
    for (const reset of settingsSearchResets) reset();
    const query = input.value.trim();
    results = matchSettingsSearch(
      buildSettingsSearchIndex(content, {
        sectionLabels: PANEL_LABELS,
        groups: PANEL_GROUPS,
        skip: [panel.id],
      }),
      query
    );
    list.replaceChildren(...results.map(resultRow));
    list.hidden = results.length === 0;
    summary.textContent = results.length
      ? `${results.length} ${results.length === 1 ? 'setting matches' : 'settings match'} “${query}”.`
      : `No settings match “${query}”.`;
  };

  // While the field has a query the results replace whichever section
  // is open; clearing it hands that section back.
  const openResults = () => {
    revealToken += 1;
    clearHighlight();
    render();
    stopPanelScroll();
    for (const id of PANELS) document.getElementById(id)?.classList.add('hidden');
    panel.classList.remove('hidden');
    showing = true;
    syncSwarmCacheUsage();
    contentScroller.scrollTo({ top: 0 });
  };

  const closeResults = ({ restoreSection = true } = {}) => {
    results = [];
    list.replaceChildren();
    panel.classList.add('hidden');
    if (showing && restoreSection) showSection(resolveRoute(location.hash));
    showing = false;
  };

  // Re-found rather than kept as a node: Chains, RPC Providers and Site
  // Permissions rebuild their view from IPC state on `hashchange`, so
  // the node the result was built from can be gone. A label alone does
  // not identify it — a chain names "One server, unchecked" once in its
  // read order and again in its broadcast order — so the result's position among
  // its section's same-labelled rows picks which one it was, walking
  // the same rows the index was built from. If the repaint left fewer
  // of them than there were, the first is still better than nothing.
  const locateRow = (result) => {
    const section = document.getElementById(result.sectionId);
    if (!section) return null;
    if (result.element === section) return section;
    const matches = settingsSearchRows(section).filter((entry) => entry.label === result.label);
    return (matches[result.labelIndex || 0] || matches[0])?.row || null;
  };

  // A row is centred, a section entry (what `locateRow` returns when the
  // result *is* the section) and anything else too tall to fit is
  // aligned to its top — see `settingsSearchScrollBlock` above.
  const applyHighlight = (row) => {
    clearHighlight();
    // A `#entry/panel` route the reveal went through would otherwise go
    // on re-aligning that panel over the row it just scrolled to.
    stopPanelScroll();
    // A row inside a collapsed Advanced disclosure (#270) has no box until
    // the disclosure is open, so open every one around it first.
    for (
      let d = row.parentElement?.closest('details');
      d;
      d = d.parentElement?.closest('details')
    ) {
      d.open = true;
    }
    row.scrollIntoView({ block: settingsSearchScrollBlock(row, window.innerHeight) });
    row.classList.add('settings-search-hit');
    highlighted = row;
  };

  // Those same views repaint *after* this runs — the nav's own
  // `hashchange` handler is registered first, and a repaint can be one
  // await away — which would rebuild the highlight away. So a highlight
  // that stops being connected is re-applied, bounded to four tries
  // over ~0.5s, after which the open section is the answer.
  const revealResult = (result, token, attempt = 0) => {
    if (token !== revealToken) return;
    const row = locateRow(result);
    if (row) applyHighlight(row);
    if (attempt >= 3) return;
    setTimeout(() => {
      if (token === revealToken && !highlighted?.isConnected) {
        revealResult(result, token, attempt + 1);
      }
    }, 150);
  };

  // Jumping to a result leaves the result list behind and opens the
  // nav entry the control is in, the way clicking that nav item would.
  // The open route is kept when it already shows the result's panel — a
  // chain's own page is where that chain's rows are. A panel of the open
  // entry that is not on screen (Networks' RPC Providers behind an open
  // chain or the add-a-chain form) is brought back by moving the hash,
  // which is what sends the Chains view back to its list.
  const reveal = (result) => {
    const panelId = result?.sectionId;
    const entry = PANEL_NAV[panelId];
    if (!entry) return;
    closeResults({ restoreSection: false });
    revealToken += 1;
    const route = resolveRoute(location.hash);
    if (route.split('/')[0] === entry) {
      showSection(route);
      if (document.getElementById(panelId)?.getClientRects().length) {
        revealResult(result, revealToken);
        return;
      }
    }
    // The hash change repaints and scrolls the content to the top, so
    // the scroll-and-flash waits for it (see the handler below).
    pending = { result, token: revealToken };
    location.hash = route === entry ? `${entry}/${panelId}` : entry;
  };

  const clearSearch = () => {
    input.value = '';
    revealToken += 1;
    closeResults();
    clearHighlight();
  };

  window.addEventListener('hashchange', () => {
    const queued = pending;
    pending = null;
    if (queued) {
      revealResult(queued.result, queued.token);
      return;
    }
    // The user went somewhere else (a nav item, back/forward, a deep
    // link from the outer chrome): the search is about a query they
    // have moved on from, so the field, the results and the highlight
    // all go. Closing the results is this handler's job and not
    // `showSection`'s — the panel is deliberately not one of
    // `PANELS`, so nothing else on the page can hide it, and left up
    // it would stack a stale result list above the section the nav's
    // own handler just opened.
    clearSearch();
  });

  // A nav item whose section the hash already names changes no hash at
  // all — its own click handler returns early — so no `hashchange`
  // reaches the handler above and the click has to close the results
  // itself: clicking "Appearance" while the results cover an open
  // `#appearance` is a user asking for that section back. Registered
  // after the nav's own listener, so by the time this runs
  // `location.hash` already reads the section being opened.
  navItems.forEach((item) => {
    if (!item.dataset.target) return;
    item.addEventListener('click', () => {
      if (showing || input.value) clearSearch();
    });
  });

  // An emptied field is a cleared search however it was emptied — the
  // `<input type="search">` clear button and a selection deleted by
  // hand both land here rather than on the Escape handler below.
  input.addEventListener('input', () => {
    if (input.value.trim()) openResults();
    else {
      revealToken += 1;
      closeResults();
      clearHighlight();
    }
  });

  input.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      clearSearch();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      if (results.length) reveal(results[0]);
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      list.firstElementChild?.focus();
    }
  });

  list.addEventListener('click', (event) => {
    const row = event.target.closest?.('.settings-search-result');
    if (!row) return;
    reveal(results[Number(row.dataset.result)]);
  });

  list.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    clearSearch();
    input.focus();
  });
})();

// The Tor rows follow the bundled Arti binary, not the platform: every
// platform the release workflow builds compiles Arti (Windows x64
// included since #337), and a source build that skipped
// `npm run tor:download` bundles none. A profile that already has the
// integration enabled keeps the rows either way — an external Tor SOCKS
// proxy needs no bundled binary, and a setting nothing can switch off
// again would be worse than a row that explains nothing.
const applyTorRowVisibility = (settings = cachedSettings) => {
  const visible = torBundled || settings?.enableTorIntegration === true;
  document
    .querySelectorAll('[data-tor]')
    .forEach((el) => (el.style.display = visible ? '' : 'none'));
};

const setFieldEnabled = (checkbox, container, ...inputs) => {
  const enabled = checkbox?.checked === true;
  container?.classList.toggle('disabled', !enabled);
  for (const input of inputs) {
    if (input) input.disabled = !enabled;
  }
};

// "Start Tor when Freedom opens" sits with the other startup rows under
// Nodes (#275), away from the Advanced toggle it depends on, so while that
// toggle is off the row says where to turn it on — the way the Radicle
// startup row names Settings → Nodes when Radicle is disabled there.
const startTorHelp = $('start-tor-help');
const defaultStartTorHelp = startTorHelp?.textContent || '';
const applyStartTorRowState = () => {
  setFieldEnabled(fields.enableTor, fields.startTorRow, fields.startTor);
  if (startTorHelp) {
    startTorHelp.textContent = fields.enableTor?.checked
      ? defaultStartTorHelp
      : 'Turn on Enable Tor (.onion access) under Advanced first.';
  }
};

const NODE_MODE_LABELS = {
  managed: 'Managed by Freedom',
  external: 'Use external node',
  disabled: 'Disabled',
};

const PROFILE_NODE_SERVICES = [
  {
    protocol: 'bee',
    label: 'Swarm',
    modes: ['managed', 'external', 'disabled'],
    externalFields: [{ key: 'externalApi', label: 'API', placeholder: 'http://127.0.0.1:1633' }],
    endpointLines: (config, service) =>
      [
        config?.externalApi ||
          service?.api ||
          (config?.apiPort ? `http://127.0.0.1:${config.apiPort}` : null),
      ].filter(Boolean),
  },
  {
    protocol: 'ipfs',
    label: 'IPFS',
    modes: ['managed', 'external', 'disabled'],
    externalFields: [
      { key: 'externalGateway', label: 'Gateway', placeholder: 'http://127.0.0.1:8080' },
    ],
    // Shown under the gateway field whenever "Use external node" is
    // selected: the embedded node verifies what it retrieves, an external
    // gateway is trusted for the bytes it serves.
    externalNote:
      'Freedom does not verify content integrity in this mode — the gateway is trusted for every ipfs:// page it serves.',
    endpointLines: (config) =>
      config?.externalGateway ? [config.externalGateway] : ['Embedded freedom-ipfs native node'],
  },
  {
    protocol: 'myotis',
    label: 'Myotis',
    modes: ['managed', 'disabled'],
    endpointLines: () => ['Embedded Myotis clients for Ethereum and Gnosis'],
  },
  {
    protocol: 'radicle',
    label: 'Radicle',
    modes: ['managed', 'disabled'],
    endpointLines: () => ['Embedded libradicle native node'],
  },
  {
    protocol: 'tor',
    label: 'Tor',
    modes: ['managed', 'external', 'disabled'],
    settingKey: 'enableTorIntegration',
    externalFields: [{ key: 'externalSocks', label: 'SOCKS5', placeholder: '127.0.0.1:9150' }],
    endpointLines: (config, service) =>
      [
        config?.externalSocks
          ? `SOCKS5 ${config.externalSocks}`
          : service?.socks
            ? `SOCKS5 ${service.socks}`
            : config?.socksPort
              ? `SOCKS5 127.0.0.1:${config.socksPort}`
              : null,
      ].filter(Boolean),
  },
];

const SERVICE_DEFINITIONS = Object.fromEntries(
  PROFILE_NODE_SERVICES.map((definition) => [definition.protocol, definition])
);
const SERVICE_LABELS = Object.fromEntries(
  PROFILE_NODE_SERVICES.map((definition) => [definition.protocol, definition.label])
);
const isProfileServiceVisible = (definition, settings) => {
  if (definition.settingKey && settings?.[definition.settingKey] !== true) return false;
  return true;
};
const visibleProfileServices = (settings) =>
  PROFILE_NODE_SERVICES.filter((definition) => isProfileServiceVisible(definition, settings));

const statusLabel = (service) => {
  const mode = service?.mode || 'none';
  const message = service?.tempMessage || service?.statusMessage;
  if (message) return message;
  if (mode === 'none') return 'Not running';
  if (mode === 'disabled') return 'Disabled';
  return mode.charAt(0).toUpperCase() + mode.slice(1);
};

// A node config keeps its external endpoint across a switch back to
// managed (the catalog merges node config updates rather than clamping
// them), so the stored value is only the endpoint in use while the mode
// actually is 'external'. Hide it otherwise, for every row, or a managed
// node advertises an address it is not serving from.
const withoutStoredExternalFields = (definition, config) => {
  const stripped = { ...(config || {}) };
  for (const field of definition.externalFields || []) delete stripped[field.key];
  return stripped;
};

const endpointLines = (definition, config, service) => {
  if (config?.mode === 'disabled') return [];
  const effective =
    config?.mode === 'external' ? config : withoutStoredExternalFields(definition, config);
  return definition.endpointLines?.(effective, service) || [];
};

const externalFields = (definition, config) =>
  (definition.externalFields || []).map((field) => ({
    ...field,
    value: config?.[field.key],
  }));

const renderModeOptions = (protocol, mode) =>
  (SERVICE_DEFINITIONS[protocol]?.modes || ['managed', 'disabled'])
    .map(
      (value) =>
        `<option value="${value}"${mode === value ? ' selected' : ''}>${NODE_MODE_LABELS[value]}</option>`
    )
    .join('');

const renderExternalEditor = (protocol, config, mode, draft) => {
  const definition = SERVICE_DEFINITIONS[protocol];
  const fields = externalFields(definition, config).map((field) => {
    const value = draft?.values?.[field.key] ?? field.value ?? '';
    const invalid = draft?.invalid?.includes(field.key);
    return `
      <div class="profile-node-field">
        <label for="profile-${protocol}-${field.key}">${esc(field.label)}</label>
        <input
          id="profile-${protocol}-${field.key}"
          class="rpc-input"
          data-endpoint-field="${field.key}"
          type="text"
          value="${esc(value)}"
          placeholder="${esc(field.placeholder || '')}"
          spellcheck="false"${invalid ? ' aria-invalid="true"' : ''}
        />
      </div>`;
  });

  const note = definition?.externalNote
    ? `<p class="profile-node-note">${esc(definition.externalNote)}</p>`
    : '';

  return `
    <div class="profile-node-editor" data-external-editor ${mode === 'external' ? '' : 'hidden'}>
      ${fields.join('')}
      ${note}
    </div>`;
};

const setProfileStatus = (message, kind) => {
  if (!profileFields.saveStatus) return;
  profileFields.saveStatus.textContent = message || '';
  profileFields.saveStatus.className = 'rpc-status' + (kind ? ' ' + kind : '');
};

const setNodesStatus = (message, kind) => {
  if (!profileFields.nodesStatus) return;
  profileFields.nodesStatus.textContent = message || '';
  profileFields.nodesStatus.className = 'rpc-status' + (kind ? ' ' + kind : '');
};

const setExternalEditorVisible = (row, mode) => {
  row?.querySelector('[data-external-editor]')?.toggleAttribute('hidden', mode !== 'external');
};

const renderProfileNodes = (profile, registry, settings) => {
  const nodes = profile?.nodes || {};
  storedProfileNodes = nodes;
  const rows = visibleProfileServices(settings).map((definition) => {
    const protocol = definition.protocol;
    const config = nodes[protocol] || {};
    const service = registry?.[protocol] || {};
    // An uncommitted edit (an external switch still missing its endpoint,
    // or one the main process refused) outlives the periodic re-render, so
    // the row keeps showing what the user picked next to why it was not
    // saved — the stored config underneath is untouched.
    const draft = nodeDrafts.get(protocol);
    const mode = draft?.mode || config.mode || 'managed';
    const lines = endpointLines(definition, config, service);
    const details = lines.length
      ? lines.map((line) => `<div class="profile-node-detail">${esc(line)}</div>`).join('')
      : '<div class="profile-node-detail">No endpoint</div>';

    return `
      <div class="profile-node" data-protocol="${protocol}">
        <div class="profile-node-main">
          <p class="profile-node-name">${SERVICE_LABELS[protocol]}</p>
          <select data-node-mode>
            ${renderModeOptions(protocol, mode)}
          </select>
        </div>
        <div class="profile-node-status">
          <div class="profile-node-status-line">${esc(statusLabel(service))}</div>
          ${details}
          ${renderExternalEditor(protocol, config, mode, draft)}
          <p class="profile-node-error" data-node-error role="alert"${draft?.error ? '' : ' hidden'}>${esc(draft?.error || '')}</p>
        </div>
      </div>`;
  });

  // Committing one row re-renders the card (the profile-updated broadcast),
  // usually just as focus moves on to the next control. Put focus — and
  // anything already typed into a focused field — back where it was.
  const active = document.activeElement;
  const focused =
    active && profileFields.nodesCard.contains(active)
      ? {
          protocol: active.closest('.profile-node')?.dataset.protocol,
          field: active.dataset?.endpointField,
          mode: active.matches?.('[data-node-mode]'),
          value: active.value,
        }
      : null;

  profileFields.nodesCard.innerHTML = rows.join('');

  if (focused?.protocol && (focused.field || focused.mode)) {
    const row = profileFields.nodesCard.querySelector(
      `.profile-node[data-protocol="${focused.protocol}"]`
    );
    const target = focused.field
      ? row?.querySelector(`[data-endpoint-field="${focused.field}"]`)
      : row?.querySelector('[data-node-mode]');
    if (target) {
      if (focused.field) target.value = focused.value;
      target.focus();
    }
  }
};

const refreshProfileSection = async (force = false) => {
  if (!profileFields.nodesCard) return;
  if (
    !force &&
    document.activeElement &&
    (profileFields.nodesCard.contains(document.activeElement) ||
      profileFields.nameInput === document.activeElement)
  ) {
    return;
  }

  const seq = ++profileRefreshSeq;
  try {
    const [profile, registry, settings] = await Promise.all([
      freedomAPI.getActiveProfile?.(),
      freedomAPI.getServiceRegistry().catch(() => null),
      freedomAPI.getSettings?.().catch(() => null),
    ]);
    if (seq !== profileRefreshSeq) return;
    const profileId = profile?.id || null;
    if (profileId !== activeProfileId) nodeDrafts.clear();
    activeProfileId = profileId;
    const label = profile?.displayName || profile?.id || '';
    if (profileFields.nameInput && profileFields.nameInput !== document.activeElement) {
      profileFields.nameInput.value = label;
      savedProfileName = label;
    }
    renderProfileNodes(profile, registry, settings);
  } catch {
    if (seq !== profileRefreshSeq) return;
    profileFields.nodesCard.innerHTML =
      '<div class="profile-node-empty">Profile data unavailable</div>';
  }
};

setProfileRefreshActive = (active) => {
  if (!active && profileRefreshTimer) {
    clearInterval(profileRefreshTimer);
    profileRefreshTimer = null;
    return;
  }
  if (active && !profileRefreshTimer) {
    refreshProfileSection(true);
    profileRefreshTimer = setInterval(refreshProfileSection, 5000);
  }
};
const isProfileOrNodesSection = () => {
  const section = resolveSection(location.hash);
  return section === 'profile' || section === 'nodes';
};
setProfileRefreshActive(isProfileOrNodesSection());
freedomAPI.onProfileUpdated?.(() => {
  refreshRadicleLaunchStatus();
  refreshSwarmCacheRow();
  syncSwarmCacheUsage({ restart: true });
  if (isProfileOrNodesSection()) {
    refreshProfileSection(true);
  }
});

// Renaming auto-saves when the field is left (blur) or Enter is hit.
// There is no success message — only failures surface. Empty, unchanged,
// or non-editable values silently revert to the committed name.
const commitProfileName = async () => {
  const input = profileFields.nameInput;
  if (!input) return;
  setProfileStatus('', null);
  const displayName = input.value.trim();
  if (!activeProfileId || !displayName || displayName === savedProfileName) {
    input.value = savedProfileName;
    return;
  }
  try {
    const result = await freedomAPI.renameProfile?.(activeProfileId, displayName);
    if (!result?.success) {
      throw new Error(result?.error?.message || 'Profile could not be renamed');
    }
    savedProfileName = displayName;
    input.value = displayName;
  } catch (err) {
    setProfileStatus(err?.message || 'Profile could not be renamed', 'error');
    input.value = savedProfileName;
  }
};

profileFields.nameInput?.addEventListener('blur', () => {
  commitProfileName();
});

profileFields.nameInput?.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    // Blur commits via the blur handler.
    profileFields.nameInput.blur();
  } else if (event.key === 'Escape') {
    event.preventDefault();
    // Restore the committed name first so the blur commit is a no-op.
    profileFields.nameInput.value = savedProfileName;
    profileFields.nameInput.blur();
  }
});

// Nodes commit the way every other Settings control does: the mode
// <select> on change, the endpoint fields when they are left (focusout,
// or Enter). There is no Save button. "Use external node" only commits
// once its endpoint fields are filled; until then the row keeps the
// selection as a draft, flags the empty fields and says the stored mode
// is unchanged. The main process validates a patch as a whole and
// refuses it as a whole, so a refused commit can't half-apply either.
const nodeRowConfig = (row) => {
  const protocol = row?.dataset.protocol;
  const mode = row?.querySelector('[data-node-mode]')?.value;
  const values = {};
  for (const input of row?.querySelectorAll('[data-endpoint-field]') || []) {
    values[input.dataset.endpointField] = input.value.trim();
  }
  return { protocol, mode, values };
};

// Paint a row's draft state onto whatever row is live now: a commit's
// reply can land after a re-render replaced the row it started from.
const setNodeDraft = (protocol, draft) => {
  if (draft) nodeDrafts.set(protocol, draft);
  else nodeDrafts.delete(protocol);
  const row = profileFields.nodesCard?.querySelector(`.profile-node[data-protocol="${protocol}"]`);
  if (!row) return;
  for (const input of row.querySelectorAll('[data-endpoint-field]')) {
    if (draft?.invalid?.includes(input.dataset.endpointField)) {
      input.setAttribute('aria-invalid', 'true');
    } else {
      input.removeAttribute('aria-invalid');
    }
  }
  const error = row.querySelector('[data-node-error]');
  if (error) {
    error.textContent = draft?.error || '';
    error.hidden = !draft?.error;
  }
};

// Why a row was not saved, ending with what the stored config still is.
const nodeNotSavedMessage = (protocol, mode, reason) => {
  const label = SERVICE_LABELS[protocol];
  const storedMode = storedProfileNodes?.[protocol]?.mode || 'managed';
  const kept =
    mode === storedMode
      ? `the saved ${label} endpoint is unchanged`
      : `${label} is still set to ${NODE_MODE_LABELS[storedMode] || storedMode}`;
  return `${reason} Not saved — ${kept}.`;
};

// Which endpoint fields a refused commit should flag. Only an endpoint
// error names fields; any other refusal (profile not editable, catalog
// write failed) says nothing about what was typed, so nothing is flagged.
const invalidNodeFields = (error) => {
  const details = error?.details || {};
  if (typeof details.field === 'string') return [details.field];
  if (Array.isArray(details.fields)) return details.fields;
  return [];
};

const commitNodeRow = (row) => {
  const { protocol, mode, values } = nodeRowConfig(row);
  if (!protocol || !mode) return Promise.resolve();
  const label = SERVICE_LABELS[protocol];
  const fieldKeys = Object.keys(values);

  if (mode === 'external') {
    const missing = fieldKeys.filter((key) => !values[key]);
    if (missing.length) {
      const names = (SERVICE_DEFINITIONS[protocol]?.externalFields || [])
        .filter((field) => missing.includes(field.key))
        .map((field) => field.label);
      setNodesStatus('', null);
      setNodeDraft(protocol, {
        mode,
        values,
        invalid: missing,
        error: nodeNotSavedMessage(
          protocol,
          mode,
          `Enter the ${names.join(', ')} endpoint to use an external ${label} node.`
        ),
      });
      return Promise.resolve();
    }
  }

  // Only an external commit carries endpoints. Switching to managed or
  // disabled leaves the stored endpoint as it is (the catalog merges), so a
  // half-typed endpoint in a now-hidden field can't make that switch fail.
  const config = mode === 'external' ? { mode, ...values } : { mode };

  // Serialise commits so two quick edits land in the order they were made
  // (IPC replies are not guaranteed to come back in dispatch order), and
  // compare against the stored config only once the previous commit landed.
  nodeSave = nodeSave
    .catch(() => {})
    .then(async () => {
      const stored = storedProfileNodes?.[protocol] || {};
      const unchanged =
        mode === (stored.mode || 'managed') &&
        (mode !== 'external' || fieldKeys.every((key) => values[key] === (stored[key] || '')));
      if (unchanged) {
        // Picking the stored mode again, or leaving a field as it was, is
        // not an edit: nothing to save, and nothing to restart.
        setNodeDraft(protocol, null);
        return;
      }
      setNodesStatus(`Saving ${label} node settings…`, 'testing');
      try {
        const result = await freedomAPI.updateProfileNodeConfig?.(protocol, config);
        // `details.saved`: the catalog write landed and only applying it to
        // the running node failed — the config is stored, so it is not a
        // draft and must not be reported as "not saved".
        const saved = result?.success || result?.error?.details?.saved === true;
        if (!saved) {
          const err = new Error(result?.error?.message || 'Profile node settings were not saved');
          err.invalid = invalidNodeFields(result?.error);
          throw err;
        }
        // Take the stored config from the reply rather than from the forced
        // refresh below: a newer refresh (the 5s timer, a profile-updated
        // broadcast) can supersede that one, and it returns without
        // rendering — the next queued commit's no-op check would then compare
        // against the config from before this one landed.
        const storedNodes = result.profile?.nodes;
        if (
          storedNodes &&
          typeof storedNodes === 'object' &&
          result.profile.id === activeProfileId
        ) {
          storedProfileNodes = storedNodes;
        }
        setNodeDraft(protocol, null);
        if (result.success) {
          setNodesStatus(
            `${label} saved. Restart the node to apply mode or endpoint changes.`,
            'success'
          );
        } else {
          setNodesStatus(
            `${label} saved, but applying it failed: ${String(result.error.message || 'unknown error').replace(/[.\s]+$/, '')}. Restart the node to apply mode or endpoint changes.`,
            'error'
          );
        }
        await refreshProfileSection(true);
        await refreshRadicleLaunchStatus();
      } catch (err) {
        setNodesStatus('', null);
        setNodeDraft(protocol, {
          mode,
          values,
          invalid: err?.invalid || [],
          error: nodeNotSavedMessage(
            protocol,
            mode,
            `${err?.message || 'Profile node settings were not saved'}.`
          ),
        });
      }
    });
  return nodeSave;
};

profileFields.nodesCard?.addEventListener('change', (event) => {
  const modeSelect = event.target?.closest?.('[data-node-mode]');
  if (!modeSelect) return;
  const row = modeSelect.closest('.profile-node');
  setExternalEditorVisible(row, modeSelect.value);
  commitNodeRow(row);
});

profileFields.nodesCard?.addEventListener('input', (event) => {
  const input = event.target?.closest?.('[data-endpoint-field]');
  if (!input) return;
  // Keep a pending draft's values current so a re-render (profile update,
  // the 5s refresh once focus leaves the card) doesn't drop what was typed.
  const row = input.closest('.profile-node');
  const draft = nodeDrafts.get(row?.dataset.protocol);
  if (draft) draft.values = nodeRowConfig(row).values;
});

profileFields.nodesCard?.addEventListener('focusout', (event) => {
  const input = event.target?.closest?.('[data-endpoint-field]');
  if (!input) return;
  commitNodeRow(input.closest('.profile-node'));
});

profileFields.nodesCard?.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter') return;
  const input = event.target?.closest?.('[data-endpoint-field]');
  if (!input) return;
  event.preventDefault();
  // Blur commits via the focusout handler, like the profile name field.
  input.blur();
});

const currentFormState = () => ({
  theme: fields.themeMode.value || 'system',
  tabsInTitlebar: fields.tabsInTitlebar.checked,
  startAntAtLaunch: fields.startAnt.checked,
  startIpfsAtLaunch: fields.startIpfs.checked,
  startMyotisAtLaunch: fields.startMyotis.checked,
  startMyotisGnosisAtLaunch: fields.startMyotisGnosis.checked,
  askWhereToSave: fields.askWhereToSave.checked,
  startRadicleAtLaunch: fields.startRadicle.checked,
  enableTorIntegration: fields.enableTor.checked,
  startTorAtLaunch: fields.startTor.checked,
  enableIdentityWallet: fields.enableIdentity.checked,
  showIpfsProgressStatus: fields.showIpfsProgressStatus.checked,
  autoUpdate: fields.autoUpdate.checked,
  blockUnverifiedEns: fields.unverifiedEnsAction.value !== 'open',
  adblockEnabled: fields.adblockEnabled.checked,
  adblockAds: fields.adblockAds.checked,
  adblockPrivacy: fields.adblockPrivacy.checked,
  adblockCookies: fields.adblockCookies.checked,
  adblockAnnoyances: fields.adblockAnnoyances.checked,
  adblockAutoUpdate: fields.adblockAutoUpdate.checked,
});

const applyFormState = (settings) => {
  if (!settings) return;
  fields.themeMode.value = settings.theme || 'system';
  fields.tabsInTitlebar.checked = settings.tabsInTitlebar === true;
  fields.startAnt.checked = settings.startAntAtLaunch !== false;
  fields.startIpfs.checked = settings.startIpfsAtLaunch !== false;
  fields.startMyotis.checked = settings.startMyotisAtLaunch === true;
  fields.startMyotisGnosis.checked = settings.startMyotisGnosisAtLaunch === true;
  fields.askWhereToSave.checked = settings.askWhereToSave === true;
  fields.startRadicle.checked = settings.startRadicleAtLaunch === true;
  fields.enableTor.checked = settings.enableTorIntegration === true;
  fields.startTor.checked = settings.startTorAtLaunch === true;
  fields.enableIdentity.checked = settings.enableIdentityWallet === true;
  fields.showIpfsProgressStatus.checked = settings.showIpfsProgressStatus === true;
  fields.autoUpdate.checked = settings.autoUpdate !== false;
  fields.unverifiedEnsAction.value = settings.blockUnverifiedEns === false ? 'open' : 'ask';
  fields.adblockEnabled.checked = settings.adblockEnabled !== false;
  fields.adblockAds.checked = settings.adblockAds !== false;
  fields.adblockPrivacy.checked = settings.adblockPrivacy !== false;
  fields.adblockCookies.checked = settings.adblockCookies === true;
  fields.adblockAnnoyances.checked = settings.adblockAnnoyances === true;
  fields.adblockAutoUpdate.checked = settings.adblockAutoUpdate !== false;
  applyStartTorRowState();
  // Re-evaluated whenever the form is repainted from a payload — first
  // load, and a broadcast that differs from what's on screen. Enabling
  // the integration is what keeps the rows on a build that bundles no
  // Arti binary. Note the broadcast that follows this page's *own* save
  // matches the form, so `onSettingsUpdated` skips applyFormState and
  // this call with it: switching the integration back off on such a
  // build leaves the rows up until the page is reloaded, which is the
  // intended escape hatch rather than an oversight — the user can still
  // see and re-enable what they just turned off.
  applyTorRowVisibility(settings);
  applyAdblockGating();
};

// With no filter lists the engine cannot run, so the section's controls
// do nothing — say so once (in the status line) and disable them, rather
// than leaving six live toggles above a line that says blocking is
// inactive (#274). Lists can still arrive later through the Swarm list
// updater, which only runs with the master and auto-update switches on
// and only fetches the categories switched on (update-scheduler.js,
// update-manager.js). So a control stays usable while switching it on
// is the way out: the master switch when it is off, and the category
// switches when none of them is on. The auto-update switch is never
// frozen: switching it on is a way out, and switching it off is the
// only way to stop the updater's background Swarm fetches while the
// master is held on. Anything else is frozen in place until lists exist.
let adblockUnavailable = false;

const applyAdblockGating = () => {
  const freeze = (row, field, keepUsable) => {
    if (!adblockUnavailable || keepUsable) return;
    row?.classList.add('disabled');
    if (field) field.disabled = true;
  };
  fields.adblockEnabled.disabled = false;
  $('adblock-enabled-row')?.classList.remove('disabled');
  freeze($('adblock-enabled-row'), fields.adblockEnabled, !fields.adblockEnabled.checked);

  const noCategoryOn = ADBLOCK_CATEGORIES.every(({ field }) => !field.checked);
  for (const { id, field } of ADBLOCK_CATEGORIES) {
    const row = $(`adblock-${id}-row`);
    setFieldEnabled(fields.adblockEnabled, row, field);
    freeze(row, field, noCategoryOn);
  }
  const autoUpdateRow = $('adblock-autoupdate-row');
  setFieldEnabled(fields.adblockEnabled, autoUpdateRow, fields.adblockAutoUpdate);
};

// Rule counts / list version come from the main-process engine, not
// settings. The engine rebuilds asynchronously after a toggle, so
// refresh once more shortly after a save.
const renderAdblockStatus = async () => {
  try {
    const status = await freedomAPI.adblockGetStatus();
    // Before the first engine build has looked for lists, "no version"
    // means "not checked yet", not "no lists" — keep the section live.
    const listsPending = status.listsResolved === false;
    adblockUnavailable = !listsPending && !status.engineReady && !status.listsVersion;
    $('adblock-status').textContent = status.engineReady
      ? `Filter lists ${status.listsVersion} · engine active`
      : status.listsVersion
        ? `Filter lists ${status.listsVersion} · engine preparing…`
        : listsPending
          ? 'Checking filter lists…'
          : 'No filter lists available. Ad blocking cannot run.';
    // A row can cover more than one list ("Block ads" is EasyList plus
    // the uBlock filters that carry the YouTube scriptlets, #410); its
    // helper is their combined rule count, no list names (#274).
    for (const { id, lists = [id] } of ADBLOCK_CATEGORIES) {
      const ruleCount = lists.reduce(
        (sum, list) => sum + (status.categories?.[list]?.ruleCount || 0),
        0
      );
      if (ruleCount) {
        $(`adblock-${id}-help`).textContent = `${ruleCount.toLocaleString()} rules`;
      }
    }
    applyAdblockGating();
    // Keep watching while there is nothing to run: the list updater (or
    // a first engine build still resolving at startup) can supply lists
    // at any time, and the section should come alive when it does.
    if (listsPending) refreshAdblockStatusSoon(1500);
    else if (adblockUnavailable) refreshAdblockStatusSoon(5000);
  } catch {
    $('adblock-status').textContent = 'Status unavailable.';
  }
};
let adblockStatusTimer = null;
const refreshAdblockStatusSoon = (delay = 1500) => {
  clearTimeout(adblockStatusTimer);
  adblockStatusTimer = setTimeout(renderAdblockStatus, delay);
};

const renderAdblockAllowlist = async () => {
  const list = $('adblock-allowlist-list');
  let hosts;
  try {
    hosts = await freedomAPI.adblockGetAllowlist();
  } catch {
    return;
  }
  list.textContent = '';
  for (const host of hosts) {
    const row = document.createElement('div');
    row.className = 'row';
    const body = document.createElement('div');
    body.className = 'row-body';
    const label = document.createElement('p');
    label.className = 'row-label';
    label.textContent = host;
    body.appendChild(label);
    const control = document.createElement('div');
    control.className = 'row-control';
    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'btn';
    removeBtn.textContent = 'Remove';
    removeBtn.addEventListener('click', async () => {
      await freedomAPI.adblockRemoveAllowlistHost(host).catch(() => {});
      renderAdblockAllowlist();
    });
    control.appendChild(removeBtn);
    row.appendChild(body);
    row.appendChild(control);
    list.appendChild(row);
  }
};

const addAllowlistHostFromInput = async () => {
  const input = $('adblock-allowlist-input');
  const host = input.value.trim();
  if (!host) return;
  const ok = await freedomAPI.adblockAddAllowlistHost(host).catch(() => false);
  if (ok) {
    input.value = '';
    renderAdblockAllowlist();
  }
};

let cachedSettings = null;
let cachedSetupState = null;

// The Swarm publishing row mirrors the main process's publish setup state
// (src/main/swarm/publish-setup-service.js): whether this profile's node can
// publish, and one button into the wallet sidebar that fixes it or manages
// the storage. The node needs no mode switch any more; buying storage there
// is the whole setup.
const renderSwarmPublishingRow = (settings, setupState) => {
  // Use onclick (not addEventListener) so each render atomically replaces
  // the prior handler — handler closes over the current state, and we
  // re-render across state transitions.
  const showAction = (label, target) => {
    swarmPublishingBtn.hidden = false;
    swarmPublishingBtn.textContent = label;
    swarmPublishingBtn.onclick = () => {
      freedomAPI.openPublishSetup(target).catch((err) => {
        console.error('[settings] could not open the publish setup:', err);
      });
    };
  };

  const hideAction = () => {
    swarmPublishingBtn.hidden = true;
    swarmPublishingBtn.onclick = null;
  };

  if (setupState?.node?.registryMode === 'reused') {
    swarmPublishingHelp.textContent =
      'Connected to a Swarm node managed outside Freedom. Set up publishing where that node runs.';
    hideAction();
    return;
  }

  // The publish setup lives inside the wallet sidebar, which is gated by the
  // Identity & Wallet feature flag. If that's off, offering a button would
  // deep-link into a sidebar the user can't open.
  if (settings?.enableIdentityWallet !== true) {
    swarmPublishingHelp.textContent =
      'Enable Identity & Wallet under Advanced to publish on Swarm.';
    hideAction();
    return;
  }

  if (!setupState) {
    swarmPublishingHelp.textContent = 'Checking the Swarm node…';
    hideAction();
    return;
  }

  const readiness = setupState.readiness || {};
  if (readiness.ok || readiness.key === 'storage-pending') {
    swarmPublishingHelp.textContent = readiness.message;
    showAction('Manage storage', 'storage');
    return;
  }

  const op = setupState.operation;
  swarmPublishingHelp.textContent =
    op?.phase === 'awaiting-funds'
      ? 'Waiting for your payment to the Swarm node.'
      : op?.phase === 'executing'
        ? 'Buying storage…'
        : op?.phase === 'confirming'
          ? 'Your storage is bought. The Swarm network is confirming it.'
          : readiness.message || 'Publishing is not set up.';
  showAction('Set up publishing', 'setup');
};

const refreshSwarmPublishingRow = async () => {
  try {
    cachedSetupState = await freedomAPI.getPublishSetupState();
  } catch {
    cachedSetupState = null;
  }
  renderSwarmPublishingRow(cachedSettings, cachedSetupState);
};

freedomAPI.onPublishSetupState?.((state) => {
  const previousNodeStatus = cachedSetupState?.node?.status;
  cachedSetupState = state;
  renderSwarmPublishingRow(cachedSettings, cachedSetupState);
  // The cache usage line follows the node at once (stopped → starting →
  // running), rather than on its next poll, and picks polling back up when a
  // stopped node starts again.
  const nodeStatus = state?.node?.status;
  if (nodeStatus && nodeStatus !== previousNodeStatus) {
    syncSwarmCacheUsage({ restart: true });
  }
});

// Settings → Nodes → Swarm cache: how much it holds (#579). The main process
// reads the node's `/v0/cache` (or `/debugstore`) and words the line (swarm/ant-cache.js); this
// page only paints it. It is read every few seconds while the row is on
// screen — the Nodes section open, not covered by search results, the page not
// in a background tab — and not at all otherwise. A node that isn't running
// stops the polling too: the line says so, and a node status change (the
// publish setup broadcast, below) or a profile change picks it back up.
const SWARM_CACHE_POLL_MS = 3000;
const swarmCacheUsageRow = $('swarm-cache-row');
const swarmCacheUsageText = $('swarm-cache-usage-text');
const swarmCacheUsageNote = $('swarm-cache-usage-note');
let swarmCacheUsageTimer = null;
let swarmCacheUsageSeq = 0;
let swarmCacheUsageActive = false;

const swarmCacheRowOnScreen = () =>
  !document.hidden && Boolean(swarmCacheUsageRow?.getClientRects().length);

// Clear cache (#579) follows the usage line: the main process says with each
// reading whether the node can clear now (`canClear`) and, if not, why
// (`clearReason`), and this row shows that reason under the disabled button.
const swarmCacheClearButton = $('swarm-cache-clear');
const swarmCacheClearReason = $('swarm-cache-clear-reason');
const swarmCacheClearStatus = $('swarm-cache-clear-status');
let swarmCacheClearing = false;
let swarmCacheCanClear = false;

const paintSwarmCacheClear = (usage) => {
  swarmCacheCanClear = usage?.canClear === true;
  const reason = swarmCacheCanClear
    ? ''
    : usage?.clearReason || "The node's cache couldn't be read.";
  if (swarmCacheClearButton) {
    swarmCacheClearButton.disabled = swarmCacheClearing || !swarmCacheCanClear;
  }
  if (swarmCacheClearReason) {
    swarmCacheClearReason.textContent = reason;
    swarmCacheClearReason.hidden = !reason;
  }
};

const paintSwarmCacheUsage = (usage) => {
  if (swarmCacheUsageText) swarmCacheUsageText.textContent = usage?.text || 'Unknown';
  if (swarmCacheUsageNote) {
    swarmCacheUsageNote.textContent = usage?.reason || '';
    swarmCacheUsageNote.hidden = !usage?.reason;
  }
  paintSwarmCacheClear(usage);
};

const stopSwarmCacheUsage = () => {
  clearTimeout(swarmCacheUsageTimer);
  swarmCacheUsageTimer = null;
  // A read still out lands on nothing.
  swarmCacheUsageSeq += 1;
  swarmCacheUsageActive = false;
};

const readSwarmCacheUsage = async () => {
  swarmCacheUsageTimer = null;
  const seq = ++swarmCacheUsageSeq;
  let usage;
  try {
    usage = (await freedomAPI.getSwarmCacheStatus?.()) || null;
  } catch {
    usage = null;
  }
  if (seq !== swarmCacheUsageSeq) return;
  paintSwarmCacheUsage(usage);
  if (usage?.state === 'not-running' || !swarmCacheRowOnScreen()) {
    swarmCacheUsageActive = false;
    return;
  }
  swarmCacheUsageTimer = setTimeout(readSwarmCacheUsage, SWARM_CACHE_POLL_MS);
};

syncSwarmCacheUsage = ({ restart = false } = {}) => {
  if (!swarmCacheRowOnScreen()) {
    stopSwarmCacheUsage();
    return;
  }
  if (swarmCacheUsageActive && !restart) return;
  stopSwarmCacheUsage();
  swarmCacheUsageActive = true;
  readSwarmCacheUsage();
};

swarmCacheClearButton?.addEventListener('click', async () => {
  if (swarmCacheClearing || !swarmCacheCanClear) return;
  if (
    !window.confirm(
      "Clear the Swarm cache?\n\nSwarm pages you've opened will load from the network again. Pinned and published content is kept."
    )
  ) {
    return;
  }
  swarmCacheClearing = true;
  swarmCacheClearButton.disabled = true;
  if (swarmCacheClearStatus) swarmCacheClearStatus.textContent = 'Clearing…';
  let result;
  try {
    result = await freedomAPI.clearSwarmCache();
  } catch {
    result = null;
  }
  swarmCacheClearing = false;
  if (swarmCacheClearStatus) {
    swarmCacheClearStatus.textContent = result?.ok
      ? result.text
      : `The Swarm cache wasn't cleared. ${result?.error || "The Swarm node didn't answer."}`;
  }
  // The usage line (and the button with it) shows the cache after the clear
  // now, not on the next poll.
  swarmCacheClearButton.disabled = !swarmCacheCanClear;
  syncSwarmCacheUsage({ restart: true });
});

document.addEventListener('visibilitychange', () => syncSwarmCacheUsage());
// The section the page opened on was shown before this ran.
syncSwarmCacheUsage();

// Settings → Nodes → Swarm cache size (#579). The sizes, the current one and
// whether Freedom runs this profile's node come from the main process
// (src/main/swarm/ant-cache.js). A running node takes the new size live
// (Ant v0.5.61+), so nothing restarts and nothing asks first.
const swarmCacheRow = $('swarm-cache-row');
const swarmCacheSelect = $('swarm-cache-size');
const swarmCacheStatus = $('swarm-cache-status');
let swarmCacheView = null;
let swarmCacheBusy = false;

const setSwarmCacheStatus = (text) => {
  if (swarmCacheStatus) swarmCacheStatus.textContent = text || '';
};

const renderSwarmCacheRow = (view) => {
  if (!swarmCacheSelect) return;
  swarmCacheView = view;
  if (!view || !Array.isArray(view.sizes)) {
    swarmCacheSelect.replaceChildren();
    swarmCacheSelect.disabled = true;
    swarmCacheRow?.classList.add('disabled');
    setSwarmCacheStatus("The cache size couldn't be read.");
    return;
  }
  swarmCacheSelect.replaceChildren(
    ...view.sizes.map(({ bytes, label }) => {
      const option = document.createElement('option');
      option.value = String(bytes);
      option.textContent = label;
      return option;
    })
  );
  swarmCacheSelect.value = String(view.bytes);
  swarmCacheSelect.disabled = !view.managed || swarmCacheBusy;
  swarmCacheRow?.classList.toggle('disabled', !view.managed);
  if (!swarmCacheBusy) setSwarmCacheStatus(view.managed ? '' : view.reason);
};

const refreshSwarmCacheRow = async () => {
  if (swarmCacheBusy) return;
  let view;
  try {
    view = await freedomAPI.getSwarmCacheSettings();
  } catch {
    view = null;
  }
  if (!swarmCacheBusy) renderSwarmCacheRow(view);
};

swarmCacheSelect?.addEventListener('change', async () => {
  // One change at a time: a second change event (arrow keys on the focused
  // select) while this one is still re-reading or applying is dropped, and the
  // picker is disabled before the first await so it can't fire one.
  if (swarmCacheBusy) return;
  const bytes = Number(swarmCacheSelect.value);
  swarmCacheBusy = true;
  swarmCacheSelect.disabled = true;
  // Re-read first: whether the node is running (and so whether this restarts
  // it) can have changed since the row was painted.
  let view = swarmCacheView;
  try {
    view = (await freedomAPI.getSwarmCacheSettings()) || view;
  } catch {
    // Keep the painted view.
  }
  const release = () => {
    swarmCacheBusy = false;
    renderSwarmCacheRow(view);
  };
  if (!view || !view.managed || bytes === view.bytes) {
    release();
    return;
  }
  const label = view.sizes.find((size) => size.bytes === bytes)?.label || '';
  setSwarmCacheStatus(view.nodeActive ? 'Applying…' : 'Saving…');
  let result;
  try {
    result = await freedomAPI.setSwarmCacheSize(bytes);
  } catch {
    result = { ok: false, error: "The cache size couldn't be saved." };
  }
  swarmCacheBusy = false;
  let message;
  if (!result?.ok) {
    message = result?.error || "The cache size couldn't be saved.";
  } else if (result.live) {
    message = `Swarm cache set to ${label}.`;
  } else if (result.error) {
    message = `Swarm cache set to ${label}. It applies the next time the Swarm node starts: ${result.error}`;
  } else {
    message = `Swarm cache set to ${label}. It applies the next time the Swarm node starts.`;
  }
  // The usage line shows the new size at once.
  if (result?.live) syncSwarmCacheUsage({ restart: true });
  let fresh;
  try {
    fresh = await freedomAPI.getSwarmCacheSettings();
  } catch {
    fresh = null;
  }
  renderSwarmCacheRow(fresh);
  setSwarmCacheStatus(message);
});

const save = async () => {
  const ok = await freedomAPI.saveSettings(currentFormState());
  if (!ok) console.error('[settings] failed to save settings');
};

fields.themeMode.addEventListener('change', save);
fields.tabsInTitlebar.addEventListener('change', () => {
  save();
  $('tabs-titlebar-restart').hidden = false;
});
$('tabs-titlebar-restart').addEventListener('click', () => freedomAPI.relaunchApp());
fields.startAnt.addEventListener('change', save);
fields.startIpfs.addEventListener('change', save);
fields.startMyotis.addEventListener('change', save);
fields.startMyotisGnosis.addEventListener('change', save);
fields.askWhereToSave.addEventListener('change', save);
fields.startRadicle.addEventListener('change', save);
fields.enableTor.addEventListener('change', () => {
  applyStartTorRowState();
  // Enabling the integration only reveals the controls — it does not
  // start Tor. Starting is via the node-status menu toggle or
  // "Start Tor when Freedom opens". Disabling stops it (settings-ui.js).
  save();
});
fields.startTor.addEventListener('change', save);
fields.enableIdentity.addEventListener('change', save);
fields.showIpfsProgressStatus.addEventListener('change', save);
fields.autoUpdate.addEventListener('change', save);
fields.unverifiedEnsAction.addEventListener('change', save);
fields.adblockEnabled.addEventListener('change', () => {
  applyAdblockGating();
  save();
  refreshAdblockStatusSoon();
});
for (const { field } of ADBLOCK_CATEGORIES) {
  field.addEventListener('change', () => {
    applyAdblockGating();
    save();
    refreshAdblockStatusSoon();
  });
}
fields.adblockAutoUpdate.addEventListener('change', () => {
  applyAdblockGating();
  save();
});
$('adblock-allowlist-add').addEventListener('click', addAllowlistHostFromInput);
$('adblock-allowlist-input').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') addAllowlistHostFromInput();
});

const formStateMatches = (settings) => {
  const form = currentFormState();
  return Object.keys(form).every((key) => form[key] === settings[key]);
};

// Broadcasts from main keep a second open settings tab in sync; skip the
// form re-render when the payload matches what's already on screen so we
// don't clobber an in-flight edit (e.g. the ENS RPC input mid-type).
// Re-render the Swarm publishing row too: it depends on the Identity &
// Wallet flag.
freedomAPI.onSettingsUpdated?.((settings) => {
  if (!settings) return;
  cachedSettings = settings;
  applySearchSettings(settings);
  if (!formStateMatches(settings)) {
    applyFormState(settings);
  }
  renderSwarmPublishingRow(cachedSettings, cachedSetupState);
  // Against what settings hold (null before the first start), not the size
  // shown, which before the first start is the one that start will write.
  if (swarmCacheView && (settings.antCacheCapacityBytes ?? null) !== swarmCacheView.storedBytes) {
    refreshSwarmCacheRow();
  }
});

(async () => {
  try {
    const platform = await freedomAPI.getPlatform();
    if (platform !== 'linux') {
      // Frameless titlebar is a Linux-only option.
      document.querySelectorAll('[data-linux-only]').forEach((el) => (el.style.display = 'none'));
    }
  } catch {
    // Non-fatal — assume Linux and leave the row visible.
  }

  try {
    const binary = await freedomAPI.checkTorBinary?.();
    torBundled = binary?.available !== false;
  } catch {
    // Non-fatal — assume the build bundles Arti and leave the rows up,
    // the same way the Radicle launch row stays live when its status
    // read fails.
  }
  applyTorRowVisibility();

  try {
    const settings = await freedomAPI.getSettings();
    cachedSettings = settings;
    applySearchSettings(settings);
    applyFormState(settings);
    refreshSwarmPublishingRow();
    refreshRadicleLaunchStatus();
    refreshSwarmCacheRow();
  } catch {
    console.error('[settings] failed to load settings');
  }

  renderAdblockStatus();
  renderAdblockAllowlist();
})();

// ── Shortcuts settings page ─────────────────────────────────────
// Render-only controller: the registry state, validation, conflict
// detection, and persistence all live in the main process behind
// freedomAPI.getShortcuts / previewShortcutBinding /
// setShortcutOverride / resetShortcut(s). This page captures
// keydowns in recording mode and paints whatever main answers.
(() => {
  const view = $('shortcuts-view');
  const searchInput = $('shortcut-search');
  const restoreBtn = $('shortcuts-restore-defaults');
  const statusEl = $('shortcuts-status');
  if (!view) return;

  let entries = [];
  let query = '';
  let recordingId = null; // shortcut currently capturing a new combo
  let conflictState = null; // { id, accelerator, formatted, conflict }
  let rowNotice = null; // { id, message } transient validation notice
  let recordingHandler = null;
  let recordingFocusHandler = null;

  const REASON_MESSAGES = {
    reserved: 'That combination is reserved and cannot be assigned.',
    'needs-modifier':
      'Combine that key with Ctrl, Alt or Cmd. Only function keys work on their own.',
    invalid: 'That key cannot be used as a shortcut.',
    'not-editable': 'This shortcut cannot be changed.',
    conflict: 'That combination is already in use.',
    'save-failed': 'Could not save the shortcut. Try again.',
  };

  const setStatus = (message, kind) => {
    if (!statusEl) return;
    statusEl.textContent = message || '';
    statusEl.className = 'rpc-status' + (kind ? ' ' + kind : '');
  };

  const matchesQuery = (entry) => {
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return [
      entry.settingsLabel || entry.description,
      entry.category,
      entry.formatted,
      entry.accelerator,
    ]
      .concat(entry.aliases)
      .join(' ')
      .toLowerCase()
      .includes(q);
  };

  const kbd = (text) => `<kbd class="shortcut-kbd">${esc(text)}</kbd>`;

  // The banner names the colliding shortcut the way its own row does
  // (sentence case, #277) — the two sit inside one card.
  const renderConflict = (state) => {
    const { conflict } = state;
    const message = conflict.fixed
      ? `${esc(state.formatted)} is already used by “${esc(conflict.settingsLabel)}” and cannot be reassigned. Pick a different combination.`
      : `${esc(state.formatted)} is already used by “${esc(conflict.settingsLabel)}”. Swap the bindings so “${esc(conflict.settingsLabel)}” becomes ${kbd(conflict.swapFormatted)}?`;
    return `
      <div class="row shortcut-conflict" data-shortcut-id="${esc(state.id)}">
        <div class="row-body"><p class="row-label">${message}</p></div>
        <span class="shortcut-conflict-actions">
          ${conflict.fixed ? '' : '<button type="button" class="btn" data-action="swap">Swap</button>'}
          <button type="button" class="btn" data-action="cancel-conflict">Cancel</button>
        </span>
      </div>`;
  };

  const renderRow = (entry) => {
    const isRecording = recordingId === entry.id;
    const notice = rowNotice?.id === entry.id ? rowNotice.message : null;
    const aliasLine = entry.aliases.length
      ? `<p class="row-help">Also ${entry.aliases.map(kbd).join(' ')}</p>`
      : '';
    // A remap the store reverted — at load because a newer default or
    // fixed alias took its combination, or on a save (a Reset restoring
    // a default that claims this row's chord) — say so on the row
    // instead of letting the binding silently snap back to the default.
    const revertedLine = entry.reverted
      ? `<p class="shortcut-note">Your ${kbd(entry.reverted.formatted)} remap was reset — that combination is now used by “${esc(entry.reverted.conflict)}”.</p>`
      : '';
    const warnLine =
      isRecording && entry.warnOnEdit
        ? '<p class="shortcut-note">Heads up: this is a common close gesture across apps — remapping it changes deep muscle memory.</p>'
        : '';
    const control = !entry.editable
      ? `<span class="shortcut-locked">${kbd(entry.formatted)} Locked</span>`
      : `<button type="button" class="btn shortcut-binding${isRecording ? ' recording' : ''}" data-action="record">
           ${isRecording ? 'Press new shortcut… (Esc cancels)' : kbd(entry.formatted)}
         </button>`;
    const resetBtn =
      entry.editable && entry.isOverridden && !isRecording
        ? `<button type="button" class="btn" data-action="reset" title="Reset to ${esc(entry.defaultFormatted)}">Reset</button>`
        : '';
    const conflictRow =
      conflictState && conflictState.id === entry.id ? renderConflict(conflictState) : '';
    return `
      <div class="row" data-shortcut-id="${esc(entry.id)}">
        <div class="row-body">
          <p class="row-label">${esc(entry.settingsLabel || entry.description)}</p>
          ${aliasLine}
          ${revertedLine}
          ${warnLine}
          ${notice ? `<p class="shortcut-note">${esc(notice)}</p>` : ''}
        </div>
        <div class="row-control shortcut-controls">${resetBtn}${control}</div>
      </div>
      ${conflictRow}`;
  };

  const render = () => {
    const visible = entries.filter(matchesQuery);
    if (!visible.length) {
      view.innerHTML =
        '<div class="card"><div class="profile-node-empty">No shortcuts match your search</div></div>';
      return;
    }
    const categories = [];
    for (const entry of visible) {
      if (!categories.includes(entry.category)) categories.push(entry.category);
    }
    view.innerHTML = categories
      .map(
        (category) => `
          <h3 class="shortcut-category">${esc(category)}</h3>
          <div class="card">
            ${visible
              .filter((entry) => entry.category === category)
              .map(renderRow)
              .join('')}
          </div>`
      )
      .join('');
  };

  const load = async () => {
    try {
      const state = await freedomAPI.getShortcuts();
      entries = (state?.entries || []).filter((entry) => !entry.hidden);
    } catch {
      entries = [];
      setStatus('Could not load shortcuts.', 'error');
    }
    render();
  };

  const stopRecording = () => {
    if (recordingId) {
      freedomAPI.setShortcutRecording?.(false)?.catch?.(() => {});
    }
    if (recordingHandler) {
      window.removeEventListener('keydown', recordingHandler, true);
      recordingHandler = null;
    }
    if (recordingFocusHandler) {
      document.removeEventListener('focusin', recordingFocusHandler, true);
      recordingFocusHandler = null;
    }
    recordingId = null;
  };

  const applyBinding = async (id, accelerator, swapWithConflict = false) => {
    let result;
    try {
      result = await freedomAPI.setShortcutOverride({ id, accelerator, swapWithConflict });
    } catch {
      result = { ok: false, reason: 'save-failed' };
    }
    if (!result?.ok) {
      rowNotice = { id, message: REASON_MESSAGES[result?.reason] || REASON_MESSAGES.invalid };
    } else {
      setStatus('Shortcut updated.', 'success');
    }
    await load();
  };

  const startRecording = (id) => {
    const entry = entries.find((item) => item.id === id);
    if (!entry?.editable || recordingId === id) return;
    stopRecording();
    conflictState = null;
    rowNotice = null;
    setStatus('');
    recordingId = id;
    // Next/Previous Tab are answered in main before the page sees the key;
    // tell it a recording is armed so the chord reaches the handler below.
    freedomAPI.setShortcutRecording?.(true)?.catch?.(() => {});
    render();

    // Chrome's own recorder gives up when the row it is recording loses
    // focus, and here it has to: the `keydown` listener below is on
    // `window` in the capture phase, so it sees every keystroke on the
    // page and calls `preventDefault()` on each one. A recording still
    // armed once the user has clicked into another field eats what they
    // type there — the page-wide search field included, where the first
    // swallowed key is the one that would have covered this section and
    // told the recording it was over.
    recordingFocusHandler = (event) => {
      if (view.contains(event.target)) return;
      stopRecording();
      render();
    };
    document.addEventListener('focusin', recordingFocusHandler, true);

    recordingHandler = async (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === 'Escape') {
        stopRecording();
        render();
        return;
      }
      const captured = {
        key: event.key,
        code: event.code,
        ctrlKey: event.ctrlKey,
        altKey: event.altKey,
        shiftKey: event.shiftKey,
        metaKey: event.metaKey,
      };
      let preview;
      try {
        preview = await freedomAPI.previewShortcutBinding({ id, event: captured });
      } catch {
        preview = { ok: false, reason: 'invalid' };
      }
      // Only modifiers held so far — keep listening.
      if (!preview.ok && preview.reason === 'incomplete') return;

      stopRecording();
      if (!preview.ok) {
        rowNotice = {
          id,
          message: REASON_MESSAGES[preview.reason] || REASON_MESSAGES.invalid,
        };
        render();
        return;
      }
      if (preview.conflict) {
        conflictState = {
          id,
          accelerator: preview.accelerator,
          formatted: preview.formatted,
          conflict: preview.conflict,
        };
        render();
        return;
      }
      await applyBinding(id, preview.accelerator);
    };
    window.addEventListener('keydown', recordingHandler, true);
  };

  view.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-action]');
    if (!button) return;
    const id = event.target.closest('[data-shortcut-id]')?.dataset.shortcutId;
    if (!id) return;

    switch (button.dataset.action) {
      case 'record':
        startRecording(id);
        break;
      case 'reset': {
        stopRecording();
        conflictState = null;
        rowNotice = null;
        const result = await freedomAPI.resetShortcut(id).catch(() => null);
        setStatus(
          result?.ok ? 'Shortcut reset to default.' : 'Could not reset.',
          result?.ok ? 'success' : 'error'
        );
        await load();
        break;
      }
      case 'swap': {
        const pending = conflictState;
        conflictState = null;
        if (pending) await applyBinding(pending.id, pending.accelerator, true);
        break;
      }
      case 'cancel-conflict':
        conflictState = null;
        render();
        break;
    }
  });

  searchInput?.addEventListener('input', () => {
    query = searchInput.value || '';
    render();
  });

  // This section stays in the DOM when it is hidden, and the page-wide
  // search reads every section's live markup (`buildSettingsSearchIndex`
  // above): a filter still applied here keeps every shortcut it excludes
  // out of that index, so "zoom" answers "No settings match" from
  // anywhere else on the page for the rest of the session — and a filter
  // that matched nothing takes the whole section with it. So the view is
  // put back whenever it is not the one on screen: on the way out of the
  // section (the contract Chains and RPC Providers keep below) and
  // before the page-wide field reads the page, which it can do without
  // the hash ever changing. The transient row state goes the same way —
  // a conflict banner is a `.row-label` the index would offer as a
  // setting — and so does an armed recording, whose window-level
  // `keydown` capture would otherwise go on swallowing every keystroke
  // on the page.
  const resetView = () => {
    if (!query && !recordingId && !conflictState && !rowNotice) return;
    stopRecording();
    conflictState = null;
    rowNotice = null;
    query = '';
    if (searchInput) searchInput.value = '';
    render();
  };
  settingsSearchResets.push(resetView);
  window.addEventListener('hashchange', () => {
    if (resolveSection(location.hash) !== 'shortcuts') resetView();
  });

  restoreBtn?.addEventListener('click', async () => {
    stopRecording();
    conflictState = null;
    rowNotice = null;
    const result = await freedomAPI.resetAllShortcuts().catch(() => null);
    setStatus(
      result?.ok ? 'All shortcuts restored to defaults.' : 'Could not restore defaults.',
      result?.ok ? 'success' : 'error'
    );
    await load();
  });

  // Keep a second open settings tab (or a remap made elsewhere) in
  // sync — but never clobber an in-progress recording or conflict
  // prompt.
  freedomAPI.onSettingsUpdated?.(() => {
    if (!recordingId && !conflictState) load();
  });

  load();
})();

// ── Chains settings page ────────────────────────────────────────
// Master-detail controller for the #chains panel of Networks: a list of
// chains, each drilling into a per-chain detail view of that chain's
// endpoint sources. Hash-routed — #networks is the list (with RPC
// Providers and Name Resolution under it), #networks/<chainId> a detail
// (#chains and #chains/<chainId> before #268, still accepted). Talks to the registry via
// freedomAPI's networks:* bridge; every mutation re-fetches and
// re-renders so the view mirrors the registry.
(() => {
  const section = $('chains');
  const view = $('chains-view');
  const statusEl = $('chains-status');
  const content = document.querySelector('main.content');
  if (!section || !view) return;

  const esc = (s) =>
    String(s == null ? '' : s).replace(
      /[&<>"]/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]
    );

  let config = { networks: {}, sources: [] };
  let myotisStatuses = {};
  let endpointForm = null; // null | { mode, id, url } — chain is the open detail; role is always rpc
  let endpointSaveInFlight = false; // guards against a double-click adding two 'user-<Date.now()>' sources
  let addState = null; // null | { mode: 'search'|'manual', results, picked } — the add-chain flow

  // Shown when a chain-detail deep link names a chain the registry does
  // not have (#280). Named so the notice can be recognized again and
  // cleared when the user navigates on.
  const CHAIN_GONE_STATUS = 'That chain is no longer configured.';

  const setStatus = (msg, kind) => {
    if (!statusEl) return;
    statusEl.textContent = msg || '';
    statusEl.className = 'rpc-status' + (kind ? ' ' + kind : '');
  };

  const chainIdsSorted = () => Object.keys(config.networks).sort((a, b) => Number(a) - Number(b));
  const chainName = (cid) => config.networks[cid]?.name || 'Chain ' + cid;

  // The chain whose detail is open, parsed from the hash; null = list.
  // `#networks/rpc` and `#networks/ens` name Networks' other panels, not a
  // chain.
  const openChainId = () => {
    const parts = resolveRoute(location.hash).split('/');
    return parts[0] === 'networks' && parts[1] && PANEL_NAV[parts[1]] !== 'networks'
      ? parts[1]
      : null;
  };

  // A master-list button row: name + sub-line, trailing chevron.
  // `name`/`sub` must already be escaped; `attr` is a data-attribute
  // string the click handler reads.
  const navRow = ({ name, sub, action, attr, disabled }) => `
    <button type="button" class="net-row" data-action="${action}" ${attr}${disabled ? ' disabled' : ''}>
      <span class="net-row-text">
        <span class="net-row-name">${name}</span>
        <span class="net-row-sub">${sub}</span>
      </span>
      <span class="net-chevron" aria-hidden="true">›</span>
    </button>`;

  // A standalone action button in its own card (12px top margin).
  const cardButton = (label, action, variant = '') => `
    <div class="card" style="margin-top: 12px">
      <div class="rpc-block" style="border-top: none">
        <button type="button" class="btn${variant ? ' ' + variant : ''}" data-action="${action}">${label}</button>
      </div>
    </div>`;

  // --- master: chain list --------------------------------------
  const renderList = () => {
    const rows = chainIdsSorted()
      .map((cid) =>
        navRow({
          name: esc(chainName(cid)),
          sub: 'chain ' + esc(cid),
          action: 'open-chain',
          attr: `data-chain="${esc(cid)}"`,
        })
      )
      .join('');
    view.innerHTML = `
      <h3 class="panel-title">Chains</h3>
      <p class="row-help" style="margin-bottom: 16px">
        The chains Freedom resolves names and balances on. Select a
        chain to choose how Freedom reads it and which servers it asks.
      </p>
      <div class="card">${rows}</div>
      ${cardButton('Add chain', 'add-chain')}`;
  };

  // --- add-chain flow ------------------------------------------
  // In-controller state (like endpointForm): mode 'search' queries
  // the public chain catalogue, 'manual' takes a hand-entered chain;
  // `picked` holds a catalogue chain awaiting confirmation.
  const searchResultsHtml = () => {
    if (addState.results === null) {
      return '<div class="rpc-block" style="border-top: none"><p class="rpc-hint">Loading…</p></div>';
    }
    if (!addState.results.length) {
      return '<div class="rpc-block" style="border-top: none"><p class="rpc-hint">No chains found</p></div>';
    }
    return addState.results
      .map((c) => {
        const exists = !!config.networks[String(c.chainId)];
        const bits = ['chain ' + c.chainId, c.rpcCount + ' RPC' + (c.rpcCount === 1 ? '' : 's')];
        if (c.isTestnet) bits.push('testnet');
        return navRow({
          name: esc(c.name) + (exists ? ' — added' : ''),
          sub: esc(bits.join(' · ')),
          action: 'pick-chain',
          attr: `data-chain-id="${esc(c.chainId)}"`,
          disabled: exists,
        });
      })
      .join('');
  };

  const searchHtml = () => `
    <div class="card">
      <div class="rpc-block" style="border-top: none">
        <div class="rpc-row">
          <input type="text" class="rpc-input" id="chain-search-input"
            placeholder="Search chains by name or ID…" spellcheck="false" />
        </div>
      </div>
    </div>
    <div class="card" id="chain-search-results" style="margin-top: 12px">${searchResultsHtml()}</div>
    ${cardButton('Enter a chain manually', 'add-manual')}`;

  const manualHtml = () => {
    const f = addState.manual || {};
    const decimals = f.decimalsRaw ?? '18';
    return `
      <div class="card">
        <div class="rpc-block" style="border-top: none">
          <p class="row-help" style="margin: 0 0 8px">
            For a chain not in the catalogue — your own devnet or a private network.
          </p>
          <div class="rpc-row" style="margin-bottom: 8px">
            <input type="text" class="rpc-input" id="man-chainid" placeholder="Chain ID (e.g. 8453)" spellcheck="false" value="${esc(f.chainId || '')}" />
          </div>
          <div class="rpc-row" style="margin-bottom: 8px">
            <input type="text" class="rpc-input" id="man-name" placeholder="Chain name" spellcheck="false" value="${esc(f.name || '')}" />
          </div>
          <div class="rpc-row" style="margin-bottom: 8px">
            <input type="text" class="rpc-input" id="man-symbol" placeholder="Currency symbol (e.g. ETH)" spellcheck="false" value="${esc(f.symbol || '')}" />
          </div>
          <div class="rpc-row" style="margin-bottom: 8px">
            <input type="number" class="rpc-input" id="man-decimals" placeholder="Currency decimals (e.g. 18)" value="${esc(decimals)}" min="0" step="1" />
          </div>
          <div class="rpc-row" style="margin-bottom: 8px">
            <input type="text" class="rpc-input" id="man-rpc" placeholder="RPC URL (https://… or http://localhost:8545)" spellcheck="false" value="${esc(f.rpc || '')}" />
          </div>
          ${addState.error ? `<p class="rpc-status error" style="margin-bottom: 8px">${esc(addState.error)}</p>` : ''}
          <button type="button" class="btn" data-action="submit-manual">Add chain</button>
          <button type="button" class="btn" data-action="add-search" style="margin-left: 8px">Back to search</button>
        </div>
      </div>`;
  };

  const renderAddConfirm = () => {
    const c = addState.picked;
    const rows = [
      ['Chain ID', String(c.chainId)],
      ['Currency', (c.nativeCurrency && c.nativeCurrency.symbol) || '—'],
      ['RPC endpoints', c.rpcUrls.length + ' will be imported'],
    ];
    if (c.explorerUrl) rows.push(['Explorer', c.explorerUrl]);
    const rowsHtml = rows
      .map(
        ([k, v]) => `
      <div class="row">
        <div class="row-body"><p class="row-label">${esc(k)}</p></div>
        <div class="row-control"><p class="row-help">${esc(v)}</p></div>
      </div>`
      )
      .join('');
    view.innerHTML = `
      <div class="settings-search-skip">
        <button type="button" class="back-link" data-action="add-back">‹ Search</button>
        <h2 class="section-title">${esc(c.name)}</h2>
        <p class="row-help" style="margin-bottom: 16px">Review and confirm.</p>
        <div class="card">${rowsHtml}</div>
        ${addState.error ? `<p class="rpc-status error" style="margin: 8px 0 0">${esc(addState.error)}</p>` : ''}
        ${cardButton('Add chain', 'confirm-add')}
      </div>`;
  };

  // The flow is a form the user opened, not settings this page has, and
  // it is rendered *into* the Chains section without a hash of its own:
  // its `<h2>` would become that section's index label (so "chains"
  // stops finding Chains and "add a chain" offers the form as a
  // section) and its confirmation rows would be offered as settings.
  // Hence the skip marker on the wrapper — a plain block box, so the
  // view lays out as it did — rather than on each piece, which the next
  // line added to either render would silently miss.
  const renderAdd = () => {
    if (addState.picked) {
      renderAddConfirm();
      return;
    }
    view.innerHTML = `
      <div class="settings-search-skip">
        <button type="button" class="back-link" data-action="cancel-add">‹ Networks</button>
        <h2 class="section-title">Add a chain</h2>
        <p class="row-help" style="margin-bottom: 16px">
          Search the public chain catalogue, or enter a chain manually.
        </p>
        ${addState.mode === 'manual' ? manualHtml() : searchHtml()}
      </div>`;
    $(addState.mode === 'manual' ? 'man-chainid' : 'chain-search-input')?.focus();
  };

  // --- an RPC endpoint row (detail view) -----------------------
  // The kind (your RPC / commercial / public) is conveyed by the
  // section the row sits in; the row itself only flags noteworthy
  // state — primary, a missing API key, a disabled builtin. Keyed
  // providers are managed on the RPC Providers page; here they
  // only show key status and a link there.
  const endpointRow = (src, cid, primary) => {
    const url = (src.coverage && src.coverage[cid]) || '';
    const meta = [];
    if (primary) meta.push('primary');
    if (src.keyed && !src.hasKey) meta.push('no API key');
    else if (src.removed) meta.push('disabled');

    let controls = '';
    if (src.keyed) {
      if (!src.hasKey) {
        controls =
          '<button type="button" class="btn" data-action="open-rpc-page">Manage keys</button>';
      }
    } else if (src.builtin) {
      controls = `<label class="toggle">
          <input type="checkbox" data-action="toggle-source" data-id="${esc(src.id)}"${src.removed ? '' : ' checked'} />
          <span class="slider"></span></label>`;
    } else {
      controls = `<button type="button" class="btn" data-action="edit-source" data-id="${esc(src.id)}">Edit</button>
         <button type="button" class="btn" data-action="delete-source" data-id="${esc(src.id)}">Remove</button>`;
    }

    return `
      <div class="row">
        <div class="row-body">
          <p class="row-label" style="font-family: ui-monospace, Menlo, monospace; font-size: 13px">${src.keyed ? esc(src.name || src.id) : esc(url)}</p>
          ${meta.length ? `<p class="row-help">${esc(meta.join(' · '))}</p>` : ''}
        </div>
        <div class="row-control">${controls}</div>
      </div>`;
  };

  // The add/edit form for an RPC endpoint. The chain is fixed (the
  // open detail) and the role is always rpc, so it only asks for a URL.
  const endpointFormHtml = () => {
    const f = endpointForm;
    return `
      <div class="card" style="margin-top: 16px">
        <div class="rpc-block" style="border-top: none">
          <p class="row-label" style="margin-bottom: 8px">${f.mode === 'edit' ? 'Edit endpoint' : 'Add endpoint'}</p>
          <div class="rpc-row" style="margin-bottom: 8px">
            <input type="text" class="rpc-input" id="ep-url" placeholder="https://… or http://localhost:8545" spellcheck="false" value="${esc(f.url)}" />
          </div>
          ${f.error ? `<p class="rpc-status error" style="margin-bottom: 8px">${esc(f.error)}</p>` : ''}
          <button type="button" class="btn" data-action="save-endpoint">Save</button>
          <button type="button" class="btn" data-action="cancel-endpoint" style="margin-left: 8px">Cancel</button>
        </div>
      </div>`;
  };

  // Which source rows' Advanced disclosures are open, as
  // `chainId:kind:source`. The detail repaints from scratch on every
  // config change, and a disclosure the user opened should not snap shut
  // under them; the chain id keeps one opened on one chain's detail from
  // rendering open on every other chain's.
  const openAccessAdvanced = new Set();

  const sourceStatus = (source, cid) => {
    if (source === 'myotis') {
      if (cid !== '1' && cid !== '100') return 'Unsupported';
      const status = myotisStatuses[cid];
      if (!status) return 'Status unknown';
      if (status.recovery?.reason === 'installation' || status.recovery?.reason === 'unsupported')
        return 'Update or reinstall — open Nodes';
      // Myotis's fork watch (peer-reported, display-only): this build lacks
      // a network upgrade. The Nodes menu carries the full explanation.
      // Deliberate precedence: below an installation/unsupported recovery
      // (that already says "Update or reinstall"), above every other state,
      // including recovering / recovery-blocked — a fork this build can't
      // follow is the likeliest cause of a stall or checkpoint recovery, and
      // updating is the one action that can end it; the Nodes card still
      // shows the recovery state next to the notice. Pinned by
      // test-e2e/myotis-upgrade-advisory.spec.js.
      if (
        !['off', 'disabled'].includes(status.state) &&
        ['SCHEDULED', 'ACTIVE'].includes(status.upgradeAdvisory?.phase)
      )
        return status.state === 'ready' ? 'Ready — update Freedom' : 'Update Freedom — open Nodes';
      if (status.state === 'ready') return 'Ready';
      if (status.state === 'syncing') return 'Syncing';
      if (status.state === 'recovering') return 'Updating checkpoint';
      if (status.state === 'recovery-blocked') {
        return status.recovery?.reason === 'stalled'
          ? 'Syncing slowly — open Nodes'
          : 'Sync paused — open Nodes';
      }
      if (status.state === 'off') return 'Off';
      if (status.state === 'disabled') return 'Profile disabled';
      return 'Unavailable';
    }
    if (source === 'colibri') {
      return config.sources.some(
        (entry) => entry.role === 'prover' && entry.coverage?.[cid] && !entry.removed
      )
        ? 'Available'
        : 'No proof server';
    }
    const count = config.sources.filter(
      (entry) =>
        entry.role === 'rpc' &&
        entry.coverage?.[cid] &&
        !entry.removed &&
        (!entry.keyed || entry.hasKey)
    ).length;
    if (source === 'quorum') {
      const quorum = config.networks[cid]?.quorum || { k: 3, m: 2 };
      return `${quorum.m || 2} of ${quorum.k || 3} · ${count} available`;
    }
    return count ? `${count} available` : 'No endpoint';
  };

  const accessRows = (cid, kind, order) =>
    order
      .map((source, index) => {
        const meta = NETWORK_SOURCE_COPY[source];
        if (!meta) return '';
        const key = `${cid}:${kind}:${source}`;
        return `<div class="resolver-method" draggable="true" tabindex="0"
              data-access-kind="${kind}" data-access-source="${source}">
            <span class="resolver-drag-handle" title="Drag to reorder" aria-hidden="true">⠿</span>
            <span class="resolver-rank">${index + 1}</span>
            <div class="row-body">
              <div class="resolver-title-line">
                <p class="row-label">${esc(meta.label)}</p>
                <span class="resolver-badge">${esc(sourceStatus(source, cid))}</span>
              </div>
              ${networkSourceHelp(source, kind)}
              ${networkSourceAdvanced(source, { key, open: openAccessAdvanced.has(key) })}
            </div>
          </div>`;
      })
      .join('');

  // The broadcast section's intro, said from the chain's actual order: a
  // custom chain has no local node, and a user can drag the server first.
  const BROADCAST_SOURCE_PHRASE = { myotis: 'the local node', direct: 'a server' };
  const broadcastIntro = (order) => {
    const named = order.map((source) => BROADCAST_SOURCE_PHRASE[source]).filter(Boolean);
    if (!named.length) return 'Signed transactions go out through the sources below.';
    if (named.length === 1) return `Signed transactions go out through ${named[0]}.`;
    return `Signed transactions go out through ${named[0]} first, with ${named[1]} as the fallback.`;
  };

  // --- detail: one chain's access policy + endpoints ------------
  // Verified/local sources are ordered first; RPC inventory remains
  // grouped into the same custom/commercial/public priority tiers that
  // network-registry resolves for quorum and direct fallbacks.
  const renderDetail = (cid) => {
    const isCustom = config.networks[cid]?.builtin === false;
    const rpcs = config.sources.filter((s) => s.role === 'rpc' && s.coverage && s.coverage[cid]);
    const mine = rpcs.filter((s) => !s.builtin);
    const commercial = rpcs.filter((s) => s.builtin && s.keyed);
    const publicRpcs = rpcs.filter((s) => s.builtin && !s.keyed);

    // primary = the first usable endpoint walking the tier order.
    const usable = (s) => !s.removed && (s.keyed ? !!s.hasKey : true);
    const primary = [...mine, ...commercial, ...publicRpcs].find(usable);
    const supportsVerifiedSources = cid === '1' || cid === '100';
    const defaultReadOrder = supportsVerifiedSources
      ? ['myotis', 'colibri', 'quorum', 'direct']
      : ['colibri', 'quorum', 'direct'];
    const defaultBroadcastOrder = supportsVerifiedSources ? ['myotis', 'direct'] : ['direct'];
    const readOrder = config.networks[cid]?.access?.readOrder || defaultReadOrder;
    const broadcastOrder = config.networks[cid]?.access?.broadcastOrder || defaultBroadcastOrder;
    const proverSource = config.sources.find(
      (entry) => entry.role === 'prover' && entry.coverage?.[cid] && !entry.removed
    );
    const proverConfig = supportsVerifiedSources
      ? `<div class="card" style="margin-top: 12px">
          <div class="rpc-block" style="border-top: none">
            <p class="row-label">Proof server</p>
            <p class="row-help" style="margin-bottom: 8px">Where ${esc(NETWORK_SOURCE_COPY.colibri.label)} gets its proofs.</p>
            <div class="rpc-row">
              <input class="rpc-input" data-chain-prover="${esc(cid)}"
                data-source-id="${esc(proverSource?.id || 'colibri-corpus')}"
                value="${esc(proverSource?.coverage?.[cid] || '')}"
                placeholder="https://…" spellcheck="false" />
            </div>
          </div>
        </div>`
      : '';

    const section = (title, help, list, emptyHint) => `
      <h3 class="subsection-title">${title}</h3>
      <p class="row-help" style="margin-bottom: 12px">${help}</p>
      <div class="card">${
        list.length
          ? list.map((s) => endpointRow(s, cid, s === primary)).join('')
          : `<div class="rpc-block" style="border-top: none"><p class="rpc-hint">${emptyHint}</p></div>`
      }</div>`;

    view.innerHTML = `
      <button type="button" class="back-link" data-action="back">‹ Networks</button>
      <h2 class="section-title">${esc(chainName(cid))}</h2>
      <p class="row-help" style="margin-bottom: 16px">chain ${esc(cid)}${isCustom ? ' · custom chain' : ''}</p>

      <p class="row-help" style="margin-bottom: 4px">
        Freedom routes wallet, transaction, and compatible dapp requests
        through the sources below. Unsupported methods automatically continue
        to the next source.
      </p>

      <h3 class="subsection-title">Read and verification order</h3>
      <p class="row-help" style="margin-bottom: 12px">Drag sources into priority order.</p>
      <div class="card">${accessRows(cid, 'read', readOrder)}</div>
      ${proverConfig}

      <h3 class="subsection-title">Transaction broadcast</h3>
      <p class="row-help" style="margin-bottom: 12px">${esc(broadcastIntro(broadcastOrder))}</p>
      <div class="card">${accessRows(cid, 'broadcast', broadcastOrder)}</div>

      ${section('Your RPCs', 'Endpoints you added — tried first.', mine, 'No custom RPCs yet')}
      ${cardButton('Add RPC', 'add-endpoint')}
      ${endpointForm ? endpointFormHtml() : ''}

      ${
        commercial.length
          ? section(
              'Commercial providers',
              'Keyed providers — used before public RPCs once you add an API key on the RPC Providers page.',
              commercial,
              ''
            )
          : ''
      }

      ${
        publicRpcs.length
          ? section(
              'Public RPCs',
              'Free builtin endpoints — the always-on fallback.',
              publicRpcs,
              ''
            )
          : ''
      }

      ${isCustom ? cardButton('Remove this chain', 'remove-chain', 'danger') : ''}`;
  };

  // The notice answers one hash and one view: the chain list standing
  // in for a chain the registry does not have. Every re-render is a
  // chance for that view to be replaced, so clearing it belongs here
  // rather than only on `hashchange` — the add-chain form opens on the
  // same hash, so no `hashchange` fires for it.
  const clearChainGoneStatus = () => {
    if (statusEl && statusEl.textContent === CHAIN_GONE_STATUS) setStatus('');
  };

  // `fresh` marks a render driven by a config just read from the
  // registry. Only such a render may conclude that a chain named in the
  // hash is gone: a hash change re-renders off the cached config first,
  // and that copy can simply predate a chain added in another window.
  // A chain's own page and the add-a-chain form are the whole of
  // Networks while they are open: the page heading, RPC Providers and
  // Name Resolution step aside (`.networks-chain-focus` in the page CSS),
  // so the chain list's siblings do not stack under a single chain.
  const setChainFocus = (focused) => content?.classList.toggle('networks-chain-focus', focused);

  const render = ({ fresh = false } = {}) => {
    clearChainGoneStatus(); // the branch below re-raises it if it still holds
    if (addState) {
      setChainFocus(true);
      renderAdd();
      return;
    }
    const cid = openChainId();
    if (cid && config.networks[cid]) {
      setChainFocus(true);
      renderDetail(cid);
      return;
    }
    setChainFocus(false);
    if (cid && fresh) {
      // The chain is not configured — removed here or in another
      // window, or a typo. Rendering the list under the detail hash
      // leaves the URL promising a chain nothing on screen names, so
      // put the URL back on the list and say what happened.
      // replaceState keeps the dead link out of the back/forward stack.
      history.replaceState(null, '', '#networks');
      setStatus(CHAIN_GONE_STATUS, 'error');
    }
    renderList();
  };

  const reload = async () => {
    try {
      const [res, ethereumMyotis, gnosisMyotis] = await Promise.all([
        freedomAPI.getNetworkConfig(),
        freedomAPI.getMyotisStatus(1).catch(() => null),
        freedomAPI.getMyotisStatus(100).catch(() => null),
      ]);
      if (!res || !res.success) {
        setStatus('Failed to load network configuration', 'error');
        return;
      }
      config = { networks: res.networks || {}, sources: res.sources || [] };
      myotisStatuses = { 1: ethereumMyotis, 100: gnosisMyotis };
      render({ fresh: true });
    } catch {
      setStatus('Failed to load network configuration', 'error');
    }
  };

  // Run a mutation, then re-fetch + re-render so the view is authoritative.
  const mutate = async (fn) => {
    try {
      const res = await fn();
      if (res && res.success === false) {
        setStatus(res.error || 'Change failed', 'error');
        return;
      }
      setStatus('', '');
    } catch (err) {
      setStatus(err?.message || 'Change failed', 'error');
    }
    await reload();
  };

  // Query the chain catalogue and refresh only the results list, so
  // the search input keeps focus while the user types.
  let searchTimer = null;
  let searchSeq = 0;
  let draggedAccess = null;

  const reorderAccess = async (kind, source, target, direction = 0) => {
    const cid = openChainId();
    if (!cid) return;
    const network = config.networks[cid] || {};
    const key = kind === 'broadcast' ? 'broadcastOrder' : 'readOrder';
    const supportsVerifiedSources = cid === '1' || cid === '100';
    const fallback =
      kind === 'broadcast'
        ? supportsVerifiedSources
          ? ['myotis', 'direct']
          : ['direct']
        : supportsVerifiedSources
          ? ['myotis', 'colibri', 'quorum', 'direct']
          : ['colibri', 'quorum', 'direct'];
    const order = [...(network.access?.[key] || fallback)];
    const from = order.indexOf(source);
    let to = target ? order.indexOf(target) : from + direction;
    if (from < 0 || to < 0 || to >= order.length || from === to) return;
    order.splice(from, 1);
    order.splice(to, 0, source);
    // Send only the changed key: main merges `access` one level deep,
    // and `network.access` here is the builtin+override merged view —
    // spreading it would freeze builtin defaults (e.g. broadcastOrder)
    // into the user config, so a future app update to a builtin order
    // would be silently ignored for this user.
    await mutate(() =>
      freedomAPI.updateNetwork(cid, {
        access: { [key]: order },
      })
    );
  };
  const runChainSearch = async (query) => {
    const seq = ++searchSeq;
    try {
      const res = await freedomAPI.searchChains(query);
      if (seq !== searchSeq) return; // a newer search has superseded this one
      if (!addState || addState.mode !== 'search' || addState.picked) return;
      addState.results = res && res.success ? res.chains : [];
    } catch {
      if (seq !== searchSeq || !addState) return;
      addState.results = [];
    }
    const el = $('chain-search-results');
    if (el) el.innerHTML = searchResultsHtml();
  };

  // Persist a new chain (+ its RPC endpoints), then open its detail.
  const submitAddChain = async (def, rpcUrls, onError) => {
    try {
      const res = await freedomAPI.addChain(def, rpcUrls);
      if (res && res.success === false) {
        const message = res.error || 'Could not add chain';
        if (onError) onError(message);
        else setStatus(message, 'error');
        return;
      }
      setStatus('', '');
      addState = null;
      await reload();
      location.hash = 'networks/' + def.chainId;
    } catch (err) {
      const message = err?.message || 'Could not add chain';
      if (onError) onError(message);
      else setStatus(message, 'error');
    }
  };

  section.addEventListener('input', (e) => {
    if (e.target.id !== 'chain-search-input') return;
    const q = e.target.value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => runChainSearch(q), 250);
  });

  section.addEventListener('change', (e) => {
    const el = e.target.closest('[data-action]');
    if (!el || el.dataset.action !== 'toggle-source') return;
    const id = el.dataset.id;
    mutate(() =>
      el.checked ? freedomAPI.restoreEndpointSource(id) : freedomAPI.removeEndpointSource(id)
    );
  });

  section.addEventListener('focusout', async (e) => {
    const input = e.target.closest('[data-chain-prover]');
    if (!input) return;
    const cid = input.dataset.chainProver;
    const url = input.value.trim();
    const id = input.dataset.sourceId || 'colibri-corpus';
    const current = config.sources.find((source) => source.id === id);
    if (current?.coverage?.[cid] === url) return;
    if (!url) {
      await mutate(() => freedomAPI.resetEndpointSourceCoverage(id, cid));
      return;
    }
    await mutate(() =>
      freedomAPI.upsertEndpointSource(id, {
        role: 'prover',
        keyed: false,
        name: current?.name || 'Colibri (corpus.core)',
        coverage: { ...(current?.coverage || {}), [cid]: url },
      })
    );
  });

  section.addEventListener('dragstart', (e) => {
    const row = e.target.closest('[data-access-source]');
    if (!row) return;
    draggedAccess = { kind: row.dataset.accessKind, source: row.dataset.accessSource };
    row.classList.add('dragging');
    e.dataTransfer?.setData('text/plain', row.dataset.accessSource);
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
  });

  section.addEventListener('dragover', (e) => {
    const row = e.target.closest('[data-access-source]');
    if (!row || !draggedAccess || row.dataset.accessKind !== draggedAccess.kind) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
  });

  section.addEventListener('drop', async (e) => {
    const row = e.target.closest('[data-access-source]');
    if (!row || !draggedAccess || row.dataset.accessKind !== draggedAccess.kind) return;
    e.preventDefault();
    const { kind, source } = draggedAccess;
    draggedAccess = null;
    await reorderAccess(kind, source, row.dataset.accessSource);
  });

  section.addEventListener('dragend', () => {
    draggedAccess = null;
    section.querySelectorAll('.dragging').forEach((row) => row.classList.remove('dragging'));
  });

  // `toggle` does not bubble, so it is caught on the way down.
  section.addEventListener(
    'toggle',
    (e) => {
      const key = e.target?.dataset?.advanced;
      if (!key || !e.target.closest('[data-access-source]')) return;
      if (e.target.open) openAccessAdvanced.add(key);
      else openAccessAdvanced.delete(key);
    },
    true
  );

  section.addEventListener('keydown', async (e) => {
    const row = e.target.closest('[data-access-source]');
    if (!row || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
    // The arrows reorder the focused row, not a row whose Advanced
    // disclosure happens to have focus inside it.
    if (e.target !== row) return;
    e.preventDefault();
    await reorderAccess(
      row.dataset.accessKind,
      row.dataset.accessSource,
      null,
      e.key === 'ArrowUp' ? -1 : 1
    );
  });

  section.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    const id = btn.dataset.id;

    if (action === 'open-chain') {
      location.hash = 'networks/' + btn.dataset.chain;
    } else if (action === 'back') {
      location.hash = 'networks';
    } else if (action === 'add-endpoint') {
      endpointForm = { mode: 'add', id: null, url: '' };
      render();
      $('ep-url')?.focus();
    } else if (action === 'edit-source') {
      const src = config.sources.find((s) => s.id === id);
      const cid = openChainId();
      if (src) {
        endpointForm = {
          mode: 'edit',
          id,
          url: (src.coverage && cid && src.coverage[cid]) || '',
        };
        render();
        $('ep-url')?.focus();
      }
    } else if (action === 'cancel-endpoint') {
      endpointForm = null;
      render();
    } else if (action === 'save-endpoint') {
      const url = ($('ep-url')?.value || '').trim();
      const cid = openChainId();
      // Keep the form open on failure and show the error next to the input
      // (a global status bar at the page bottom is easy to miss).
      const failForm = (error) => {
        endpointForm = { ...endpointForm, url, error };
        setStatus('', '');
        render();
        $('ep-url')?.focus();
      };
      if (!url) {
        failForm('Enter an endpoint URL');
        return;
      }
      if (!cid) {
        endpointForm = null;
        render();
        return;
      }
      // Ignore a second Save while the first upsert is still in flight:
      // in add mode each click mints a distinct 'user-<Date.now()>' id,
      // so a double-click would persist two duplicate sources (which also
      // lets one server satisfy the quorum tier twice).
      if (endpointSaveInFlight) return;
      const sourceId =
        endpointForm?.mode === 'edit' && endpointForm.id ? endpointForm.id : 'user-' + Date.now();
      endpointSaveInFlight = true;
      try {
        const res = await freedomAPI.upsertEndpointSource(sourceId, {
          role: 'rpc',
          keyed: false,
          coverage: { [cid]: url },
        });
        if (res && res.success === false) {
          failForm(res.error || 'Could not save endpoint');
          return;
        }
      } catch (err) {
        failForm(err?.message || 'Could not save endpoint');
        return;
      } finally {
        endpointSaveInFlight = false;
      }
      endpointForm = null;
      setStatus('', '');
      await reload();
    } else if (action === 'delete-source') {
      await mutate(() => freedomAPI.removeEndpointSource(id));
    } else if (action === 'open-rpc-page') {
      location.hash = 'networks/rpc';
    } else if (action === 'remove-chain') {
      const cid = openChainId();
      if (!cid) return;
      if (
        !window.confirm('Remove ' + chainName(cid) + '? Its custom RPC endpoints are removed too.')
      )
        return;
      try {
        const res = await freedomAPI.removeChain(cid);
        if (res && res.success === false) {
          setStatus(res.error || 'Could not remove chain', 'error');
          return;
        }
        setStatus('', '');
        location.hash = 'networks';
      } catch (err) {
        setStatus(err?.message || 'Could not remove chain', 'error');
      }
    } else if (action === 'add-chain') {
      // The form is part of the Chains list view, which `#networks` names.
      // Arriving via `#networks/rpc` or `#networks/ens` (the wallet's RPC
      // button, the onchain-app interstitial) leaves that hash in place,
      // and the form's focus mode hides the very panel it names — so put
      // the URL back on the list. replaceState fires no `hashchange`, which
      // would clear `addState`, and keeps the swap out of back/forward.
      if (resolveRoute(location.hash) !== 'networks') {
        stopPanelScroll();
        history.replaceState(null, '', '#networks');
      }
      addState = { mode: 'search', results: null, picked: null };
      render();
      runChainSearch('');
    } else if (action === 'add-manual') {
      if (addState) {
        addState.mode = 'manual';
        addState.error = null;
        addState.manual = addState.manual || { decimalsRaw: '18' };
        render();
      }
    } else if (action === 'add-search') {
      if (addState) {
        addState.mode = 'search';
        addState.results = null;
        addState.error = null;
        render();
        runChainSearch('');
      }
    } else if (action === 'cancel-add') {
      clearTimeout(searchTimer);
      addState = null;
      render();
    } else if (action === 'add-back') {
      if (addState) {
        addState.picked = null;
        addState.error = null;
        render();
        runChainSearch($('chain-search-input')?.value || '');
      }
    } else if (action === 'pick-chain') {
      setStatus('Loading chain…', 'testing');
      try {
        const res = await freedomAPI.getCatalogChain(btn.dataset.chainId);
        if (!res || !res.success) {
          setStatus(res?.error || 'Could not load chain', 'error');
          return;
        }
        setStatus('', '');
        if (addState) {
          addState.picked = res.chain;
          render();
        }
      } catch (err) {
        setStatus(err?.message || 'Could not load chain', 'error');
      }
    } else if (action === 'confirm-add') {
      const c = addState?.picked;
      if (!c) return;
      const failConfirm = (error) => {
        if (!addState) {
          setStatus(error, 'error');
          return;
        }
        addState.error = error;
        render();
      };
      await submitAddChain(
        {
          chainId: c.chainId,
          name: c.name,
          nativeSymbol: (c.nativeCurrency && c.nativeCurrency.symbol) || '',
          nativeCurrency: c.nativeCurrency || null,
          blockExplorer: c.explorerUrl || '',
        },
        c.rpcUrls || [],
        failConfirm
      );
    } else if (action === 'submit-manual') {
      const chainId = ($('man-chainid')?.value || '').trim();
      const name = ($('man-name')?.value || '').trim();
      const symbol = ($('man-symbol')?.value || '').trim();
      const decimalsRaw = ($('man-decimals')?.value || '').trim();
      const rpc = ($('man-rpc')?.value || '').trim();
      const decimals = decimalsRaw === '' ? 18 : Number(decimalsRaw);
      const manual = { chainId, name, symbol, decimalsRaw, rpc };
      const failManual = (error, focusId = 'man-rpc') => {
        if (!addState) {
          setStatus(error, 'error');
          return;
        }
        addState.manual = manual;
        addState.error = error;
        render();
        $(focusId)?.focus();
      };
      if (!chainId) {
        failManual('Chain ID is required', 'man-chainid');
        return;
      }
      if (!name) {
        failManual('Chain name is required', 'man-name');
        return;
      }
      if (!symbol) {
        failManual('Currency symbol is required', 'man-symbol');
        return;
      }
      if (!rpc) {
        failManual('RPC URL is required');
        return;
      }
      if (!Number.isInteger(decimals) || decimals < 0) {
        failManual('Currency decimals must be a non-negative whole number', 'man-decimals');
        return;
      }
      await submitAddChain(
        {
          chainId: Number(chainId),
          name,
          nativeSymbol: symbol,
          nativeCurrency: { name: symbol, symbol, decimals },
          blockExplorer: '',
        },
        [rpc],
        failManual
      );
    }
  });

  // The hash drives list↔detail, so every hash change re-renders —
  // leaving the section included, not only entering it. The section
  // stays in the DOM when it is hidden and `render()` reads the
  // sub-route off the hash, which by now names somewhere else, so this
  // is what puts the view back to the chain list. Returning early
  // instead parks the visited chain's detail in the hidden section for
  // the rest of the session, and the page-wide search indexes every
  // section's live markup: it would go on offering that chain's
  // endpoint rows as results that jump to a list holding no such row,
  // under an `<h2>` reading the chain's name where the section's own
  // "Chains" heading belongs. Only the re-sync is gated on entering —
  // leaving is not a visit. The transient add/edit form is cleared on
  // any navigation either way.
  window.addEventListener('hashchange', () => {
    const entering = resolveSection(location.hash) === 'networks';
    clearTimeout(searchTimer);
    endpointForm = null;
    addState = null;
    // The "no longer configured" notice is cleared by `render()` below:
    // the user has navigated past the hash it explains.
    render(); // instant list<->detail swap from cached config
    if (entering) reload(); // then re-sync in case it changed elsewhere
  });

  reload();
})();

// ── Ordered Ethereum name-resolution policy ─────────────────────
// The policy belongs to Ethereum's existing network configuration.
// This controller only renders/mutates that policy; resolver execution
// remains in the main process and node lifecycle remains under Nodes.
(() => {
  const list = $('ens-method-list');
  const preferVerified = $('ens-prefer-verified');
  const policyStatus = $('ens-policy-status');
  if (!list || !preferVerified) return;

  // Names and explanations come from NETWORK_SOURCE_COPY, shared with a
  // chain's detail page (#269); only the links are this list's own.
  const METHODS = [
    { id: 'myotis', link: '#nodes', linkLabel: 'Node settings' },
    { id: 'colibri' },
    { id: 'quorum', link: '#networks/1', linkLabel: 'Manage servers' },
    { id: 'direct', link: '#networks/1', linkLabel: 'Configure' },
  ].map((method) => ({ ...method, ...NETWORK_SOURCE_COPY[method.id] }));
  const METHOD_IDS = new Set(METHODS.map((method) => method.id));

  let config = { networks: {}, sources: [] };
  let enabledOrder = ['myotis', 'colibri', 'quorum'];
  let currentQuorum = { k: 3, m: 2 };
  let currentProverUrl = '';
  let proverId = 'colibri-corpus';
  let myotisStatus = null;
  let myotisGnosisStatus = null;
  let policySave = Promise.resolve();
  let quorumSave = Promise.resolve();
  let draggedMethod = null;
  let dropPlacement = null;
  let policyLoaded = false;
  // Which methods' Advanced disclosures are open: every change here
  // repaints the list, and the proof server and agreement threshold
  // live inside the disclosure.
  const openAdvanced = new Set();

  preferVerified.disabled = true;

  const setPolicyStatus = (message, kind = '') => {
    policyStatus.textContent = message || '';
    policyStatus.className = `rpc-status resolver-status${kind ? ` ${kind}` : ''}`;
  };

  const legacyOrder = (primary) => [
    'myotis',
    ...(primary === 'direct' ? ['direct', 'quorum'] : []),
    ...(primary === 'quorum' ? ['quorum'] : []),
    ...(!primary || primary === 'colibri' ? ['colibri', 'quorum'] : []),
  ];

  const activeSources = (role) =>
    (config.sources || []).filter(
      (source) =>
        source.role === role &&
        source.coverage?.['1'] &&
        !source.removed &&
        (!source.keyed || source.hasKey)
    );

  const setBadge = (method, text, kind = '') => {
    const badge = list.querySelector(`[data-method-status="${method}"]`);
    if (!badge) return;
    badge.textContent = text;
    badge.className = `resolver-badge${kind ? ` ${kind}` : ''}`;
  };

  const updateMethodStatuses = () => {
    const rpcSources = activeSources('rpc');
    const customRpc = rpcSources.find(
      (source) => source.builtin === false && source.keyed === false
    );

    if (!myotisStatus) {
      setBadge('myotis', 'Status unknown', 'warning');
    } else if (['installation', 'unsupported'].includes(myotisStatus.recovery?.reason)) {
      setBadge('myotis', 'Update or reinstall — open Nodes', 'warning');
    } else if (myotisStatus.state === 'unavailable') {
      setBadge('myotis', 'Unavailable');
    } else if (myotisStatus.state === 'disabled') {
      setBadge('myotis', 'Profile disabled', 'warning');
    } else if (myotisStatus.state === 'off') {
      setBadge('myotis', 'Off');
    } else if (myotisStatus.state === 'error') {
      setBadge('myotis', 'Error', 'warning');
    } else if (myotisStatus.state === 'recovering') {
      setBadge('myotis', 'Updating checkpoint', 'warning');
    } else if (myotisStatus.state === 'recovery-blocked') {
      setBadge(
        'myotis',
        myotisStatus.recovery?.reason === 'stalled'
          ? 'Syncing slowly — open Nodes'
          : 'Sync paused — open Nodes',
        'warning'
      );
    } else if (myotisStatus.state === 'ready') {
      setBadge('myotis', 'Ready', 'ready');
    } else {
      setBadge('myotis', 'Syncing…', 'warning');
    }

    const hasProver = activeSources('prover').length > 0;
    setBadge(
      'colibri',
      hasProver ? 'Verified' : 'No proof server',
      hasProver ? 'verified' : 'warning'
    );
    setBadge(
      'quorum',
      `${currentQuorum.m} of ${currentQuorum.k}`,
      rpcSources.length >= currentQuorum.k ? 'verified' : 'warning'
    );
    setBadge(
      'direct',
      customRpc ? 'Your server' : rpcSources.length ? 'Public server' : 'No server',
      'warning'
    );
  };

  const numberOptions = (min, max, selected) =>
    Array.from({ length: max - min + 1 }, (_, offset) => min + offset)
      .map(
        (value) =>
          `<option value="${value}"${value === selected ? ' selected' : ''}>${value}</option>`
      )
      .join('');

  const render = () => {
    const visibleOrder = [
      ...enabledOrder,
      ...METHODS.map((method) => method.id).filter((id) => !enabledOrder.includes(id)),
    ];
    list.innerHTML = visibleOrder
      .map((id) => {
        const method = METHODS.find((entry) => entry.id === id);
        const enabled = enabledOrder.includes(id);
        const index = enabledOrder.indexOf(id);
        const link = method.link
          ? `<a class="row-help" href="${method.link}">${method.linkLabel}</a>`
          : '';
        let configRow = '';
        if (id === 'colibri' && enabled) {
          configRow = `<div class="resolver-config" data-method-config="colibri">
                <div class="resolver-config-line">
                  <div class="row-body">
                    <p class="row-label">Proof server</p>
                    <p class="row-help">Leave empty to use the default.</p>
                  </div>
                  <input type="text" id="ens-prover-url" class="rpc-input"
                    placeholder="https://mainnet1.colibri-proof.tech" spellcheck="false" />
                </div>
              </div>`;
        } else if (id === 'quorum' && enabled) {
          configRow = `<div class="resolver-config" data-method-config="quorum">
                <div class="resolver-config-line">
                  <div class="row-body">
                    <p class="row-label">Agreement threshold</p>
                    <p class="row-help">How many servers must give the same answer. ${activeSources('rpc').length} currently available.</p>
                  </div>
                  <div class="resolver-quorum-fields">
                    Require
                    <select data-quorum-field="m" aria-label="Servers that must agree">
                      ${numberOptions(2, currentQuorum.k, currentQuorum.m)}
                    </select>
                    out of
                    <select data-quorum-field="k" aria-label="Servers asked">
                      ${numberOptions(3, 9, currentQuorum.k)}
                    </select>
                  </div>
                </div>
              </div>`;
        }
        return `
          <div class="resolver-method${enabled ? '' : ' disabled'}" data-method="${id}">
            <button class="resolver-drag-handle" type="button"
              data-drag-handle="${id}" draggable="${enabled}"
              aria-label="Reorder ${method.label}. Drag, or use the up and down arrow keys."
              title="Drag to reorder" ${enabled ? '' : 'disabled'}>
              <span aria-hidden="true">⠿</span>
            </button>
            <span class="resolver-rank">${enabled ? index + 1 : '–'}</span>
            <div class="row-body">
              <div class="resolver-title-line">
                <p class="row-label">${esc(method.label)}</p>
                <span class="resolver-badge" data-method-status="${id}">Loading…</span>
              </div>
              ${networkSourceHelp(id)}
              ${link}
              ${networkSourceAdvanced(id, { open: openAdvanced.has(id), extra: configRow })}
            </div>
            <div class="resolver-controls">
              <label class="toggle" aria-label="Enable ${method.label}">
                <input type="checkbox" data-method-enabled="${id}" ${enabled ? 'checked' : ''} />
                <span class="slider"></span>
              </label>
            </div>
          </div>`;
      })
      .join('');

    const proverInput = $('ens-prover-url');
    if (proverInput) proverInput.value = currentProverUrl;
    updateMethodStatuses();
  };

  const persistPolicy = () => {
    if (!policyLoaded || !config.networks?.['1']) {
      return Promise.reject(new Error('Resolution policy is not loaded yet'));
    }
    const primary = enabledOrder.find((method) => method !== 'myotis') || 'quorum';
    const verification = {
      primary,
      order: [...enabledOrder],
      preferVerified: preferVerified.checked,
    };
    // Preserve interaction order when several controls are changed in
    // quick succession. IPC responses are not guaranteed to complete in
    // the same order the renderer dispatched them.
    policySave = policySave
      .catch(() => {})
      .then(async () => {
        const result = await freedomAPI.updateNetwork('1', { verification });
        if (result?.success === false) throw new Error(result.error || 'Policy was not saved');
        config.networks['1'].verification = verification;
        setPolicyStatus('Resolution policy saved.', 'success');
      });
    return policySave;
  };

  const persistQuorum = () => {
    if (!policyLoaded || !config.networks?.['1']) {
      return Promise.reject(new Error('Resolution policy is not loaded yet'));
    }
    const quorum = { ...currentQuorum };
    quorumSave = quorumSave
      .catch(() => {})
      .then(async () => {
        const result = await freedomAPI.updateNetwork('1', { quorum });
        if (result?.success === false) throw new Error(result.error || 'Quorum was not saved');
        config.networks['1'].quorum = {
          ...(config.networks['1'].quorum || {}),
          ...quorum,
        };
        setPolicyStatus('Agreement threshold saved.', 'success');
      });
    return quorumSave;
  };

  const clearDragState = () => {
    list
      .querySelectorAll('.dragging, .drop-before, .drop-after')
      .forEach((row) => row.classList.remove('dragging', 'drop-before', 'drop-after'));
    draggedMethod = null;
    dropPlacement = null;
  };

  const reorderMethod = async (id, targetIndex) => {
    const currentIndex = enabledOrder.indexOf(id);
    if (
      currentIndex < 0 ||
      targetIndex < 0 ||
      targetIndex >= enabledOrder.length ||
      currentIndex === targetIndex
    ) {
      clearDragState();
      return;
    }
    enabledOrder.splice(currentIndex, 1);
    enabledOrder.splice(targetIndex, 0, id);
    const restoreHandleFocus = document.activeElement?.dataset?.dragHandle === id;
    clearDragState();
    render();
    if (restoreHandleFocus) {
      list.querySelector(`[data-drag-handle="${id}"]`)?.focus();
    }
    try {
      await persistPolicy();
    } catch (err) {
      setPolicyStatus(err?.message || 'Failed to reorder methods.', 'error');
      refresh();
    }
  };

  const refresh = async () => {
    try {
      const res = await freedomAPI.getNetworkConfig();
      if (!res || !res.success) throw new Error('Network configuration unavailable');
      config = { networks: res.networks || {}, sources: res.sources || [] };
      if (!config.networks['1']) throw new Error('Ethereum network configuration unavailable');
      const verification = config.networks?.['1']?.verification || {};
      const configured = Array.isArray(verification.order)
        ? verification.order.filter(
            (method, index, all) => METHOD_IDS.has(method) && all.indexOf(method) === index
          )
        : [];
      enabledOrder = configured.length
        ? configured
        : legacyOrder(verification.primary || 'colibri');
      preferVerified.checked = verification.preferVerified !== false;
      const quorum = config.networks?.['1']?.quorum || {};
      const k = Math.max(3, Math.min(Number(quorum.k) || 3, 9));
      const m = Math.max(2, Math.min(Number(quorum.m) || 2, k));
      currentQuorum = { k, m };

      const prover = (config.sources || []).find(
        (source) => source.role === 'prover' && source.coverage?.['1'] && !source.removed
      );
      proverId = prover?.id || 'colibri-corpus';
      currentProverUrl = prover && prover.builtin === false ? prover.coverage['1'] : '';
      policyLoaded = true;
      preferVerified.disabled = false;
      setPolicyStatus('');
      render();
    } catch (err) {
      policyLoaded = false;
      preferVerified.disabled = true;
      setPolicyStatus(err?.message || 'Could not load resolution policy.', 'error');
    }
  };

  // `toggle` does not bubble, so it is caught on the way down.
  list.addEventListener(
    'toggle',
    (event) => {
      const id = event.target?.dataset?.advanced;
      if (!id || !METHOD_IDS.has(id)) return;
      if (event.target.open) openAdvanced.add(id);
      else openAdvanced.delete(id);
    },
    true
  );

  list.addEventListener('keydown', (event) => {
    const handle = event.target.closest?.('[data-drag-handle]');
    if (!handle || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return;
    event.preventDefault();
    const id = handle.dataset.dragHandle;
    const currentIndex = enabledOrder.indexOf(id);
    const targetIndex = currentIndex + (event.key === 'ArrowUp' ? -1 : 1);
    reorderMethod(id, targetIndex);
  });

  list.addEventListener('dragstart', (event) => {
    const handle = event.target.closest?.('[data-drag-handle]');
    const id = handle?.dataset.dragHandle;
    if (!id || !enabledOrder.includes(id)) {
      event.preventDefault();
      return;
    }
    draggedMethod = id;
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', id);
    handle.closest('[data-method]')?.classList.add('dragging');
  });

  list.addEventListener('dragover', (event) => {
    if (!draggedMethod) return;
    const row = event.target.closest?.('[data-method]');
    const targetId = row?.dataset.method;
    if (!row || targetId === draggedMethod || !enabledOrder.includes(targetId)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    list
      .querySelectorAll('.drop-before, .drop-after')
      .forEach((candidate) => candidate.classList.remove('drop-before', 'drop-after'));
    const bounds = row.getBoundingClientRect();
    const after = event.clientY >= bounds.top + bounds.height / 2;
    row.classList.add(after ? 'drop-after' : 'drop-before');
    dropPlacement = { targetId, after };
  });

  list.addEventListener('drop', (event) => {
    if (!draggedMethod || !dropPlacement) {
      clearDragState();
      return;
    }
    event.preventDefault();
    const id = draggedMethod;
    const currentIndex = enabledOrder.indexOf(id);
    const targetIndex = enabledOrder.indexOf(dropPlacement.targetId);
    let insertionIndex = targetIndex + (dropPlacement.after ? 1 : 0);
    if (currentIndex < insertionIndex) insertionIndex -= 1;
    reorderMethod(id, insertionIndex);
  });

  list.addEventListener('dragend', clearDragState);

  list.addEventListener('change', async (event) => {
    const quorumField = event.target.closest?.('[data-quorum-field]');
    if (quorumField) {
      const kInput = list.querySelector('[data-quorum-field="k"]');
      const mInput = list.querySelector('[data-quorum-field="m"]');
      const k = Math.max(3, Math.min(Number(kInput?.value) || 3, 9));
      const m = Math.max(2, Math.min(Number(mInput?.value) || 2, k));
      currentQuorum = { k, m };
      render();
      try {
        await persistQuorum();
      } catch (err) {
        setPolicyStatus(err?.message || 'Failed to update the agreement threshold.', 'error');
        refresh();
      }
      return;
    }

    const toggle = event.target.closest?.('[data-method-enabled]');
    if (!toggle) return;
    const id = toggle.dataset.methodEnabled;
    if (toggle.checked) {
      if (!enabledOrder.includes(id)) enabledOrder.push(id);
    } else if (enabledOrder.length === 1) {
      toggle.checked = true;
      setPolicyStatus('At least one resolution method must remain enabled.', 'error');
      return;
    } else {
      enabledOrder = enabledOrder.filter((method) => method !== id);
    }
    render();
    try {
      await persistPolicy();
    } catch (err) {
      setPolicyStatus(err?.message || 'Failed to update methods.', 'error');
      refresh();
    }
  });

  list.addEventListener('focusout', async (event) => {
    if (event.target.id !== 'ens-prover-url') return;
    const url = event.target.value.trim();
    if (url === currentProverUrl) return;
    try {
      const proverSource = config.sources.find((source) => source.id === proverId);
      const result = url
        ? await freedomAPI.upsertEndpointSource(proverId, {
            role: 'prover',
            keyed: false,
            // Include `name` so an override built here collapses back to
            // the builtin (via resetEndpointSourceCoverage's structural
            // equality) when the URL is cleared — the builtin
            // colibri-corpus carries a name, so omitting it here pins the
            // override in the user layer forever. Matches the Chains-page
            // upsert.
            name: proverSource?.name || 'Colibri (corpus.core)',
            coverage: {
              ...(proverSource?.coverage || {}),
              1: url,
            },
          })
        : await freedomAPI.resetEndpointSourceCoverage(proverId, 1);
      if (result?.success === false) throw new Error(result.error || 'Proof server was not saved');
      await refresh();
    } catch (err) {
      setPolicyStatus(err?.message || 'Failed to update the proof server.', 'error');
    }
  });

  preferVerified.addEventListener('change', async () => {
    try {
      await persistPolicy();
    } catch (err) {
      setPolicyStatus(err?.message || 'Failed to update verification preference.', 'error');
      refresh();
    }
  });

  const launchRow = $('myotis-launch-row');
  const launchToggle = $('start-myotis-at-launch');
  const launchHelp = $('myotis-launch-help');
  const defaultLaunchHelp = launchHelp?.textContent || '';
  const gnosisLaunchRow = $('myotis-gnosis-launch-row');
  const gnosisLaunchToggle = $('start-myotis-gnosis-at-launch');
  const gnosisLaunchHelp = $('myotis-gnosis-launch-help');
  const defaultGnosisLaunchHelp = gnosisLaunchHelp?.textContent || '';

  const updateMyotis = async () => {
    try {
      [myotisStatus, myotisGnosisStatus] = await Promise.all([
        freedomAPI.getMyotisStatus(1),
        freedomAPI.getMyotisStatus(100),
      ]);
    } catch {
      myotisStatus = null;
      myotisGnosisStatus = null;
    }
    if (launchRow && launchToggle) {
      const supported = myotisStatus?.supported !== false;
      const available = myotisStatus ? Boolean(myotisStatus.available) : true;
      const disabled = myotisStatus?.state === 'disabled';
      launchRow.hidden = !supported;
      launchToggle.disabled = Boolean(myotisStatus) && supported && (!available || disabled);
      if (launchHelp) {
        launchHelp.textContent = !myotisStatus
          ? 'Myotis status could not be read. The startup preference can still be saved.'
          : disabled
            ? 'Disabled for this profile under Settings → Nodes.'
            : supported && !available
              ? 'Sync component missing. Update or reinstall Freedom; open Nodes for help.'
              : myotisStatus.state === 'recovery-blocked'
                ? 'Sync recovery needs attention. Open Nodes in the toolbar for recovery actions and help.'
                : myotisStatus.state === 'recovering'
                  ? 'Updating the sync checkpoint automatically. You can turn the node off in Nodes.'
                  : defaultLaunchHelp;
      }
    }
    if (gnosisLaunchRow && gnosisLaunchToggle) {
      const supported = myotisGnosisStatus?.supported !== false;
      const available = myotisGnosisStatus ? Boolean(myotisGnosisStatus.available) : true;
      const disabled = myotisGnosisStatus?.state === 'disabled';
      gnosisLaunchRow.hidden = !supported;
      gnosisLaunchToggle.disabled =
        Boolean(myotisGnosisStatus) && supported && (!available || disabled);
      if (gnosisLaunchHelp) {
        gnosisLaunchHelp.textContent = !myotisGnosisStatus
          ? 'Myotis status could not be read. The startup preference can still be saved.'
          : disabled
            ? 'Disabled for this profile under Settings → Nodes.'
            : supported && !available
              ? 'Sync component missing. Update or reinstall Freedom; open Nodes for help.'
              : myotisGnosisStatus.state === 'recovery-blocked'
                ? 'Sync recovery needs attention. Open Nodes in the toolbar for recovery actions and help.'
                : myotisGnosisStatus.state === 'recovering'
                  ? 'Updating the sync checkpoint automatically. You can turn the node off in Nodes.'
                  : defaultGnosisLaunchHelp;
      }
    }
    updateMethodStatuses();
  };

  window.addEventListener('hashchange', () => {
    if (resolveSection(location.hash) === 'networks') refresh();
  });
  freedomAPI.onSettingsUpdated?.((settings) => {
    if (settings?.networkConfigUpdated) refresh();
  });

  refresh();
  updateMyotis();
  const myotisTimer = setInterval(updateMyotis, 5000);
  window.addEventListener('beforeunload', () => clearInterval(myotisTimer));
})();

// ── RPC Providers page ──────────────────────────────────────────
// Commercial RPC providers (Alchemy / Infura / DRPC) and their API
// keys, for the #rpc section. A keyed provider's API key is
// one credential across every chain that provider serves, so it
// belongs here rather than per-chain.
(() => {
  const section = $('rpc');
  const view = $('rpc-view');
  const statusEl = $('rpc-status');
  if (!section || !view) return;

  const esc = (s) =>
    String(s == null ? '' : s).replace(
      /[&<>"]/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]
    );

  let config = { networks: {}, sources: [] };
  let keyFor = null; // null | provider id whose key is being edited

  const setStatus = (msg, kind) => {
    if (!statusEl) return;
    statusEl.textContent = msg || '';
    statusEl.className = 'rpc-status' + (kind ? ' ' + kind : '');
  };

  // Of the user's configured chains, the ones this provider serves.
  const supportedChains = (provider) => {
    const names = Object.keys(provider.coverage || {})
      .filter((cid) => config.networks[cid])
      .map((cid) => config.networks[cid].name || 'Chain ' + cid);
    return names.length ? names.join(', ') : 'none of your chains';
  };

  const providerRow = (p) => {
    if (keyFor === p.id) {
      return `
        <div class="row">
          <div class="row-body" style="flex: 1">
            <p class="row-label">${esc(p.name || p.id)}</p>
            <div class="rpc-row" style="margin-top: 8px">
              <input type="password" class="rpc-input" id="pkey-${esc(p.id)}" placeholder="API key" spellcheck="false" />
              <button type="button" class="btn" data-action="test-key" data-id="${esc(p.id)}">Test</button>
              <button type="button" class="btn" data-action="save-key" data-id="${esc(p.id)}">Save</button>
              <button type="button" class="btn" data-action="cancel-key">Cancel</button>
            </div>
            <p class="rpc-status" id="pstatus-${esc(p.id)}"></p>
          </div>
        </div>`;
    }
    const controls = p.hasKey
      ? `<button type="button" class="btn" data-action="edit-key" data-id="${esc(p.id)}">Replace key</button>
         <button type="button" class="btn danger" data-action="remove-key" data-id="${esc(p.id)}">Remove</button>`
      : `<button type="button" class="btn" data-action="edit-key" data-id="${esc(p.id)}">Add key</button>`;
    return `
      <div class="row">
        <div class="row-body">
          <p class="row-label">${esc(p.name || p.id)}</p>
          <p class="row-help">${p.hasKey ? 'API key set' : 'No API key'} · supports ${esc(supportedChains(p))}</p>
        </div>
        <div class="row-control">${controls}</div>
      </div>`;
  };

  const render = () => {
    const providers = config.sources.filter((s) => s.keyed);
    const body = providers.length
      ? `<div class="card">${providers.map(providerRow).join('')}</div>`
      : '<div class="card"><div class="rpc-block" style="border-top: none"><p class="rpc-hint">No keyed providers available</p></div></div>';
    view.innerHTML = `
      <h3 class="panel-title">RPC Providers</h3>
      <p class="row-help" style="margin-bottom: 16px">
        Commercial RPC providers. Add an API key to use one — a single
        key covers every chain that provider serves. Keyless public
        RPCs are managed per chain under Chains settings.
      </p>
      ${body}`;
  };

  const reload = async () => {
    try {
      const res = await freedomAPI.getNetworkConfig();
      if (!res || !res.success) {
        setStatus('Failed to load provider configuration', 'error');
        return;
      }
      config = { networks: res.networks || {}, sources: res.sources || [] };
      render();
    } catch {
      setStatus('Failed to load provider configuration', 'error');
    }
  };

  const mutate = async (fn) => {
    try {
      const res = await fn();
      if (res && res.success === false) {
        setStatus(res.error || 'Change failed', 'error');
        return;
      }
      setStatus('', '');
    } catch (err) {
      setStatus(err?.message || 'Change failed', 'error');
    }
    await reload();
  };

  section.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    const id = btn.dataset.id;

    if (action === 'edit-key') {
      keyFor = id;
      render();
      $('pkey-' + id)?.focus();
    } else if (action === 'cancel-key') {
      keyFor = null;
      render();
    } else if (action === 'remove-key') {
      await mutate(() => freedomAPI.removeNetworkApiKey(id));
    } else if (action === 'test-key') {
      const key = ($('pkey-' + id)?.value || '').trim();
      const line = $('pstatus-' + id);
      if (!key) {
        if (line) {
          line.textContent = 'Enter a key to test';
          line.className = 'rpc-status error';
        }
        return;
      }
      if (line) {
        line.textContent = 'testing…';
        line.className = 'rpc-status testing';
      }
      try {
        const r = await freedomAPI.testNetworkApiKey(id, key);
        if (line) {
          line.textContent = r?.success ? 'Key works' : r?.error || 'Key test failed';
          line.className = 'rpc-status ' + (r?.success ? 'success' : 'error');
        }
      } catch (err) {
        if (line) {
          line.textContent = err?.message || 'Key test failed';
          line.className = 'rpc-status error';
        }
      }
    } else if (action === 'save-key') {
      const key = ($('pkey-' + id)?.value || '').trim();
      if (!key) {
        const line = $('pstatus-' + id);
        if (line) {
          line.textContent = 'Enter a key';
          line.className = 'rpc-status error';
        }
        return;
      }
      keyFor = null;
      await mutate(() => freedomAPI.setNetworkApiKey(id, key));
    }
  });

  // Re-sync on navigation into this section. Navigating *away* drops
  // the open key field too — the same shape as Chains above: this
  // section stays in the DOM when hidden, so an abandoned edit would
  // otherwise sit there with a typed API key in it until the user came
  // back.
  window.addEventListener('hashchange', () => {
    if (resolveSection(location.hash) !== 'networks') {
      if (keyFor !== null) {
        keyFor = null;
        render();
      }
      return;
    }
    keyFor = null;
    reload();
  });

  reload();
})();

// Controller for the #permissions section: stored per-site
// permission decisions (permissions.json) grouped by origin, with
// per-permission revoke, per-site revoke, and revoke-all. Session-only
// (unremembered) decisions live in main-process memory and are not
// listed here — they expire with the app anyway.
(() => {
  const view = $('permissions-view');
  const revokeAll = $('permissions-revoke-all');
  if (!view) return;

  const PERMISSION_LABELS = {
    camera: 'Camera',
    microphone: 'Microphone',
    notifications: 'Notifications',
    'clipboard-read': 'Clipboard reading',
    geolocation: 'Location',
    midi: 'MIDI devices',
    // The pop-up-blocked icon's "Always allow pop-ups on this site" (#442).
    popups: 'Pop-ups',
  };
  // `external:<scheme>` — one decision per external-protocol scheme
  // (#406); mirrors permissionLabel in lib/site-permissions-ui.js.
  const label = (key) =>
    key.startsWith('external:')
      ? `Open ${key.slice('external:'.length)}: links`
      : PERMISSION_LABELS[key] || key;

  const render = (all) => {
    const origins = Object.keys(all || {}).sort();

    if (revokeAll) revokeAll.disabled = origins.length === 0;

    // The empty state and the error state below are status messages in
    // a row's clothing, so both carry the page-wide search's skip
    // marker: indexed, "No saved permissions" is offered as a setting
    // to jump to and marked with the accent edge that means "here is
    // your control" (#281).
    if (origins.length === 0) {
      view.innerHTML = `<div class="card"><div class="row settings-search-skip"><div class="row-body">
           <p class="row-label">No saved permissions</p>
           <p class="row-help">Sites you allow or block with
           “Remember for this site” appear here.</p>
         </div></div></div>`;
      return;
    }

    const cards = origins
      .map((origin) => {
        const rows = Object.entries(all[origin] || {})
          .sort(([a], [b]) => a.localeCompare(b))
          .map(
            ([permission, decision]) => `
              <div class="row sub">
                <div class="row-body">
                  <p class="row-label">${esc(label(permission))}</p>
                  <p class="row-help" ${
                    decision === 'deny' ? 'style="color: var(--danger)"' : ''
                  }>${decision === 'allow' ? 'Allowed' : 'Blocked'}</p>
                </div>
                <div class="row-control">
                  <button class="btn" data-action="revoke"
                    data-origin="${esc(origin)}"
                    data-permission="${esc(permission)}">Remove</button>
                </div>
              </div>`
          )
          .join('');
        return `
          <div class="card" style="margin-bottom: 12px">
            <div class="row">
              <div class="row-body">
                <p class="row-label" style="word-break: break-all">${esc(origin)}</p>
              </div>
              <div class="row-control">
                <button class="btn danger" data-action="revoke-origin"
                  data-origin="${esc(origin)}">Remove site</button>
              </div>
            </div>
            ${rows}
          </div>`;
      })
      .join('');

    view.innerHTML = cards;
  };

  const reload = async () => {
    try {
      render(await freedomAPI.getSitePermissions());
    } catch (err) {
      // The button lives in the section header now, outside the view
      // this replaces, so the error render has to disable it itself —
      // offering to wipe state the page just said it cannot read.
      if (revokeAll) revokeAll.disabled = true;
      view.innerHTML = `<div class="card"><div class="row settings-search-skip"><div class="row-body">
        <p class="row-label">Could not load site permissions</p>
        <p class="row-help">${esc(err?.message || String(err))}</p>
      </div></div></div>`;
    }
  };

  revokeAll?.addEventListener('click', async () => {
    try {
      await freedomAPI.revokeAllSitePermissions();
    } catch (err) {
      console.error('[settings] site-permission revoke failed:', err);
    }
    reload();
  });

  view.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const { action, origin, permission } = btn.dataset;
    try {
      if (action === 'revoke') {
        await freedomAPI.revokeSitePermission(origin, permission);
      } else if (action === 'revoke-origin') {
        await freedomAPI.revokeSitePermissionOrigin(origin);
      }
    } catch (err) {
      console.error('[settings] site-permission revoke failed:', err);
    }
    reload();
  });

  // Live refresh when decisions change elsewhere (prompt answers,
  // the address-bar indicator's quick revoke).
  freedomAPI.onSitePermissionsChanged?.(() => {
    reload();
  });

  // Re-sync on navigation into this section.
  window.addEventListener('hashchange', () => {
    if (resolveSection(location.hash) !== 'privacy') return;
    reload();
  });

  reload();
})();
