const {
  BlockscoutError,
  LookupsExhausted,
  LOG_INDEX_URLS,
  boundLookups,
  isLocalHostname,
  redirectTarget,
} = require('./blockscout-logs');

// A page of the index, as main's executor reads it, and its origin.
const PAGE = `${LOG_INDEX_URLS[100]}/v2/addresses/0x971f/token-transfers?type=ERC-20&filter=from`;
const ORIGIN = new URL(PAGE).origin;

// Off-origin redirect hops are resolved before they are dialled; tests never
// reach the real resolver.
const publicLookup = () => jest.fn(async () => [{ address: '104.18.12.34', family: 4 }]);
const target = (location, lookup = publicLookup(), signal) =>
  redirectTarget(location, PAGE, ORIGIN, { lookup, signal });

describe("the redirect policy for the index's pages", () => {
  test('an https hop is followed, relative ones against the page, the query kept', async () => {
    const next = await target('https://gnosisscan.io/api/v2/addresses/0x971f?block_number=10');
    expect(next).toBeInstanceOf(URL);
    expect(next.href).toBe('https://gnosisscan.io/api/v2/addresses/0x971f?block_number=10');
    expect((await target('/api?again=1')).href).toBe('https://gnosis.blockscout.com/api?again=1');
  });

  test.each([
    [undefined, 'redirected with no location'],
    ['', 'redirected with no location'],
    ['https://[::1', 'redirected to a malformed location'],
    // The address would go out in clear: refused before it is dialled.
    ['http://gnosisscan.io/api', 'redirected off https'],
  ])('a hop to %p is refused: %s', async (location, reason) => {
    const lookup = publicLookup();
    const refusal = await target(location, lookup).catch((err) => err);
    expect(refusal).toBeInstanceOf(BlockscoutError);
    expect(refusal.message).toBe(reason);
    expect(lookup).not.toHaveBeenCalled();
  });

  test.each([
    'https://127.0.0.1/api',
    'https://127.1/api',
    'https://[::1]/api',
    'https://localhost./api',
    'https://localhost/api',
    'https://wallet.localhost/api',
    'https://0.0.0.0/api',
    'https://[::]/api',
    'https://[::7f00:1]/api',
    'https://10.0.0.1/api',
    'https://172.16.5.4/api',
    'https://192.168.1.1/api',
    'https://169.254.169.254/api',
    'https://100.64.0.1/api',
    'https://[fd00::1]/api',
    'https://[fe80::1]/api',
    'https://[::ffff:127.0.0.1]/api',
    'https://[::ffff:10.0.0.1]/api',
    'https://[2002:7f00:1::1]/api',
    'https://[2002:c0a8:101::1]/api',
    'https://[64:ff9b::7f00:1]/api',
    'https://[64:ff9b:1::a00:1]/api',
    'https://[::ffff:0:7f00:1]/api',
    'https://[fec0::1]/api',
    'https://[ff02::1]/api',
    'https://198.18.0.1/api',
    'https://224.0.0.251/api',
    'https://255.255.255.255/api',
  ])('a hop to %s is refused before it is dialled', async (location) => {
    const lookup = publicLookup();
    await expect(target(location, lookup)).rejects.toThrow('redirected to a local host');
    expect(lookup).not.toHaveBeenCalled();
  });

  test('local hosts: canonical forms are caught, public hosts are not', () => {
    const local = (url) => isLocalHostname(new URL(url).hostname);
    for (const url of ['https://0x7f.1', 'https://2130706433', 'https://[::127.0.0.1]']) {
      expect(local(url)).toBe(true);
    }
    for (const url of [
      'https://gnosisscan.io',
      'https://8.8.8.8',
      'https://172.32.0.1',
      'https://[2001:db8::1]',
      'https://[::ffff:8.8.8.8]',
      'https://[2002:808:808::1]',
      'https://[64:ff9b::808:808]',
      'https://198.20.0.1',
      'https://notlocalhost',
    ]) {
      expect(local(url)).toBe(false);
    }
  });

  test.each([
    ['to loopback', [{ address: '127.0.0.1', family: 4 }]],
    [
      'to a LAN address among public ones',
      [
        { address: '104.18.12.34', family: 4 },
        { address: '192.168.1.10', family: 4 },
      ],
    ],
    ['to IPv6 loopback', [{ address: '::1', family: 6 }]],
  ])('a hop to a DNS name resolving %s is refused', async (_l, answer) => {
    const lookup = jest.fn(async () => answer);
    await expect(target('https://127.0.0.1.nip.io/api', lookup)).rejects.toThrow(
      'redirected to a local host'
    );
    expect(lookup).toHaveBeenCalledWith('127.0.0.1.nip.io', { all: true, verbatim: true });
  });

  test('a hop to a name that does not resolve is refused', async () => {
    const lookup = jest.fn(async () => {
      throw Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' });
    });
    await expect(target('https://nowhere.example/api', lookup)).rejects.toThrow('does not resolve');
  });

  test.each([
    'https://wallet.onion/api',
    'https://WALLET.ONION./api',
    'https://wallet.onion../api',
  ])('a hop to %s is refused without asking the resolver', async (location) => {
    const lookup = publicLookup();
    await expect(target(location, lookup)).rejects.toThrow('does not resolve');
    expect(lookup).not.toHaveBeenCalled();
  });

  test('a public name is resolved, then followed; one on the same origin is not resolved', async () => {
    const lookup = publicLookup();
    expect((await target('https://gnosisscan.io/api', lookup)).host).toBe('gnosisscan.io');
    expect(lookup).toHaveBeenCalledTimes(1);
    const same = jest.fn(async () => [{ address: '127.0.0.1', family: 4 }]);
    expect((await target('/api?x=1', same)).origin).toBe(ORIGIN);
    expect(same).not.toHaveBeenCalled();
  });

  test('a lookup cut short, or past its bound, throws its own error, not a refusal', async () => {
    const controller = new AbortController();
    const hung = target('https://slow.example/api', () => new Promise(() => {}), controller.signal);
    controller.abort();
    const aborted = await hung.catch((err) => err);
    expect(aborted).not.toBeInstanceOf(BlockscoutError);
    const exhausted = await target('https://busy.example/api', () => {
      throw new LookupsExhausted();
    }).catch((err) => err);
    expect(exhausted).toBeInstanceOf(LookupsExhausted);
  });

  // Review of #692 (security, N1): the resolver can't cancel a lookup, so
  // one given up on keeps its slot until it settles.
  test('lookups still outstanding are bounded, given up on or not', async () => {
    const settle = [];
    const lookup = jest.fn(
      () =>
        new Promise((resolve, reject) => {
          settle.push({ resolve, reject });
        })
    );
    const bounded = boundLookups(lookup, 2);
    const first = bounded('a.example', { all: true });
    const second = bounded('b.example', { all: true });
    await expect(bounded('c.example', { all: true })).rejects.toBeInstanceOf(LookupsExhausted);
    await Promise.resolve();
    expect(lookup).toHaveBeenCalledTimes(2);
    expect(bounded.outstanding()).toBe(2);
    // Settled, either way, a slot is free again.
    settle[0].resolve([{ address: '104.18.12.34', family: 4 }]);
    settle[1].reject(new Error('ENOTFOUND'));
    await first;
    await second.catch(() => {});
    await Promise.resolve();
    expect(bounded.outstanding()).toBe(0);
    const throwing = boundLookups(() => {
      throw new Error('sync');
    }, 1);
    await expect(throwing('d.example')).rejects.toThrow('sync');
    expect(throwing.outstanding()).toBe(0);
  });
});
