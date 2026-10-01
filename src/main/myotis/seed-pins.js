// Untrusted discovery hints only. Checkpoint and read verification are unchanged.
const MAX_PINS = 64;
const DEFAULT_LIMIT = 20;
const MAX_RESOURCE_BYTES = 128 * 1024;

function parse(json) {
  if (typeof json !== 'string' || json.length > MAX_RESOURCE_BYTES) return [];
  let values;
  try {
    values = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(values)) return [];
  const pins = [];
  const addresses = new Set();
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const match = /^enode:\/\/([0-9a-f]{128})@((?:\d{1,3}\.){3}\d{1,3}):(\d{1,5})$/.exec(value);
    if (!match) continue;
    const [, key, ip, rawPort] = match;
    // Rust's numeric-address parser rejects ambiguous leading-zero octets.
    if (!ip.split('.').every((octet) => Number(octet) <= 255 && String(Number(octet)) === octet))
      continue;
    const port = Number(rawPort);
    if (port < 1 || port > 65535) continue;
    const address = `${ip}:${port}`;
    if (addresses.has(address)) continue;
    addresses.add(address);
    pins.push(`enode://${key}@${address}`);
    if (pins.length === MAX_PINS) break;
  }
  return pins;
}

function select(list, limit = DEFAULT_LIMIT, rng = Math.random) {
  if (!Number.isInteger(limit) || limit <= 0) return [];
  const shuffled = parse(JSON.stringify(list));
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled.slice(0, Math.min(limit, DEFAULT_LIMIT));
}

function load(network, { env = process.env, readFile = require('node:fs').readFileSync } = {}) {
  if (!['mainnet', 'gnosis'].includes(network)) return [];
  const override = env[`FREEDOM_MYOTIS_BOOT_ENODES_${network.toUpperCase()}`];
  // Explicit empty/invalid overrides never silently fall back to the bundle.
  if (override !== undefined) return parse(override);
  try {
    return parse(
      readFile(require('node:path').join(__dirname, 'seeds', `${network}.json`), 'utf8')
    );
  } catch {
    return [];
  }
}

module.exports = { parse, select, load, MAX_PINS, DEFAULT_LIMIT };
