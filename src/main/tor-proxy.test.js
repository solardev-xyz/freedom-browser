jest.mock('./logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const log = require('./logger');
const {
  buildScopedPacScript,
  buildOnionPacScript,
  applyOnionProxy,
  clearOnionProxy,
  applyTonProxy,
  clearTonProxy,
} = require('./tor-proxy');

// Compile the PAC text into a callable FindProxyForURL, supplying the
// `dnsDomainIs` built-in that Chromium provides to PAC scripts (it isn't a
// plain-JS global). Standard semantics: host ends with the given domain.
function compilePac(pac) {
  return new Function('dnsDomainIs', `${pac}; return FindProxyForURL;`)((host, domain) =>
    String(host).toLowerCase().endsWith(String(domain).toLowerCase())
  );
}

describe('buildOnionPacScript', () => {
  const pac = buildOnionPacScript('127.0.0.1:9150');

  test('is a syntactically valid PAC FindProxyForURL function', () => {
    expect(pac).toContain('function FindProxyForURL(url, host)');
    expect(() => compilePac(pac)).not.toThrow();
  });

  test('routes .onion (and subdomains) through the SOCKS5 proxy', () => {
    const find = compilePac(pac);
    expect(find('http://abc.onion/', 'abc.onion')).toContain('SOCKS5 127.0.0.1:9150');
    expect(find('http://sub.abc.onion/', 'sub.abc.onion')).toContain('SOCKS5 127.0.0.1:9150');
  });

  test('returns DIRECT for clearnet hosts', () => {
    const find = compilePac(pac);
    expect(find('https://example.com/', 'example.com')).toBe('DIRECT');
    expect(find('https://onion.example.com/', 'onion.example.com')).toBe('DIRECT');
  });

  test('embeds the provided host:port', () => {
    const custom = buildOnionPacScript('127.0.0.1:9999');
    expect(custom).toContain('127.0.0.1:9999');
  });
});

describe('buildScopedPacScript', () => {
  test('composes TON and Tor without routing clearnet through either proxy', () => {
    const find = compilePac(
      buildScopedPacScript({
        socksHostPort: '127.0.0.1:9150',
        tonProxyHostPort: '127.0.0.1:18085',
      })
    );

    expect(find('http://foundation.ton/', 'foundation.ton')).toBe('PROXY 127.0.0.1:18085');
    expect(find('http://foundation.ton./', 'foundation.ton.')).toBe('PROXY 127.0.0.1:18085');
    expect(find('http://site.adnl/', 'site.adnl')).toBe('PROXY 127.0.0.1:18085');
    expect(find('http://archive.bag/', 'archive.bag')).toBe('PROXY 127.0.0.1:18085');
    expect(find('http://name.t.me/', 'name.t.me')).toBe('PROXY 127.0.0.1:18085');
    expect(find('http://hidden.onion/', 'hidden.onion')).toBe('SOCKS5 127.0.0.1:9150');
    expect(find('https://example.com/', 'example.com')).toBe('DIRECT');
    expect(find('http://127.0.0.1:1633/bzz/abc', '127.0.0.1')).toBe('DIRECT');
    expect(find('http://foo.tonic.example/', 'foo.tonic.example')).toBe('DIRECT');
    expect(find('https://t.me/', 't.me')).toBe('DIRECT');
  });
});

describe('applyOnionProxy / clearOnionProxy', () => {
  test('applyOnionProxy sets a pac_script proxy on the session', async () => {
    const setProxy = jest.fn().mockResolvedValue(undefined);
    const forceReloadProxyConfig = jest.fn().mockResolvedValue(undefined);
    const closeAllConnections = jest.fn().mockResolvedValue(undefined);
    const resolveProxy = jest.fn().mockResolvedValue('SOCKS5 127.0.0.1:9150');
    await applyOnionProxy(
      { setProxy, forceReloadProxyConfig, closeAllConnections, resolveProxy },
      '127.0.0.1:9150'
    );
    expect(setProxy).toHaveBeenCalledTimes(1);
    const arg = setProxy.mock.calls[0][0];
    expect(arg.mode).toBe('pac_script');
    expect(arg.pacScript).toMatch(/^data:application\/x-ns-proxy-autoconfig;base64,/);
    expect(forceReloadProxyConfig).toHaveBeenCalledTimes(1);
    expect(closeAllConnections).toHaveBeenCalledTimes(1);
    expect(resolveProxy).toHaveBeenCalledWith('https://freedom-proxy-check.onion/');
    expect(log.info).toHaveBeenCalledWith(
      '[tor-proxy] Chromium resolves .onion via SOCKS5 127.0.0.1:9150'
    );
  });

  test('clearOnionProxy resets the session to direct', async () => {
    const setProxy = jest.fn().mockResolvedValue(undefined);
    const forceReloadProxyConfig = jest.fn().mockResolvedValue(undefined);
    const closeAllConnections = jest.fn().mockResolvedValue(undefined);
    await clearOnionProxy({ setProxy, forceReloadProxyConfig, closeAllConnections });
    expect(setProxy).toHaveBeenCalledWith({ mode: 'direct' });
    expect(forceReloadProxyConfig).toHaveBeenCalledTimes(1);
    expect(closeAllConnections).toHaveBeenCalledTimes(1);
  });

  test('no-ops gracefully when session has no setProxy', async () => {
    await expect(applyOnionProxy(null, '127.0.0.1:9150')).resolves.toBeUndefined();
    await expect(clearOnionProxy({})).resolves.toBeUndefined();
  });

  test('clearing Tor preserves an active TON route', async () => {
    const targetSession = {
      setProxy: jest.fn().mockResolvedValue(undefined),
      forceReloadProxyConfig: jest.fn().mockResolvedValue(undefined),
      closeAllConnections: jest.fn().mockResolvedValue(undefined),
      resolveProxy: jest.fn().mockResolvedValue('PROXY 127.0.0.1:18085'),
    };

    await applyTonProxy(targetSession, '127.0.0.1:18085');
    await applyOnionProxy(targetSession, '127.0.0.1:9150');
    await clearOnionProxy(targetSession);

    const finalConfig = targetSession.setProxy.mock.calls.at(-1)[0];
    expect(finalConfig.mode).toBe('pac_script');
    const pac = Buffer.from(finalConfig.pacScript.split(',')[1], 'base64').toString('utf8');
    const find = compilePac(pac);
    expect(find('http://foundation.ton/', 'foundation.ton')).toBe('PROXY 127.0.0.1:18085');
    expect(find('http://hidden.onion/', 'hidden.onion')).toBe('DIRECT');
  });

  test('clearing TON preserves an active Tor route', async () => {
    const targetSession = {
      setProxy: jest.fn().mockResolvedValue(undefined),
      forceReloadProxyConfig: jest.fn().mockResolvedValue(undefined),
      closeAllConnections: jest.fn().mockResolvedValue(undefined),
      resolveProxy: jest.fn().mockResolvedValue('SOCKS5 127.0.0.1:9150'),
    };

    await applyOnionProxy(targetSession, '127.0.0.1:9150');
    await applyTonProxy(targetSession, '127.0.0.1:18085');
    await clearTonProxy(targetSession);

    const finalConfig = targetSession.setProxy.mock.calls.at(-1)[0];
    expect(finalConfig.mode).toBe('pac_script');
    const pac = Buffer.from(finalConfig.pacScript.split(',')[1], 'base64').toString('utf8');
    const find = compilePac(pac);
    expect(find('http://foundation.ton/', 'foundation.ton')).toBe('DIRECT');
    expect(find('http://hidden.onion/', 'hidden.onion')).toBe('SOCKS5 127.0.0.1:9150');
  });
});
