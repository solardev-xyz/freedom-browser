const { createPrivacyScope } = require('../networks/privacy-context');
const { inspectPPv2NoteRecovery } = require('./ppv2-note-recovery');
const commitment = (byte) => `0x${byte.padStart(64, '0')}`;
const note = (byte) => ({
  commitment: commitment(byte),
  asset: { __type: 'native' },
  value: 10000n,
  status: 'pending',
  labelState: 'pending',
  noteSecret: 'must-not-escape',
});
let scope, handle, host, params, plugin;
beforeEach(() => {
  scope = createPrivacyScope({ profileId: 'fixture', signal: new AbortController().signal });
  handle = scope.getContext({
    kind: 'private-account',
    principal: 'ppv2:0',
    protocol: 'privacy-pools-v2',
    deployment: 'sepolia',
    chainId: 11155111,
    role: 'session',
  });
  host = { storage: { get: jest.fn(), set: jest.fn() }, provider: {}, keystore: {} };
  params = {};
  plugin = {
    exportAccount: async () =>
      JSON.stringify({ notes: [{ commitment: commitment('1'), noteSecret: 'private' }] }),
  };
});
afterEach(() => scope.close());
const inspect = (createPlugin) =>
  inspectPPv2NoteRecovery({ handle, host, params, plugin, createPlugin });

test('full scan is isolated from persistent cache and missing notes are reported without deletion', async () => {
  const result = await inspect(async (freshHost) => {
    expect(await freshHost.storage.get('ppv2:controlled:notes')).toBeNull();
    await freshHost.storage.set('ppv2:controlled:notes', 'temporary private state');
    expect(await freshHost.storage.get('ppv2:controlled:notes')).toBe('temporary private state');
    expect(freshHost.provider).toBe(host.provider);
    expect(freshHost.keystore).toBe(host.keystore);
    return { notes: async () => [note('2')] };
  });
  expect(result).toMatchObject({
    missingFromScan: [commitment('1')],
    newlyDiscovered: [commitment('2')],
    cacheReplaced: false,
    historyCompletenessVerified: false,
    chainStateVerified: false,
    requiresReview: true,
  });
  expect(result.notes[0].noteSecret).toBeUndefined();
  expect(Object.isFrozen(result.notes[0].asset)).toBe(true);
  expect(host.storage.get).not.toHaveBeenCalled();
  expect(host.storage.set).not.toHaveBeenCalled();
});

test('bounded temporary storage refuses unknown namespaces and is discarded after failure', async () => {
  let storage;
  await expect(
    inspect(async (freshHost) => {
      storage = freshHost.storage;
      await expect(storage.set('outside', 'value')).rejects.toThrow();
      await expect(storage.set('ppv2:controlled:x', 'x'.repeat(1024 * 1024 + 1))).rejects.toThrow();
      await storage.set('ppv2:controlled:x', 'secret');
      throw new Error('sensitive SDK failure');
    })
  ).rejects.toMatchObject({
    code: 'PRIVATE_PPV2_RECOVERY_FAILED',
    message: 'PPv2 note recovery could not be inspected',
  });
  await expect(storage.get('ppv2:controlled:x')).rejects.toThrow();
  await expect(storage.set('ppv2:controlled:late', 'secret')).rejects.toThrow();
  expect(host.storage.set).not.toHaveBeenCalled();
});

test('malformed or duplicate reconstructed notes cannot become a recovery result', async () => {
  for (const notes of [
    [note('2'), note('2')],
    [{ ...note('2'), value: -1n }],
    [{ ...note('2'), status: 'invented' }],
    [{ ...note('2'), asset: { __type: 'unknown' } }],
  ]) {
    await expect(inspect(async () => ({ notes: async () => notes }))).rejects.toMatchObject({
      code: 'PRIVATE_PPV2_RECOVERY_FAILED',
    });
  }
});

test('vault cancellation prevents a late recovery result or subsequent temporary writes', async () => {
  let finish, storage;
  const result = inspect(async (h) => {
    storage = h.storage;
    return {
      notes: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    };
  });
  while (!finish) await new Promise(setImmediate);
  scope.close();
  finish([note('1')]);
  await expect(result).rejects.toMatchObject({ code: 'PRIVACY_CONTEXT_REVOKED' });
  await expect(storage.set('ppv2:controlled:late', 'secret')).rejects.toMatchObject({
    code: 'PRIVACY_CONTEXT_REVOKED',
  });
});
