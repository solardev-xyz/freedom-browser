/**
 * Secure DNS (#472): DNS over HTTPS for the names Chromium's network stack
 * looks up, through `app.configureHostResolver`. That covers pages in every
 * window (private ones too, the resolver is app-wide), internal pages,
 * downloads, favicons, the updater (electron-updater uses Electron's `net`),
 * and what main dials through `ipfs/gateway-transport.js`: an external IPFS
 * gateway, the gateway warm-up and ENS CCIP-Read gateways.
 *
 * Not covered, and listed in docs/features.md:
 * - requests main makes with Node's own stack (`fetch`, `http`, ethers):
 *   Ethereum and Gnosis RPC providers (ENS lookups included), the chain
 *   list, Freedom Agent's providers and the GitHub bridge resolve with the
 *   system's DNS;
 * - the bundled nodes (Swarm, IPFS, Radicle, Myotis), separate processes
 *   with their own resolvers.
 *
 * `.onion` names reach no resolver here: the Tor PAC hands them to Arti's
 * SOCKS5 proxy, which resolves them inside Tor (tor-proxy.js). Loopback
 * names (`localhost`, `*.localhost`) and IP literals are answered locally.
 *
 * The pure half (modes, providers, the custom-address check, the resolver
 * config) is also what settings-store validates a save with. The settings
 * accessors are passed to `initSecureDns` rather than required, so
 * settings-store can require this module without a cycle.
 */

const { app } = require('electron');
const log = require('./logger');

// `secure` is the Settings page's "Strict": DoH only, no fallback.
const SECURE_DNS_MODES = Object.freeze(['automatic', 'secure', 'off']);

// RFC 8484 templates. Cloudflare's and Mullvad's are unfiltered; Quad9's
// standard resolver refuses known malware and phishing domains (its
// unfiltered one is dns10.quad9.net).
const SECURE_DNS_PROVIDERS = Object.freeze({
  quad9: 'https://dns.quad9.net/dns-query',
  cloudflare: 'https://cloudflare-dns.com/dns-query',
  mullvad: 'https://dns.mullvad.net/dns-query',
});

const CUSTOM_PROVIDER = 'custom';

const SECURE_DNS_DEFAULTS = Object.freeze({
  secureDnsMode: 'automatic',
  secureDnsProvider: 'quad9',
  // The address for the `custom` provider; '' until one is entered.
  secureDnsCustomTemplate: '',
});

const SECURE_DNS_KEYS = Object.freeze(Object.keys(SECURE_DNS_DEFAULTS));

const MAX_TEMPLATE_LENGTH = 2048;

const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

/**
 * A custom provider address as Chromium takes it, or null: an https:// URL
 * with a host, no credentials, no fragment, no whitespace, and no URI
 * template variable other than RFC 8484's `{?dns}` (Chromium refuses any
 * other).
 */
function normalizeDohTemplate(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_TEMPLATE_LENGTH || /\s/.test(trimmed)) return null;
  if (/[{}]/.test(trimmed.replace('{?dns}', ''))) return null;
  let url;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || !url.hostname) return null;
  if (url.username || url.password || url.hash) return null;
  return trimmed;
}

/**
 * The value a settings save stores for a Secure DNS key, or undefined to
 * keep the stored one: an unknown mode or provider, an address that isn't a
 * usable https:// one, or a provider of `custom` (or a cleared address)
 * that would leave the custom provider with no address.
 *
 * @param {string} key - one of SECURE_DNS_KEYS
 * @param {*} value - what the save asks for
 * @param {{ previous?: object, incoming?: object }} context - the stored
 *   settings and the whole save, for the provider/address pairing
 */
function secureDnsSaveValue(key, value, { previous = {}, incoming = {} } = {}) {
  if (key === 'secureDnsMode') return SECURE_DNS_MODES.includes(value) ? value : undefined;

  const templateAfter = () =>
    hasOwn(incoming, 'secureDnsCustomTemplate')
      ? normalizeDohTemplate(incoming.secureDnsCustomTemplate)
      : normalizeDohTemplate(previous.secureDnsCustomTemplate);

  if (key === 'secureDnsProvider') {
    if (hasOwn(SECURE_DNS_PROVIDERS, value)) return value;
    if (value === CUSTOM_PROVIDER && templateAfter()) return value;
    return undefined;
  }

  if (key === 'secureDnsCustomTemplate') {
    if (value === '') {
      const providerAfter = hasOwn(incoming, 'secureDnsProvider')
        ? incoming.secureDnsProvider
        : previous.secureDnsProvider;
      return providerAfter === CUSTOM_PROVIDER ? undefined : '';
    }
    return normalizeDohTemplate(value) ?? undefined;
  }

  return undefined;
}

// The DoH server for these settings. A provider id this build doesn't know,
// or a custom provider whose address is unusable (only a hand-edited
// settings.json gets there), falls back to the default provider rather than
// to unencrypted DNS.
function secureDnsServer(settings) {
  const provider = settings?.secureDnsProvider;
  if (provider === CUSTOM_PROVIDER) {
    const custom = normalizeDohTemplate(settings?.secureDnsCustomTemplate);
    if (custom) return custom;
  } else if (hasOwn(SECURE_DNS_PROVIDERS, provider)) {
    return SECURE_DNS_PROVIDERS[provider];
  }
  return SECURE_DNS_PROVIDERS[SECURE_DNS_DEFAULTS.secureDnsProvider];
}

/**
 * The `app.configureHostResolver` options for these settings. `off` passes
 * no servers and turns off Chromium's own upgrade to the system resolver's
 * DoH endpoint too, as Chrome's "Use secure DNS" switch does.
 */
function secureDnsConfig(settings) {
  const mode = SECURE_DNS_MODES.includes(settings?.secureDnsMode)
    ? settings.secureDnsMode
    : SECURE_DNS_DEFAULTS.secureDnsMode;
  if (mode === 'off') return { secureDnsMode: 'off', secureDnsServers: [] };
  return { secureDnsMode: mode, secureDnsServers: [secureDnsServer(settings)] };
}

let appliedConfig = null;
// How many times a config has been handed over, so an E2E spec can wait for
// the hand-over to a replaced network service.
let applyCount = 0;

// The config last handed to Chromium, or null before the first apply (E2E).
function getAppliedSecureDnsConfig() {
  return appliedConfig
    ? { ...appliedConfig, secureDnsServers: [...appliedConfig.secureDnsServers] }
    : null;
}

const getSecureDnsApplyCount = () => applyCount;

function describeConfig(config) {
  const [server] = config.secureDnsServers;
  if (!server) return config.secureDnsMode;
  return `${config.secureDnsMode} via ${new URL(server).host}`;
}

/**
 * Hand these settings to Chromium's resolver; a no-op when they resolve to
 * the config already in place, unless `force`. Must run after `ready`.
 */
function applySecureDns(settings, { force = false } = {}) {
  const config = secureDnsConfig(settings);
  if (!force && appliedConfig && JSON.stringify(appliedConfig) === JSON.stringify(config)) {
    return config;
  }
  try {
    app.configureHostResolver(config);
    appliedConfig = config;
    applyCount += 1;
    log.info(`[secure-dns] ${describeConfig(config)}`);
  } catch (err) {
    log.error('[secure-dns] Could not configure the host resolver:', err);
  }
  return config;
}

const NETWORK_SERVICE = 'network.mojom.NetworkService';

/**
 * Apply the stored settings, then every change to them, and again whenever
 * Chromium replaces its network service. Called from bootstrap before
 * anything goes out over Chromium's network stack.
 *
 * Chromium keeps the resolver config in the network service process. When
 * that process dies, Chromium starts a new one and Electron sets it up with
 * its own defaults (Automatic, no servers), so Strict would quietly become
 * Automatic with the system's DNS. `child-process-gone` arrives before the
 * replacement is set up, and a config handed over right then is overwritten;
 * the next turn of the event loop is the earliest one that sticks (probed on
 * Electron 45.2.1). A lookup made in that one turn still gets Electron's
 * defaults: closing it would need Electron to keep the config across a
 * restart.
 */
function initSecureDns({ loadSettings, onSettingsChanged }) {
  applySecureDns(loadSettings());
  onSettingsChanged((merged, previous) => {
    if (SECURE_DNS_KEYS.some((key) => merged?.[key] !== previous?.[key])) applySecureDns(merged);
  });
  app.on('child-process-gone', (_event, details) => {
    if (details?.type !== 'Utility' || details?.serviceName !== NETWORK_SERVICE) return;
    log.warn(`[secure-dns] Network service gone (${details.reason}); applying Secure DNS again`);
    setImmediate(() => applySecureDns(loadSettings(), { force: true }));
  });
}

module.exports = {
  CUSTOM_PROVIDER,
  SECURE_DNS_DEFAULTS,
  SECURE_DNS_KEYS,
  SECURE_DNS_MODES,
  SECURE_DNS_PROVIDERS,
  applySecureDns,
  getAppliedSecureDnsConfig,
  getSecureDnsApplyCount,
  initSecureDns,
  normalizeDohTemplate,
  secureDnsConfig,
  secureDnsSaveValue,
};
