const {
  BlockscoutError,
  BLOCKSCOUT_MAX_PAGES,
  ERC20_TRANSFER_TOPIC,
  agreedRpcLogs,
  blockscoutTransfer,
  fetchBlockscoutTransferLogs,
  isLocalHostname,
  logIndexFilter,
  logsAgree,
  rpcTransfer,
  rpcTransferLogsWellFormed,
} = require('./blockscout-logs');
const captured = require('./__fixtures__/blockscout-xbzz-transfers.json');

const XBZZ = '0xdBF3Ea6F5beE45c02255B2c26a16F300502F68da';
const WALLET = '0x000000000000000000000000971f31aaeac713b47aa55e50c06409afc1de46b9';
const OTHER = '0x00000000000000000000000045a1502382541cd610cc9068e88727426b696293';

// Ant's wallet scan filter (discover.rs scan_transfers), as it sends it.
const antFilter = (overrides = {}) => [
  {
    address: XBZZ,
    fromBlock: '0xfbfeca',
    toBlock: '0x2e5a4c7',
    topics: [ERC20_TRANSFER_TOPIC, WALLET],
    ...overrides,
  },
];

describe('logIndexFilter: only the Transfer scans Ant sends', () => {
  test("Ant's sender scan, whatever the address case", () => {
    expect(logIndexFilter(100, antFilter())).toEqual({
      chainId: 100,
      token: XBZZ.toLowerCase(),
      sender: WALLET,
      recipient: null,
      fromBlock: 0xfbfeca,
      toBlock: 0x2e5a4c7,
    });
    expect(logIndexFilter(100, captured.params)).not.toBeNull();
  });

  test('a recipient scan, and a sender-and-recipient scan', () => {
    expect(
      logIndexFilter(100, antFilter({ topics: [ERC20_TRANSFER_TOPIC, null, WALLET] }))
    ).toMatchObject({ sender: null, recipient: WALLET });
    expect(
      logIndexFilter(100, antFilter({ topics: [ERC20_TRANSFER_TOPIC, WALLET, OTHER] }))
    ).toMatchObject({ sender: WALLET, recipient: OTHER });
  });

  test.each([
    ['another chain', 1, antFilter()],
    ['another token', 100, antFilter({ address: '0xe91d153e0b41518a2ce8dd3d7944fa863463a97d' })],
    ['an address list', 100, antFilter({ address: [XBZZ] })],
    ['no topics', 100, antFilter({ topics: [] })],
    ['Transfer with no address topic', 100, antFilter({ topics: [ERC20_TRANSFER_TOPIC] })],
    [
      'Transfer from anyone to anyone',
      100,
      antFilter({ topics: [ERC20_TRANSFER_TOPIC, null, null] }),
    ],
    ['another event', 100, antFilter({ topics: [OTHER, WALLET] })],
    ['a topic list (OR)', 100, antFilter({ topics: [ERC20_TRANSFER_TOPIC, [WALLET, OTHER]] })],
    ['a fourth topic', 100, antFilter({ topics: [ERC20_TRANSFER_TOPIC, WALLET, null, OTHER] })],
    [
      'a topic that is no address',
      100,
      antFilter({ topics: [ERC20_TRANSFER_TOPIC, `0x${'f'.repeat(64)}`] }),
    ],
    ['a range ending at a tag', 100, antFilter({ toBlock: 'latest' })],
    ['a reversed range', 100, antFilter({ fromBlock: '0x10', toBlock: '0x1' })],
    ['a blockHash filter', 100, antFilter({ blockHash: `0x${'1'.repeat(64)}` })],
    ['a second param', 100, [...antFilter(), {}]],
    [
      'BatchCreated (the batch scan)',
      100,
      [{ address: XBZZ, fromBlock: '0x1', toBlock: '0x1', topics: [OTHER] }],
    ],
  ])('not %s', (_label, chainId, params) => {
    expect(logIndexFilter(chainId, params)).toBeNull();
  });
});

describe('mapping (captured from both providers, 2026-10-07)', () => {
  const indexed = () => captured.blockscout.items.map(blockscoutTransfer);

  test("each Blockscout transfer is the RPC's entry for it, field for field", () => {
    expect(captured.blockscout.next_page_params).toBeNull();
    expect(captured.blockscout.items).toHaveLength(captured.rpc.length);
    const byPosition = new Map(
      captured.rpc.map((log) => [
        `${parseInt(log.blockNumber, 16)}:${parseInt(log.logIndex, 16)}`,
        log,
      ])
    );
    for (const item of captured.blockscout.items) {
      const transfer = blockscoutTransfer(item);
      const log = byPosition.get(`${item.block_number}:${item.log_index}`);
      expect(transfer).toEqual(rpcTransfer(log));
      expect(transfer).toMatchObject({
        address: log.address,
        blockHash: log.blockHash,
        transactionHash: log.transactionHash,
        from: log.topics[1],
        to: log.topics[2],
        value: BigInt(log.data).toString(),
      });
    }
  });

  test('the two captured answers agree', () => {
    expect(logsAgree(indexed(), captured.rpc)).toBe(true);
    // Order and spelling do not matter.
    const shouted = [...captured.rpc].reverse().map((log) => ({
      ...log,
      address: log.address.toUpperCase().replace('0X', '0x'),
      blockNumber: `0x000${log.blockNumber.slice(2)}`,
    }));
    expect(logsAgree(indexed(), shouted)).toBe(true);
  });

  test.each([
    ['one log missing', (rpc) => rpc.slice(1)],
    ['one log extra', (rpc) => [...rpc, { ...rpc[0], logIndex: '0x63' }]],
    ['a different amount', (rpc) => [{ ...rpc[0], data: `0x${'0'.repeat(63)}1` }, ...rpc.slice(1)]],
    [
      'a different recipient',
      (rpc) => [{ ...rpc[0], topics: [ERC20_TRANSFER_TOPIC, WALLET, OTHER] }, ...rpc.slice(1)],
    ],
    [
      'a different transaction',
      (rpc) => [{ ...rpc[0], transactionHash: `0x${'2'.repeat(64)}` }, ...rpc.slice(1)],
    ],
    [
      'a different block hash',
      (rpc) => [{ ...rpc[0], blockHash: `0x${'3'.repeat(64)}` }, ...rpc.slice(1)],
    ],
    ['another contract', (rpc) => [{ ...rpc[0], address: `0x${'1'.repeat(40)}` }, ...rpc.slice(1)]],
    [
      'another event',
      (rpc) => [
        { ...rpc[0], topics: [`0x${'4'.repeat(64)}`, ...rpc[0].topics.slice(1)] },
        ...rpc.slice(1),
      ],
    ],
    ['a removed log', (rpc) => [{ ...rpc[0], removed: true }, ...rpc.slice(1)]],
    ['a duplicate in place of a log', (rpc) => [rpc[1], ...rpc.slice(1)]],
    ['a malformed entry', (rpc) => [{ ...rpc[0], blockNumber: 12 }, ...rpc.slice(1)]],
    ['no list', () => null],
  ])('they disagree with %s', (_label, change) => {
    expect(logsAgree(indexed(), change(captured.rpc))).toBe(false);
  });

  test('a duplicate on the Blockscout side disagrees', () => {
    const doubled = indexed();
    doubled[1] = doubled[0];
    expect(logsAgree(doubled, captured.rpc)).toBe(false);
  });

  test.each([
    ['no block hash', { block_hash: null }],
    ['a short transaction hash', { transaction_hash: '0x12' }],
    ['a block number that is a string', { block_number: '48059551' }],
    ['a negative log index', { log_index: -1 }],
    ['no sender', { from: null }],
    ['a recipient that is not an address', { to: { hash: '0x12' } }],
    ['a value that is not decimal', { total: { value: '0x10' } }],
    ['a value over 256 bits', { total: { value: (1n << 256n).toString() } }],
    ['another token type', { token_type: 'ERC-721' }],
    ['no token', { token: null }],
  ])('a Blockscout transfer with %s is malformed', (_label, change) => {
    expect(blockscoutTransfer({ ...captured.blockscout.items[0], ...change })).toBeNull();
  });
});

// The RPC's entries are what Ant receives, so they must be in the exact shape
// Ant reads, not only agree with Blockscout once both are canonicalised.
describe('the RPC entries must have the exact shape Ant reads', () => {
  const indexed = () => captured.blockscout.items.map(blockscoutTransfer);
  const first = (change) => (rpc) => [{ ...rpc[0], ...change(rpc[0]) }, ...rpc.slice(1)];

  test('the captured RPC answer is well formed', () => {
    expect(rpcTransferLogsWellFormed(captured.rpc)).toBe(true);
    expect(rpcTransferLogsWellFormed([])).toBe(true);
    expect(rpcTransferLogsWellFormed(null)).toBe(false);
  });

  test.each([
    ['no blockHash', first(() => ({ blockHash: undefined }))],
    ['a short blockHash', first((log) => ({ blockHash: log.blockHash.slice(0, 64) }))],
    ['a blockHash that is not hex', first(() => ({ blockHash: `0x${'g'.repeat(64)}` }))],
    [
      'a short transactionHash',
      first((log) => ({ transactionHash: log.transactionHash.slice(0, 64) })),
    ],
    ['removed: true', first(() => ({ removed: true }))],
    ['a value of two words', first((log) => ({ data: `${log.data}${'0'.repeat(64)}` }))],
    ['a value shorter than a word', first((log) => ({ data: `0x${log.data.slice(4)}` }))],
    ['an empty value', first(() => ({ data: '0x' }))],
    [
      'a sender topic that is not a zero-padded address',
      first((log) => ({ topics: [log.topics[0], `0x${'1'.repeat(64)}`, log.topics[2]] })),
    ],
    [
      'a recipient topic that is not a zero-padded address',
      first((log) => ({ topics: [log.topics[0], log.topics[1], `0x01${log.topics[2].slice(4)}`] })),
    ],
    ['null-padded topics', first((log) => ({ topics: [...log.topics, null] }))],
  ])('%s: the check fails', (_label, change) => {
    const rpc = change(captured.rpc);
    expect(rpcTransferLogsWellFormed(rpc)).toBe(false);
    expect(logsAgree(indexed(), rpc)).toBe(false);
  });
});

// What the pair delivers is what it verified: the RPC's entries cut to the
// fields logsAgree compared with Blockscout's transfers.
describe('agreedRpcLogs', () => {
  const indexed = () => captured.blockscout.items.map(blockscoutTransfer);

  test('a wrong transactionIndex still agrees, so it is not delivered', () => {
    // Blockscout does not report it: nothing in the pair can check it.
    const rpc = captured.rpc.map((log) => ({ ...log, transactionIndex: '0x3e7' }));
    expect(logsAgree(indexed(), rpc)).toBe(true);
    const delivered = agreedRpcLogs(rpc);
    expect(delivered).toHaveLength(rpc.length);
    for (const log of delivered) expect(log).not.toHaveProperty('transactionIndex');
  });

  test('keeps every compared field in the RPC spelling, and nothing else', () => {
    const rpc = captured.rpc.map((log) => ({ ...log, blockTimestamp: '0x1', extra: 'x' }));
    const delivered = agreedRpcLogs(rpc);
    delivered.forEach((log, i) => {
      const { transactionIndex: _unchecked, blockTimestamp: _t, extra: _x, ...compared } = rpc[i];
      expect(log).toEqual({ ...compared, removed: false });
      expect(log.topics).not.toBe(rpc[i].topics);
    });
  });
});

// A Blockscout token-transfer item, as its API v2 lists one (see the fixture,
// which also carries display fields such as the token's name and the parties'
// tags; they are not read).
const row = (block, logIndex = 0, { from = WALLET, to = OTHER, token = XBZZ } = {}) => ({
  block_hash: `0x${block.toString(16).padStart(64, 'b')}`,
  block_number: block,
  from: { hash: `0x${from.slice(26)}` },
  log_index: logIndex,
  to: { hash: `0x${to.slice(26)}` },
  token: { address_hash: token, type: 'ERC-20' },
  token_type: 'ERC-20',
  total: { decimals: '16', value: '1' },
  transaction_hash: `0x${block.toString(16).padStart(32, '0')}${logIndex.toString(16).padStart(32, '0')}`,
  type: 'token_transfer',
});

function reply(body, { status = 200, headers = {}, url = 'https://gnosisscan.io/api' } = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    url,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    text: async () => text,
  });
}
// One page of items, newest first; `more` names the next page as Blockscout
// does (the last item's position), else this is the last page.
const ok = (items, { more = false } = {}) => {
  const last = items[items.length - 1];
  return reply({
    items,
    next_page_params: more
      ? { block_number: last.block_number, index: last.log_index, items_count: 50 }
      : null,
  });
};
const NO_LOGS = { items: [], next_page_params: null };

describe('fetchBlockscoutTransferLogs', () => {
  const filter = logIndexFilter(100, antFilter({ fromBlock: '0x64', toBlock: '0x2710' }));
  // Off-origin redirect hops are resolved before they are dialled; tests
  // never reach the real resolver.
  const publicLookup = jest.fn(async () => [{ address: '104.18.12.34', family: 4 }]);
  const read = (fetchImpl, toBlock = 10_000, lookup = publicLookup) =>
    fetchBlockscoutTransferLogs(filter, toBlock, { timeoutMs: 1000, fetchImpl, lookup });
  const queryOf = (url) => Object.fromEntries(new URL(url).searchParams);
  // `count` items newest first, one per block from `newest` down.
  const descending = (newest, count) => Array.from({ length: count }, (_, i) => row(newest - i));

  test("asks Blockscout's token-transfer API for the sender's transfers before toBlock + 1", async () => {
    const fetchImpl = jest.fn(() => ok([row(300, 2), row(200)]));
    const logs = await read(fetchImpl, 5000);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(new URL(url).origin + new URL(url).pathname).toBe(
      'https://gnosis.blockscout.com/api/v2/addresses/0x971f31aaeac713b47aa55e50c06409afc1de46b9/token-transfers'
    );
    expect(queryOf(url)).toEqual({
      type: 'ERC-20',
      filter: 'from',
      token: XBZZ.toLowerCase(),
      block_number: '5001',
      index: '0',
    });
    // Nothing but the filter: no credentials, no referrer.
    expect(init).toMatchObject({
      method: 'GET',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
    });
    // Oldest first.
    expect(logs.map((log) => [log.blockNumber, log.logIndex])).toEqual([
      [200, 0],
      [300, 2],
    ]);
    expect(logs[0]).toEqual(blockscoutTransfer(row(200)));
  });

  test("a recipient scan lists the recipient's incoming transfers", async () => {
    const fetchImpl = jest.fn(() => reply(NO_LOGS));
    const recipient = logIndexFilter(
      100,
      antFilter({ topics: [ERC20_TRANSFER_TOPIC, null, WALLET] })
    );
    await fetchBlockscoutTransferLogs(recipient, 10, { timeoutMs: 1000, fetchImpl });
    const url = new URL(fetchImpl.mock.calls[0][0]);
    expect(url.pathname).toBe(
      '/api/v2/addresses/0x971f31aaeac713b47aa55e50c06409afc1de46b9/token-transfers'
    );
    expect(queryOf(url)).toMatchObject({ filter: 'to', block_number: '11', index: '0' });
  });

  test('a scan by sender and recipient reads by sender and keeps that recipient only', async () => {
    const both = logIndexFilter(
      100,
      antFilter({
        fromBlock: '0x64',
        toBlock: '0x2710',
        topics: [ERC20_TRANSFER_TOPIC, WALLET, OTHER],
      })
    );
    const elsewhere = `0x${'0'.repeat(24)}${'2'.repeat(40)}`;
    const fetchImpl = jest.fn(() => ok([row(300), row(250, 0, { to: elsewhere }), row(200)]));
    const logs = await fetchBlockscoutTransferLogs(both, 10_000, { timeoutMs: 1000, fetchImpl });
    expect(queryOf(fetchImpl.mock.calls[0][0])).toMatchObject({ filter: 'from' });
    expect(logs.map((log) => log.blockNumber)).toEqual([200, 300]);
  });

  test('no transfers is an empty answer', async () => {
    expect(await read(() => reply(NO_LOGS))).toEqual([]);
  });

  test('pages are read back from where the last one ended, until fromBlock is passed', async () => {
    const fetchImpl = jest
      .fn()
      .mockImplementationOnce(() => ok(descending(9000, 50), { more: true }))
      .mockImplementationOnce(() => ok([...descending(8950, 3), row(99), row(98)], { more: true }));
    const logs = await read(fetchImpl);
    // The second page reached a transfer before fromBlock (100): no third.
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(queryOf(fetchImpl.mock.calls[1][0])).toMatchObject({
      block_number: '8951',
      index: '0',
    });
    expect(logs).toHaveLength(53);
    expect(logs[0].blockNumber).toBe(8948);
    expect(logs[52].blockNumber).toBe(9000);
  });

  test('an empty page that names a next one fails the read', async () => {
    await expect(
      read(() => reply({ items: [], next_page_params: { block_number: 1, index: 0 } }))
    ).rejects.toThrow('an empty page that is not the last');
  });

  test(`more than ${BLOCKSCOUT_MAX_PAGES} pages fail rather than return part of the answer`, async () => {
    let newest = 10_000;
    const fetchImpl = jest.fn(() => {
      const items = descending(newest, 50);
      newest -= 50;
      return ok(items, { more: true });
    });
    await expect(read(fetchImpl)).rejects.toThrow(`over ${BLOCKSCOUT_MAX_PAGES} pages`);
    expect(fetchImpl).toHaveBeenCalledTimes(BLOCKSCOUT_MAX_PAGES);
  });

  test.each([
    ['a transfer after toBlock', [row(10_001)], 'out of order'],
    ['a transfer from another sender', [row(200, 0, { from: OTHER })], 'outside the filter'],
    [
      'a transfer of another token',
      [row(200, 0, { token: `0x${'1'.repeat(40)}` })],
      'outside the filter',
    ],
    ['a malformed transfer', [{ ...row(200), transaction_hash: '0x12' }], 'outside the filter'],
    ['transfers out of order', [row(200), row(300)], 'out of order'],
    ['the same transfer twice', [row(200), row(200)], 'out of order'],
  ])('%s fails the read', async (_label, rows, message) => {
    await expect(read(() => ok(rows))).rejects.toThrow(message);
  });

  test('a page that repeats the last transfer of the one before fails the read', async () => {
    const fetchImpl = jest
      .fn()
      .mockImplementationOnce(() => ok([row(300), row(200)], { more: true }))
      .mockImplementationOnce(() => ok([row(200)]));
    await expect(read(fetchImpl)).rejects.toThrow('out of order');
  });

  test('a 429 cools Blockscout down for the reset it names, within bounds', async () => {
    const limited = (reset) =>
      read(() =>
        reply(
          { message: 'Too many requests' },
          {
            status: 429,
            headers: reset === undefined ? {} : { 'x-ratelimit-reset': String(reset) },
          }
        )
      ).catch((err) => err);
    const named = await limited(344628);
    expect(named).toBeInstanceOf(BlockscoutError);
    expect(named.coolMs).toBe(344628);
    expect((await limited(10)).coolMs).toBe(60_000);
    expect((await limited(10 * 3600_000)).coolMs).toBe(15 * 60_000);
    expect((await limited(undefined)).coolMs).toBe(5 * 60_000);
  });

  test.each([
    ['HTTP 500', () => reply('oops', { status: 500 }), 'HTTP 500'],
    ['an answer that is not JSON', () => reply('<html>'), 'not JSON'],
    ['a refusal', () => reply({ message: 'Invalid address format' }), 'refused'],
    ['items that are not a list', () => reply({ items: {}, next_page_params: null }), 'refused'],
    ['no next_page_params', () => reply({ items: [] }), 'refused'],
    [
      'a throttle in the body',
      () => reply({ message: 'Too many requests. Increase limits' }),
      'throttled',
    ],
    [
      'a redirect off https',
      () => reply('', { status: 301, headers: { location: 'http://gnosisscan.io/api?x=1' } }),
      'off https',
    ],
    ['a redirect with no location', () => reply('', { status: 302 }), 'no location'],
    ['a transport failure', () => Promise.reject(new TypeError('fetch failed')), 'unreachable'],
  ])('%s fails the read', async (_label, fetchImpl, message) => {
    await expect(read(fetchImpl)).rejects.toThrow(message);
  });

  test('a hung Blockscout fails within the timeout', async () => {
    jest.useFakeTimers();
    try {
      const hang = (_url, { signal }) =>
        new Promise((_resolve, reject) =>
          signal.addEventListener('abort', () => reject(new Error('aborted')))
        );
      const pending = read(hang).catch((err) => err);
      await jest.advanceTimersByTimeAsync(1000);
      expect((await pending).message).toBe('no answer within 1000ms');
    } finally {
      jest.useRealTimers();
    }
  });

  test('an https redirect is followed by hand, keeping the query', async () => {
    const fetchImpl = jest
      .fn()
      .mockImplementationOnce((url) =>
        reply('', {
          status: 301,
          headers: {
            location: url.replace('https://gnosis.blockscout.com', 'https://gnosisscan.io'),
          },
        })
      )
      .mockImplementationOnce(() => ok([row(200)]));
    const logs = await read(fetchImpl);
    expect(logs).toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls.every(([, init]) => init.redirect === 'manual')).toBe(true);
    const second = new URL(fetchImpl.mock.calls[1][0]);
    expect(second.host).toBe('gnosisscan.io');
    expect(second.pathname).toContain(`/addresses/0x${WALLET.slice(26)}/`);
    expect(queryOf(second.toString())).toMatchObject({ filter: 'from', block_number: '10001' });
  });

  test('a redirect to http is refused before it is dialled: the address never goes out in clear', async () => {
    const fetchImpl = jest.fn((url) =>
      url.startsWith('https://gnosis.blockscout.com/')
        ? reply('', { status: 307, headers: { location: url.replace('https:', 'http:') } })
        : ok([])
    );
    await expect(read(fetchImpl)).rejects.toThrow('redirected off https');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls.some(([url]) => !url.startsWith('https:'))).toBe(false);
  });

  test('a relative redirect resolves against the hop, and a loop gives up', async () => {
    const fetchImpl = jest.fn(() =>
      reply('', { status: 302, headers: { location: '/api?again=1' } })
    );
    await expect(read(fetchImpl)).rejects.toThrow('redirected too often');
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(fetchImpl.mock.calls[1][0]).toBe('https://gnosis.blockscout.com/api?again=1');
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
  ])('a redirect to %s is refused before it is dialled', async (location) => {
    const fetchImpl = jest.fn((url) =>
      url.startsWith('https://gnosis.blockscout.com/')
        ? reply('', { status: 302, headers: { location } })
        : ok([])
    );
    await expect(read(fetchImpl)).rejects.toThrow('redirected to a local host');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
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

  const redirectTo = (location) =>
    jest.fn((url) =>
      url.startsWith('https://gnosis.blockscout.com/')
        ? reply('', { status: 302, headers: { location } })
        : ok([row(200)])
    );

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
  ])(
    'a redirect to a DNS name resolving %s is refused before it is dialled',
    async (_l, answer) => {
      const lookup = jest.fn(async () => answer);
      const fetchImpl = redirectTo('https://127.0.0.1.nip.io/api');
      await expect(read(fetchImpl, 10_000, lookup)).rejects.toThrow('redirected to a local host');
      expect(lookup).toHaveBeenCalledWith('127.0.0.1.nip.io', { all: true, verbatim: true });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
  );

  test('a redirect to a name that does not resolve is refused before it is dialled', async () => {
    const lookup = jest.fn(async () => {
      throw Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' });
    });
    const fetchImpl = redirectTo('https://nowhere.example/api');
    await expect(read(fetchImpl, 10_000, lookup)).rejects.toThrow('does not resolve');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test('a redirect to a public name is resolved, then followed', async () => {
    const lookup = jest.fn(async () => [{ address: '104.18.12.34', family: 4 }]);
    const fetchImpl = redirectTo('https://gnosisscan.io/api');
    expect(await read(fetchImpl, 10_000, lookup)).toHaveLength(1);
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  test('a same-origin redirect is not resolved', async () => {
    const lookup = jest.fn(async () => [{ address: '127.0.0.1', family: 4 }]);
    const fetchImpl = jest
      .fn()
      .mockImplementationOnce(() => reply('', { status: 302, headers: { location: '/api?x=1' } }))
      .mockImplementationOnce(() => ok([]));
    await read(fetchImpl, 10_000, lookup);
    expect(lookup).not.toHaveBeenCalled();
  });

  test('a hung lookup is bounded by the read timeout', async () => {
    jest.useFakeTimers();
    try {
      const lookup = jest.fn(() => new Promise(() => {}));
      const pending = read(redirectTo('https://slow.example/api'), 10_000, lookup).catch(
        (err) => err
      );
      await jest.advanceTimersByTimeAsync(1000);
      expect((await pending).message).toBe('no answer within 1000ms');
    } finally {
      jest.useRealTimers();
    }
  });

  test('a browser-style opaque redirect is refused', async () => {
    const fetchImpl = () =>
      Promise.resolve({
        type: 'opaqueredirect',
        status: 0,
        ok: false,
        headers: { get: () => null },
      });
    await expect(read(fetchImpl)).rejects.toThrow('hidden location');
  });

  test('the timeout bounds the whole read, not each page', async () => {
    jest.useFakeTimers();
    try {
      let page = 0;
      // Every page answers in 600ms, under the 1000ms timeout on its own.
      const slowPages = jest.fn(
        (_url, { signal }) =>
          new Promise((resolve, reject) => {
            page += 1;
            const rows = Array.from({ length: 50 }, (_, i) => row(10_000 - page * 50 - i));
            const timer = setTimeout(() => resolve(ok(rows, { more: true })), 600);
            signal.addEventListener('abort', () => {
              clearTimeout(timer);
              reject(new Error('aborted'));
            });
          })
      );
      const started = Date.now();
      const pending = read(slowPages).catch((err) => err);
      await jest.advanceTimersByTimeAsync(5000);
      const err = await pending;
      expect(err).toBeInstanceOf(BlockscoutError);
      expect(err.message).toBe('no answer within 1000ms');
      expect(err.coolMs).toBeGreaterThan(0);
      expect(slowPages).toHaveBeenCalledTimes(2);
      expect(Date.now() - started).toBeLessThanOrEqual(5000);
    } finally {
      jest.useRealTimers();
    }
  });

  test("no failure text matches Ant's range-limit needles", async () => {
    const { antShrinksLogScanOn } = require('../swarm/ant-chain-bridge');
    const failures = [
      () => reply({}, { status: 429 }),
      () => reply('oops', { status: 503 }),
      () => reply('<html>'),
      () => reply({ message: 'Too many requests' }),
      () => reply({ message: 'Query limit exceeded' }),
      () => ok([row(20_000)]),
      () => ok([row(200), row(300)]),
      () => ok([row(200, 0, { from: OTHER })]),
      () => reply({ items: [], next_page_params: { block_number: 1, index: 0 } }),
      () => Promise.reject(new TypeError('fetch failed')),
    ];
    for (const fetchImpl of failures) {
      const err = await read(fetchImpl).catch((error) => error);
      expect(err).toBeInstanceOf(BlockscoutError);
      expect(antShrinksLogScanOn(err.message)).toBe(false);
    }
    let newest = 10_000;
    const err = await read(() => {
      const items = Array.from({ length: 50 }, (_, i) => row(newest - i));
      newest -= 50;
      return ok(items, { more: true });
    }).catch((error) => error);
    expect(antShrinksLogScanOn(err.message)).toBe(false);
  });
});
