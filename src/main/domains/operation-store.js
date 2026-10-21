'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { refuse } = require('./contracts');
const MAX_BYTES = 4 * 1024 * 1024;

// Profile-owned state, not Agent history: future manual interfaces can continue
// these same operations. Secrets use Electron's OS-backed credential protection.
class DomainOperationStore {
  constructor({ directory, safeStorage }) {
    this.filename = path.join(directory, 'domain-operations.json');
    this.safeStorage = safeStorage;
    this.operations = new Map();
    try {
      const fd = fs.openSync(this.filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_BYTES) throw new Error('Invalid domain journal');
        const payload = JSON.parse(fs.readFileSync(fd, 'utf8'));
        if (payload.version !== 1 || !Array.isArray(payload.operations) || payload.operations.length > 500) throw new Error('Invalid domain journal');
        for (const operation of payload.operations) {
          if (!/^domain_[a-f0-9]{24}$/.test(operation.id)) throw new Error('Invalid domain operation');
          // A crash after handing off to the signer is never permission to send
          // again. Keep the uncertain marker even if there is no returned hash.
          if (operation.state === 'dispatching') operation.state = 'dispatch_unknown';
          this.operations.set(operation.id, operation);
        }
      } finally { fs.closeSync(fd); }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  list() { return structuredClone([...this.operations.values()]); }
  get(id) { return structuredClone(this.operations.get(id) || null); }
  protectSecret(secret) {
    const storage = this.safeStorage;
    if (!storage?.isEncryptionAvailable() || storage.getSelectedStorageBackend?.() === 'basic_text') refuse('Registration needs secure operating-system credential storage. Other domain operations remain available.', 'DOMAIN_SECURE_STORAGE');
    return storage.encryptString(secret).toString('base64');
  }
  revealSecret(operation) {
    if (!this.safeStorage?.isEncryptionAvailable() || this.safeStorage.getSelectedStorageBackend?.() === 'basic_text') refuse('Unlock secure credential storage to resume this registration.', 'DOMAIN_SECURE_STORAGE');
    try {
      const secret = this.safeStorage.decryptString(Buffer.from(operation.encryptedSecret, 'base64'));
      if (!/^0x[a-f0-9]{64}$/.test(secret)) throw new Error('Invalid secret');
      return secret;
    } catch { refuse('The saved registration secret could not be recovered.', 'DOMAIN_SECURE_STORAGE'); }
  }
  save(operation) {
    const next = new Map(this.operations);
    next.set(operation.id, structuredClone(operation));
    if (next.size > 500) refuse('Domain operation storage is full. Existing operations can still be inspected.');
    const body = JSON.stringify({ version: 1, operations: [...next.values()] });
    if (Buffer.byteLength(body) > MAX_BYTES) refuse('Domain operation storage is full.');
    fs.mkdirSync(path.dirname(this.filename), { recursive: true, mode: 0o700 });
    const temporary = `${this.filename}.${crypto.randomBytes(12).toString('hex')}.tmp`;
    const fd = fs.openSync(temporary, 'wx', 0o600);
    try {
      try { fs.writeFileSync(fd, body); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(temporary, this.filename);
      this.operations = next;
    } catch (error) {
      try { fs.unlinkSync(temporary); } catch { /* Preserve the original storage failure. */ }
      throw error;
    }
  }
}
module.exports = { DomainOperationStore };
