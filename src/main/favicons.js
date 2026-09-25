/**
 * Favicon fetching and caching module
 *
 * Fetches favicons from websites and caches them in SQLite.
 *
 * This module never fetches a *page*. The `<link rel="icon">` parse is
 * Chromium's own, done on the document the webview already downloaded and
 * handed to us through `page-favicon-updated` (src/renderer/lib/tabs.js) as
 * `iconUrl`. Before #75 this module re-downloaded every page URL here to run
 * its own regex over the HTML, so every external navigation produced two
 * server-side GETs for the same URL — one cookied (the webview) and one
 * cookieless (this module) — which tripped paywalls, rate limits and auth
 * challenges on stateful sites. With no `iconUrl` the only request made is
 * `<content root>/favicon.ico`, the same fallback as before.
 *
 * PRIVACY: the icon request goes through main-process `net.request`, i.e. the
 * *default* session — no cookies, no credentials, no webview storage. That
 * cookieless property was the point of the old page probe and is preserved
 * here; it is also why this module can never be handed a private window's
 * partition, and why private senders degrade to a cache read instead
 * (see registerFaviconsIpc). The default session is the session Tor's
 * `.onion` PAC is installed on (src/main/tor-proxy.js#applyOnionProxy), so a
 * favicon on a `.onion` host is dialled over the Arti SOCKS proxy exactly
 * like the page was — it is never handed to the system DNS resolver.
 */

const log = require('./logger');
const { ipcMain, net } = require('electron');
const { getDb } = require('./history');
const IPC = require('../shared/ipc-channels');
const { isPrivateWebContents } = require('./private/private-windows');

// Prepared statements (lazily initialized)
let statements = null;

/**
 * Run favicon table migration
 */
function migrateFavicons(db) {
  const version = db.pragma('user_version', { simple: true });

  // Migration 2: Add favicons table
  if (version < 2) {
    log.info('[Favicons] Running migration to version 2');
    db.exec(`
      CREATE TABLE IF NOT EXISTS favicons (
        domain TEXT PRIMARY KEY,
        icon_data TEXT,
        content_type TEXT,
        fetched_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_favicons_domain ON favicons(domain);
    `);
    db.pragma('user_version = 2');
  }
}

/**
 * Get prepared statements
 */
function getStatements() {
  if (statements) return statements;

  const db = getDb();

  // Run migration on first access
  migrateFavicons(db);

  statements = {
    get: db.prepare('SELECT * FROM favicons WHERE domain = ?'),
    upsert: db.prepare(`
      INSERT INTO favicons (domain, icon_data, content_type, fetched_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(domain) DO UPDATE SET
        icon_data = excluded.icon_data,
        content_type = excluded.content_type,
        fetched_at = excluded.fetched_at
    `),
    delete: db.prepare('DELETE FROM favicons WHERE domain = ?'),
  };

  return statements;
}

/**
 * Extract domain from URL
 */
function extractDomain(url) {
  try {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      const parsed = new URL(url);
      return parsed.host;
    }
    // For bzz://, ipfs://, etc., use the full protocol + host
    const match = url.match(/^([a-z]+:\/\/[^\/]+)/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

/**
 * Fetch data from URL with timeout
 */
async function fetchWithTimeout(url, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const request = net.request(url);
    let data = [];
    let contentType = 'image/x-icon';

    const timer = setTimeout(() => {
      request.abort();
      reject(new Error('Timeout'));
    }, timeout);

    request.on('response', (response) => {
      if (response.statusCode !== 200) {
        clearTimeout(timer);
        // The body is abandoned unread. An `IncomingMessage` is an
        // EventEmitter, so a connection error emitted on it after this point
        // (the server resetting the socket once the 404's headers are out)
        // would be an unhandled `'error'` — a main-process crash, not a
        // failed fetch. Take a no-op listener and abort the request rather
        // than leaving it dialling, same as the abandoned-response paths in
        // `src/main/ipfs/gateway-transport.js` (#358).
        response.on?.('error', () => {});
        request.abort();
        reject(new Error(`HTTP ${response.statusCode}`));
        return;
      }

      contentType = response.headers['content-type'] || 'image/x-icon';
      if (Array.isArray(contentType)) contentType = contentType[0];

      response.on('data', (chunk) => {
        data.push(chunk);
      });

      response.on('end', () => {
        clearTimeout(timer);
        resolve({
          data: Buffer.concat(data),
          contentType,
        });
      });

      response.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });

    request.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    request.end();
  });
}

/**
 * Convert SVG data URL to base64 for reliable img src usage
 */
function normalizeDataUrl(dataUrl) {
  // Check if it's an SVG data URL that's not base64 encoded
  if (dataUrl.startsWith('data:image/svg+xml,') && !dataUrl.includes(';base64,')) {
    // Extract the SVG content after the comma
    const svgContent = dataUrl.slice('data:image/svg+xml,'.length);
    // Decode any URL encoding first, then base64 encode
    let decoded;
    try {
      decoded = decodeURIComponent(svgContent);
    } catch {
      decoded = svgContent;
    }
    const base64 = Buffer.from(decoded, 'utf8').toString('base64');
    return `data:image/svg+xml;base64,${base64}`;
  }
  return dataUrl;
}

/**
 * Extract content root for IPFS/Swarm gateway URLs
 * For http://localhost:5001/ipfs/CID/path -> http://localhost:5001/ipfs/CID
 * For http://localhost:1633/bzz/HASH/path -> http://localhost:1633/bzz/HASH
 */
function extractContentRoot(pageUrl) {
  try {
    const parsed = new URL(pageUrl);
    const pathParts = parsed.pathname.split('/').filter(Boolean);

    // Check for /ipfs/CID or /ipns/ID or /bzz/HASH pattern
    if (pathParts.length >= 2) {
      const protocol = pathParts[0].toLowerCase();
      if (protocol === 'ipfs' || protocol === 'ipns' || protocol === 'bzz') {
        // Return origin + /protocol/identifier
        return `${parsed.origin}/${pathParts[0]}/${pathParts[1]}`;
      }
    }

    // Not an IPFS/Swarm URL, return origin
    return parsed.origin;
  } catch {
    return null;
  }
}

/**
 * Pull a gateway-root-resolved icon URL back under the page's content root.
 *
 * Chromium never hands us the raw `href`: it resolves `<link rel="icon"
 * href="/icon.png">` against the page's *origin* before reporting it, and it
 * synthesises the implicit `<origin>/favicon.ico` candidate for a page that
 * declares no icon at all the same way. On a path-gateway load
 * (`http://127.0.0.1:8080/ipfs/<cid>/index.html`) that origin is the
 * *gateway*, not the site, so both reports point at the gateway's own root —
 * a 404 on Kubo/Bee, or, on a public gateway that serves a root favicon, the
 * *gateway's* icon cached under the site's key. Remap them onto
 * `<origin>/ipfs/<cid>`, which is exactly what the pre-#75 HTML parser
 * resolved a root-relative href against.
 *
 * Left untouched: a cross-origin icon, a page whose content root *is* its
 * origin (an ordinary http site), an icon already inside the content root,
 * and one that names a gateway path of its own (`/ipfs/<other-cid>/…`) —
 * prefixing that would only double the path.
 */
function remapToContentRoot(iconUrl, contentRoot) {
  if (!contentRoot) return iconUrl;
  try {
    const parsed = new URL(iconUrl);
    if (contentRoot === parsed.origin) return iconUrl;
    if (!contentRoot.startsWith(`${parsed.origin}/`)) return iconUrl;
    if (iconUrl.startsWith(`${contentRoot}/`)) return iconUrl;
    if (extractContentRoot(iconUrl) !== parsed.origin) return iconUrl;
    return `${contentRoot}${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return iconUrl;
  }
}

/**
 * Resolve the icon URL a page load should fetch.
 *
 * `reportedIconUrl` is what Chromium's own `<link rel="icon">` parse produced
 * for the document the webview already has (#75) — in practice always
 * absolute and already resolved against the page origin, which is why it
 * goes through `remapToContentRoot`. A relative one (a direct caller of this
 * module, not the renderer pipeline) is resolved the same way the old
 * in-module parser did: root-relative against the *content root*, anything
 * else against the page URL.
 *
 * With nothing reported, fall back to `<content root>/favicon.ico` — except
 * on content-addressed roots, where the manifest usually has no favicon.ico
 * and probing it just produces a Bee/IPFS gateway error. That guard has to
 * cover the *reported* URL too: Chromium synthesises the implicit
 * /favicon.ico candidate itself and reports it like any other, so a
 * report-only guard would probe every content-addressed page view once and
 * cache whatever a public gateway answers with under the site's own key.
 * An explicit `<link rel="icon" href="/favicon.ico">` on such a page is
 * indistinguishable from the synthesised candidate and is skipped with it —
 * the same trade the pre-#75 fallback made.
 *
 * Returns null when there is nothing fetchable. Never returns the page URL:
 * that is the whole point of #75.
 */
function resolveIconUrl(pageUrl, reportedIconUrl) {
  const contentRoot = extractContentRoot(pageUrl);
  const isContentAddressed = Boolean(contentRoot) && /\/(bzz|ipfs|ipns)\//.test(contentRoot);
  const isContentAddressedProbe = (url) =>
    isContentAddressed && url === `${contentRoot}/favicon.ico`;

  if (reportedIconUrl) {
    // Data URLs carry the icon inline — nothing to fetch.
    if (reportedIconUrl.startsWith('data:')) return reportedIconUrl;

    let resolved;
    if (reportedIconUrl.startsWith('http://') || reportedIconUrl.startsWith('https://')) {
      resolved = remapToContentRoot(reportedIconUrl, contentRoot);
    } else if (reportedIconUrl.startsWith('/') && contentRoot) {
      resolved = `${contentRoot}${reportedIconUrl}`;
    } else {
      try {
        resolved = new URL(reportedIconUrl, pageUrl).toString();
      } catch {
        return null;
      }
    }
    return isContentAddressedProbe(resolved) ? null : resolved;
  }

  if (!contentRoot) return null;
  if (isContentAddressed) return null;
  return `${contentRoot}/favicon.ico`;
}

/**
 * Fetch and cache the favicon for a page load.
 *
 * @param {string} pageUrl - the URL that was loaded (used to resolve a
 *   relative icon URL and to build the /favicon.ico fallback). It is never
 *   itself fetched.
 * @param {string|null} cacheKey - per-domain cache key, e.g. the displayed
 *   `bzz://name.eth` for a gateway-backed page. Defaults to `pageUrl`.
 * @param {string|null} reportedIconUrl - the icon URL the webview reported
 *   via `page-favicon-updated`.
 */
async function fetchFavicon(pageUrl, cacheKey = null, reportedIconUrl = null) {
  // Use cacheKey if provided, otherwise extract domain from pageUrl
  const domain = cacheKey ? extractDomain(cacheKey) : extractDomain(pageUrl);
  if (!domain) return null;

  // Skip non-HTTP(S) page URLs: `net.request` only speaks http(s), and a
  // dweb page's icon lives behind a custom scheme this module cannot dial.
  // Unchanged from before #75.
  if (!pageUrl.startsWith('http://') && !pageUrl.startsWith('https://')) {
    return null;
  }

  try {
    const faviconUrl = resolveIconUrl(pageUrl, reportedIconUrl);
    if (!faviconUrl) return null;

    // If favicon is a data URL, cache and return it directly (no fetch needed)
    if (faviconUrl.startsWith('data:')) {
      // Normalize SVG data URLs to base64 for reliable img src usage
      const normalizedUrl = normalizeDataUrl(faviconUrl);
      const stmt = getStatements().upsert;
      const contentType = normalizedUrl.match(/^data:([^;,]+)/)?.[1] || 'image/x-icon';
      stmt.run(domain, normalizedUrl, contentType, Date.now());
      return normalizedUrl;
    }

    // Anything that is not http(s) by now (a bzz://, ipfs:// or rad: icon on
    // a dweb page) cannot be dialled from here — skip rather than hand a
    // custom scheme to net.request.
    if (!faviconUrl.startsWith('http://') && !faviconUrl.startsWith('https://')) {
      return null;
    }

    // Fetch the actual favicon — the one and only request this module makes.
    const result = await fetchWithTimeout(faviconUrl, 5000);

    // Convert to base64 for storage
    const base64 = result.data.toString('base64');
    const dataUrl = `data:${result.contentType};base64,${base64}`;

    // Cache it using the domain (which may be derived from cacheKey)
    const stmt = getStatements().upsert;
    stmt.run(domain, dataUrl, result.contentType, Date.now());

    log.info('[Favicons] Cached favicon for:', domain);

    return dataUrl;
  } catch (err) {
    log.info('[Favicons] Failed to fetch favicon for:', domain, err.message);
    return null;
  }
}

/**
 * Get cached favicon for a domain
 */
function getCachedFavicon(url) {
  const domain = extractDomain(url);
  if (!domain) return null;

  try {
    const stmt = getStatements().get;
    const result = stmt.get(domain);
    return result ? result.icon_data : null;
  } catch {
    return null;
  }
}

/**
 * Get favicon - returns the cached icon, or fetches one on a cache miss.
 *
 * NOTE (#75): there is no icon *discovery* left in this module, so a cache
 * miss here can only probe `<content root>/favicon.ico` — a site whose icon
 * is declared at any other path resolves to nothing. The declared path is
 * Chromium's parse of the document the webview loaded, which only a caller
 * holding a `page-favicon-updated` report has; such a caller should hand it
 * to `fetchFavicon`/`IPC.FAVICON_FETCH`(`_WITH_KEY`) instead of calling this.
 * Kept as the no-report entry point (exposed as `electronAPI.getFavicon`,
 * currently with no renderer caller) rather than re-downloading the page.
 */
async function getFavicon(url) {
  // Check cache first
  const cached = getCachedFavicon(url);
  if (cached) return cached;

  // Fetch and cache
  return await fetchFavicon(url);
}

/**
 * Register IPC handlers
 */
function registerFaviconsIpc() {
  // PRIVATE MODE GUARD (favicons): private windows never write to the
  // favicon cache. Reads of already-cached icons are fine (they reveal
  // nothing about private browsing); fetch-and-cache is what would leave
  // a trace, so fetching from a private sender degrades to a cache read.
  // The private window's renderer already skips the fetch calls
  // (src/renderer/lib/navigation.js); this is the main-process
  // belt-and-braces.
  const isPrivateSender = (event) => isPrivateWebContents(event?.sender);

  // Get favicon (returns cached, or probes /favicon.ico on a miss — see the
  // note on getFavicon: this entry point does no icon discovery since #75).
  ipcMain.handle(IPC.FAVICON_GET, async (event, url) => {
    if (isPrivateSender(event)) {
      return getCachedFavicon(url);
    }
    return await getFavicon(url);
  });

  // Get cached favicon only (no fetch)
  ipcMain.handle(IPC.FAVICON_GET_CACHED, (_event, url) => {
    return getCachedFavicon(url);
  });

  // Fetch and cache favicon. `iconUrl` is the URL the renderer's webview
  // reported through `page-favicon-updated`; omitted, this degrades to the
  // /favicon.ico fallback. Either way the page itself is never fetched (#75).
  ipcMain.handle(IPC.FAVICON_FETCH, async (event, url, iconUrl = null) => {
    if (isPrivateSender(event)) {
      log.info('[Favicons] Ignoring favicon:fetch from private window');
      return getCachedFavicon(url);
    }
    return await fetchFavicon(url, null, iconUrl);
  });

  // Fetch favicon with custom cache key (for bzz://, ipfs:// URLs)
  ipcMain.handle(IPC.FAVICON_FETCH_WITH_KEY, async (event, fetchUrl, cacheKey, iconUrl = null) => {
    if (isPrivateSender(event)) {
      log.info('[Favicons] Ignoring favicon:fetch-with-key from private window');
      return getCachedFavicon(cacheKey || fetchUrl);
    }
    return await fetchFavicon(fetchUrl, cacheKey, iconUrl);
  });

  log.info('[Favicons] IPC handlers registered');
}

module.exports = {
  migrateFavicons,
  fetchFavicon,
  getCachedFavicon,
  getFavicon,
  registerFaviconsIpc,
  extractDomain,
};
