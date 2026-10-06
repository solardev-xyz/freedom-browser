const {
  BlockscoutError,
  BLOCKSCOUT_MAX_PAGES,
  ERC20_TRANSFER_TOPIC,
  blockscoutLogToRpcLog,
  fetchBlockscoutTransferLogs,
  isLocalHostname,
  logIndexFilter,
  logsAgree,
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

describe('mapping (captured from both providers, 2026-10-05)', () => {
  test("each Blockscout log maps onto the RPC's entry for it, field for field", () => {
    expect(captured.blockscout.result).toHaveLength(captured.rpc.length);
    captured.blockscout.result.forEach((row, index) => {
      const { blockHash, blockTimestamp, ...rpcEntry } = captured.rpc[index];
      expect(blockHash).toMatch(/^0x[0-9a-f]{64}$/);
      expect(blockTimestamp).toBeDefined();
      // Topics lose Blockscout's null padding; gasPrice, gasUsed and timeStamp
      // are dropped; blockHash, which the index does not report, stays out.
      expect(blockscoutLogToRpcLog(row)).toEqual(rpcEntry);
    });
  });

  test('the two captured answers agree', () => {
    const mapped = captured.blockscout.result.map(blockscoutLogToRpcLog);
    expect(logsAgree(mapped, captured.rpc)).toBe(true);
    // Order and spelling do not matter.
    const shouted = [...captured.rpc].reverse().map((log) => ({
      ...log,
      address: log.address.toUpperCase().replace('0X', '0x'),
      blockNumber: `0x000${log.blockNumber.slice(2)}`,
    }));
    expect(logsAgree(mapped, shouted)).toBe(true);
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
      'a different transaction index',
      (rpc) => [{ ...rpc[0], transactionIndex: '0x7' }, ...rpc.slice(1)],
    ],
    ['a removed log', (rpc) => [{ ...rpc[0], removed: true }, ...rpc.slice(1)]],
    ['a duplicate in place of a log', (rpc) => [rpc[1], ...rpc.slice(1)]],
    ['a malformed entry', (rpc) => [{ ...rpc[0], blockNumber: 12 }, ...rpc.slice(1)]],
    ['no list', () => null],
  ])('they disagree with %s', (_label, change) => {
    const mapped = captured.blockscout.result.map(blockscoutLogToRpcLog);
    expect(logsAgree(mapped, change(captured.rpc))).toBe(false);
  });
});

// The RPC's entries are what Ant receives, so they must be in the exact shape
// Ant reads, not only agree with Blockscout once both are canonicalised.
describe('the RPC entries must have the exact shape Ant reads', () => {
  const mapped = () => captured.blockscout.result.map(blockscoutLogToRpcLog);
  const first = (change) => (rpc) => [{ ...rpc[0], ...change(rpc[0]) }, ...rpc.slice(1)];
  const WORD = `0x${'0'.repeat(63)}1`;

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
    expect(logsAgree(mapped(), rpc)).toBe(false);
  });

  // A malformed RPC value never agrees, even with a Blockscout row that is
  // malformed the same way (Blockscout's rows are held to the same encoding
  // when they are read: fetchBlockscoutTransferLogs).
  test('a two-word value disagrees even when Blockscout reports the same', () => {
    const data = `${WORD}${'0'.repeat(64)}`;
    const indexed = mapped().map((log, i) => (i === 0 ? { ...log, data } : log));
    const rpc = captured.rpc.map((log, i) => (i === 0 ? { ...log, data } : log));
    expect(logsAgree(indexed, rpc)).toBe(false);
  });
});

// A Blockscout log row, as its logs API returns one (see the fixture).
const row = (block, logIndex = 0, { from = WALLET, to = OTHER } = {}) => ({
  address: XBZZ.toLowerCase(),
  blockNumber: `0x${block.toString(16)}`,
  data: `0x${'0'.repeat(63)}1`,
  gasPrice: '0x1',
  gasUsed: '0x1',
  logIndex: `0x${logIndex.toString(16)}`,
  timeStamp: '0x1',
  topics: [ERC20_TRANSFER_TOPIC, from, to, null],
  transactionHash: `0x${block.toString(16).padStart(32, '0')}${logIndex.toString(16).padStart(32, '0')}`,
  transactionIndex: '0x0',
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
const ok = (rows) => reply({ status: '1', message: 'OK', result: rows });
const NO_LOGS = { status: '0', message: 'No logs found', result: [] };

describe('fetchBlockscoutTransferLogs', () => {
  const filter = logIndexFilter(100, antFilter({ fromBlock: '0x64', toBlock: '0x2710' }));
  // Off-origin redirect hops are resolved before they are dialled; tests
  // never reach the real resolver.
  const publicLookup = jest.fn(async () => [{ address: '104.18.12.34', family: 4 }]);
  const read = (fetchImpl, toBlock = 10_000, lookup = publicLookup) =>
    fetchBlockscoutTransferLogs(filter, toBlock, { timeoutMs: 1000, fetchImpl, lookup });
  const queryOf = (url) => Object.fromEntries(new URL(url).searchParams);

  test("asks Blockscout's logs API for exactly the filter, and maps the answer", async () => {
    const fetchImpl = jest.fn(() => ok([row(200), row(300, 2)]));
    const logs = await read(fetchImpl, 5000);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url.startsWith('https://gnosis.blockscout.com/api?')).toBe(true);
    expect(queryOf(url)).toEqual({
      module: 'logs',
      action: 'getLogs',
      fromBlock: '100',
      toBlock: '5000',
      address: XBZZ.toLowerCase(),
      topic0: ERC20_TRANSFER_TOPIC,
      topic1: WALLET,
      topic0_1_opr: 'and',
    });
    // Nothing but the filter: no credentials, no referrer.
    expect(init).toMatchObject({
      method: 'GET',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
    });
    expect(logs.map((log) => [log.blockNumber, log.logIndex])).toEqual([
      ['0xc8', '0x0'],
      ['0x12c', '0x2'],
    ]);
    expect(logs[0]).toEqual({ ...blockscoutLogToRpcLog(row(200)), removed: false });
  });

  test('a recipient scan names topic2 and its operator', async () => {
    const fetchImpl = jest.fn(() => reply(NO_LOGS));
    const recipient = logIndexFilter(
      100,
      antFilter({ topics: [ERC20_TRANSFER_TOPIC, null, WALLET] })
    );
    await fetchBlockscoutTransferLogs(recipient, 10, { timeoutMs: 1000, fetchImpl });
    const query = queryOf(fetchImpl.mock.calls[0][0]);
    expect(query).toMatchObject({ topic2: WALLET, topic0_2_opr: 'and' });
    expect(query.topic1).toBeUndefined();
  });

  test('"No logs found" is an empty answer', async () => {
    expect(await read(() => reply(NO_LOGS))).toEqual([]);
  });

  test('a page at the 1,000-log cap is never taken as complete: the next is read from its last block', async () => {
    // 999 logs in blocks 101..1099, then the cap cuts block 1100 part-way.
    const first = [
      ...Array.from({ length: 998 }, (_, i) => row(101 + i)),
      row(1100, 0),
      row(1100, 1),
    ];
    const second = [row(1100, 0), row(1100, 1), row(1100, 2), row(5000)];
    const fetchImpl = jest
      .fn()
      .mockImplementationOnce(() => ok(first))
      .mockImplementationOnce(() => ok(second));
    const logs = await read(fetchImpl);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(queryOf(fetchImpl.mock.calls[1][0])).toMatchObject({
      fromBlock: '1100',
      toBlock: '10000',
    });
    expect(logs).toHaveLength(998 + 4);
    expect(logs.filter((log) => log.blockNumber === '0x44c')).toHaveLength(3);
  });

  test('a capped page whose logs all sit in one block cannot be read on', async () => {
    const fetchImpl = () => ok(Array.from({ length: 1000 }, (_, i) => row(500, i)));
    await expect(read(fetchImpl)).rejects.toThrow('one block fills a whole page');
  });

  test(`more than ${BLOCKSCOUT_MAX_PAGES} full pages fail rather than return part of the answer`, async () => {
    let page = 0;
    const fetchImpl = jest.fn(() => {
      const base = 101 + page * 1000;
      page += 1;
      return ok(Array.from({ length: 1000 }, (_, i) => row(base + i)));
    });
    await expect(read(fetchImpl)).rejects.toThrow(`over ${BLOCKSCOUT_MAX_PAGES} pages`);
    expect(fetchImpl).toHaveBeenCalledTimes(BLOCKSCOUT_MAX_PAGES);
  });

  test.each([
    ['a log outside the range', [row(20_000)], 'outside the filter'],
    ['a log from another sender', [row(200, 0, { from: OTHER })], 'outside the filter'],
    [
      'a log of another contract',
      [{ ...row(200), address: `0x${'1'.repeat(40)}` }],
      'outside the filter',
    ],
    ['a malformed log', [{ ...row(200), transactionHash: '0x12' }], 'outside the filter'],
    ['logs out of order', [row(300), row(200)], 'out of order'],
  ])('%s fails the read', async (_label, rows, message) => {
    await expect(read(() => ok(rows))).rejects.toThrow(message);
  });

  test('a 429 cools Blockscout down for the reset it names, within bounds', async () => {
    const limited = (reset) =>
      read(() =>
        reply(
          { status: '0', message: 'Too many requests', result: null },
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
    ['a value of two words', { data: `0x${'0'.repeat(127)}1` }],
    ['an empty value', { data: '0x' }],
    ['a recipient topic that is not an address', { to: `0x${'1'.repeat(64)}` }],
  ])('a Blockscout row with %s is not in the encoding Ant reads', async (_label, change) => {
    const bad = { ...row(200, 0, change.to ? { to: change.to } : {}) };
    if (change.data) bad.data = change.data;
    await expect(read(() => ok([bad]))).rejects.toThrow('outside the filter');
  });

  test('a recipient scan refuses a Blockscout row whose sender topic is not an address', async () => {
    const recipient = logIndexFilter(
      100,
      antFilter({
        fromBlock: '0x64',
        toBlock: '0x2710',
        topics: [ERC20_TRANSFER_TOPIC, null, OTHER],
      })
    );
    const bad = row(200, 0, { from: `0x${'1'.repeat(64)}` });
    await expect(
      fetchBlockscoutTransferLogs(recipient, 10_000, {
        timeoutMs: 1000,
        fetchImpl: () => ok([bad]),
      })
    ).rejects.toThrow('outside the filter');
    // The same row with an address sender is read.
    const good = row(200, 0);
    await expect(
      fetchBlockscoutTransferLogs(recipient, 10_000, {
        timeoutMs: 1000,
        fetchImpl: () => ok([good]),
      })
    ).resolves.toHaveLength(1);
  });

  test.each([
    ['HTTP 500', () => reply('oops', { status: 500 }), 'HTTP 500'],
    ['an answer that is not JSON', () => reply('<html>'), 'not JSON'],
    [
      'a refusal',
      () => reply({ status: '0', message: 'Invalid address format', result: null }),
      'refused',
    ],
    [
      'a throttle in the body',
      () => reply({ status: '0', message: 'Too many requests. Increase limits', result: null }),
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
    expect(queryOf(second.toString()).topic1).toBe(WALLET);
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
            const rows = Array.from({ length: 1000 }, (_, i) => row(page * 1000 + i));
            const timer = setTimeout(() => resolve(ok(rows)), 600);
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
      () => reply({ status: '0', message: 'Too many requests', result: null }),
      () => reply({ status: '0', message: 'Query limit exceeded', result: null }),
      () => ok([row(20_000)]),
      () => ok([row(300), row(200)]),
      () => ok(Array.from({ length: 1000 }, (_, i) => row(500, i))),
      () => Promise.reject(new TypeError('fetch failed')),
    ];
    for (const fetchImpl of failures) {
      const err = await read(fetchImpl).catch((error) => error);
      expect(err).toBeInstanceOf(BlockscoutError);
      expect(antShrinksLogScanOn(err.message)).toBe(false);
    }
    let page = 0;
    const err = await read(() => {
      page += 1;
      return ok(Array.from({ length: 1000 }, (_, i) => row(page * 1000 + i)));
    }).catch((error) => error);
    expect(antShrinksLogScanOn(err.message)).toBe(false);
  });
});
