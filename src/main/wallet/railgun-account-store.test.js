const mockEnrollments = new WeakSet();
jest.mock('./railgun-account-enrollment', () => ({
  isRailgunAccountEnrollment: (v) => mockEnrollments.has(v),
}));
const fs = require('fs'),
  os = require('os'),
  path = require('path');
const { createPrivacyScope } = require('../networks/privacy-context');
const { openRailgunAccountStore } = require('./railgun-account-store');
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
  };
  mockEnrollments.add(enrollment);
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
