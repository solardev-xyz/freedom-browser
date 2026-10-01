/** Runs the real, pinned upstream PPv2 storage adapter when the scratch fixture
 * is supplied. Synthetic note-shaped data is not a protocol recovery test.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createPrivacyScope } = require('../networks/privacy-context');
const { createPrivacyStorage } = require('./privacy-storage');
const fixture = process.env.FREEDOM_PP_V2_STORAGE_FIXTURE;
const upstreamTest = fixture ? test : test.skip;
let directory, scope, hostStorage, sdkStorage, StorageAdapter;
const subject = {
  kind: 'private-account',
  principal: 'synthetic-account',
  protocol: 'ppv2',
  deployment: 'candidate-fixture',
  chainId: 11155111,
  role: 'storage',
};
function open() {
  scope = createPrivacyScope({ profileId: 'fixture', signal: new AbortController().signal });
  hostStorage = createPrivacyStorage({
    handle: scope.getContext(subject),
    directory,
    key: Buffer.alloc(32, 5),
  });
  sdkStorage = new StorageAdapter(hostStorage, 'candidate');
}
beforeEach(() => {
  if (!fixture) return;
  ({ KohakuStorageService: StorageAdapter } = require(fixture));
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ppv2-storage-fixture-'));
  open();
});
afterEach(() => scope?.close());

upstreamTest(
  'the actual PPv2 adapter preserves JSON through encrypted restart and keeps namespaces separate',
  async () => {
    const value = {
      notes: [{ commitment: 'synthetic-commitment', amount: '1000' }],
      syncCursor: '0x10',
    };
    await sdkStorage.set('note-manager-state', value);
    const other = new StorageAdapter(hostStorage, 'other-instance');
    expect(await other.get('note-manager-state')).toBeNull();
    expect(
      fs.readFileSync(path.join(directory, fs.readdirSync(directory)[0]), 'utf8')
    ).not.toContain('synthetic-commitment');
    scope.close();
    open();
    expect(await sdkStorage.get('note-manager-state')).toEqual(value);
  }
);

upstreamTest(
  'tombstones survive restart; clearing one adapter cannot wipe the host store',
  async () => {
    await sdkStorage.set('spent-note', { value: 'fixture' });
    await sdkStorage.set('retained-note', { value: 'retained' });
    await sdkStorage.delete('spent-note');
    scope.close();
    open();
    expect(await sdkStorage.get('spent-note')).toBeNull();
    await expect(sdkStorage.clear()).rejects.toThrow('not supported');
    expect(await sdkStorage.get('retained-note')).toEqual({ value: 'retained' });
  }
);

upstreamTest(
  'malformed JSON and damaged ciphertext reject rather than becoming empty recovery state',
  async () => {
    await hostStorage.set('ppv2:candidate:bad-json', '{');
    await expect(sdkStorage.get('bad-json')).rejects.toMatchObject({
      name: 'StorageCorruptionError',
    });
    fs.writeFileSync(path.join(directory, fs.readdirSync(directory)[0]), '{}');
    await expect(sdkStorage.get('bad-json')).rejects.toMatchObject({
      code: 'PRIVATE_STORAGE_UNREADABLE',
    });
  }
);

upstreamTest(
  'lock and the host value limit prevent writes through the actual SDK adapter',
  async () => {
    await sdkStorage.set('state', { value: 'original' });
    await expect(sdkStorage.set('state', { value: 'x'.repeat(1024 * 1024) })).rejects.toMatchObject(
      { code: 'PRIVATE_STORAGE_LIMIT' }
    );
    expect(await sdkStorage.get('state')).toEqual({ value: 'original' });
    const revoked = sdkStorage;
    scope.close();
    await expect(revoked.set('state', { value: 'late' })).rejects.toMatchObject({
      code: 'PRIVACY_CONTEXT_REVOKED',
    });
    await expect(revoked.get('state')).rejects.toMatchObject({ code: 'PRIVACY_CONTEXT_REVOKED' });
    open();
    expect(await sdkStorage.get('state')).toEqual({ value: 'original' });
  }
);
