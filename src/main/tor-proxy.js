/**
 * Scoped proxy wiring for Electron sessions.
 *
 * Electron allows only one proxy configuration per session. Tor and TON must
 * therefore share one PAC script; setting either integration independently
 * would otherwise silently disable the other one. Route state is kept per
 * session so normal and private windows receive the same composed policy.
 */

const log = require('./logger');
const { buildTonHostCondition } = require('./ton-pac');

const ONION_PROXY_TEST_URL = 'https://freedom-proxy-check.onion/';
const TON_PROXY_TEST_URL = 'http://freedom-proxy-check.ton/';
const routeStateBySession = new WeakMap();
const applyQueueBySession = new WeakMap();

function routeState(targetSession) {
  let state = routeStateBySession.get(targetSession);
  if (!state) {
    state = { socksHostPort: null, tonProxyHostPort: null };
    routeStateBySession.set(targetSession, state);
  }
  return state;
}

function buildScopedPacScript({ socksHostPort = null, tonProxyHostPort = null } = {}) {
  const lines = [
    'function FindProxyForURL(url, host) {',
    '  var lower = host.toLowerCase();',
    '  if (lower.charAt(lower.length - 1) === ".") lower = lower.slice(0, -1);',
  ];

  if (tonProxyHostPort) {
    lines.push(
      `  if (${buildTonHostCondition()}) {`,
      `    return ${JSON.stringify(`PROXY ${tonProxyHostPort}`)};`,
      '  }'
    );
  }

  if (socksHostPort) {
    lines.push(
      '  if (dnsDomainIs(lower, ".onion") || lower === "onion") {',
      `    return ${JSON.stringify(`SOCKS5 ${socksHostPort}`)};`,
      '  }'
    );
  }

  lines.push('  return "DIRECT";', '}');
  return lines.join('\n');
}

/**
 * Build the PAC script that routes only `*.onion` through the SOCKS5 proxy.
 * Pure function so it can be unit-tested without a live session.
 *
 * @param {string} socksHostPort - e.g. '127.0.0.1:9150'
 * @returns {string} PAC script source
 */
function buildOnionPacScript(socksHostPort) {
  return buildScopedPacScript({ socksHostPort });
}

function pacDataUrl(source) {
  return `data:application/x-ns-proxy-autoconfig;base64,${Buffer.from(source, 'utf-8').toString(
    'base64'
  )}`;
}

async function applyCurrentRouteState(targetSession) {
  const state = routeState(targetSession);
  if (!state.socksHostPort && !state.tonProxyHostPort) {
    await targetSession.setProxy({ mode: 'direct' });
  } else {
    await targetSession.setProxy({
      mode: 'pac_script',
      pacScript: pacDataUrl(buildScopedPacScript(state)),
    });
  }
  await targetSession.forceReloadProxyConfig?.();
  await targetSession.closeAllConnections?.();
}

function updateSessionRoutes(targetSession, updates, unavailableMessage) {
  if (!targetSession || typeof targetSession.setProxy !== 'function') {
    if (unavailableMessage) log.warn(unavailableMessage);
    return Promise.resolve();
  }

  Object.assign(routeState(targetSession), updates);
  const previous = applyQueueBySession.get(targetSession) || Promise.resolve();
  const next = previous.catch(() => {}).then(() => applyCurrentRouteState(targetSession));
  applyQueueBySession.set(targetSession, next);
  return next;
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
  await updateSessionRoutes(
    targetSession,
    { socksHostPort },
    '[tor-proxy] session.setProxy unavailable — skipping proxy apply'
  );
  if (!targetSession || typeof targetSession.setProxy !== 'function') return;
  await logOnionProxyResolution(targetSession, socksHostPort);
  log.info(`[tor-proxy] .onion traffic routed via SOCKS5 ${socksHostPort}`);
}

/**
 * Remove the `.onion` route while preserving any active TON route.
 *
 * @param {import('electron').Session} targetSession
 * @returns {Promise<void>}
 */
async function clearOnionProxy(targetSession) {
  await updateSessionRoutes(targetSession, { socksHostPort: null });
  if (!targetSession || typeof targetSession.setProxy !== 'function') return;
  const state = routeState(targetSession);
  log.info(
    state.tonProxyHostPort
      ? '[tor-proxy] .onion route cleared; TON route remains active'
      : '[tor-proxy] proxy cleared — connections are direct'
  );
}

async function logTonProxyResolution(targetSession, proxyHostPort) {
  if (!targetSession || typeof targetSession.resolveProxy !== 'function') return;
  try {
    const resolvedProxy = await targetSession.resolveProxy(TON_PROXY_TEST_URL);
    if (String(resolvedProxy).includes(proxyHostPort)) {
      log.info(`[ton-proxy] Chromium resolves TON Sites via ${resolvedProxy}`);
      return;
    }
    log.warn(
      `[ton-proxy] Chromium did not resolve TON Sites via PROXY ${proxyHostPort}: ${resolvedProxy || '(empty)'}`
    );
  } catch (err) {
    log.warn(`[ton-proxy] failed to verify TON proxy resolution: ${err?.message || err}`);
  }
}

async function applyTonProxy(targetSession, proxyHostPort) {
  await updateSessionRoutes(
    targetSession,
    { tonProxyHostPort: proxyHostPort },
    '[ton-proxy] session.setProxy unavailable — skipping proxy apply'
  );
  if (!targetSession || typeof targetSession.setProxy !== 'function') return;
  await logTonProxyResolution(targetSession, proxyHostPort);
  log.info(`[ton-proxy] TON Sites traffic routed via HTTP proxy ${proxyHostPort}`);
}

async function clearTonProxy(targetSession) {
  await updateSessionRoutes(targetSession, { tonProxyHostPort: null });
  if (!targetSession || typeof targetSession.setProxy !== 'function') return;
  const state = routeState(targetSession);
  log.info(
    state.socksHostPort
      ? '[ton-proxy] TON route cleared; .onion route remains active'
      : '[ton-proxy] proxy cleared — connections are direct'
  );
}

module.exports = {
  buildScopedPacScript,
  buildOnionPacScript,
  applyOnionProxy,
  clearOnionProxy,
  applyTonProxy,
  clearTonProxy,
};
