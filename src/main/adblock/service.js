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
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const log = require('../logger');
const { FiltersEngine, Request, ENGINE_VERSION } = require('@ghostery/adblocker');
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

// Cosmetic filtering is loaded (element hiding); extended/procedural
// selectors and scriptlet resources are out of scope for now. This config
// is folded into the cache key (below) so any change to it — enabling
// cosmetics, a later scriptlet milestone — automatically invalidates caches
// serialized under a different shape, with no separate version to bump.
const ENGINE_CONFIG = { loadCosmeticFilters: true, loadExtendedSelectors: false };
const ENGINE_CONFIG_KEY = JSON.stringify(ENGINE_CONFIG);

// Category name in manifest.json -> settings key gating it.
const CATEGORY_SETTINGS = [
  ['ads', 'adblockAds'],
  ['privacy', 'adblockPrivacy'],
  ['cookies', 'adblockCookies'],
  ['annoyances', 'adblockAnnoyances'],
];

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
  for (const dir of getArtifactDirs()) {
    const manifest = await readManifest(dir);
    if (!manifest) continue;
    if (version === null) version = manifest.version;
    for (const [category, entry] of Object.entries(manifest.categories || {})) {
      if (!categories[category]) {
        categories[category] = { ...entry, dir, listsVersion: manifest.version };
      }
    }
  }
  return version === null ? null : { version, categories };
}

async function readEnabledListsText(settings, resolved) {
  const texts = [];
  for (const [category, settingKey] of CATEGORY_SETTINGS) {
    const entry = resolved.categories[category];
    if (!entry || settings[settingKey] !== true) continue;
    try {
      texts.push(await fs.promises.readFile(path.join(entry.dir, entry.file), 'utf-8'));
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
function engineIdentity(resolved, enabledCategories) {
  return enabledCategories
    .map((category) => {
      const entry = resolved.categories[category];
      if (!entry) return `${category}@none`;
      return `${category}@${entry.listsVersion}:${entry.file}:${entry.sha256 || ''}`;
    })
    .join(',');
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

  const text = await readEnabledListsText(settings, resolved);
  if (text === null) {
    engine = null;
    return;
  }
  engine = FiltersEngine.parse(text, ENGINE_CONFIG);
  log.info(`[adblock] filter engine ready (${resolved.version}, categories: ${categoriesKey})`);
  if (cacheFile) {
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
}

/** The category keys currently enabled in settings (e.g. ['ads','privacy']). */
function getEnabledCategories() {
  const settings = loadSettings();
  return CATEGORY_SETTINGS.filter(([, key]) => settings[key] === true).map(
    ([category]) => category
  );
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
  refreshEngine,
  setAllowlistedHosts,
  cleanupAdblockWebContents,
  isEngineReady,
  getAdblockStatus,
  getEnabledCategories,
  _resetAdblockForTests,
};
