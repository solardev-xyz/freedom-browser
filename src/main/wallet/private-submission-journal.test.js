jest.mock('../profile-resolver', () => ({ getActiveProfile: () => mockProfile }));
jest.mock('../identity/vault', () => ({
  getSessionSignal: () => mockVault.signal,
  getMnemonic: () => mockMnemonic,
}));
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { createHash } = require('crypto');
const { createPrivacyScope } = require('../networks/privacy-context');
const {
  createSubmissionJournal,
  getPrivateSubmissionJournal,
} = require('./private-submission-journal');
let directory, scope, handle, journal, mockProfile, mockVault;
const mockMnemonic = 'test test test test test test test test test test test junk';
const key = Buffer.alloc(32, 3);
const hash = `0x${'a'.repeat(64)}`;
const subject = {
  kind: 'public-address',
  principal: `0x${'1'.repeat(40)}`,
  chainId: 11155111,
  role: 'transaction-rpc',
};
const scopes = [];
function open(profileId = 'fixture', owner = subject) {
  const session = createPrivacyScope({ profileId, signal: mockVault.signal });
  scopes.push(session);
  return { scope: session, handle: session.getContext(owner) };
}
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'submission-journal-fixture-'));
  mockProfile = { id: 'fixture', userDataDir: directory };
  mockVault = new AbortController();
  ({ scope, handle } = open());
  journal = createSubmissionJournal({ handle, directory, key });
});
afterEach(() => {
  scopes.splice(0).forEach((value) => value.close());
  jest.restoreAllMocks();
});

test('an attempted hash survives an actual process exit and a fresh context without storing signed bytes', async () => {
  const root = path.resolve(__dirname, '../..');
  execFileSync(process.execPath, [
    '-e',
    `
    const { createPrivacyScope } = require(${JSON.stringify(path.join(root, 'main/networks/privacy-context'))});
    const { createSubmissionJournal } = require(${JSON.stringify(path.join(root, 'main/wallet/private-submission-journal'))});
    const scope = createPrivacyScope({ profileId: 'fixture', signal: new AbortController().signal });
    const handle = scope.getContext(${JSON.stringify(subject)});
    createSubmissionJournal({handle, directory: process.argv[1], key: Buffer.alloc(32, 3)})
      .begin(${JSON.stringify(hash)}, 7).then(() => process.exit(0));
  `,
    directory,
  ]);
  expect(await journal.list()).toEqual([
    expect.objectContaining({ hash, nonce: 7, state: 'attempted' }),
  ]);
  const bytes = fs.readFileSync(path.join(directory, fs.readdirSync(directory)[0]), 'utf8');
  expect(bytes).not.toContain(hash);
  expect(bytes).not.toContain(subject.principal);
  await expect(journal.assertCanSubmit()).rejects.toMatchObject({
    code: 'PRIVATE_SUBMISSION_UNRESOLVED',
  });
  await expect(journal.begin(hash, 7)).rejects.toMatchObject({
    code: 'PRIVATE_BROADCAST_ALREADY_ATTEMPTED',
  });
});

test('multiple adapters cannot race past the durable reservation, even with different transaction hashes', async () => {
  const other = createSubmissionJournal({ handle, directory, key });
  const attempts = await Promise.allSettled([
    journal.begin(hash, 0),
    other.begin(`0x${'b'.repeat(64)}`, 1),
  ]);
  expect(attempts.map((r) => r.status)).toEqual(['fulfilled', 'rejected']);
  expect(attempts[1].reason.code).toBe('PRIVATE_SUBMISSION_UNRESOLVED');
  expect(await other.list()).toHaveLength(1);
});

test('a partial public intent survives reopening and retains its unresolved nonce without private amounts', async () => {
  const { record, transaction } =
    require('../../../scripts/fixtures/railgun-partial-own-txid-data').samplePartial();
  const owner = { ...subject, principal: transaction.from };
  scope.close();
  ({ scope, handle } = open('fixture', owner));
  journal = createSubmissionJournal({ handle, directory, key });
  await journal.begin(record.hash, record.nonce, record.intent);
  const before = await journal.list();
  expect(before[0].intent).toEqual(record.intent);
  expect(before[0].intent.version).toBe(2);
  expect(before[0].intent.operation).toBe('railgun-partial-unshield');
  expect(before[0].intent.inputAmount).toBeUndefined();
  expect(before[0].intent.changeAmount).toBeUndefined();
  scope.close();
  const reopened = createSubmissionJournal({
    handle: open('fixture', owner).handle,
    directory,
    key,
  });
  const after = await reopened.list();
  expect(JSON.stringify(after)).toBe(JSON.stringify(before));
  expect(Object.isFrozen(after[0].intent)).toBe(true);
  await expect(reopened.assertCanSubmit()).rejects.toMatchObject({
    code: 'PRIVATE_SUBMISSION_UNRESOLVED',
  });
  await expect(reopened.begin(record.hash, record.nonce, record.intent)).rejects.toMatchObject({
    code: 'PRIVATE_BROADCAST_ALREADY_ATTEMPTED',
  });
  await expect(reopened.selectNonce(record.nonce + 1)).rejects.toMatchObject({
    code: 'PRIVATE_SUBMISSION_UNRESOLVED',
  });
});

test('initialization cannot erase a concurrent attempt and does not reset its nonce floor', async () => {
  const initial = journal.initialize();
  await journal.begin(hash, 7);
  await initial;
  expect(await journal.list()).toHaveLength(1);
  await expect(journal.selectNonce(0)).rejects.toMatchObject({
    code: 'PRIVATE_SUBMISSION_UNRESOLVED',
  });
});

test('nonce floor survives resolved-history archival and rejects unsafe quantities', async () => {
  await journal.begin(hash, 7, { kind: 'ppv2-register-auth', digest: `0x${'b'.repeat(64)}` });
  await journal.observe(
    hash,
    {
      status: 'included',
      trust: 'unverified',
      observedAt: 1,
      confirmations: 12,
      blockNumber: 20,
      blockHash: `0x${'c'.repeat(64)}`,
    },
    0
  );
  const clock = jest.spyOn(Date, 'now').mockReturnValue(Date.now() - 2 * 86400000);
  await journal.resolve(hash, 1, 12);
  clock.mockRestore();
  expect(await journal.selectNonce(2)).toBe(8);
  await journal.archiveResolved(
    [{ hash, revision: 2 }],
    [{ blockNumber: 30, blockHash: `0x${'d'.repeat(64)}` }]
  );
  expect(await journal.list()).toEqual([]);
  expect(await journal.selectNonce(2)).toBe(8);
  expect(await journal.selectNonce(12)).toBe(12);
  for (const value of [-1, NaN, Number.MAX_SAFE_INTEGER + 1])
    await expect(journal.selectNonce(value)).rejects.toMatchObject({
      code: 'PRIVATE_JOURNAL_INVALID',
    });
});

test('failed pre-handoff commit leaves no attempt; failed acknowledgment preserves the prior attempted state', async () => {
  const rename = jest.spyOn(fs, 'renameSync').mockImplementation(() => {
    throw new Error('disk unavailable');
  });
  await expect(journal.begin(hash, 0)).rejects.toMatchObject({
    code: 'PRIVATE_STORAGE_WRITE_FAILED',
  });
  expect(await journal.list()).toEqual([]);
  rename.mockRestore();
  await journal.begin(hash, 0);
  jest.spyOn(fs, 'renameSync').mockImplementation(() => {
    throw new Error('disk unavailable');
  });
  await expect(journal.markSubmitted(hash)).rejects.toMatchObject({
    code: 'PRIVATE_STORAGE_WRITE_FAILED',
  });
  expect((await journal.list())[0].state).toBe('attempted');
});

test('one snapshot remains coherent across a concurrent archival transition', async () => {
  await journal.begin(hash, 7, { kind: 'ppv2-register-auth', digest: `0x${'b'.repeat(64)}` });
  await journal.observe(
    hash,
    {
      status: 'included',
      trust: 'unverified',
      observedAt: 1,
      confirmations: 12,
      blockNumber: 20,
      blockHash: `0x${'c'.repeat(64)}`,
    },
    0
  );
  const clock = jest.spyOn(Date, 'now').mockReturnValue(Date.now() - 2 * 86400000);
  await journal.resolve(hash, 1, 12);
  clock.mockRestore();
  const pending = journal.readSnapshot();
  await journal.archiveResolved(
    [{ hash, revision: 2 }],
    [{ blockNumber: 30, blockHash: `0x${'d'.repeat(64)}` }]
  );
  const before = await pending;
  expect(before.records.map((record) => record.hash)).toEqual([hash]);
  expect(before.archive).toEqual([]);
  const after = await journal.readSnapshot();
  expect(after.records).toEqual([]);
  expect(after.archive.map((record) => record.hash)).toEqual([hash]);
  const frozen = (value) => {
    if (value && typeof value === 'object') {
      expect(Object.isFrozen(value)).toBe(true);
      Object.values(value).forEach(frozen);
    }
  };
  frozen(before);
  frozen(after);
  expect(Reflect.set(before.records[0].intent, 'digest', 'changed')).toBe(false);
  expect(Reflect.set(after.archive[0].finalized, 'blockNumber', 0)).toBe(false);
  expect(await journal.readSnapshot()).toEqual(after);
});

test('snapshot revokes a pending read and does not create a missing journal', async () => {
  expect(await journal.readSnapshot()).toEqual({ records: [], archive: [] });
  expect(fs.readdirSync(directory)).toEqual([]);
  await journal.begin(hash, 7);
  const pending = journal.readSnapshot();
  scope.close();
  await expect(pending).rejects.toMatchObject({ code: 'PRIVACY_CONTEXT_REVOKED' });
  await expect(journal.readSnapshot()).rejects.toMatchObject({ code: 'PRIVACY_CONTEXT_REVOKED' });
});

test.each([1, 2, 3, 4])(
  'snapshot preserves journal version %i without migrating bytes',
  async (version) => {
    const storage = require('./privacy-storage').createPrivacyStorage({ handle, directory, key });
    const record = { hash, nonce: 7, state: 'attempted', attemptedAt: 0 };
    await storage.set(
      'submissions-v1',
      JSON.stringify({
        version,
        records: [record],
        ...(version === 1 ? {} : { archive: [] }),
      })
    );
    const file = path.join(directory, fs.readdirSync(directory)[0]);
    const bytes = fs.readFileSync(file);
    expect(await journal.readSnapshot()).toEqual({ records: [record], archive: [] });
    expect(fs.readFileSync(file)).toEqual(bytes);
  }
);

test('snapshot uses the shared decoder and refuses inconsistent or unreadable state', async () => {
  const storage = require('./privacy-storage').createPrivacyStorage({ handle, directory, key });
  const record = { hash, nonce: 7, state: 'attempted', attemptedAt: 0 };
  const archived = {
    hash,
    nonce: 7,
    status: 'included',
    blockNumber: 20,
    blockHash: `0x${'c'.repeat(64)}`,
    archivedAt: 1,
    finalized: { blockNumber: 30, blockHash: `0x${'d'.repeat(64)}` },
  };
  for (const state of [
    { version: 4, records: [record, record], archive: [] },
    { version: 4, records: [{ ...record, nonce: 8 }], archive: [archived] },
    {
      version: 4,
      records: [],
      archive: [
        { ...archived, nonce: 8 },
        { ...archived, hash: `0x${'b'.repeat(64)}` },
      ],
    },
    { version: 4, records: [{ ...record, nonce: -1 }], archive: [] },
  ]) {
    await storage.set('submissions-v1', JSON.stringify(state));
    await expect(journal.readSnapshot()).rejects.toMatchObject({ code: 'PRIVATE_JOURNAL_INVALID' });
  }
  const file = path.join(directory, fs.readdirSync(directory)[0]);
  fs.writeFileSync(file, 'invalid encrypted data');
  await expect(journal.readSnapshot()).rejects.toMatchObject({
    code: 'PRIVATE_STORAGE_UNREADABLE',
  });
});

test('failure after rename reports the possibly durable hash and cannot authorize a retry', async () => {
  const guarded = createSubmissionJournal({
    handle,
    directory,
    key,
    profileGuard: {
      assert() {},
      remember() {
        throw new Error('inventory write failed after journal rename');
      },
    },
  });
  await expect(guarded.begin(hash, 7)).rejects.toMatchObject({
    code: 'PRIVATE_BROADCAST_UNCERTAIN',
    transactionHash: hash,
    submissionStatus: 'unknown',
  });
  expect(await journal.list()).toEqual([
    expect.objectContaining({ hash, nonce: 7, state: 'attempted' }),
  ]);
  await expect(journal.assertCanSubmit()).rejects.toMatchObject({
    code: 'PRIVATE_SUBMISSION_UNRESOLVED',
  });
});

test('lock revokes the old journal; the same account can reopen and read an acknowledged send', async () => {
  await journal.begin(hash, 0);
  await journal.markSubmitted(hash);
  const inFlightRead = journal.list();
  scope.close();
  await expect(inFlightRead).rejects.toMatchObject({ code: 'PRIVACY_CONTEXT_REVOKED' });
  await expect(journal.list()).rejects.toMatchObject({ code: 'PRIVACY_CONTEXT_REVOKED' });
  const restored = createSubmissionJournal({ handle: open().handle, directory, key });
  expect((await restored.list())[0].state).toBe('submitted');
  // RPC acknowledgment is not finality and cannot authorize another send.
  await expect(restored.assertCanSubmit()).rejects.toMatchObject({
    code: 'PRIVATE_SUBMISSION_UNRESOLVED',
  });
});

test('production factory restores its vault-derived key and refuses a mismatched profile', async () => {
  const profileId = createHash('sha256')
    .update(JSON.stringify([mockProfile.id, directory]))
    .digest('hex');
  const first = open(profileId);
  await getPrivateSubmissionJournal(first.handle).begin(hash, 2);
  first.scope.close();
  const restored = getPrivateSubmissionJournal(open(profileId).handle);
  expect(await restored.has(hash)).toBe(true);
  expect(() => getPrivateSubmissionJournal(handle)).toThrow(
    expect.objectContaining({ code: 'PRIVATE_JOURNAL_SCOPE' })
  );
  mockVault.abort();
  await expect(restored.list()).rejects.toMatchObject({ code: 'PRIVACY_CONTEXT_REVOKED' });
});

test('corruption or another key fails closed, and operation-specific contexts cannot bypass account serialization', async () => {
  await journal.begin(hash, 0);
  const wrongKey = createSubmissionJournal({ handle, directory, key: Buffer.alloc(32, 4) });
  await expect(wrongKey.assertCanSubmit()).rejects.toMatchObject({
    code: 'PRIVATE_STORAGE_UNREADABLE',
  });
  const file = path.join(directory, fs.readdirSync(directory)[0]);
  fs.writeFileSync(file, '{}');
  await expect(journal.list()).rejects.toMatchObject({ code: 'PRIVATE_STORAGE_UNREADABLE' });
  expect(() =>
    createSubmissionJournal({
      handle: open('fixture', { ...subject, operation: 'bypass' }).handle,
      directory,
      key,
    })
  ).toThrow(expect.objectContaining({ code: 'PRIVATE_JOURNAL_SCOPE' }));
});

// Authenticated encrypted structural histories; no resolution permit or network
// authority is invented. Every seeded history must pass the real journal decoder.
const word = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
const railgunKinds = [
  'railgun-private-transfer',
  'railgun-token-unshield',
  'railgun-partial-unshield',
];
function railgunIntent(kind, { tree = 0, nullifier = word(10) } = {}) {
  const {
    createRailgunPartialCapsuleData,
    createRailgunLegacyCapsuleData,
  } = require('../../../scripts/fixtures/railgun-partial-capsule-data');
  const f =
    kind === 'railgun-partial-unshield'
      ? createRailgunPartialCapsuleData()
      : createRailgunLegacyCapsuleData(kind);
  f.inner.boundParams.treeNumber = tree;
  f.inner.nullifiers = [nullifier];
  return require('./railgun-transact-intent').railgunTransactJournalIntent({
    ...f.capsule.preparation.transaction,
    from: subject.principal,
    data: f.encode(),
  });
}
function railgunHistory(kind, archived, reverted = false) {
  const record =
    kind === 'railgun-partial-unshield'
      ? require('../../../scripts/fixtures/railgun-partial-own-txid-data').samplePartial({
          archived,
        }).record
      : require('../../../scripts/fixtures/railgun-own-txid-data').sample(
          kind === 'railgun-token-unshield',
          archived
        ).record;
  if (reverted) {
    if (archived) record.status = 'reverted';
    else record.observation.status = 'reverted';
    const outcome = archived ? record.railgun : record.resolution.railgun;
    outcome.outcome = 'reverted';
    outcome.transact = null;
  }
  return record;
}
async function seedSubmissionHistory(record, archived, version = 4) {
  const state = { records: archived ? [] : [record], archive: archived ? [record] : [] };
  const storage = require('./privacy-storage').createPrivacyStorage({ handle, directory, key });
  await storage.set(
    'submissions-v1',
    JSON.stringify({
      version,
      records: state.records,
      ...(version === 1 ? {} : { archive: state.archive }),
    })
  );
  expect(await journal.readSnapshot()).toEqual(state);
  const file = require('./privacy-storage').getPrivacyStoragePath(handle, directory);
  return { file, bytes: fs.readFileSync(file) };
}
describe.each(railgunKinds)('permanent Railgun attempt exclusion for %s', (kind) => {
  test.each(['attempted', 'submitted', 'pending', 'reorged'])(
    'active %s blocks a different hash and higher nonce before generic unresolved refusal',
    async (state) => {
      const intent = railgunIntent(kind);
      await journal.begin(word(101), 1, intent);
      if (state === 'submitted') await journal.markSubmitted(word(101));
      if (state === 'pending' || state === 'reorged')
        await journal.observe(
          word(101),
          {
            status: state,
            trust: 'unverified',
            observedAt: 1,
            confirmations: 0,
            blockNumber: null,
            blockHash: null,
          },
          0
        );
      const file = require('./privacy-storage').getPrivacyStoragePath(handle, directory);
      const bytes = fs.readFileSync(file);
      await expect(
        journal.begin(word(102), 2, { ...intent, digest: word(103) })
      ).rejects.toMatchObject({
        code: 'PRIVATE_RAILGUN_NULLIFIER_RESERVED',
        message: 'Selected input has a recorded transaction attempt',
      });
      expect(fs.readFileSync(file)).toEqual(bytes);
      expect(await journal.list()).toHaveLength(1);
    }
  );
  test.each([
    [false, false],
    [false, true],
    [true, false],
    [true, true],
  ])(
    'resolved archived=%s reverted=%s never authorizes reuse, including after reopen',
    async (archived, reverted) => {
      const record = railgunHistory(kind, archived, reverted);
      const { file, bytes } = await seedSubmissionHistory(record, archived);
      await expect(journal.assertCanSubmit()).resolves.toBeUndefined();
      scope.close();
      ({ scope, handle } = open());
      journal = createSubmissionJournal({ handle, directory, key });
      const candidate = railgunIntent(kind, record.intent);
      let failure;
      try {
        await journal.begin(word(102), record.nonce + 1, candidate);
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({
        code: 'PRIVATE_RAILGUN_NULLIFIER_RESERVED',
        message: 'Selected input has a recorded transaction attempt',
      });
      expect(failure.transactionHash).toBeUndefined();
      expect(failure.submissionStatus).toBeUndefined();
      expect(failure.message).not.toContain(record.intent.nullifier);
      expect(fs.readFileSync(file)).toEqual(bytes);
      expect(await journal.readSnapshot()).toEqual({
        records: archived ? [] : [record],
        archive: archived ? [record] : [],
      });
    }
  );
  test.each([false, true])(
    'distinct nullifier is admissible with resolved archived=%s history',
    async (archived) => {
      const record = railgunHistory(kind, archived, true);
      await seedSubmissionHistory(record, archived);
      const intent = railgunIntent(kind, { tree: record.intent.tree, nullifier: word(991) });
      await journal.begin(word(102), record.nonce + 1, intent);
      expect((await journal.list()).at(-1).intent).toEqual(intent);
    }
  );
});
test.each(railgunKinds)(
  'different operation %s cannot bypass the same tree/nullifier reservation',
  async (kind) => {
    const record = railgunHistory('railgun-partial-unshield', true, true);
    await seedSubmissionHistory(record, true);
    const intent = railgunIntent(kind, record.intent);
    expect(intent).not.toEqual(record.intent);
    await expect(journal.begin(word(102), 4, intent)).rejects.toMatchObject({
      code: 'PRIVATE_RAILGUN_NULLIFIER_RESERVED',
    });
  }
);
test('same nullifier bytes in a different input tree are a distinct protocol identity', async () => {
  const record = railgunHistory('railgun-private-transfer', true, true);
  await seedSubmissionHistory(record, true);
  const intent = railgunIntent('railgun-private-transfer', {
    tree: record.intent.tree + 1,
    nullifier: record.intent.nullifier,
  });
  await journal.begin(word(102), 4, intent);
  expect((await journal.list())[0].intent).toEqual(intent);
});
test.each([false, true])(
  'concurrent adapters atomically reserve one same-input attempt, reversed=%s',
  async (reverse) => {
    const other = createSubmissionJournal({ handle: open().handle, directory, key });
    const intents = [
      railgunIntent('railgun-private-transfer'),
      railgunIntent('railgun-partial-unshield'),
    ];
    const calls = [
      () => journal.begin(word(110), 1, intents[0]),
      () => other.begin(word(111), 2, intents[1]),
    ];
    if (reverse) calls.reverse();
    const result = await Promise.allSettled(calls.map((call) => call()));
    expect(result.map((value) => value.status)).toEqual(['fulfilled', 'rejected']);
    expect(result[1].reason.code).toBe('PRIVATE_RAILGUN_NULLIFIER_RESERVED');
    const records = await journal.list();
    expect(records).toHaveLength(1);
    expect(records[0].intent).toEqual(intents[reverse ? 1 : 0]);
    expect(await other.list()).toEqual(records);
  }
);
test('same hash keeps its existing refusal precedence and distinct pending input keeps account serialization', async () => {
  const intent = railgunIntent('railgun-private-transfer');
  await journal.begin(word(110), 1, intent);
  await expect(journal.begin(word(110), 2, intent)).rejects.toMatchObject({
    code: 'PRIVATE_BROADCAST_ALREADY_ATTEMPTED',
    transactionHash: word(110),
  });
  await expect(
    journal.begin(word(111), 2, railgunIntent('railgun-private-transfer', { nullifier: word(991) }))
  ).rejects.toMatchObject({ code: 'PRIVATE_SUBMISSION_UNRESOLVED' });
});
test.each([1, 2, 3, 4])(
  'legacy document v%s resolved Railgun input refuses without schema rewrite',
  async (version) => {
    const record = railgunHistory('railgun-private-transfer', false, true);
    const { file, bytes } = await seedSubmissionHistory(record, false, version);
    await expect(
      journal.begin(word(111), 4, railgunIntent('railgun-partial-unshield', record.intent))
    ).rejects.toMatchObject({ code: 'PRIVATE_RAILGUN_NULLIFIER_RESERVED' });
    expect(fs.readFileSync(file)).toEqual(bytes);
  }
);
test.each(['tree', 'nullifier', 'target', 'chainId'])(
  'invalid or caller-expanded %s identity refuses before storage mutation',
  async (field) => {
    const intent = railgunIntent('railgun-private-transfer');
    const invalid = {
      ...intent,
      [field]: field === 'tree' ? -1 : field === 'nullifier' ? '0xBAD' : 'other',
    };
    await expect(journal.begin(word(101), 1, invalid)).rejects.toMatchObject({
      code: 'PRIVATE_JOURNAL_INVALID',
    });
    expect(fs.readdirSync(directory)).toEqual([]);
  }
);

test.each([false, true])(
  'atomic guard follows a concurrent archive transition, archive-first=%s',
  async (archiveFirst) => {
    const record = railgunHistory('railgun-partial-unshield', false, true);
    await seedSubmissionHistory(record, false);
    const calls = [
      () =>
        journal.archiveResolved(
          [{ hash: record.hash, revision: record.revision }],
          [{ blockNumber: 301, blockHash: word(202) }]
        ),
      () => journal.begin(word(102), 4, railgunIntent('railgun-private-transfer', record.intent)),
    ];
    if (!archiveFirst) calls.reverse();
    const results = await Promise.allSettled(calls.map((call) => call()));
    const refusal = results.find((value) => value.status === 'rejected');
    expect(results.filter((value) => value.status === 'fulfilled')).toHaveLength(1);
    expect(refusal.reason.code).toBe('PRIVATE_RAILGUN_NULLIFIER_RESERVED');
    expect(await journal.list()).toEqual([]);
    expect((await journal.listArchive())[0].intent).toEqual(record.intent);
  }
);
function genericResolved(intent, archived, ordinary) {
  const common = {
    hash: word(100),
    nonce: 3,
    ...(intent ? { intent } : {}),
    ...(ordinary ? { route: 'ordinary', ordinary } : {}),
  };
  return archived
    ? {
        ...common,
        status: 'reverted',
        blockNumber: 291,
        blockHash: word(200),
        archivedAt: 0,
        finalized: { blockNumber: 301, blockHash: word(202) },
      }
    : {
        ...common,
        state: 'submitted',
        attemptedAt: 0,
        revision: 2,
        observation: {
          status: 'reverted',
          trust: 'unverified',
          observedAt: 1,
          confirmations: 4,
          blockNumber: 291,
          blockHash: word(200),
        },
        resolution: { minimumConfirmations: 3, reviewedAt: 0, blockHash: word(200) },
      };
}
test.each([false, true])(
  'PPv2 commitment exclusion remains unchanged, archived=%s',
  async (archived) => {
    const intent = {
      kind: 'ppv2-native-ragequit',
      digest: word(501),
      pool: '0x' + '22'.repeat(20),
      commitment: word(10),
    };
    const record = genericResolved(intent, archived);
    const { file, bytes } = await seedSubmissionHistory(record, archived);
    await expect(
      journal.begin(word(102), 4, { ...intent, digest: word(502) })
    ).rejects.toMatchObject({ code: 'PRIVATE_PPV2_EXIT_RESERVED' });
    expect(fs.readFileSync(file)).toEqual(bytes);
    // Same bytes in another protocol are not the same spent-input namespace.
    const railgun = railgunIntent('railgun-private-transfer', { nullifier: intent.commitment });
    await journal.begin(word(102), 4, railgun);
    expect((await journal.list()).at(-1).intent).toEqual(railgun);
  }
);
test.each(['ppv2', 'ordinary', 'unclassified', 'shield'])(
  'resolved Railgun history does not reserve unrelated %s submissions',
  async (kind) => {
    const old = railgunHistory('railgun-private-transfer', false, true);
    await seedSubmissionHistory(old, false);
    let intent, ordinary;
    if (kind === 'ppv2')
      intent = {
        kind: 'ppv2-native-ragequit',
        digest: word(501),
        pool: '0x' + '22'.repeat(20),
        commitment: old.intent.nullifier,
      };
    if (kind === 'ordinary')
      ordinary = {
        to: '0x' + '56'.repeat(20),
        selector: null,
        type: 2,
        senderCode: '0x',
        trust: 'unverified-rpc',
      };
    if (kind === 'shield')
      intent = {
        kind: 'railgun-native-shield',
        digest: word(501),
        npk: old.intent.nullifier,
        token: require('./railgun-shield-pins.json').wrappedNative,
        amount: '1000',
        noteValue: '998',
      };
    await journal.begin(word(102), 4, intent, ordinary);
    const saved = (await journal.list()).at(-1);
    expect(saved.intent).toEqual(intent);
    expect(saved.ordinary).toEqual(ordinary);
    expect(saved.route).toBe(kind === 'ordinary' ? 'ordinary' : undefined);
  }
);
test.each([false, true])(
  'resolved Shield history with matching NPK bytes is not a Railgun transact reservation, archived=%s',
  async (archived) => {
    const candidate = railgunIntent('railgun-private-transfer');
    const intent = {
      kind: 'railgun-native-shield',
      digest: word(501),
      npk: candidate.nullifier,
      token: require('./railgun-shield-pins.json').wrappedNative,
      amount: '1000',
      noteValue: '998',
    };
    const record = genericResolved(intent, archived);
    const railgun = {
      outcome: 'reverted',
      finalizedBlockNumber: 300,
      finalizedBlockHash: word(201),
      shield: null,
    };
    if (archived) record.railgun = railgun;
    else record.resolution.railgun = railgun;
    await seedSubmissionHistory(record, archived);
    await journal.begin(word(102), 4, candidate);
    expect((await journal.list()).at(-1).intent).toEqual(candidate);
  }
);
test('ordinary resolved history keeps its normal admission and nonce behavior', async () => {
  const ordinary = {
    to: '0x' + '56'.repeat(20),
    selector: null,
    type: 2,
    senderCode: '0x',
    trust: 'unverified-rpc',
  };
  await seedSubmissionHistory(genericResolved(undefined, true, ordinary), true);
  await expect(journal.begin(word(102), 3, undefined, ordinary)).rejects.toMatchObject({
    code: 'PRIVATE_NONCE_REUSE_REFUSED',
  });
  await journal.begin(word(102), 4, undefined, ordinary);
  expect((await journal.list())[0]).toMatchObject({ route: 'ordinary', ordinary });
});
test('guard is account-local and unsupported chains cannot create this journal', async () => {
  const intent = railgunIntent('railgun-private-transfer');
  await journal.begin(word(101), 1, intent);
  const another = createSubmissionJournal({
    handle: open('fixture', { ...subject, principal: '0x' + '22'.repeat(20) }).handle,
    directory,
    key,
  });
  await another.begin(word(102), 1, intent);
  expect(await another.list()).toHaveLength(1);
  expect(await journal.list()).toHaveLength(1);
  expect(() =>
    createSubmissionJournal({
      handle: open('fixture', { ...subject, chainId: 1 }).handle,
      directory,
      key,
    })
  ).toThrow(expect.objectContaining({ code: 'PRIVATE_JOURNAL_SCOPE' }));
});
test('possibly committed Railgun write remains reserved after inventory failure and reopen', async () => {
  const guarded = createSubmissionJournal({
    handle,
    directory,
    key,
    profileGuard: {
      assert() {},
      remember() {
        throw Error('inventory failure');
      },
    },
  });
  const intent = railgunIntent('railgun-partial-unshield');
  await expect(guarded.begin(word(101), 1, intent)).rejects.toMatchObject({
    code: 'PRIVATE_BROADCAST_UNCERTAIN',
    transactionHash: word(101),
  });
  scope.close();
  ({ scope, handle } = open());
  journal = createSubmissionJournal({ handle, directory, key });
  await expect(journal.begin(word(102), 2, intent)).rejects.toMatchObject({
    code: 'PRIVATE_RAILGUN_NULLIFIER_RESERVED',
  });
  expect((await journal.list())[0].hash).toBe(word(101));
});
