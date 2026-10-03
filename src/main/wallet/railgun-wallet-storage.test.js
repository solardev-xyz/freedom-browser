const { createRailgunWalletStorage } = require('./railgun-wallet-storage');
const { paths } = require('./railgun-frontier');
const id = 'a'.repeat(64),
  prefix = paths.metadata().toString();
const walletPrefix = [
  Buffer.from('wallet').toString('hex').padStart(64, '0'),
  id,
  'aa36a7'.padStart(64, '0'),
].join(':');
const b64 = (text) => Buffer.from(text).toString('base64');
let router, publicDispatch, walletDispatch, lifetime, sequence;
function setup() {
  lifetime = new AbortController();
  publicDispatch = jest.fn(async (wire) => {
    const value = JSON.parse(wire);
    return JSON.stringify({ id: value.id, value: value.method === 'open' ? 1 : null });
  });
  walletDispatch = jest.fn(publicDispatch.getMockImplementation());
  router = createRailgunWalletStorage({
    publicSnapshot: { signal: lifetime.signal, dispatch: publicDispatch },
    walletSession: { signal: lifetime.signal, claimDispatch: () => ({ dispatch: walletDispatch }) },
    walletId: id,
  });
  sequence = 0;
}
const call = (channel, method, args, localId = 1) =>
  router.dispatch(
    JSON.stringify({ id: ++sequence, channel, wire: JSON.stringify({ id: localId, method, args }) })
  );
beforeEach(setup);
afterEach(() => router.close());
test('keeps public and derived streams separate and remaps only the enclosing request', async () => {
  const result = JSON.parse(await call('public', 'get', { key: b64(prefix) }));
  expect(result.id).toBe(1);
  expect(JSON.parse(result.value)).toEqual({ id: 1, value: null });
  await call('wallet', 'batch', {
    operations: [{ type: 'put', key: b64(walletPrefix + ':details'), value: b64('derived') }],
  });
  expect(publicDispatch).toHaveBeenCalledTimes(1);
  expect(walletDispatch).toHaveBeenCalledTimes(1);
  expect(JSON.parse(walletDispatch.mock.calls[0][0]).id).toBe(1);
  router.assertIdle();
});
test.each(['batch', 'clear', 'txBegin', 'txRead', 'rpc', 'sourceNext', 'visitSource'])(
  'rejects %s on the public channel before dispatch',
  async (method) => {
    await expect(call('public', method, {})).rejects.toThrow();
    expect(publicDispatch).not.toHaveBeenCalled();
    expect(router.signal.aborted).toBe(true);
  }
);
test.each(['clear', 'txBegin', 'txRead', 'rpc', 'sourceNext', 'visitSource'])(
  'rejects %s on the wallet channel',
  async (method) => {
    await expect(call('wallet', method, {})).rejects.toThrow();
    expect(walletDispatch).not.toHaveBeenCalled();
  }
);
test.each([
  prefix,
  walletPrefix.replace(id, 'b'.repeat(64)),
  walletPrefix + '-outside',
  'nft-token-cache',
])('rejects cross-domain derived key %s', async (key) => {
  await expect(
    call('wallet', 'batch', { operations: [{ type: 'put', key: b64(key), value: b64('value') }] })
  ).rejects.toThrow();
  expect(walletDispatch).not.toHaveBeenCalled();
});
test('a mixed valid/invalid batch reaches neither store', async () => {
  await expect(
    call('wallet', 'batch', {
      operations: [
        { type: 'put', key: b64(walletPrefix + ':valid'), value: b64('value') },
        { type: 'del', key: b64(walletPrefix + ':bad') },
      ],
    })
  ).rejects.toThrow();
  expect(walletDispatch).not.toHaveBeenCalled();
});
test('getMany cannot cross from the tree into another namespace', async () => {
  await expect(
    call('public', 'getMany', { keys: [b64(prefix), b64(walletPrefix)] })
  ).rejects.toThrow();
  expect(publicDispatch).not.toHaveBeenCalled();
});
test('cursor IDs belong to their own channel and block completion until ended', async () => {
  await call('public', 'open', { options: { gte: b64(prefix), lte: b64(prefix + '~') } });
  expect(() => router.assertIdle()).toThrow();
  await call('public', 'nextMany', { cursor: 1, limit: 128 }, 2);
  await call('public', 'end', { cursor: 1 }, 3);
  router.assertIdle();
  await expect(call('wallet', 'next', { cursor: 1 })).rejects.toThrow();
});
test.each([
  {},
  { gte: b64(prefix) },
  { gte: b64(prefix), lte: b64(prefix + '~outside') },
  { gte: b64(prefix), gt: b64(prefix), lte: b64(prefix + '~') },
])('refuses unbounded or ambiguous iterator options', async (options) => {
  await expect(call('public', 'open', { options })).rejects.toThrow();
  expect(publicDispatch).not.toHaveBeenCalled();
});
test('a seek cannot escape the opened public namespace', async () => {
  await call('public', 'open', { options: { gte: b64(prefix), lte: b64(prefix + '~') } });
  await expect(
    call('public', 'seek', { cursor: 1, target: b64(walletPrefix) }, 2)
  ).rejects.toThrow();
  expect(publicDispatch).toHaveBeenCalledTimes(1);
});
test('revocation discards a late storage reply', async () => {
  let resolve;
  publicDispatch.mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      })
  );
  const running = call('public', 'get', { key: b64(prefix) });
  expect(() => router.assertIdle()).toThrow();
  lifetime.abort();
  resolve(JSON.stringify({ id: 1, value: b64('late') }));
  await expect(running).rejects.toThrow();
});
