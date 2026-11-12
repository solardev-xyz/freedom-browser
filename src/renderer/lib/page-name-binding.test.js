// The chrome holds a DNS name over IPNS for a tab's next commit in main
// (freedom-core design 0011, "Names over IPNS"; PRQ-3), naming exactly what
// it keys the page on itself (`applyDnsNameIdentity`).

const B58_KEY = '12D3KooWD3eckifWpRn9wQpMG9R9hX3sD158z7EqHWmweQAJU5SA';
const BASE36_KEY = 'k51qzi5uqu5dlvj2baxnqndepeb86cbk3ng7n3i46uzyxzyqj2xjonzllnv0v8';

describe('bindPageNameForLoad', () => {
  let bindPageName;
  let bindPageNameForLoad;
  let ipnsMhToCidV1Base36;

  beforeEach(async () => {
    jest.resetModules();
    bindPageName = jest.fn();
    global.window = { electronAPI: { bindPageName } };
    ({ bindPageNameForLoad } = await import('./page-name-binding.js'));
    ({ ipnsMhToCidV1Base36 } = await import('./cid-utils.js'));
  });

  afterEach(() => {
    delete global.window;
  });

  const webview = (id = 42) => ({ getWebContentsId: () => id });

  test('binds the name the chrome keys the page on, with the key the URL carries', () => {
    const known = new Map([[BASE36_KEY, 'example.com']]);
    expect(bindPageNameForLoad(webview(), `ipns://${BASE36_KEY}/docs?x=1`, known)).toBe(true);
    expect(bindPageName).toHaveBeenCalledWith(42, 'example.com', BASE36_KEY);
  });

  test('a key the resolver gave in base58 maps through its base36 form, as the chrome maps it', () => {
    const base36 = ipnsMhToCidV1Base36(B58_KEY);
    const known = new Map([[B58_KEY, 'dns.example']]);
    expect(bindPageNameForLoad(webview(7), `ipns://${base36}/`, known)).toBe(true);
    expect(bindPageName).toHaveBeenCalledWith(7, 'dns.example', base36);
  });

  test('binds nothing for a key no DNS name is known for, an ENS name, or another scheme', () => {
    const known = new Map([[BASE36_KEY, 'example.com'], ['bafyfoo', 'site.eth']]);
    for (const url of [
      'ipns://k51other/',
      'ipns://name.eth/',
      `https://${BASE36_KEY}.example/`,
      `ipfs://${BASE36_KEY}/`,
      'bzz://bafyfoo/',
      '',
      null,
    ]) {
      expect({ url, bound: bindPageNameForLoad(webview(), url, known) }).toEqual({ url, bound: false });
    }
    // A name that is itself a dweb name never needs a binding.
    expect(bindPageNameForLoad(webview(), 'ipns://bafyfoo/', new Map([['bafyfoo', 'site.eth']]))).toBe(false);
    expect(bindPageName).not.toHaveBeenCalled();
  });

  test('never throws, and binds nothing, without a guest id or the API', () => {
    const known = new Map([[BASE36_KEY, 'example.com']]);
    const url = `ipns://${BASE36_KEY}/`;
    expect(bindPageNameForLoad({}, url, known)).toBe(false);
    expect(bindPageNameForLoad({ getWebContentsId: () => { throw new Error('not attached'); } }, url, known)).toBe(false);
    expect(bindPageNameForLoad(null, url, known)).toBe(false);
    delete window.electronAPI;
    expect(bindPageNameForLoad(webview(), url, known)).toBe(false);
    expect(bindPageName).not.toHaveBeenCalled();
  });
});
