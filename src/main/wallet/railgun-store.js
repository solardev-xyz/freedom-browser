/** Development engine store. Main owns the path/key/context; the engine receives
 * only byte operations. Keys as well as values are encrypted. Explicit creation
 * is required: a missing existing database is never treated as an empty wallet.
 * A bounded in-memory snapshot serves reads; disk authentication occurs at open.
 * This primitive is not yet enrolled in the product profile inventory.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getPrivacyContext } = require('../networks/privacy-context');
const MAX_BYTES = 32 * 1024 * 1024;
const MAX_KEYS = 65536;
const MAX_VALUE = 1024 * 1024;
const opened = new Set();
function refused(code = 'RAILGUN_STORE_REFUSED') {
  return Object.assign(new Error('Railgun state unavailable'), { code });
}

function createRailgunStore({ handle, filename, key, binding, onFatal, create = false }) {
  const context = getPrivacyContext(handle);
  if (
    context.subject.kind !== 'private-account' ||
    context.subject.protocol !== 'railgun' ||
    context.subject.role !== 'storage' ||
    context.subject.operation !== null ||
    !path.isAbsolute(filename) ||
    !Buffer.isBuffer(key) ||
    key.length !== 32 ||
    typeof binding !== 'string' ||
    !/^[0-9a-f]{64}$/.test(binding) ||
    typeof create !== 'boolean' ||
    typeof onFatal !== 'function'
  )
    throw refused();
  filename = path.resolve(filename);
  if (opened.has(filename)) throw refused('RAILGUN_STORE_BUSY');
  const secret = Buffer.from(key);
  const aad = Buffer.from(
    JSON.stringify([
      'railgun-store-v1',
      context.profileId,
      context.subject.kind,
      context.subject.principal,
      context.subject.chainId,
      context.subject.protocol,
      context.subject.deployment,
      context.subject.role,
      binding,
    ])
  );
  const stop = new AbortController();
  const signal = AbortSignal.any([context.signal, stop.signal]);
  let db,
    closed = false,
    entries = new Map();
  const active = () => {
    if (closed) throw refused('RAILGUN_STORE_REVOKED');
    getPrivacyContext(handle);
  };
  const seal = (plaintext, id) => {
    const iv = crypto.randomBytes(12),
      cipher = crypto.createCipheriv('aes-256-gcm', secret, iv);
    cipher.setAAD(Buffer.concat([aad, Buffer.from(id)]));
    return Buffer.concat([iv, cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
  };
  const unseal = (bytes, id) => {
    if (!Buffer.isBuffer(bytes) || bytes.length < 28) throw refused();
    const decipher = crypto.createDecipheriv('aes-256-gcm', secret, bytes.subarray(0, 12));
    decipher.setAAD(Buffer.concat([aad, Buffer.from(id)]));
    decipher.setAuthTag(bytes.subarray(-16));
    return Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]);
  };
  const root = (values) => {
    const hash = crypto.createHash('sha256');
    for (const e of [...values.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
      hash.update(e.id).update(e.digest);
    }
    return hash.digest();
  };
  const wipe = (values) => {
    for (const e of values.values()) {
      e.key.fill(0);
      e.value.fill(0);
    }
    values.clear();
  };
  const close = () => {
    if (closed) return;
    closed = true;
    stop.abort();
    context.signal.removeEventListener('abort', close);
    secret.fill(0);
    wipe(entries);
    try {
      db?.close();
    } finally {
      opened.delete(filename);
    }
  };
  try {
    if (create) {
      fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
      fs.closeSync(fs.openSync(filename, 'wx', 0o600));
    } else if (!fs.existsSync(filename)) throw refused('RAILGUN_STORE_MISSING');
    if (fs.lstatSync(filename).isSymbolicLink() || fs.statSync(filename).size > MAX_BYTES * 4)
      throw refused();
    const Database = require('better-sqlite3');
    db = new Database(filename, { fileMustExist: true, timeout: 0 });
    db.pragma('journal_mode = DELETE');
    db.pragma('synchronous = FULL');
    if (process.platform === 'darwin') db.pragma('fullfsync = ON');
    db.pragma('secure_delete = ON');
    db.pragma('trusted_schema = OFF');
    db.pragma('locking_mode = EXCLUSIVE');
    db.exec('BEGIN EXCLUSIVE; COMMIT;');
    if (create) {
      db.transaction(() => {
        db.exec('CREATE TABLE records (id TEXT PRIMARY KEY, ciphertext BLOB NOT NULL)');
        db.prepare('INSERT INTO records VALUES (?, ?)').run(
          'manifest',
          seal(root(entries), 'manifest')
        );
      })();
    }
    const schema = db
      .prepare('SELECT type, name, sql FROM sqlite_master ORDER BY name')
      .all()
      .filter((row) => row.name !== 'sqlite_autoindex_records_1');
    if (!schema.length) throw refused('RAILGUN_STORE_INCOMPLETE');
    if (
      schema.length !== 1 ||
      schema[0].type !== 'table' ||
      schema[0].name !== 'records' ||
      schema[0].sql !== 'CREATE TABLE records (id TEXT PRIMARY KEY, ciphertext BLOB NOT NULL)'
    )
      throw refused();
    const count = db.prepare('SELECT COUNT(*) AS count FROM records').get().count;
    if (count < 1 || count > MAX_KEYS + 1) throw refused();
    if (create && process.platform !== 'win32') {
      const parent = fs.openSync(path.dirname(filename), 'r');
      try {
        fs.fsyncSync(parent);
      } finally {
        fs.closeSync(parent);
      }
    }
    const rows = db.prepare('SELECT id, ciphertext FROM records').all();
    if (rows.length < 1 || rows.length > MAX_KEYS + 1) throw refused();
    let manifest,
      total = 0;
    for (const row of rows) {
      if (row.ciphertext.length > MAX_VALUE + 4096 + 32) throw refused();
      if (row.id === 'manifest') {
        manifest = unseal(row.ciphertext, row.id);
        continue;
      }
      if (!/^[0-9a-f]{32}$/.test(row.id)) throw refused();
      const plain = unseal(row.ciphertext, row.id);
      try {
        const length = plain.readUInt32BE(0);
        if (
          !length ||
          length > 4096 ||
          plain.length < 4 + length ||
          plain.length - 4 - length > MAX_VALUE
        )
          throw refused();
        const k = Buffer.from(plain.subarray(4, 4 + length)),
          value = Buffer.from(plain.subarray(4 + length));
        const index = k.toString('hex');
        if (entries.has(index)) throw refused();
        entries.set(index, {
          id: row.id,
          ciphertext: row.ciphertext,
          digest: crypto.createHash('sha256').update(row.ciphertext).digest(),
          key: k,
          value,
        });
        total += k.length + value.length;
        if (total > MAX_BYTES) throw refused();
      } finally {
        plain.fill(0);
      }
    }
    if (!manifest || !manifest.equals(root(entries))) throw refused();
    opened.add(filename);
    context.signal.addEventListener('abort', close, { once: true });
    active();
  } catch (error) {
    close();
    if (['RAILGUN_STORE_MISSING', 'RAILGUN_STORE_INCOMPLETE'].includes(error.code)) throw error;
    if (error.code === 'EEXIST') throw refused('RAILGUN_STORE_EXISTS');
    if (error.code === 'SQLITE_BUSY' || error.code === 'SQLITE_LOCKED')
      throw refused('RAILGUN_STORE_BUSY');
    throw refused('RAILGUN_STORE_UNREADABLE');
  }
  const validKey = (k) => {
    if (!Buffer.isBuffer(k) || !k.length || k.length > 4096) throw refused();
    return k.toString('hex');
  };
  const api = {
    signal,
    assertActive: active,
    close,
    get(k) {
      active();
      const value = entries.get(validKey(k))?.value;
      return value === undefined ? null : Buffer.from(value);
    },
    snapshot(options = {}, keysOnly = false) {
      active();
      return [...entries.values()]
        .filter((e) =>
          ['gt', 'gte', 'lt', 'lte'].every((name) => {
            if (options[name] == null) return true;
            if (!Buffer.isBuffer(options[name])) throw refused();
            const n = Buffer.compare(e.key, options[name]);
            return name === 'gt' ? n > 0 : name === 'gte' ? n >= 0 : name === 'lt' ? n < 0 : n <= 0;
          })
        )
        .sort((a, b) => Buffer.compare(a.key, b.key))
        .map((e) => [Buffer.from(e.key), keysOnly ? Buffer.alloc(0) : Buffer.from(e.value)]);
    },
    commitBatch(operations) {
      active();
      if (!Array.isArray(operations) || !operations.length || operations.length > MAX_KEYS)
        throw refused();
      // Bound input work before any copied plaintext/ciphertext allocation.
      let inputBytes = 0;
      for (const op of operations) {
        if (
          !op ||
          !['put', 'del'].includes(op.type) ||
          Object.keys(op).some((k) => !['type', 'key', 'value'].includes(k))
        )
          throw refused();
        validKey(op.key);
        if (op.type === 'put' && (!Buffer.isBuffer(op.value) || op.value.length > MAX_VALUE))
          throw refused();
        inputBytes += op.key.length + (op.type === 'put' ? op.value.length : 0);
        if (inputBytes > MAX_BYTES) throw refused('RAILGUN_STORE_LIMIT');
      }
      const next = new Map(entries),
        fresh = new Set();
      let committed = false;
      try {
        for (const op of operations) {
          if (
            !op ||
            !['put', 'del'].includes(op.type) ||
            Object.keys(op).some((k) => !['type', 'key', 'value'].includes(k))
          )
            throw refused();
          const index = validKey(op.key);
          if (op.type === 'del') {
            next.delete(index);
            continue;
          }
          if (!Buffer.isBuffer(op.value) || op.value.length > MAX_VALUE) throw refused();
          const k = Buffer.from(op.key),
            value = Buffer.from(op.value),
            id = crypto.randomBytes(16).toString('hex');
          const plain = Buffer.alloc(4 + k.length + value.length);
          plain.writeUInt32BE(k.length);
          k.copy(plain, 4);
          value.copy(plain, 4 + k.length);
          let ciphertext;
          try {
            ciphertext = seal(plain, id);
          } finally {
            plain.fill(0);
          }
          const e = {
            key: k,
            value,
            id,
            ciphertext,
            digest: crypto.createHash('sha256').update(ciphertext).digest(),
          };
          fresh.add(e);
          next.set(index, e);
        }
        if (
          next.size > MAX_KEYS ||
          [...next.values()].reduce((n, e) => n + e.key.length + e.value.length, 0) > MAX_BYTES
        )
          throw refused('RAILGUN_STORE_LIMIT');
        const digest = root(next);
        db.transaction(() => {
          active();
          const remove = db.prepare('DELETE FROM records WHERE id = ?');
          for (const [k, e] of entries) if (next.get(k) !== e) remove.run(e.id);
          const insert = db.prepare('INSERT INTO records VALUES (?, ?)');
          for (const [k, e] of next) if (entries.get(k) !== e) insert.run(e.id, e.ciphertext);
          db.prepare('UPDATE records SET ciphertext = ? WHERE id = ?').run(
            seal(digest, 'manifest'),
            'manifest'
          );
        })();
        const retained = new Set(next.values());
        for (const e of entries.values())
          if (!retained.has(e)) {
            e.key.fill(0);
            e.value.fill(0);
          }
        entries = next;
        committed = true;
      } finally {
        const retained = committed ? new Set(entries.values()) : new Set();
        for (const e of fresh)
          if (!retained.has(e)) {
            e.key.fill(0);
            e.value.fill(0);
          }
      }
    },
  };
  const { commitBatch, ...capability } = api;
  return Object.freeze({
    ...capability,
    batch(operations) {
      try {
        return commitBatch(operations);
      } catch (error) {
        close();
        try {
          onFatal();
        } catch {
          /* Store already revoked; preserve the failure. */
        }
        if (error.code?.startsWith('RAILGUN_') || error.code?.startsWith('PRIVACY_')) throw error;
        throw refused('RAILGUN_STORE_WRITE_FAILED');
      }
    },
  });
}
module.exports = { createRailgunStore };
