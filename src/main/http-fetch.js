const https = require('https');
const http = require('http');
const fs = require('fs');

const DEFAULT_TIMEOUT = 30000;
const MAX_REDIRECTS = 5;

// Dweb schemes served by the custom protocol handlers registered on the
// default session (see registerSchemesAsPrivileged in main/index.js). These
// can't go through Node's http stack — session.fetch dispatches them to the
// same handlers that serve page loads.
const SESSION_FETCH_PREFIXES = ['bzz://', 'ipfs://', 'ipns://'];

function isSessionFetchUrl(url) {
  return SESSION_FETCH_PREFIXES.some((prefix) => url.startsWith(prefix));
}

/**
 * Validate that a URL uses a fetchable scheme (http, https, or a dweb
 * scheme handled by a session protocol handler).
 */
function validateUrl(url) {
  if (!url || typeof url !== 'string') {
    throw new Error('Invalid URL');
  }
  if (!url.startsWith('http://') && !url.startsWith('https://') && !isSessionFetchUrl(url)) {
    throw new Error(`Unsupported URL scheme: ${url.split(':')[0]}`);
  }
}

/**
 * Fetch a dweb URL through the default session's protocol handlers,
 * streaming the body to onChunk. The timeout is an inactivity timeout to
 * match the http(s) paths' protocol.get semantics: it resets on every
 * chunk, so a slow-but-steady transfer is not cut off mid-download.
 */
async function sessionFetchStream(url, onChunk, { timeout = DEFAULT_TIMEOUT } = {}) {
  // Lazy require so the plain http/https paths stay usable in tests that
  // don't mock the electron module.
  const { session } = require('electron');
  const controller = new AbortController();
  let timer = setTimeout(() => controller.abort(), timeout);
  const touch = () => {
    clearTimeout(timer);
    timer = setTimeout(() => controller.abort(), timeout);
  };
  try {
    const response = await session.defaultSession.fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`Failed to download: HTTP ${response.status}`);
    }
    // Headers arriving is activity too — don't let a slow time-to-headers
    // eat into the first chunk's window.
    touch();
    if (response.body) {
      const reader = response.body.getReader();
      // A protocol handler may return a Response whose body stream is not
      // wired to the fetch signal — cancel the reader on abort so a stalled
      // stream can't hang past the timeout.
      const onAbort = () => reader.cancel().catch(() => {});
      controller.signal.addEventListener('abort', onAbort);
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (controller.signal.aborted) {
            throw new Error('Request timed out');
          }
          if (done) break;
          touch();
          await onChunk(Buffer.from(value));
        }
      } finally {
        controller.signal.removeEventListener('abort', onAbort);
      }
    }
  } catch (err) {
    if (err?.name === 'AbortError') {
      throw new Error('Request timed out', { cause: err });
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch a dweb URL through the default session's protocol handlers and
 * return the body as a Buffer.
 */
async function sessionFetchBuffer(url, opts) {
  const chunks = [];
  await sessionFetchStream(url, (chunk) => chunks.push(chunk), opts);
  return Buffer.concat(chunks);
}

/**
 * Fetch a dweb URL and stream the body to a file. The file is only created
 * once the first chunk arrives (never on a failed response) and partial
 * files are removed on error.
 */
async function sessionFetchToFile(url, destPath, opts) {
  let handle = null;
  try {
    await sessionFetchStream(
      url,
      async (chunk) => {
        if (!handle) {
          handle = await fs.promises.open(destPath, 'w');
        }
        await handle.write(chunk);
      },
      opts
    );
    if (handle) {
      await handle.close();
      handle = null;
    } else {
      // Empty body still produces an (empty) file, like the http path.
      await fs.promises.writeFile(destPath, Buffer.alloc(0));
    }
  } catch (err) {
    if (handle) {
      await handle.close().catch(() => {});
      await fs.promises.unlink(destPath).catch(() => {});
    }
    throw err;
  }
}

/**
 * Fetch a URL and return the response body as a Buffer.
 * Follows redirects (up to MAX_REDIRECTS) and enforces a timeout.
 */
async function fetchBuffer(url, { timeout = DEFAULT_TIMEOUT, _redirectCount = 0 } = {}) {
  validateUrl(url);

  if (isSessionFetchUrl(url)) {
    return sessionFetchBuffer(url, { timeout });
  }

  if (_redirectCount > MAX_REDIRECTS) {
    return Promise.reject(new Error(`Too many redirects (max ${MAX_REDIRECTS})`));
  }

  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;

    const request = protocol.get(url, { timeout }, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        fetchBuffer(response.headers.location, { timeout, _redirectCount: _redirectCount + 1 })
          .then(resolve)
          .catch(reject);
        return;
      }

      if (response.statusCode !== 200) {
        reject(new Error(`Failed to download: HTTP ${response.statusCode}`));
        return;
      }

      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve(Buffer.concat(chunks)));
      response.on('error', reject);
    });

    request.on('error', reject);
    request.on('timeout', () => {
      request.destroy();
      reject(new Error('Request timed out'));
    });
  });
}

/**
 * Fetch a URL and write the response body directly to a file.
 * Follows redirects (up to MAX_REDIRECTS) and enforces a timeout.
 * Cleans up partial files on error.
 */
async function fetchToFile(url, destPath, { timeout = DEFAULT_TIMEOUT, _redirectCount = 0 } = {}) {
  validateUrl(url);

  if (isSessionFetchUrl(url)) {
    return sessionFetchToFile(url, destPath, { timeout });
  }

  if (_redirectCount > MAX_REDIRECTS) {
    return Promise.reject(new Error(`Too many redirects (max ${MAX_REDIRECTS})`));
  }

  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;

    const request = protocol.get(url, { timeout }, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        fetchToFile(response.headers.location, destPath, {
          timeout,
          _redirectCount: _redirectCount + 1,
        })
          .then(resolve)
          .catch(reject);
        return;
      }

      if (response.statusCode !== 200) {
        reject(new Error(`Failed to download: HTTP ${response.statusCode}`));
        return;
      }

      const fileStream = fs.createWriteStream(destPath);
      response.pipe(fileStream);

      fileStream.on('finish', () => {
        fileStream.close();
        resolve();
      });

      fileStream.on('error', (err) => {
        fs.unlink(destPath, () => {});
        reject(err);
      });
    });

    request.on('error', reject);
    request.on('timeout', () => {
      request.destroy();
      reject(new Error('Request timed out'));
    });
  });
}

module.exports = {
  fetchBuffer,
  fetchToFile,
};
