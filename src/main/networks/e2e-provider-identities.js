// A test-only seam: provider identities the Safe E2E gives its endpoints
// (#1094, #1097 round 1).
//
// Every loopback endpoint is one provider (endpoint-identity.js), so the
// Safe E2E's anvil fork and the forwarder in front of it are one quorum
// member, and a Safe's activation needs a verified read. The E2E fixtures
// set FREEDOM_E2E_PROVIDER_IDENTITIES to a JSON object from URL to label;
// URLs with different labels then count as different providers.
//
// It splits URLs that are one provider, which is exactly what lets one
// node's answer be labelled verified, so it must never reach a shipped
// build. It is honored only when all of these hold, and ignored otherwise:
// - the app isn't packaged (`app.isPackaged === false`): a packaged build
//   never reads the variable, whatever its environment;
// - this file isn't inside an asar archive, which every packaged build
//   ships its source in, so even a packaged binary renamed to `electron`
//   (which makes Electron report it unpackaged) ignores it;
// - the variable is set, to a JSON object of non-empty string labels.

const ENV_VAR = 'FREEDOM_E2E_PROVIDER_IDENTITIES';

// The map's key for `url`: its parsed form, so `http://127.0.0.1:1` and
// `http://127.0.0.1:1/` are one key.
function urlKey(url) {
  try {
    return new URL(url).href;
  } catch {
    return String(url);
  }
}

// Whether `dir` is inside an asar archive, as a packaged build's source is
// (`.../resources/app.asar/src/main/networks`).
function insideAsar(dir) {
  return /\.asar([\\/]|$)/i.test(String(dir));
}

/**
 * The E2E's provider labels by URL key, or null when the seam is off.
 *
 * @param {{isPackaged: unknown, fromAsar: unknown, env: object}} launch
 * @returns {Map<string, string> | null}
 */
function providerIdentityOverrides({ isPackaged, fromAsar, env }) {
  if (isPackaged !== false || fromAsar !== false) return null;
  const raw = env?.[ENV_VAR];
  if (typeof raw !== 'string' || !raw.trim()) return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const overrides = new Map();
  for (const [url, label] of Object.entries(parsed)) {
    if (typeof label === 'string' && label.trim()) overrides.set(urlKey(url), label.trim());
  }
  return overrides.size ? overrides : null;
}

let active;

// This launch's labels, read once. Outside Electron (Jest, plain Node),
// `require('electron')` isn't an app, so the seam stays off.
function activeProviderIdentityOverrides() {
  if (active !== undefined) return active;
  let isPackaged;
  try {
    isPackaged = require('electron').app?.isPackaged;
  } catch {
    isPackaged = undefined;
  }
  active = providerIdentityOverrides({
    isPackaged,
    fromAsar: insideAsar(__dirname),
    env: process.env,
  });
  if (active) {
    require('../logger').warn(
      `[endpoint-identity] ${ENV_VAR} is set: test-only provider identities for ${active.size} URL(s)`
    );
  }
  return active;
}

module.exports = {
  ENV_VAR,
  urlKey,
  insideAsar,
  providerIdentityOverrides,
  activeProviderIdentityOverrides,
};
