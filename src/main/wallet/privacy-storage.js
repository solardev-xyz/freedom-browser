/** Encrypted atomic implementation of the Kohaku Storage shape. Main owns
 * the directory and 256-bit storage key; neither is supplied by a renderer.
 * No product key-management or backup policy is selected by this primitive.
 */
const fs = require('fs');
const path = require('path');
const { createHash, randomBytes, createCipheriv, createDecipheriv } = require('crypto');
const { getPrivacyContext, privacyError } = require('../networks/privacy-context');
const MAX_BYTES = 4 * 1024 * 1024;

function createPrivacyStorage({ handle, directory, key }) {
  const context = getPrivacyContext(handle);
  if (context.subject.kind !== 'private-account' || context.subject.role !== 'storage' ||
      !Buffer.isBuffer(key) || key.length !== 32 || !path.isAbsolute(directory)) {
    throw privacyError('PRIVATE_STORAGE_INVALID', 'Invalid privacy storage configuration');
  }
  const secret = Buffer.from(key);
  const aad = Buffer.from(JSON.stringify([1, context.profileId, context.subject]));
  const file = path.join(directory, `${createHash('sha256').update(aad).digest('hex')}.json`);
  context.signal.addEventListener('abort', () => secret.fill(0), { once: true });
  function assertActive() { getPrivacyContext(handle); }
  function validKey(name) {
    if (typeof name !== 'string' || !name || name.length > 256) throw privacyError('PRIVATE_STORAGE_INVALID', 'Invalid storage key');
  }
  function read() {
    assertActive();
    if (!fs.existsSync(file)) return {};
    try {
      if (fs.statSync(file).size > MAX_BYTES * 2) throw new Error('size');
      const record = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (record.version !== 1) throw new Error('version');
      const iv = Buffer.from(record.iv, 'base64');
      const tag = Buffer.from(record.tag, 'base64');
      const ciphertext = Buffer.from(record.ciphertext, 'base64');
      if (iv.length !== 12 || tag.length !== 16 || ciphertext.length > MAX_BYTES) throw new Error('shape');
      const decipher = createDecipheriv('aes-256-gcm', secret, iv);
      decipher.setAAD(aad); decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      try {
        const values = JSON.parse(plaintext.toString('utf8'));
        if (!values || Array.isArray(values) || typeof values !== 'object' || Object.keys(values).length > 256 ||
            Object.entries(values).some(([name, value]) => !name || name.length > 256 || typeof value !== 'string')) throw new Error('shape');
        return values;
      } finally { plaintext.fill(0); }
    } catch {
      throw privacyError('PRIVATE_STORAGE_UNREADABLE', 'Privacy state could not be authenticated or decoded');
    }
  }
  return Object.freeze({
    _brand: 'Storage',
    async get(name) {
      validKey(name);
      const values = read();
      assertActive();
      return Object.hasOwn(values, name) ? values[name] : null;
    },
    async set(name, value) {
      validKey(name); assertActive();
      if (typeof value !== 'string' || Buffer.byteLength(value) > 1024 * 1024) throw privacyError('PRIVATE_STORAGE_LIMIT', 'Privacy value is too large');
      const values = read();
      Object.defineProperty(values, name, { value, enumerable: true, configurable: true, writable: true });
      const plaintext = Buffer.from(JSON.stringify(values));
      try {
        if (Object.keys(values).length > 256 || plaintext.length > MAX_BYTES) throw privacyError('PRIVATE_STORAGE_LIMIT', 'Privacy state is too large');
        const iv = randomBytes(12);
        const cipher = createCipheriv('aes-256-gcm', secret, iv);
        cipher.setAAD(aad);
        const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
        const serialized = JSON.stringify({ version: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') });
        assertActive();
        fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
        const temporary = `${file}.${randomBytes(8).toString('hex')}.tmp`;
        const fd = fs.openSync(temporary, 'wx', 0o600);
        try { fs.writeFileSync(fd, serialized); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
        // Synchronous rename keeps the lifetime check and commit in one main
        // event-loop turn. Interrupted writes leave only encrypted temp files.
        assertActive();
        fs.renameSync(temporary, file);
        if (process.platform !== 'win32') {
          const parent = fs.openSync(directory, 'r');
          try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
        }
      } catch (error) {
        if (error.code?.startsWith('PRIVATE_') || error.code?.startsWith('PRIVACY_')) throw error;
        throw privacyError('PRIVATE_STORAGE_WRITE_FAILED', 'Privacy state could not be saved');
      } finally { plaintext.fill(0); }
    },
  });
}
module.exports = { createPrivacyStorage };
