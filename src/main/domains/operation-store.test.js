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
