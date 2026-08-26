/**
 * Serve the wallet bridge page on a local port — for development and
 * the remote-signing E2E test. Static files only.
 *
 * The page lives in its own repo (solardev-xyz/freedom-bridge, deployed
 * independently to Swarm); this expects a sibling checkout, overridable
 * via FREEDOM_BRIDGE_DIR.
 *
 *   node scripts/serve-bridge.js [port]   (default 8797)
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const BRIDGE_DIR =
  process.env.FREEDOM_BRIDGE_DIR || path.join(__dirname, '..', '..', 'freedom-bridge');

/** False when the sibling checkout is missing — callers skip or error. */
function bridgeAvailable() {
  return fs.existsSync(path.join(BRIDGE_DIR, 'index.html'));
}
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
};

function createBridgeServer() {
  if (!bridgeAvailable()) {
    throw new Error(
      `freedom-bridge checkout not found at ${BRIDGE_DIR} — clone ` +
        'github.com/solardev-xyz/freedom-bridge next to this repo, or set FREEDOM_BRIDGE_DIR'
    );
  }
  return http.createServer((req, res) => {
    const urlPath = new URL(req.url, 'http://localhost').pathname;
    const rel = urlPath === '/' ? 'index.html' : urlPath.slice(1);
    const file = path.join(BRIDGE_DIR, rel);
    if (!file.startsWith(BRIDGE_DIR) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
}

module.exports = { createBridgeServer, bridgeAvailable };

if (require.main === module) {
  const port = Number(process.argv[2]) || 8797;
  createBridgeServer().listen(port, '127.0.0.1', () => {
    console.log(`Bridge page at http://127.0.0.1:${port}/`);
  });
}
