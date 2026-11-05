'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { DomainOperationStore } = require('./operation-store');

function fixture(safeStorage) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-domain-journal-'));
  return new DomainOperationStore({ directory, safeStorage });
}
test('restarts preserve unresolved progress and never silently replay a dispatch', () => {
  const store = fixture();
  const operation = { id: `domain_${'a'.repeat(24)}`, state: 'dispatching', name: 'test.eth' };
  store.save(operation);
  const reopened = new DomainOperationStore({ directory: path.dirname(store.filename) });
  expect(reopened.get(operation.id).state).toBe('dispatch_unknown');
  reopened.get(operation.id).state = 'ready';
  expect(reopened.get(operation.id).state).toBe('dispatch_unknown');
  if (process.platform !== 'win32') expect(fs.statSync(store.filename).mode & 0o777).toBe(0o600);
});
test('registration requires protected storage rather than a plaintext fallback', () => {
  expect(() => fixture().protectSecret('secret')).toThrow('secure');
  expect(() => fixture({ isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'basic_text' }).protectSecret('secret')).toThrow('secure');
});
test('only ciphertext is saved and a secret cannot be recovered with a broken keyring', () => {
  const secret = `0x${'ab'.repeat(32)}`;
  const safeStorage = { isEncryptionAvailable: () => true,
    encryptString: jest.fn(() => Buffer.from('ciphertext-fixture')), decryptString: jest.fn(() => secret) };
  const store = fixture(safeStorage);
  const operation = { id: `domain_${'b'.repeat(24)}`, state: 'waiting_commitment', encryptedSecret: store.protectSecret(secret) };
  store.save(operation);
  expect(fs.readFileSync(store.filename, 'utf8')).not.toContain(secret);
  expect(store.revealSecret(operation)).toBe(secret);
  safeStorage.decryptString.mockImplementation(() => { throw new Error(secret); });
  expect(() => store.revealSecret(operation)).toThrow('could not be recovered');
});
test('corrupt journals are refused without overwriting evidence', () => {
  const store = fixture();
  fs.writeFileSync(store.filename, '{bad json');
  expect(() => new DomainOperationStore({ directory: path.dirname(store.filename) })).toThrow();
  expect(fs.readFileSync(store.filename, 'utf8')).toBe('{bad json');
});
test('a copy read before a newer save is refused instead of overwriting it', () => {
  const store = fixture();
  const operation = { id: `domain_${'c'.repeat(24)}`, state: 'ready', name: 'test.eth' };
  store.save(operation);
  const stale = store.get(operation.id);
  const current = store.get(operation.id);
  current.state = 'pending'; current.transactionHash = `0x${'ab'.repeat(32)}`;
  store.save(current);
  stale.state = 'ready';
  expect(() => store.save(stale)).toThrow(expect.objectContaining({ code: 'DOMAIN_CONFLICT' }));
  const reopened = new DomainOperationStore({ directory: path.dirname(store.filename) });
  expect(reopened.get(operation.id)).toMatchObject({ state: 'pending', transactionHash: current.transactionHash, revision: 2 });
  // The holder of the newest copy keeps saving; a journal from before revisions counts as revision 0.
  reopened.save({ ...reopened.get(operation.id), state: 'completed' });
  expect(reopened.get(operation.id)).toMatchObject({ state: 'completed', revision: 3 });
});
