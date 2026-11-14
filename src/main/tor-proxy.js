/**
 * Tor proxy wiring for Electron sessions.
 *
 * Scope is `.onion`-only: a PAC script routes `*.onion` hostnames through the
 * local Arti SOCKS5 proxy and returns DIRECT for everything else, so clearnet
 * and the decentralized protocols (bzz/ipfs/ipns/rad) keep connecting directly.
 * `.onion` needs no custom scheme — it is an ordinary http(s) host that just
 * needs proxying, and SOCKS5 does remote DNS so the name resolves at Tor.
 */

const log = require('./logger');

const ONION_PROXY_TEST_URL = 'https://freedom-proxy-check.onion/';

/**
 * Build the PAC script that routes only `*.onion` through the SOCKS5 proxy.
 * Pure function so it can be unit-tested without a live session.
 *
 * @param {string} socksHostPort - e.g. '127.0.0.1:9150'
 * @returns {string} PAC script source
 */
function buildOnionPacScript(socksHostPort) {
  // dnsDomainIs matches both `foo.onion` and `sub.foo.onion`. A fully
  // qualified spelling (`foo.onion.`) is the same host, so its final dot goes
  // first: dnsDomainIs misses it otherwise, and the name would go DIRECT to
  // the system resolver (#1248).
  // SOCKS5 only (no SOCKS4 fallback): SOCKS4 can't do remote DNS, so a
  // fallback would make Chromium resolve the .onion name locally — a DNS leak
  // and a guaranteed failure. Fail closed if the proxy is unreachable.
  return [
    'function FindProxyForURL(url, host) {',
    '  var name = String(host).toLowerCase();',
    '  if (name.charAt(name.length - 1) === ".") name = name.substring(0, name.length - 1);',
    `  if (dnsDomainIs(name, ".onion") || name === "onion") {`,
    `    return "SOCKS5 ${socksHostPort}";`,
    '  }',
    '  return "DIRECT";',
    '}',
  ].join('\n');
}

async function logOnionProxyResolution(targetSession, socksHostPort) {
  if (!targetSession || typeof targetSession.resolveProxy !== 'function') {
    return;
  }

  try {
    const resolvedProxy = await targetSession.resolveProxy(ONION_PROXY_TEST_URL);
    if (String(resolvedProxy).includes(socksHostPort)) {
      log.info(`[tor-proxy] Chromium resolves .onion via ${resolvedProxy}`);
      return;
    }
    log.warn(
      `[tor-proxy] Chromium did not resolve .onion via SOCKS5 ${socksHostPort}: ${resolvedProxy || '(empty)'}`
    );
  } catch (err) {
    log.warn(`[tor-proxy] failed to verify .onion proxy resolution: ${err?.message || err}`);
  }
}

/**
 * Point a session at the Arti SOCKS proxy for `.onion` traffic only.
 *
 * @param {import('electron').Session} targetSession
 * @param {string} socksHostPort - e.g. '127.0.0.1:9150'
 * @returns {Promise<void>}
 */
async function applyOnionProxy(targetSession, socksHostPort) {
  if (!targetSession || typeof targetSession.setProxy !== 'function') {
    log.warn('[tor-proxy] session.setProxy unavailable — skipping proxy apply');
    return;
  }
  const pacScript = buildOnionPacScript(socksHostPort);
  // Inline the PAC via a data: URL so we don't depend on a file on disk.
  const pacUrl = `data:application/x-ns-proxy-autoconfig;base64,${Buffer.from(
    pacScript,
    'utf-8'
  ).toString('base64')}`;
  await targetSession.setProxy({ mode: 'pac_script', pacScript: pacUrl });
  await targetSession.forceReloadProxyConfig?.();
  await targetSession.closeAllConnections?.();
  await logOnionProxyResolution(targetSession, socksHostPort);
  log.info(`[tor-proxy] .onion traffic routed via SOCKS5 ${socksHostPort}`);
}

/**
 * Restore direct connections (no proxy) on a session.
 *
 * @param {import('electron').Session} targetSession
 * @returns {Promise<void>}
 */
async function clearOnionProxy(targetSession) {
  if (!targetSession || typeof targetSession.setProxy !== 'function') {
    return;
  }
  await targetSession.setProxy({ mode: 'direct' });
  await targetSession.forceReloadProxyConfig?.();
  await targetSession.closeAllConnections?.();
  log.info('[tor-proxy] proxy cleared — connections are direct');
}

/**
 * The proxy config for a Tor window's session (#473): every request goes to
 * Arti's SOCKS5 port, with no PAC, no DIRECT and no fallback. SOCKS5 hands
 * the hostname to Tor, so nothing is looked up locally. `<-loopback>` takes
 * back Chromium's implicit loopback bypass: a page in a Tor window can't
 * reach this machine's own services (127.0.0.1, localhost, [::1]) either,
 * as in Tor Browser. When nothing listens on the port the request fails;
 * that is the point (fail closed).
 *
 * @param {string} socksHostPort - e.g. '127.0.0.1:9150'
 */
function buildTorWindowProxyConfig(socksHostPort) {
  return {
    mode: 'fixed_servers',
    proxyRules: `socks5://${socksHostPort}`,
    proxyBypassRules: '<-loopback>',
  };
}

/**
 * Point a Tor window's session at Arti for everything. Existing connections
 * are closed so none made before the apply carries on outside the new route.
 *
 * @param {import('electron').Session} targetSession
 * @param {string} socksHostPort
 */
async function applyTorWindowProxy(targetSession, socksHostPort) {
  if (!targetSession || typeof targetSession.setProxy !== 'function') {
    throw new Error('session.setProxy unavailable');
  }
  await targetSession.setProxy(buildTorWindowProxyConfig(socksHostPort));
  await targetSession.forceReloadProxyConfig?.();
  await targetSession.closeAllConnections?.();
  log.info(`[tor-proxy] Tor window: all traffic via SOCKS5 ${socksHostPort}`);
}

module.exports = {
  buildOnionPacScript,
  applyOnionProxy,
  clearOnionProxy,
  buildTorWindowProxyConfig,
  applyTorWindowProxy,
};
