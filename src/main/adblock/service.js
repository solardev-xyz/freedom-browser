/**
 * Desktop ad blocking: filter-engine lifecycle plus webRequest
 * interception, registered with the shared dispatcher as the 'adblock'
 * onBeforeRequest handler (between the request rewriter and x402).
 *
 * The engine backend (@ghostery/adblocker) is confined to this module:
 * callers only see install/refresh/cleanup and the classifier helpers,
 * so the engine can be swapped (e.g. for Brave's adblock-rust) without
 * touching the rest of the browser.
 *
 * Filter lists are read from artifacts directories: a `manifest.json`
 * naming one ABP-syntax list file per category (see the desktop target
 * of freedom-adblock-service). Directories are layered per category — a
 * landed Swarm update over the bundled floor — so an update carrying only
 * some categories never shadows the bundled lists for the rest. Engine
 * builds happen off the request hot path and are swapped atomically; until
 * the first build completes, requests pass through.
 *
 * Blocking decisions match Freedom iOS: ads + privacy on by default,
 * cookie banners + annoyances opt-in, allowlist bypasses the engine for
 * the tab's whole top-level host rather than layering exception rules.
 *
 * Scriptlets (`##+js(...)`, #410): the manifest may name a `resources` file
 * (uBlock Origin's scriptlets, in @ghostery's resources.json shape) that is
 * loaded into the engine; `getScriptlets` then hands a frame its injection
 * code, which the webview preload runs in the page's main world at document
 * start. `trusted-*` scriptlets can do arbitrary things to a page (replace
 * fetch responses, set any constant), so — as in uBlock Origin — only lists
 * from the scriptlet authors themselves may invoke them; they are stripped
 * from every other list before the engine sees it.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const log = require('../logger');
const { FiltersEngine, Request, Resources, ENGINE_VERSION } = require('@ghostery/adblocker');
const ADBLOCKER_VERSION = require('@ghostery/adblocker/package.json').version;
const { registerWebRequestHandler } = require('../webrequest-dispatcher');
const { loadSettings } = require('../settings-store');
const IPC = require('../../shared/ipc-channels');
const {
  getAllowlistedHosts,
  addAllowlistedHost,
  removeAllowlistedHost,
} = require('./allowlist-store');
const {
  mapResourceType,
  isInterceptableUrl,
  isLoopbackHost,
  hostnameFromUrl,
  normalizeHost,
  isHostAllowlisted,
} = require('./request-classifier');

// Cosmetic filtering is loaded (element hiding and, with a resources file,
// `+js(...)` scriptlets — @ghostery parses both as cosmetic filters);
// extended/procedural selectors stay out of scope. `scriptlets` is Freedom's
// own list preprocessing (untrusted lists lose their `trusted-*` scriptlet
// rules, see stripTrustedScriptlets), not an engine option: bump it whenever
// that preprocessing changes. The whole object is folded into the cache key
// (below) so any change to it automatically invalidates caches serialized
// under a different shape, with no separate version to bump.
const ENGINE_CONFIG = { loadCosmeticFilters: true, loadExtendedSelectors: false };
const ENGINE_CONFIG_KEY = JSON.stringify({ ...ENGINE_CONFIG, scriptlets: 1 });

// Category name in manifest.json -> settings key gating it. Two categories
// can share a setting: `ublock` (uBlock Origin's own filters + Quick fixes,
// which carry the YouTube ad-pruning scriptlets) is part of "Block ads", but
// is its own manifest entry so a Swarm update carrying only `ads` never
// shadows it (layers are merged per category, see resolveArtifacts).
const CATEGORY_SETTINGS = [
  ['ads', 'adblockAds'],
  ['ublock', 'adblockAds'],
  ['privacy', 'adblockPrivacy'],
  ['cookies', 'adblockCookies'],
  ['annoyances', 'adblockAnnoyances'],
];

// Categories bundled at build time only — the Swarm update channel
// (freedom-adblock-service/sources.json) does not publish them, so the update
// manager must not wait for / try to backfill them from the feed.
const BUNDLED_ONLY_CATEGORIES = new Set(['ublock']);

// Categories whose lists may invoke `trusted-*` scriptlets: the lists written
// by the authors of the scriptlets themselves, as in uBlock Origin.
const TRUSTED_SCRIPTLET_CATEGORIES = new Set(['ublock']);

// When set (tests / E2E via options.artifactsDir), the artifacts dir is
// pinned. Otherwise refreshEngine re-resolves the layers each build so a Swarm
// update promoted into userData/adblock/updated takes effect in-session, not
// just on the next restart.
let artifactsDirOverride = null;
let installed = false;
let cacheDir = null;
let engine = null;
let lastArtifacts = null;
let allowlistedHosts = [];
// webContentsId -> top-level URL, maintained from mainFrame requests so
// subresources get first-party context and allowlist scoping.
const topLevelUrls = new Map();

// Cosmetic requests hit the same frame URL repeatedly (once per mutation
// batch); Request parsing does a public-suffix lookup, so cache the derived
// hostname/domain. Bounded, oldest-evicted — frames are few and long-lived.
const frameUrlCache = new Map();
const FRAME_URL_CACHE_MAX = 128;

function parseFrameUrl(url) {
  if (frameUrlCache.has(url)) return frameUrlCache.get(url);
  let parsed;
  try {
    const req = Request.fromRawDetails({ url });
    parsed = { hostname: req.hostname, domain: req.domain };
  } catch {
    parsed = null;
  }
  if (frameUrlCache.size >= FRAME_URL_CACHE_MAX) {
    frameUrlCache.delete(frameUrlCache.keys().next().value);
  }
  frameUrlCache.set(url, parsed);
  return parsed;
}

/**
 * Where the Swarm update-manager writes downloaded lists, when present and
 * valid. Preferred over the bundled floor so live updates take effect.
 * Returns null when no verified update has landed.
 */
function getUpdatedArtifactsDir() {
  try {
    const { app } = require('electron');
    const dir = path.join(app.getPath('userData'), 'adblock', 'updated');
    if (fs.existsSync(path.join(dir, 'manifest.json'))) return dir;
  } catch {
    // Running outside Electron (e.g. Jest).
  }
  return null;
}

// Lists live in assets/adblock (fetched by scripts/fetch-adblock-lists.js,
// gitignored); packaged builds ship the whole assets/ dir via extraResources.
function getBundledArtifactsDir() {
  try {
    const { app } = require('electron');
    if (app && app.isPackaged) {
      return path.join(process.resourcesPath, 'assets', 'adblock');
    }
  } catch {
    // Running outside Electron (e.g. Jest).
  }
  return path.join(__dirname, '..', '..', '..', 'assets', 'adblock');
}

/**
 * The artifact layers to build from, highest precedence first: a landed Swarm
 * update in userData, then the bundled floor (which FREEDOM_ADBLOCK_DIR
 * replaces for dev/E2E). A dir pinned via options.artifactsDir is used alone.
 *
 * An update dir only carries the categories that were enabled when it was
 * downloaded, so it is layered over — never substituted for — the floor:
 * enabling a category after an update landed still blocks with that
 * category's bundled list until the feed copy is backfilled.
 */
function getArtifactDirs() {
  if (artifactsDirOverride) return [artifactsDirOverride];
  const bundled = process.env.FREEDOM_ADBLOCK_DIR || getBundledArtifactsDir();
  const updated = getUpdatedArtifactsDir();
  return updated ? [updated, bundled] : [bundled];
}

function getDefaultCacheDir() {
  try {
    const { app } = require('electron');
    return path.join(app.getPath('userData'), 'adblock-cache');
  } catch {
    // Running outside Electron (e.g. Jest) — caching off unless injected.
    return null;
  }
}

async function readManifest(dir) {
  try {
    const raw = await fs.promises.readFile(path.join(dir, 'manifest.json'), 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    log.info(`[adblock] no filter-list artifacts at ${dir}: ${err.message}`);
    return null;
  }
}

/**
 * Merge the layers' manifests into one per-category view: each category is
 * served by the highest-precedence layer carrying it, and every entry keeps
 * the dir + bundle version it came from (needed for reads and the cache key).
 *
 * @returns {Promise<{version: string, categories: object}|null>} null when no
 *   layer has a readable manifest at all.
 */
async function resolveArtifacts() {
  const categories = {};
  let version = null;
  const resources = [];
  for (const dir of getArtifactDirs()) {
    const manifest = await readManifest(dir);
    if (!manifest) continue;
    if (version === null) version = manifest.version;
    for (const [category, entry] of Object.entries(manifest.categories || {})) {
      if (!categories[category]) {
        categories[category] = { ...entry, dir, listsVersion: manifest.version };
      }
    }
    // Scriptlet resources layer the same way: the highest layer naming a
    // resources file serves it (today only the bundled floor carries one).
    // Lower layers stay on as fallbacks in case that file can't be read.
    if (manifest.resources?.file) {
      resources.push({ ...manifest.resources, dir });
    }
  }
  return version === null
    ? null
    : { version, categories, resources: resources[0] || null, resourcesFallbacks: resources };
}

/**
 * Read and parse the scriptlet resources file, from the highest layer whose
 * file is usable (an unreadable updated copy falls back to a lower layer's,
 * ultimately the bundled floor). Returns null when there is none or none can
 * be used — the engine still blocks and hides, it just has no scriptlets (and
 * no `$redirect=` bodies). `degraded` marks a result that isn't the top
 * layer's own file, so the caller doesn't cache it under that file's identity.
 */
async function readResources(resolved) {
  const candidates = resolved.resourcesFallbacks || [];
  for (const [i, entry] of candidates.entries()) {
    try {
      const text = await fs.promises.readFile(path.join(entry.dir, entry.file), 'utf-8');
      const checksum = entry.sha256 || crypto.createHash('sha256').update(text).digest('hex');
      const parsed = Resources.parse(text, { checksum });
      return {
        text,
        checksum,
        entry,
        degraded: i > 0,
        trustedNames: trustedScriptletNames(parsed),
      };
    } catch (err) {
      log.warn(`[adblock] skipping unreadable scriptlet resources in ${entry.dir}: ${err.message}`);
    }
  }
  return candidates.length ? { degraded: true } : null;
}

// Every spelling a list can use to name a trust-requiring scriptlet: its
// name and aliases, each with and without the `.js`/`.fn` suffix (uBlock lets
// `+js(json-prune, …)` omit it).
function trustedScriptletNames(resources) {
  const names = new Set();
  for (const scriptlet of resources.scriptlets) {
    if (scriptlet.requiresTrust !== true) continue;
    for (const name of [scriptlet.name, ...(scriptlet.aliases || [])]) {
      names.add(name);
      names.add(name.replace(/\.(js|fn)$/, ''));
    }
  }
  return names;
}

// A `+js(...)` injection rule (not an `#@#` exception), capturing the
// scriptlet name.
const SCRIPTLET_RULE_RE = /^[^\n]*?#[$?]?#\+js\(\s*([^,)\s]+)[^\n]*$/gm;

/**
 * Drop the rules of `text` that invoke a trust-requiring scriptlet. Anything
 * named `trusted-*` counts even if the resources file doesn't list it, so a
 * newer list can't slip one past an older resources file.
 */
function stripTrustedScriptlets(text, trustedNames) {
  if (!text.includes('+js(')) return text;
  return text.replace(SCRIPTLET_RULE_RE, (line, name) =>
    name.startsWith('trusted-') || trustedNames.has(name) ? '' : line
  );
}

async function readEnabledListsText(settings, resolved, trustedNames = new Set()) {
  const texts = [];
  for (const [category, settingKey] of CATEGORY_SETTINGS) {
    const entry = resolved.categories[category];
    if (!entry || settings[settingKey] !== true) continue;
    try {
      const text = await fs.promises.readFile(path.join(entry.dir, entry.file), 'utf-8');
      texts.push(
        TRUSTED_SCRIPTLET_CATEGORIES.has(category)
          ? text
          : stripTrustedScriptlets(text, trustedNames)
      );
    } catch (err) {
      // A bad list disables that category, never the whole feature.
      log.warn(`[adblock] skipping unreadable list '${category}': ${err.message}`);
    }
  }
  return texts.length > 0 ? texts.join('\n') : null;
}

// Identity of the exact bytes an engine build compiles in: per enabled
// category, the serving layer's bundle version plus the list file's name and
// digest — deliberately not its directory, so the identity travels with the
// content. A partial update refreshing only 'ads' therefore invalidates the
// cache while the bundled layer's other categories keep their identity.
// The scriptlet resources are compiled into (and serialized with) the engine
// too, so their digest is part of the identity.
function engineIdentity(resolved, enabledCategories) {
  const lists = enabledCategories.map((category) => {
    const entry = resolved.categories[category];
    if (!entry) return `${category}@none`;
    return `${category}@${entry.listsVersion}:${entry.file}:${entry.sha256 || ''}`;
  });
  const res = resolved.resources;
  lists.push(
    res ? `resources@${res.version || ''}:${res.file}:${res.sha256 || ''}` : 'resources@none'
  );
  return lists.join(',');
}

// The serialized-engine format is version-locked, so the cache key covers
// the exact library + format versions plus the engine identity above. Any
// mismatch is simply a different filename, so stale caches are never read —
// and pruned on the next write.
function cacheFileFor(identity) {
  const key = crypto
    .createHash('sha256')
    .update(`${ADBLOCKER_VERSION}|${ENGINE_VERSION}|${ENGINE_CONFIG_KEY}|${identity}`)
    .digest('hex')
    .slice(0, 16);
  return path.join(cacheDir, `engine-${key}.bin`);
}

async function readEngineCache(cacheFile) {
  try {
    const buf = await fs.promises.readFile(cacheFile);
    return FiltersEngine.deserialize(buf);
  } catch {
    return null; // Missing or unreadable cache is just a rebuild.
  }
}

async function writeEngineCache(cacheFile, builtEngine) {
  try {
    await fs.promises.mkdir(cacheDir, { recursive: true });
    // Prune caches from other engine/list/category combinations.
    for (const entry of await fs.promises.readdir(cacheDir)) {
      if (entry.startsWith('engine-') && entry !== path.basename(cacheFile)) {
        await fs.promises.unlink(path.join(cacheDir, entry)).catch(() => {});
      }
    }
    const tmpFile = `${cacheFile}.tmp`;
    await fs.promises.writeFile(tmpFile, builtEngine.serialize());
    await fs.promises.rename(tmpFile, cacheFile);
  } catch (err) {
    log.warn(`[adblock] failed to write engine cache: ${err.message}`);
  }
}

/**
 * (Re)build the engine from the artifacts on disk for the current
 * settings, then swap it in. Called at install, by settings-store when
 * an adblock setting changes, and after a list update lands (WP5 Swarm
 * channel). Prefers a serialized-engine cache (milliseconds) over
 * parsing raw list text (hundreds of milliseconds of main-thread CPU).
 *
 * Builds are serialized: settings changes fire refreshes without awaiting
 * each other, and if builds overlapped, a slower earlier build (say, with a
 * since-disabled category) could finish last and clobber the newer engine.
 * Each build starts only after the previous one settled and reads the
 * then-current settings/artifacts, so the last caller always wins.
 */
let refreshChain = Promise.resolve();

function refreshEngine() {
  const run = refreshChain.then(rebuildEngineOnce);
  // Keep the chain usable after a failed build; the failure still reaches
  // this call's caller through `run`.
  refreshChain = run.catch(() => {});
  return run;
}

async function rebuildEngineOnce() {
  // Not installed yet (e.g. a settings save before bootstrap wires us up).
  if (!installed) return;

  const settings = loadSettings();
  // Re-resolve the layers each build (unless pinned) so a just-promoted
  // update dir wins per category.
  const resolved = await resolveArtifacts();
  lastArtifacts = resolved;
  if (!resolved) {
    engine = null;
    return;
  }

  const enabledCategories = getEnabledCategories();
  const categoriesKey = enabledCategories.join(',');
  const cacheFile = cacheDir ? cacheFileFor(engineIdentity(resolved, enabledCategories)) : null;

  if (cacheFile) {
    const cached = await readEngineCache(cacheFile);
    if (cached) {
      engine = cached;
      log.info('[adblock] filter engine ready (cache)');
      return;
    }
  }

  const read = await readResources(resolved);
  const resources = read?.text ? read : null;
  const text = await readEnabledListsText(settings, resolved, resources?.trustedNames);
  if (text === null) {
    engine = null;
    return;
  }
  const built = FiltersEngine.parse(text, ENGINE_CONFIG);
  if (resources) built.updateResources(resources.text, resources.checksum);
  engine = built;
  log.info(
    `[adblock] filter engine ready (${resolved.version}, categories: ${categoriesKey}, ` +
      `scriptlets: ${resources ? resources.entry.version || 'yes' : 'none'})`
  );
  // A build that couldn't use the top layer's resources file isn't what the
  // engine identity names; caching it would keep serving the fallback after
  // that file is fixed.
  if (cacheFile && !read?.degraded) {
    await writeEngineCache(cacheFile, engine);
  }
}

/**
 * Pure dispatcher handler — returns `{cancel}` / `{redirectURL}` or
 * `null` to pass through. Runs on the request hot path: no I/O, no
 * awaits.
 */
function adblockRequestForDispatch(details) {
  const { url, resourceType, webContentsId } = details;

  // Record top-level context even while disabled so toggling adblock on
  // mid-session has correct first-party state. Top-level navigation is
  // never cancelled — network lists target subresources, and a broken
  // list must not be able to brick navigation.
  if (resourceType === 'mainFrame') {
    if (typeof webContentsId === 'number') {
      topLevelUrls.set(webContentsId, url);
    }
    return null;
  }

  if (!engine || loadSettings().adblockEnabled === false) return null;
  if (!isInterceptableUrl(url)) return null;

  // Each URL is parsed exactly once; the hostnames are handed to the
  // engine so it skips its own URL parse.
  const hostname = hostnameFromUrl(url);
  if (!hostname || isLoopbackHost(hostname)) return null;

  const sourceUrl = topLevelUrls.get(webContentsId) || details.referrer || '';
  const sourceHostname = hostnameFromUrl(sourceUrl) || '';
  if (
    allowlistedHosts.length > 0 &&
    isHostAllowlisted(normalizeHost(sourceHostname), allowlistedHosts)
  ) {
    return null;
  }

  const result = engine.match(
    Request.fromRawDetails({
      url,
      hostname,
      sourceUrl,
      sourceHostname,
      type: mapResourceType(resourceType),
    })
  );
  if (result.redirect?.dataUrl) return { redirectURL: result.redirect.dataUrl };
  if (result.match) return { cancel: true };
  return null;
}

/**
 * Compute cosmetic (element-hiding) CSS for a frame, requested by the
 * webview preload. Two phases: `initial` returns the frame's
 * hostname-specific rules; subsequent calls pass newly-seen DOM
 * classes/ids/hrefs and get the generic rules that match them, so the
 * hostname rules aren't re-sent on every mutation.
 *
 * @param {object} args
 * @param {string} args.url       Frame document URL (styles are per-frame).
 * @param {number} [args.sourceId] Guest webContents id, for allowlist scoping.
 * @param {boolean} [args.initial]
 * @returns {{ active: boolean, styles: string }}
 */
function getCosmeticFilters({ url, sourceId, initial, classes = [], ids = [], hrefs = [] }) {
  const inactive = { active: false, styles: '' };
  if (!engine || loadSettings().adblockEnabled === false) return inactive;
  if (!isInterceptableUrl(url)) return inactive;

  // Allowlist is keyed on the tab's top-level host, not the (possibly
  // sub-frame) document being styled.
  const topUrl = (typeof sourceId === 'number' && topLevelUrls.get(sourceId)) || url;
  const topHost = normalizeHost(hostnameFromUrl(topUrl));
  if (topHost && allowlistedHosts.length > 0 && isHostAllowlisted(topHost, allowlistedHosts)) {
    return inactive;
  }

  const parsed = parseFrameUrl(url);
  if (!parsed) return inactive;

  // Initial call: hostname/base rules (DOM-independent), fetched once.
  // Later calls: generic rules keyed on the newly-seen DOM tokens.
  const wantHostname = initial === true;
  const { active, styles } = engine.getCosmeticsFilters({
    url,
    hostname: parsed.hostname,
    domain: parsed.domain,
    classes,
    ids,
    hrefs,
    getRulesFromHostname: wantHostname,
    getRulesFromDOM: !wantHostname,
    getInjectionRules: false,
    getExtendedRules: false,
    getBaseRules: wantHostname,
  });
  return { active, styles: styles || '' };
}

/**
 * The scriptlet code a frame must run before any of its own scripts, as one
 * function body (empty when there is nothing to inject). Requested
 * synchronously by the webview preload at document start, so this sits on
 * every http(s) navigation of every frame: no I/O, and the same early-outs
 * as getCosmeticFilters — master toggle, per-category toggles (baked into
 * the engine), the tab's allowlisted top-level host, non-web URLs.
 *
 * Each scriptlet is wrapped in its own try/catch so one throwing (a page
 * that already froze the global it patches, say) can't stop the rest.
 *
 * @param {object} args
 * @param {string} args.url        Frame document URL.
 * @param {number} [args.sourceId] Guest webContents id, for allowlist scoping.
 * @returns {{ script: string }}
 */
function getScriptlets({ url, sourceId } = {}) {
  const none = { script: '' };
  if (!engine || loadSettings().adblockEnabled === false) return none;
  if (!isInterceptableUrl(url) || url.startsWith('ws')) return none;

  const topUrl = (typeof sourceId === 'number' && topLevelUrls.get(sourceId)) || url;
  const topHost = normalizeHost(hostnameFromUrl(topUrl));
  if (topHost && allowlistedHosts.length > 0 && isHostAllowlisted(topHost, allowlistedHosts)) {
    return none;
  }

  const parsed = parseFrameUrl(url);
  if (!parsed) return none;

  const { active, scripts } = engine.getCosmeticsFilters({
    url,
    hostname: parsed.hostname,
    domain: parsed.domain,
    getRulesFromHostname: true,
    getRulesFromDOM: false,
    getBaseRules: false,
    getInjectionRules: true,
    getExtendedRules: false,
  });
  if (active === false || !Array.isArray(scripts) || scripts.length === 0) return none;
  return {
    script: scripts.map((code) => `try {\n${code}\n} catch (e) {}`).join('\n'),
  };
}

/**
 * Register the adblock handler. Must run before
 * `attachWebRequestDispatcher()`. The initial engine build is kicked off
 * in the background; blocking starts once it completes.
 */
function installAdblockInterception(options = {}) {
  artifactsDirOverride = options.artifactsDir || null;
  cacheDir = options.cacheDir !== undefined ? options.cacheDir : getDefaultCacheDir();
  installed = true;
  setAllowlistedHosts(getAllowlistedHosts());
  registerWebRequestHandler('onBeforeRequest', 'adblock', adblockRequestForDispatch);
  refreshEngine().catch((err) => {
    log.error(`[adblock] initial engine build failed: ${err.message}`);
  });
}

/**
 * Replace the set of allowlisted hosts. Called at install with the
 * persisted allowlist and by allowlist-store after each mutation.
 * Entries are normalized here, once, so the hot path only compares.
 */
function setAllowlistedHosts(hosts) {
  allowlistedHosts = Array.isArray(hosts) ? hosts.map(normalizeHost).filter(Boolean) : [];
}

function cleanupAdblockWebContents(webContentsId) {
  topLevelUrls.delete(webContentsId);
}

/**
 * Whether a filter engine is loaded and blocking is live. Consumed by the
 * E2E readiness poll and the settings-page status.
 */
function isEngineReady() {
  return engine !== null;
}

/** Status snapshot for the settings page. */
function getAdblockStatus() {
  const categories = {};
  for (const [category, meta] of Object.entries(lastArtifacts?.categories || {})) {
    categories[category] = { title: meta.title, ruleCount: meta.ruleCount };
  }
  return {
    engineReady: isEngineReady(),
    listsVersion: lastArtifacts?.version || null,
    categories,
  };
}

/** Register the settings-page and cosmetic-injection IPC surface. */
function registerAdblockIpc() {
  const { ipcMain } = require('electron');
  ipcMain.handle(IPC.ADBLOCK_GET_STATUS, () => getAdblockStatus());
  ipcMain.handle(IPC.ADBLOCK_GET_ALLOWLIST, () => getAllowlistedHosts());
  ipcMain.handle(IPC.ADBLOCK_ADD_ALLOWLIST_HOST, (_event, host) => addAllowlistedHost(host));
  ipcMain.handle(IPC.ADBLOCK_REMOVE_ALLOWLIST_HOST, (_event, host) => removeAllowlistedHost(host));
  // Requested per-frame by the webview preload; sender id scopes the
  // allowlist to the tab's top-level host.
  ipcMain.handle(IPC.ADBLOCK_COSMETIC, (event, args) =>
    getCosmeticFilters({ ...args, sourceId: event.sender?.id })
  );
  // Synchronous: the preload must have the scriptlets before the page's first
  // script runs. Sub-frames send it too; their sender is the tab's guest
  // webContents, so the allowlist still keys on the tab's top-level host.
  ipcMain.on(IPC.ADBLOCK_SCRIPTLETS, (event, args) => {
    try {
      event.returnValue = getScriptlets({ url: args?.url, sourceId: event.sender?.id });
    } catch (err) {
      log.warn(`[adblock] scriptlet lookup failed: ${err.message}`);
      event.returnValue = { script: '' };
    }
  });
}

/** The category keys currently enabled in settings (e.g. ['ads','privacy']). */
function getEnabledCategories() {
  const settings = loadSettings();
  return CATEGORY_SETTINGS.filter(([, key]) => settings[key] === true).map(
    ([category]) => category
  );
}

/**
 * The enabled categories the Swarm update channel publishes — what the update
 * manager downloads and backfills. Bundle-only categories are left out, or a
 * category the feed never carries would look permanently un-backfilled.
 */
function getEnabledFeedCategories() {
  return getEnabledCategories().filter((category) => !BUNDLED_ONLY_CATEGORIES.has(category));
}

/** Test-only: clear module state between suites. */
function _resetAdblockForTests() {
  artifactsDirOverride = null;
  installed = false;
  cacheDir = null;
  engine = null;
  lastArtifacts = null;
  allowlistedHosts = [];
  topLevelUrls.clear();
  frameUrlCache.clear();
  refreshChain = Promise.resolve();
}

module.exports = {
  installAdblockInterception,
  registerAdblockIpc,
  adblockRequestForDispatch,
  getCosmeticFilters,
  getScriptlets,
  stripTrustedScriptlets,
  refreshEngine,
  setAllowlistedHosts,
  cleanupAdblockWebContents,
  isEngineReady,
  getAdblockStatus,
  getEnabledCategories,
  getEnabledFeedCategories,
  _resetAdblockForTests,
};
