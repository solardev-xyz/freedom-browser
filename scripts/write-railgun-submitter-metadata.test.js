/** Offline: synthetic disposable profiles made the way create-railgun-test-profile.js
 * made the live one (the encrypted vault alone), the real identity vault,
 * identity-manager, vault signer and production submitter metadata reader. No
 * Electron, safeStorage, network or real profile. */
const fs = require('fs'),
  os = require('os'),
  path = require('path');
const { createHash } = require('crypto');
const api = require('./write-railgun-submitter-metadata');
const identity = require('../src/main/identity');
const identityManager = require('../src/main/identity-manager');
const signers = require('../src/main/wallet/signers');
const { readMetadata: readRailgunSubmitterMetadata } =
  require('../src/main/identity/railgun-submitter-host').createRailgunSubmitterHost();

const PASSWORD = 'p'.repeat(32);
const NOW = new Date('2026-10-07T20:00:00.000Z');
const OTHER = '0x' + '98'.repeat(20);
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const refused = (step) =>
  expect.objectContaining({ code: 'RAILGUN_SUBMITTER_METADATA_REFUSED', step });
const thrown = (run) => {
  try {
    run();
  } catch (error) {
    return error;
  }
  return null;
};

let root, savedIdentityData, quiet;
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'submitter-metadata-')));
  savedIdentityData = process.env.FREEDOM_IDENTITY_DATA;
  quiet = jest.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  identity.lockVault();
  quiet.mockRestore();
  if (savedIdentityData === undefined) delete process.env.FREEDOM_IDENTITY_DATA;
  else process.env.FREEDOM_IDENTITY_DATA = savedIdentityData;
  fs.rmSync(root, { recursive: true, force: true });
});

// A profile as create-railgun-test-profile.js made it before it wrote the
// metadata: the vault through identity/vault alone, and the disposable marker.
// Production resolves its identity directory (FREEDOM_IDENTITY_DATA here, the
// profile's userData under Electron).
async function vaultOnlyProfile(name = 'profile') {
  const directory = path.join(root, name);
  fs.mkdirSync(directory, { mode: 0o700 });
  const identityDir = path.join(directory, 'identity');
  const mnemonic = await identity.createVault(identityDir, PASSWORD);
  fs.writeFileSync(
    path.join(directory, 'railgun-test-profile.json'),
    JSON.stringify({ version: 1, chainId: 11155111, profileId: 'test', disposable: true }),
    { flag: 'wx', mode: 0o600 }
  );
  process.env.FREEDOM_IDENTITY_DATA = identityDir;
  return { directory, identityDir, mnemonic };
}
async function derive(identityDir) {
  await identity.unlockVault(identityDir, PASSWORD, 0);
  try {
    return await api.deriveSubmitter({ identity, signers });
  } finally {
    identity.lockVault();
  }
}
const listing = (directory) => fs.readdirSync(directory).sort();
const metaFile = (identityDir) => path.join(identityDir, 'vault-meta.json');

test('derives the EOA as identity-manager and the vault signer do, with the vault unlocked', async () => {
  const { identityDir, mnemonic } = await vaultOnlyProfile();
  const keys = identity.deriveAllKeys(mnemonic);
  expect(await derive(identityDir)).toEqual({
    userWallet: { address: keys.userWallet.address },
    beeWallet: { address: keys.beeWallet.address },
  });
  await expect(api.deriveSubmitter({ identity, signers })).rejects.toEqual(refused('vault-locked'));
  // A signer that disagrees with the derivation refuses.
  await identity.unlockVault(identityDir, PASSWORD, 0);
  const lying = { getSigner: () => ({ getAddress: async () => OTHER }) };
  await expect(api.deriveSubmitter({ identity, signers: lying })).rejects.toEqual(
    refused('signer')
  );
});

test('absent: creates identity-manager’s record exclusively and reads it back through production', async () => {
  const { identityDir, mnemonic } = await vaultOnlyProfile();
  expect(() => readRailgunSubmitterMetadata()).toThrow();
  const derived = await derive(identityDir);
  const expected = derived.userWallet.address.toLowerCase();
  const vaultBytes = fs.readFileSync(path.join(identityDir, 'identity-vault.json'));
  const report = api.provisionSubmitterMetadata({ identityDir, derived, expected, now: NOW });
  const text = fs.readFileSync(metaFile(identityDir), 'utf8');
  const vaultCreatedAt = JSON.parse(vaultBytes).createdAt;
  const keys = identity.deriveAllKeys(mnemonic);
  expect(text).toBe(
    JSON.stringify(
      {
        userKnowsPassword: false,
        createdAt: vaultCreatedAt,
        addresses: { userWallet: keys.userWallet.address, beeWallet: keys.beeWallet.address },
      },
      null,
      2
    )
  );
  expect(readRailgunSubmitterMetadata()).toEqual({ index: 0, type: 'mnemonic', address: expected });
  expect(identityManager.getWalletRecord(0)).toMatchObject({
    index: 0,
    name: 'Main Wallet',
    type: 'mnemonic',
    address: keys.userWallet.address,
  });
  // Nothing else changed: the vault keeps its bytes and the directory gains one file.
  expect(fs.readFileSync(path.join(identityDir, 'identity-vault.json')).equals(vaultBytes)).toBe(
    true
  );
  expect(listing(identityDir)).toEqual(['identity-vault.json', 'vault-meta.json']);
  expect(fs.statSync(metaFile(identityDir)).mode & 0o777).toBe(0o600);
  expect(report).toEqual({
    tool: 'railgun-submitter-metadata',
    version: 1,
    result: 'created',
    walletIndex: 0,
    type: 'mnemonic',
    submitter: 'expected-eoa',
    readback: 'production-reader',
    metadataSha256: sha(text),
    createdAtSource: 'existing-vault',
    identityEntries: { before: 1, after: 2 },
    otherEntriesUnchanged: true,
    written: true,
    preservationScope: 'identity-directory-recursive-except-vault-meta',
    profileSideEffects: 'profile-lock-and-electron-userData-not-measured',
    verification: 'full-created-record',
  });
  // Aggregate only: no address, key, mnemonic or password.
  const rendered = JSON.stringify(report).toLowerCase();
  for (const secret of [
    expected,
    keys.beeWallet.address.toLowerCase(),
    keys.userWallet.privateKey.slice(2).toLowerCase(),
    mnemonic.split(' ')[0] + ' ' + mnemonic.split(' ')[1],
    PASSWORD,
  ])
    expect(rendered).not.toContain(secret);
});

test('detects a nested recovery record changing during provisioning', async () => {
  const { identityDir } = await vaultOnlyProfile();
  const derived = await derive(identityDir);
  const store = path.join(identityDir, 'recovery');
  fs.mkdirSync(store);
  const record = path.join(store, 'capsule.json');
  fs.writeFileSync(record, 'original synthetic record');
  const changing = {
    ...fs,
    fsyncSync: (fd) => {
      fs.fsyncSync(fd);
      fs.writeFileSync(record, 'changed synthetic record');
    },
  };
  const failure = thrown(() =>
    api.provisionSubmitterMetadata({
      identityDir,
      derived,
      expected: derived.userWallet.address,
      fsImpl: changing,
    })
  );
  expect(failure).toEqual(refused('changed'));
  expect(failure.written).toBe(true);
  expect(failure.metadataSha256).toBe(sha(fs.readFileSync(metaFile(identityDir))));
});

test('persists a repair outcome and never re-enters an existing evidence directory', async () => {
  const directory = path.join(root, 'evidence');
  const run = jest.fn(async () => {
    expect(JSON.parse(fs.readFileSync(path.join(directory, 'pending.json'))).state).toBe('pending');
    return { tool: 'railgun-submitter-metadata', result: 'created', written: true };
  });
  const result = await api.recordRepair(directory, run);
  expect(JSON.parse(fs.readFileSync(path.join(directory, 'metadata-report.json')))).toEqual(result);
  await expect(api.recordRepair(directory, run)).rejects.toThrow();
  expect(run).toHaveBeenCalledTimes(1);
});

test('a write-then-refused repair persists its write state', async () => {
  const directory = path.join(root, 'evidence');
  const failure = Object.assign(new Error('not logged'), {
    step: 'readback',
    written: true,
    metadataSha256: sha('partial'),
  });
  await expect(
    api.recordRepair(directory, async () => {
      throw failure;
    })
  ).rejects.toBe(failure);
  expect(JSON.parse(fs.readFileSync(path.join(directory, 'metadata-report.json')))).toMatchObject({
    result: 'refused',
    step: 'readback',
    written: true,
    metadataSha256: sha('partial'),
  });
  await expect(api.recordRepair(directory, jest.fn())).rejects.toThrow();
});

test('a symlink in an identity store refuses before creating metadata', async () => {
  const { identityDir } = await vaultOnlyProfile();
  const derived = await derive(identityDir);
  fs.symlinkSync(path.join(root, 'missing'), path.join(identityDir, 'recovery'));
  expect(
    thrown(() =>
      api.provisionSubmitterMetadata({
        identityDir,
        derived,
        expected: derived.userWallet.address,
      })
    )
  ).toEqual(refused('identity-entry'));
  expect(fs.existsSync(metaFile(identityDir))).toBe(false);
});

test('the record matches what identity-manager itself writes for the same mnemonic', async () => {
  const { identityDir, mnemonic } = await vaultOnlyProfile();
  const derived = await derive(identityDir);
  api.provisionSubmitterMetadata({
    identityDir,
    derived,
    expected: derived.userWallet.address,
    now: NOW,
  });
  const ours = JSON.parse(fs.readFileSync(metaFile(identityDir), 'utf8'));
  // identity-manager's own import into another identity directory (Quick Setup).
  const appDir = path.join(root, 'app-identity');
  process.env.FREEDOM_IDENTITY_DATA = appDir;
  await identityManager.importExistingMnemonic(PASSWORD, mnemonic, false);
  await identityManager.lockVault();
  const appText = fs.readFileSync(metaFile(appDir), 'utf8');
  const app = JSON.parse(appText);
  expect(Object.keys(ours)).toEqual(Object.keys(app));
  expect(Object.keys(ours.addresses)).toEqual(Object.keys(app.addresses));
  expect({ ...ours, createdAt: null }).toEqual({ ...app, createdAt: null });
  expect(appText).toBe(
    fs.readFileSync(metaFile(identityDir), 'utf8').replace(ours.createdAt, app.createdAt)
  );
});

test('present and equal: already-present, and nothing changes', async () => {
  const { identityDir } = await vaultOnlyProfile();
  const derived = await derive(identityDir);
  const expected = derived.userWallet.address;
  api.provisionSubmitterMetadata({ identityDir, derived, expected, now: NOW });
  const before = fs.readFileSync(metaFile(identityDir));
  const { mtimeMs } = fs.statSync(metaFile(identityDir));
  const again = api.provisionSubmitterMetadata({
    identityDir,
    derived,
    expected: expected.toLowerCase(),
    now: new Date(NOW.getTime() + 60000),
  });
  expect(again).toMatchObject({
    result: 'already-present',
    metadataSha256: sha(before),
    identityEntries: { before: 2, after: 2 },
  });
  expect(fs.readFileSync(metaFile(identityDir)).equals(before)).toBe(true);
  expect(fs.statSync(metaFile(identityDir)).mtimeMs).toBe(mtimeMs);
  // Also a record the app wrote itself, in its own format and time.
  const appMade = await vaultOnlyProfile('app-made');
  const appDerived = await derive(appMade.identityDir);
  const appRecord = JSON.stringify(
    {
      userKnowsPassword: true,
      createdAt: '2026-01-01T00:00:00.000Z',
      addresses: {
        userWallet: appDerived.userWallet.address,
        beeWallet: appDerived.beeWallet.address,
      },
    },
    null,
    2
  );
  fs.writeFileSync(metaFile(appMade.identityDir), appRecord);
  expect(
    api.provisionSubmitterMetadata({
      identityDir: appMade.identityDir,
      derived: appDerived,
      expected: appDerived.userWallet.address,
    }).result
  ).toBe('already-present');
  expect(fs.readFileSync(metaFile(appMade.identityDir), 'utf8')).toBe(appRecord);
});

test('present and different: refused, and the file is left as found', async () => {
  const { identityDir } = await vaultOnlyProfile();
  const derived = await derive(identityDir);
  const expected = derived.userWallet.address;
  const record = (fields) =>
    JSON.stringify({
      userKnowsPassword: false,
      createdAt: NOW.toISOString(),
      addresses: { userWallet: derived.userWallet.address, beeWallet: derived.beeWallet.address },
      ...fields,
    });
  for (const text of [
    record({ addresses: { userWallet: OTHER, beeWallet: derived.beeWallet.address } }),
    // Wallet 0 of another kind, even at the same address.
    record({
      derivedWallets: [
        { index: 0, name: 'Main Wallet', address: derived.userWallet.address, type: 'ledger' },
      ],
    }),
    // A wallet list without wallet 0.
    record({ derivedWallets: [{ index: 1, name: 'Other', address: derived.userWallet.address }] }),
    'not json',
    '',
  ]) {
    fs.writeFileSync(metaFile(identityDir), text);
    expect(
      thrown(() => api.provisionSubmitterMetadata({ identityDir, derived, expected }))
    ).toEqual(refused('metadata-present-different'));
    expect(fs.readFileSync(metaFile(identityDir), 'utf8')).toBe(text);
  }
  // A symlink in its place is refused and never followed, even to a valid record.
  fs.rmSync(metaFile(identityDir));
  const target = path.join(root, 'elsewhere.json');
  fs.writeFileSync(target, record({}));
  fs.symlinkSync(target, metaFile(identityDir));
  expect(thrown(() => api.provisionSubmitterMetadata({ identityDir, derived, expected }))).toEqual(
    refused('metadata-present-different')
  );
  expect(fs.readFileSync(target, 'utf8')).toBe(record({}));
  expect(fs.lstatSync(metaFile(identityDir)).isSymbolicLink()).toBe(true);
});

test('a wrong or malformed expected address refuses with no write', async () => {
  const { identityDir } = await vaultOnlyProfile();
  const derived = await derive(identityDir);
  const checksummed = derived.userWallet.address;
  const flipped = checksummed.replace(/[a-f]/, (c) => c.toUpperCase());
  const before = listing(identityDir);
  for (const expected of [
    OTHER,
    checksummed.slice(0, 41),
    checksummed.slice(2),
    checksummed + '0',
    // Mixed case must carry a valid checksum.
    ...(flipped === checksummed ? [] : [flipped]),
    undefined,
    0,
  ]) {
    expect(
      thrown(() => api.provisionSubmitterMetadata({ identityDir, derived, expected }))
    ).toEqual(refused('expected-address'));
    expect(listing(identityDir)).toEqual(before);
  }
  // A derivation that does not name the expected account refuses too.
  const misderived = { ...derived, userWallet: { address: OTHER } };
  expect(
    thrown(() =>
      api.provisionSubmitterMetadata({ identityDir, derived: misderived, expected: checksummed })
    )
  ).toEqual(refused('expected-address'));
  expect(fs.existsSync(metaFile(identityDir))).toBe(false);
});

test('concurrent creates: one wins, the other refuses and replaces nothing', async () => {
  const { identityDir } = await vaultOnlyProfile();
  const derived = await derive(identityDir);
  const expected = derived.userWallet.address;
  let winner;
  // The loser found no file, then a concurrent writer completed before its
  // exclusive create.
  const racing = {
    ...fs,
    openSync: (file, flags, mode) => {
      if (flags === 'wx')
        winner = api.provisionSubmitterMetadata({ identityDir, derived, expected, now: NOW });
      return fs.openSync(file, flags, mode);
    },
  };
  expect(
    thrown(() =>
      api.provisionSubmitterMetadata({
        identityDir,
        derived,
        expected,
        now: new Date(NOW.getTime() + 1000),
        fsImpl: racing,
      })
    )
  ).toEqual(refused('metadata-raced'));
  expect(winner.result).toBe('created');
  const text = fs.readFileSync(metaFile(identityDir), 'utf8');
  expect(JSON.parse(text).createdAt).toBe(
    JSON.parse(fs.readFileSync(path.join(identityDir, 'identity-vault.json'))).createdAt
  );
  expect(sha(text)).toBe(winner.metadataSha256);
  expect(readRailgunSubmitterMetadata().address).toBe(expected.toLowerCase());
});

test('an incomplete write is never read as created and is left for diagnosis', async () => {
  const { identityDir } = await vaultOnlyProfile();
  const derived = await derive(identityDir);
  const expected = derived.userWallet.address;
  const short = { ...fs, writeSync: (fd, bytes) => fs.writeSync(fd, bytes, 0, 10, 0) };
  expect(
    thrown(() => api.provisionSubmitterMetadata({ identityDir, derived, expected, fsImpl: short }))
  ).toEqual(refused('metadata-write'));
  const partial = fs.readFileSync(metaFile(identityDir), 'utf8');
  expect(partial).toHaveLength(10);
  expect(thrown(() => api.provisionSubmitterMetadata({ identityDir, derived, expected }))).toEqual(
    refused('metadata-present-different')
  );
  expect(fs.readFileSync(metaFile(identityDir), 'utf8')).toBe(partial);
});

test('refuses an identity directory production would not read, or one without the vault', async () => {
  const { identityDir } = await vaultOnlyProfile();
  const derived = await derive(identityDir);
  const expected = derived.userWallet.address;
  const elsewhere = path.join(root, 'elsewhere');
  fs.mkdirSync(elsewhere);
  process.env.FREEDOM_IDENTITY_DATA = elsewhere;
  expect(thrown(() => api.provisionSubmitterMetadata({ identityDir, derived, expected }))).toEqual(
    refused('identity-directory')
  );
  process.env.FREEDOM_IDENTITY_DATA = identityDir;
  for (const directory of [identityDir + '/', 'identity', path.join(root, 'missing')])
    expect(
      thrown(() => api.provisionSubmitterMetadata({ identityDir: directory, derived, expected }))
    ).toEqual(refused('identity-directory'));
  const linked = path.join(root, 'linked-identity');
  fs.symlinkSync(identityDir, linked);
  process.env.FREEDOM_IDENTITY_DATA = linked;
  expect(
    thrown(() => api.provisionSubmitterMetadata({ identityDir: linked, derived, expected }))
  ).toEqual(refused('identity-directory'));
  process.env.FREEDOM_IDENTITY_DATA = elsewhere;
  expect(
    thrown(() => api.provisionSubmitterMetadata({ identityDir: elsewhere, derived, expected }))
  ).toEqual(refused('vault'));
  expect(listing(elsewhere)).toEqual([]);
  expect(listing(identityDir)).toEqual(['identity-vault.json']);
});

test('main refuses bad arguments before any profile, Electron readiness or vault access', async () => {
  const entered = [];
  const enter = (name) => () => {
    entered.push(name);
    throw Error(name + ' entered');
  };
  const { directory } = await vaultOnlyProfile();
  const saved = process.argv;
  jest.doMock('electron', () => ({
    app: { isPackaged: false, whenReady: enter('app-ready') },
    safeStorage: { isEncryptionAvailable: enter('safe-storage'), decryptString: enter('decrypt') },
  }));
  jest.doMock('../src/main/profile-resolver', () => ({ initializeProfile: enter('profile') }));
  try {
    let fresh;
    jest.isolateModules(() => {
      fresh = require('./write-railgun-submitter-metadata');
    });
    delete process.env.FREEDOM_IDENTITY_DATA;
    for (const [argv, step] of [
      [[directory], 'arguments'],
      [[directory, OTHER, 'extra'], 'arguments'],
      [['profile', OTHER], 'environment'],
      [[directory, OTHER.slice(0, 20)], 'expected-address'],
      [[path.join(root, 'missing'), OTHER], 'profile'],
      [[directory + '/', OTHER], 'profile'],
    ]) {
      process.argv = ['electron', 'scripts/write-railgun-submitter-metadata.js', ...argv];
      await expect(fresh.main()).rejects.toEqual(refused(step));
    }
    process.env.FREEDOM_IDENTITY_DATA = path.join(directory, 'identity');
    process.argv = ['electron', 'scripts/write-railgun-submitter-metadata.js', directory, OTHER];
    await expect(fresh.main()).rejects.toEqual(refused('environment'));
    expect(entered).toEqual([]);
    expect(listing(path.join(directory, 'identity'))).toEqual(['identity-vault.json']);
  } finally {
    process.argv = saved;
    jest.dontMock('electron');
    jest.dontMock('../src/main/profile-resolver');
  }
});

test('fixed host repair output keeps its historical directory without importing the removed campaign', () => {
  const source = fs.readFileSync(require.resolve('./write-railgun-submitter-metadata'), 'utf8');
  const expression = /const evidence = (path\.join\([\s\S]*?\));/.exec(source);
  expect(expression).not.toBeNull();
  const actual = Function('path', '__dirname', `return ${expression[1]};`)(path, __dirname);
  expect(actual).toBe(
    path.join(__dirname, '..', 'tmp/privacy-research-oct7-l-a', 'metadata-repair-1')
  );
  expect(source).not.toContain("require('./lib/railgun-metadata-continuation')");
});
