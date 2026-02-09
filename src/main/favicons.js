/**
 * Favicon fetching and caching module
 *
 * Fetches favicons from websites and caches them in SQLite.
 * Falls back to /favicon.ico if no <link rel="icon"> is found.
 */

const log = require('./logger');
const { ipcMain, net } = require('electron');
const { getDb } = require('./history');
const IPC = require('../shared/ipc-channels');

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
 * Decode HTML entities in a string
 */
function decodeHtmlEntities(str) {
  return str
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#(\d+);/g, (_, num) => String.fromCharCode(num))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
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
 * Parse HTML to find favicon link
 */
function parseFaviconFromHtml(html, pageUrl) {
  // Look for <link rel="icon" or <link rel="shortcut icon"
  // Use separate patterns for double and single quoted href values
  // to avoid stopping at quotes inside data URLs
  const patterns = [
    /<link[^>]*rel=["'](?:shortcut )?icon["'][^>]*href="([^"]+)"/i,
    /<link[^>]*rel=["'](?:shortcut )?icon["'][^>]*href='([^']+)'/i,
    /<link[^>]*href="([^"]+)"[^>]*rel=["'](?:shortcut )?icon["']/i,
    /<link[^>]*href='([^']+)'[^>]*rel=["'](?:shortcut )?icon["']/i,
    /<link[^>]*rel=["']apple-touch-icon["'][^>]*href="([^"]+)"/i,
    /<link[^>]*rel=["']apple-touch-icon["'][^>]*href='([^']+)'/i,
  ];

  // Get content root for IPFS/Swarm URLs
  const contentRoot = extractContentRoot(pageUrl);

  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match && match[1]) {
      let iconUrl = decodeHtmlEntities(match[1]);

      // Data URLs can be used directly
      if (iconUrl.startsWith('data:')) {
        return iconUrl;
      }

      // Absolute URLs can be used directly
      if (iconUrl.startsWith('http://') || iconUrl.startsWith('https://')) {
        return iconUrl;
      }

      // Resolve relative URLs
      try {
        if (iconUrl.startsWith('/') && contentRoot) {
          // Absolute path - resolve relative to content root (not gateway root)
          iconUrl = contentRoot + iconUrl;
        } else {
          // Relative path - resolve relative to page URL
          iconUrl = new URL(iconUrl, pageUrl).toString();
        }
        return iconUrl;
      } catch {
        continue;
      }
    }
  }

  return null;
}

/**
 * Fetch favicon for a URL
 */
async function fetchFavicon(pageUrl, cacheKey = null) {
  // Use cacheKey if provided, otherwise extract domain from pageUrl
  const domain = cacheKey ? extractDomain(cacheKey) : extractDomain(pageUrl);
  if (!domain) return null;

  // Skip non-HTTP(S) URLs for fetching
  if (!pageUrl.startsWith('http://') && !pageUrl.startsWith('https://')) {
    return null;
  }

  try {
    // First, try to get the page and parse for favicon link
    const contentRoot = extractContentRoot(pageUrl);

    let faviconUrl = null;

    try {
      const pageResponse = await fetchWithTimeout(pageUrl, 3000);
      const html = pageResponse.data.toString('utf8').slice(0, 50000); // Only check first 50KB
      faviconUrl = parseFaviconFromHtml(html, pageUrl);
    } catch {
      // Page fetch failed, will try /favicon.ico
    }

    // If favicon is a data URL, cache and return it directly (no fetch needed)
    if (faviconUrl && faviconUrl.startsWith('data:')) {
      // Normalize SVG data URLs to base64 for reliable img src usage
      const normalizedUrl = normalizeDataUrl(faviconUrl);
      const stmt = getStatements().upsert;
      const contentType = normalizedUrl.match(/^data:([^;,]+)/)?.[1] || 'image/x-icon';
      stmt.run(domain, normalizedUrl, contentType, Date.now());
      return normalizedUrl;
    }

    // Fall back to /favicon.ico at content root (skip for content-addressed URLs
    // where the manifest likely doesn't have favicon.ico, avoiding Bee/IPFS gateway errors)
    if (!faviconUrl) {
      const isContentAddressed = contentRoot && /\/(bzz|ipfs|ipns)\//.test(contentRoot);
      if (isContentAddressed) {
        return null;
      }
      faviconUrl = `${contentRoot}/favicon.ico`;
    }

    // Fetch the actual favicon
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
 * Get favicon - returns cached or fetches new
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
  // Get favicon (returns cached or fetches)
  ipcMain.handle(IPC.FAVICON_GET, async (_event, url) => {
    return await getFavicon(url);
  });

  // Get cached favicon only (no fetch)
  ipcMain.handle(IPC.FAVICON_GET_CACHED, (_event, url) => {
    return getCachedFavicon(url);
  });

  // Fetch and cache favicon (called after page load)
  ipcMain.handle(IPC.FAVICON_FETCH, async (_event, url) => {
    return await fetchFavicon(url);
  });

  // Fetch favicon with custom cache key (for bzz://, ipfs:// URLs)
  ipcMain.handle(IPC.FAVICON_FETCH_WITH_KEY, async (_event, fetchUrl, cacheKey) => {
    return await fetchFavicon(fetchUrl, cacheKey);
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
