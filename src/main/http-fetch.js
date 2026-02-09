const https = require('https');
const http = require('http');
const fs = require('fs');

const DEFAULT_TIMEOUT = 30000;
const MAX_REDIRECTS = 5;

/**
 * Validate that a URL is safe to fetch (http or https only).
 */
function validateUrl(url) {
  if (!url || typeof url !== 'string') {
    throw new Error('Invalid URL');
  }
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    throw new Error(`Unsupported URL scheme: ${url.split(':')[0]}`);
  }
}

/**
 * Fetch a URL and return the response body as a Buffer.
 * Follows redirects (up to MAX_REDIRECTS) and enforces a timeout.
 */
function fetchBuffer(url, { timeout = DEFAULT_TIMEOUT, _redirectCount = 0 } = {}) {
  validateUrl(url);

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
function fetchToFile(url, destPath, { timeout = DEFAULT_TIMEOUT, _redirectCount = 0 } = {}) {
  validateUrl(url);

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
