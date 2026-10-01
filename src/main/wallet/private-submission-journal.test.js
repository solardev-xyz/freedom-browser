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
