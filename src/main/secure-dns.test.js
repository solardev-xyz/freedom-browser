const { createAppMock, loadMainModule } = require('../../test/helpers/main-process-test-utils');

function loadSecureDns({ configureHostResolver = jest.fn() } = {}) {
  const app = { ...createAppMock(), configureHostResolver };
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const { mod } = loadMainModule(require.resolve('./secure-dns'), {
    app,
    extraMocks: { [require.resolve('./logger')]: () => logger },
  });
  return { mod, app, configureHostResolver, logger };
}

const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

const QUAD9 = 'https://dns.quad9.net/dns-query';
const CUSTOM = 'https://doh.example.org/dns-query';

describe('secure DNS (#472)', () => {
  describe('normalizeDohTemplate', () => {
    const { mod } = loadSecureDns();

    test.each([
      [CUSTOM, CUSTOM],
      ['  https://doh.example.org/dns-query  ', CUSTOM],
      ['https://doh.example.org/dns-query{?dns}', 'https://doh.example.org/dns-query{?dns}'],
      ['https://192.168.1.2:8443/dns-query', 'https://192.168.1.2:8443/dns-query'],
      ['https://[2620:fe::fe]/dns-query', 'https://[2620:fe::fe]/dns-query'],
    ])('accepts %j', (input, expected) => {
      expect(mod.normalizeDohTemplate(input)).toBe(expected);
    });

    test.each([
      ['http://doh.example.org/dns-query', 'not https'],
      ['doh.example.org/dns-query', 'no scheme'],
      ['https://', 'no host'],
      ['https://user:pass@doh.example.org/dns-query', 'credentials'],
      ['https://doh.example.org/dns-query#x', 'a fragment'],
      ['https://doh.example.org/dns query', 'whitespace'],
      ['https://doh.example.org/{name}', 'another template variable'],
      ['https://doh.example.org/dns-query{?dns', 'an unbalanced brace'],
      [`https://doh.example.org/${'a'.repeat(2048)}`, 'too long'],
      ['', 'empty'],
      [null, 'not a string'],
      [42, 'not a string'],
    ])('refuses %j (%s)', (input) => {
      expect(mod.normalizeDohTemplate(input)).toBeNull();
    });
  });

  describe('secureDnsConfig', () => {
    const { mod } = loadSecureDns();

    test('the defaults are Automatic with Quad9', () => {
      expect(mod.secureDnsConfig(mod.SECURE_DNS_DEFAULTS)).toEqual({
        secureDnsMode: 'automatic',
        secureDnsServers: [QUAD9],
      });
    });

    test.each([
      ['cloudflare', 'https://cloudflare-dns.com/dns-query'],
      ['mullvad', 'https://dns.mullvad.net/dns-query'],
      ['quad9', QUAD9],
    ])('Strict with %s', (provider, server) => {
      expect(mod.secureDnsConfig({ secureDnsMode: 'secure', secureDnsProvider: provider })).toEqual(
        { secureDnsMode: 'secure', secureDnsServers: [server] }
      );
    });

    test('a custom provider uses its address', () => {
      expect(
        mod.secureDnsConfig({
          secureDnsMode: 'automatic',
          secureDnsProvider: 'custom',
          secureDnsCustomTemplate: CUSTOM,
        })
      ).toEqual({ secureDnsMode: 'automatic', secureDnsServers: [CUSTOM] });
    });

    test('Off passes no servers', () => {
      expect(
        mod.secureDnsConfig({ secureDnsMode: 'off', secureDnsProvider: 'cloudflare' })
      ).toEqual({
        secureDnsMode: 'off',
        secureDnsServers: [],
      });
    });

    // Only a hand-edited settings.json gets here; it must not end up on
    // unencrypted DNS, nor hand Chromium a server it would refuse.
    test.each([
      [{ secureDnsMode: 'nonsense' }, { secureDnsMode: 'automatic', secureDnsServers: [QUAD9] }],
      [
        { secureDnsMode: 'secure', secureDnsProvider: 'nonsense' },
        { secureDnsMode: 'secure', secureDnsServers: [QUAD9] },
      ],
      [
        {
          secureDnsMode: 'secure',
          secureDnsProvider: 'custom',
          secureDnsCustomTemplate: 'http://plain.example/dns-query',
        },
        { secureDnsMode: 'secure', secureDnsServers: [QUAD9] },
      ],
      [{}, { secureDnsMode: 'automatic', secureDnsServers: [QUAD9] }],
      [null, { secureDnsMode: 'automatic', secureDnsServers: [QUAD9] }],
    ])('unusable stored values fall back to the defaults: %j', (settings, expected) => {
      expect(mod.secureDnsConfig(settings)).toEqual(expected);
    });
  });

  describe('secureDnsSaveValue', () => {
    const { mod } = loadSecureDns();
    const value = (key, v, previous = mod.SECURE_DNS_DEFAULTS, incoming = { [key]: v }) =>
      mod.secureDnsSaveValue(key, v, { previous, incoming });

    test('modes: the three known ones', () => {
      expect(value('secureDnsMode', 'secure')).toBe('secure');
      expect(value('secureDnsMode', 'off')).toBe('off');
      expect(value('secureDnsMode', 'automatic')).toBe('automatic');
      expect(value('secureDnsMode', 'strict')).toBeUndefined();
      expect(value('secureDnsMode', true)).toBeUndefined();
    });

    test('providers: the known ones, and custom only with a usable address', () => {
      expect(value('secureDnsProvider', 'mullvad')).toBe('mullvad');
      expect(value('secureDnsProvider', 'google')).toBeUndefined();
      // No address stored and none in the save.
      expect(value('secureDnsProvider', 'custom')).toBeUndefined();
      // The address comes with the save.
      expect(
        value('secureDnsProvider', 'custom', mod.SECURE_DNS_DEFAULTS, {
          secureDnsProvider: 'custom',
          secureDnsCustomTemplate: CUSTOM,
        })
      ).toBe('custom');
      // ...but not an unusable one, even with a usable one stored.
      expect(
        value(
          'secureDnsProvider',
          'custom',
          { ...mod.SECURE_DNS_DEFAULTS, secureDnsCustomTemplate: CUSTOM },
          { secureDnsProvider: 'custom', secureDnsCustomTemplate: 'http://x.example/' }
        )
      ).toBeUndefined();
      // A stored address is enough on its own.
      expect(
        value('secureDnsProvider', 'custom', {
          ...mod.SECURE_DNS_DEFAULTS,
          secureDnsCustomTemplate: CUSTOM,
        })
      ).toBe('custom');
    });

    test('the custom address: usable ones trimmed, and cleared only while not in use', () => {
      expect(value('secureDnsCustomTemplate', ` ${CUSTOM} `)).toBe(CUSTOM);
      expect(value('secureDnsCustomTemplate', 'http://x.example/')).toBeUndefined();
      expect(value('secureDnsCustomTemplate', '')).toBe('');
      const usingCustom = {
        ...mod.SECURE_DNS_DEFAULTS,
        secureDnsProvider: 'custom',
        secureDnsCustomTemplate: CUSTOM,
      };
      expect(value('secureDnsCustomTemplate', '', usingCustom)).toBeUndefined();
      // Cleared in the same save that leaves the custom provider.
      expect(
        value('secureDnsCustomTemplate', '', usingCustom, {
          secureDnsProvider: 'quad9',
          secureDnsCustomTemplate: '',
        })
      ).toBe('');
    });

    test('keys it does not own are left alone', () => {
      expect(value('theme', 'dark')).toBeUndefined();
    });
  });

  describe('applying it', () => {
    test('hands the config to Chromium once per change and logs only the host', () => {
      const { mod, configureHostResolver, logger } = loadSecureDns();
      mod.applySecureDns({ secureDnsMode: 'secure', secureDnsProvider: 'quad9' });
      mod.applySecureDns({ secureDnsMode: 'secure', secureDnsProvider: 'quad9' });
      expect(configureHostResolver).toHaveBeenCalledTimes(1);
      expect(configureHostResolver).toHaveBeenCalledWith({
        secureDnsMode: 'secure',
        secureDnsServers: [QUAD9],
      });
      expect(logger.info).toHaveBeenCalledWith('[secure-dns] secure via dns.quad9.net');
      expect(mod.getAppliedSecureDnsConfig()).toEqual({
        secureDnsMode: 'secure',
        secureDnsServers: [QUAD9],
      });

      mod.applySecureDns({ secureDnsMode: 'off' });
      expect(configureHostResolver).toHaveBeenLastCalledWith({
        secureDnsMode: 'off',
        secureDnsServers: [],
      });
      expect(logger.info).toHaveBeenLastCalledWith('[secure-dns] off');
    });

    test('a refused config is logged and leaves the last applied one recorded', () => {
      const configureHostResolver = jest.fn(() => {
        throw new TypeError('bad template');
      });
      const { mod, logger } = loadSecureDns({ configureHostResolver });
      expect(() => mod.applySecureDns(mod.SECURE_DNS_DEFAULTS)).not.toThrow();
      expect(logger.error).toHaveBeenCalled();
      expect(mod.getAppliedSecureDnsConfig()).toBeNull();
    });

    test('initSecureDns applies the stored settings, then each Secure DNS change', () => {
      const { mod, configureHostResolver } = loadSecureDns();
      let listener;
      const stored = { ...mod.SECURE_DNS_DEFAULTS, theme: 'system' };
      mod.initSecureDns({
        loadSettings: () => stored,
        onSettingsChanged: (fn) => {
          listener = fn;
        },
      });
      expect(configureHostResolver).toHaveBeenCalledTimes(1);
      expect(configureHostResolver).toHaveBeenLastCalledWith({
        secureDnsMode: 'automatic',
        secureDnsServers: [QUAD9],
      });

      // Another setting changing doesn't touch the resolver.
      listener({ ...stored, theme: 'dark' }, stored);
      expect(configureHostResolver).toHaveBeenCalledTimes(1);

      const next = { ...stored, secureDnsProvider: 'mullvad' };
      listener(next, stored);
      expect(configureHostResolver).toHaveBeenCalledTimes(2);
      expect(configureHostResolver).toHaveBeenLastCalledWith({
        secureDnsMode: 'automatic',
        secureDnsServers: ['https://dns.mullvad.net/dns-query'],
      });
    });

    // A new network service starts on Electron's defaults; the unchanged
    // config is handed over again, on the next turn (a call made during the
    // event itself is overwritten).
    test('a replaced network service gets the config again, on the next turn', async () => {
      const { mod, app, configureHostResolver, logger } = loadSecureDns();
      let stored = { ...mod.SECURE_DNS_DEFAULTS, secureDnsMode: 'secure' };
      mod.initSecureDns({ loadSettings: () => stored, onSettingsChanged: () => {} });
      expect(configureHostResolver).toHaveBeenCalledTimes(1);

      // Another utility process going away is not the resolver's business.
      app.emit(
        'child-process-gone',
        {},
        { type: 'Utility', serviceName: 'audio.mojom.AudioService', reason: 'crashed' }
      );
      app.emit('child-process-gone', {}, { type: 'GPU', reason: 'crashed' });
      await nextTurn();
      expect(configureHostResolver).toHaveBeenCalledTimes(1);

      // The settings as they are when it happens, not as they were at start.
      stored = { ...stored, secureDnsProvider: 'mullvad' };
      app.emit(
        'child-process-gone',
        {},
        { type: 'Utility', serviceName: 'network.mojom.NetworkService', reason: 'crashed' }
      );
      expect(configureHostResolver).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenCalledWith(
        '[secure-dns] Network service gone (crashed); applying Secure DNS again'
      );
      await nextTurn();
      expect(configureHostResolver).toHaveBeenCalledTimes(2);
      expect(configureHostResolver).toHaveBeenLastCalledWith({
        secureDnsMode: 'secure',
        secureDnsServers: ['https://dns.mullvad.net/dns-query'],
      });

      // Unchanged settings are handed over again too: the new service has none.
      app.emit(
        'child-process-gone',
        {},
        { type: 'Utility', serviceName: 'network.mojom.NetworkService', reason: 'killed' }
      );
      await nextTurn();
      expect(configureHostResolver).toHaveBeenCalledTimes(3);
    });
  });
});
