const mockEnrollments = new WeakSet();
jest.mock('./railgun-account-enrollment', () => ({
  isRailgunAccountEnrollment: (v) => mockEnrollments.has(v),
}));
const fs = require('fs'),
  os = require('os'),
  path = require('path');
const { createPrivacyScope } = require('../networks/privacy-context');
const { openRailgunAccountStore } = require('./railgun-account-store');
const { createHash } = require('crypto');
const { startRailgunSessionWorker } = require('./railgun-session-worker');
const { railgunSourceBinding } = require('./railgun-source-ledger');
let scope, enrollment, opened, remembered, borrowed, current;
const generationId = '1'.repeat(64);
beforeEach(() => {
  opened = [];
  remembered = new Set();
  borrowed = [];
  scope = createPrivacyScope({ profileId: 'store-fixture', signal: new AbortController().signal });
  const directory = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'railgun-account-store-'))
  );
  fs.mkdirSync(path.join(directory, 'railgun-cache-' + generationId));
  current = { active: null, pending: { id: generationId, policy: '2'.repeat(64) } };
  const keys = async (names, use) => {
    const values = Object.fromEntries(names.map(([name, byte]) => [name, Buffer.alloc(32, byte)]));
    borrowed.push(...Object.values(values));
    try {
      return await use(values);
    } finally {
      Object.values(values).forEach((key) => key.fill(0));
    }
  };
  enrollment = {
    directory,
    binding: '3'.repeat(64),
    signal: scope.signal,
    getContext: (role) =>
      scope.getContext({
        kind: 'private-account',
        principal: 'railgun:0',
        protocol: 'railgun',
        deployment: 'sepolia',
        chainId: 11155111,
        role,
      }),
    profileGuard: {
      assert: () => {
        for (const f of remembered) if (!fs.existsSync(f)) throw Error('missing');
      },
      remember: (f) => {
        expect(fs.existsSync(f)).toBe(true);
        remembered.add(f);
      },
    },
    catalog: { inspect: async () => structuredClone(current) },
    withPublicKeys: (use) =>
      keys(
        [
          ['source-ledger', 41],
          ['public-store', 42],
        ],
        use
      ),
    withGenerationKeys: async (id, use) => {
      expect(id).toBe(generationId);
      return keys([['wallet-store', 43]], use);
    },
    withTxidGenerationKeys: async (_catalog, id, policy, use) => {
      expect(id).toBe(generationId);
      return keys([['txid-store', Number.parseInt(policy.slice(0, 2), 16)]], use);
    },
  };
  mockEnrollments.add(enrollment);
});
test('versioned TXID mirrors coexist with active public stores and bind their own identity and policy key', async () => {
  const directory = path.join(enrollment.directory, 'railgun-public-' + generationId);
  fs.mkdirSync(directory);
  current = {
    active: {
      id: generationId,
      policy: '2'.repeat(64),
      storeId: 'a'.repeat(64),
      ledgerId: 'b'.repeat(64),
    },
    pending: null,
  };
  const publicCatalog = { inspect: async () => structuredClone(current) };
  const options = { kind: 'txid', publicCatalog, generationId, txidPolicy: '4'.repeat(64) };
  const first = await open({ ...options, create: true });
  expect(first.filename).toBe(path.join(directory, 'txid-' + options.txidPolicy + '.sqlite'));
  expect(remembered.has(first.filename)).toBe(true);
  expect(first.storeId).not.toBe(current.active.storeId);
  first.session.close();
  await first.session.closed;
  const second = await open({ ...options, txidPolicy: '5'.repeat(64), create: true });
  expect(second.storeId).not.toBe(first.storeId);
  second.session.close();
  await second.session.closed;
  const cold = await open({ ...options, expectedStoreId: first.storeId });
  expect(cold.storeId).toBe(first.storeId);
  cold.session.close();
  await cold.session.closed;
  await expect(open({ ...options, expectedStoreId: second.storeId })).rejects.toThrow();
  await expect(open({ ...options, publicCatalog: undefined })).rejects.toThrow();
});
test('TXID policy allocation is bounded including interrupted staging attempts', async () => {
  const directory = path.join(enrollment.directory, 'railgun-public-' + generationId);
  fs.mkdirSync(directory);
  const publicCatalog = { inspect: async () => structuredClone(current) };
  for (let i = 0; i < 8; i++)
    fs.writeFileSync(
      path.join(directory, 'txid-' + String(i).repeat(64) + '.init-' + 'a'.repeat(32) + '.sqlite'),
      'retained'
    );
  const options = {
    kind: 'txid',
    publicCatalog,
    generationId,
    txidPolicy: 'f'.repeat(64),
    create: true,
  };
  await expect(open(options)).rejects.toThrow();
  expect(fs.readdirSync(directory)).toHaveLength(8);
});
afterEach(async () => {
  opened.forEach((v) => v.session.close());
  scope.close();
  await Promise.all(opened.map((v) => v.session.closed));
  jest.restoreAllMocks();
});
async function open(options = {}) {
  const value = await openRailgunAccountStore({ enrollment, kind: 'source', ...options });
  opened.push(value);
  return value;
}
test.each(['source', 'public', 'wallet'])(
  'stages %s, authenticates after publication, registers and cold opens the same store',
  async (kind) => {
    const options = { kind, ...(kind === 'wallet' ? { generationId } : {}) };
    await expect(open(options)).rejects.toThrow();
    const first = await open({ ...options, create: true });
    expect(remembered.has(first.filename)).toBe(true);
    expect(fs.readdirSync(path.dirname(first.filename))).not.toEqual(
      expect.arrayContaining([expect.stringContaining('.init-')])
    );
    expect(borrowed.every((k) => k.every((v) => v === 0))).toBe(true);
    await expect(open(options)).rejects.toThrow();
    first.session.close();
    await first.session.closed;
    const cold = await open({ ...options, expectedStoreId: first.storeId });
    expect(cold.storeId).toBe(first.storeId);
    cold.session.close();
    await cold.session.closed;
    await expect(open({ ...options, create: true })).rejects.toThrow();
  }
);
test('active wallet store ID is checked before any session is returned, even without caller expectation', async () => {
  const options = { kind: 'wallet', generationId };
  const first = await open({ ...options, create: true });
  first.session.close();
  await first.session.closed;
  current = { active: { ...current.pending, storeId: 'f'.repeat(64) }, pending: null };
  await expect(open(options)).rejects.toThrow();
  current.active.storeId = first.storeId;
  expect((await open(options)).storeId).toBe(first.storeId);
});
test('failed publication retains encrypted staging and a later explicit creation can proceed', async () => {
  const original = fs.renameSync;
  jest.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
    throw Error('interrupt');
  });
  await expect(open({ create: true })).rejects.toThrow('interrupt');
  const retained = fs.readdirSync(enrollment.directory).filter((n) => n.startsWith('source.init-'));
  expect(retained).toHaveLength(1);
  expect(fs.existsSync(path.join(enrollment.directory, 'source.sqlite'))).toBe(false);
  fs.renameSync.mockImplementation(original);
  await open({ create: true });
  expect(fs.existsSync(path.join(enrollment.directory, retained[0]))).toBe(true);
});
test('staging attempts are bounded and an existing final file is never overwritten', async () => {
  for (let i = 0; i < 8; i++)
    fs.writeFileSync(path.join(enrollment.directory, `source.init-${i}.sqlite`), 'retained');
  await expect(open({ create: true })).rejects.toThrow();
  expect(fs.existsSync(path.join(enrollment.directory, 'source.sqlite'))).toBe(false);
  const final = path.join(enrollment.directory, 'public.sqlite');
  fs.writeFileSync(final, 'existing');
  await expect(open({ kind: 'public', create: true })).rejects.toThrow();
  expect(fs.readFileSync(final, 'utf8')).toBe('existing');
});
test('missing inventoried file, forged enrollment and a symbolic link refuse', async () => {
  const first = await open({ create: true });
  first.session.close();
  await first.session.closed;
  await expect(open({ enrollment: { ...enrollment } })).rejects.toThrow();
  fs.renameSync(first.filename, first.filename + '.preserved');
  await expect(open()).rejects.toThrow('missing');
  await expect(open({ create: true })).rejects.toThrow('missing');
  fs.symlinkSync(first.filename + '.preserved', first.filename);
  await expect(open()).rejects.toThrow();
});
test('vault/profile revocation closes returned workers and prevents reopening', async () => {
  const first = await open({ create: true });
  scope.close();
  await first.session.closed;
  expect(first.session.signal.aborted).toBe(true);
  await expect(open()).rejects.toThrow();
});
test('source metadata survives publication before inventory registration and ledger owns dispatch', async () => {
  const remember = enrollment.profileGuard.remember;
  enrollment.profileGuard.remember = () => {
    throw Error('interrupted inventory');
  };
  await expect(open({ create: true })).rejects.toThrow('interrupted inventory');
  expect(remembered.size).toBe(0);
  enrollment.profileGuard.remember = remember;
  const reopened = await open();
  reopened.ledger.assertEmpty();
  expect(reopened.ledger.identity()).toBe(reopened.storeId);
  const range = {
    from: 0,
    to: { number: 10, hash: '0x' + '1'.repeat(64) },
    previousHash: '0x' + '0'.repeat(64),
    providersSha256: 'b'.repeat(64),
    logs: { count: 0, sha256: createHash('sha256').update('').digest('hex') },
  };
  const reference = await reopened.ledger.stage(range, []);
  expect(() => reopened.ledger.assertEmpty()).toThrow();
  reopened.ledger.close();
  await reopened.session.closed;
  const cold = await open({ expectedStoreId: reopened.storeId });
  expect(await cold.ledger.stage(range, [])).toEqual(reference);
  expect(() => cold.session.claimDispatch()).toThrow();
  await expect(
    cold.session.dispatch(
      JSON.stringify({
        id: 1,
        method: 'get',
        args: { key: Buffer.from('source:meta').toString('base64') },
      })
    )
  ).rejects.toThrow();
  await cold.ledger.closed;
  expect(cold.ledger.signal.aborted).toBe(true);
});
test.each(['missing-meta', 'invalid-meta', 'legacy-binding'])(
  'refuses final source store with %s before inventory registration without replacement',
  async (mode) => {
    const filename = path.join(enrollment.directory, 'source.sqlite');
    const session = startRailgunSessionWorker({
      handle: enrollment.getContext('engine'),
      storage: {
        format: 'paged-v2',
        filename,
        key: Buffer.alloc(32, 41),
        create: true,
        binding:
          mode === 'legacy-binding' ? enrollment.binding : railgunSourceBinding(enrollment.binding),
      },
      createProvider: ({ signal }) => ({
        signal,
        request: async () => {
          throw Error('no RPC');
        },
      }),
      onClose: () => {},
    });
    opened.push({ session });
    await session.ready;
    if (mode === 'invalid-meta')
      await session.dispatch(
        JSON.stringify({
          id: 1,
          method: 'batch',
          args: {
            operations: [
              {
                type: 'put',
                key: Buffer.from('source:meta').toString('base64'),
                value: Buffer.from('{}').toString('base64'),
              },
            ],
          },
        })
      );
    session.close();
    await session.closed;
    const before = fs.readFileSync(filename);
    await expect(open()).rejects.toThrow();
    await expect(open({ create: true })).rejects.toThrow();
    expect(remembered.size).toBe(0);
    expect(fs.readFileSync(filename)).toEqual(before);
  }
);
