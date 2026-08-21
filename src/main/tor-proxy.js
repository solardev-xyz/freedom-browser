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
  // dnsDomainIs matches both `foo.onion` and `sub.foo.onion`.
  // SOCKS5 only (no SOCKS4 fallback): SOCKS4 can't do remote DNS, so a
  // fallback would make Chromium resolve the .onion name locally — a DNS leak
  // and a guaranteed failure. Fail closed if the proxy is unreachable.
  return [
    'function FindProxyForURL(url, host) {',
    `  if (dnsDomainIs(host, ".onion") || host === "onion") {`,
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

module.exports = {
  buildOnionPacScript,
  applyOnionProxy,
  clearOnionProxy,
};
