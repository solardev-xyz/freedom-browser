/** Main-owned encrypted, copy-on-write pages for the development Railgun engine.
 * Only the authenticated directory and a bounded page are resident. Opening
 * streams and authenticates every page; snapshots pin immutable page references.
 * Whole-file rollback still needs an external epoch/recovery policy. This format
 * is explicit: it never migrates or silently creates an existing wallet store.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getPrivacyContext } = require('../networks/privacy-context');
const PAGE_TARGET = 64 * 1024;
const MAX_VALUE = 1024 * 1024;
const MAX_PAGE = MAX_VALUE + 4096 + 12;
const MAX_DIRECTORY = 8 * 1024 * 1024;
const MAX_PAGES = 32768;
const MAX_KEYS = 2000000;
const MAX_BYTES = 1024 * 1024 * 1024;
const MAX_BATCH = 32 * 1024 * 1024;
const MAX_REWRITE = 128 * 1024 * 1024;
const MAX_DIRECTORY_KEYS = 16 * 1024 * 1024;
const MAX_DISK = 4 * MAX_BYTES;
const opened = new Set();
const refused = (code = 'RAILGUN_STORE_REFUSED') =>
  Object.assign(new Error('Railgun state unavailable'), { code });
const integer = (n, max) => Number.isSafeInteger(n) && n >= 0 && n <= max;
const validKey = (key) => {
  if (!Buffer.isBuffer(key) || !key.length || key.length > 4096) throw refused();
};
const wipe = (rows) => {
  for (const [key, value] of rows) {
    key.fill(0);
    value.fill(0);
  }
};
function bounds(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw refused();
  const result = {};
  for (const [name, value] of Object.entries(options)) {
    if (['gt', 'gte', 'lt', 'lte'].includes(name)) {
      validKey(value);
      result[name] = Buffer.from(value);
    } else if (name === 'limit') {
      if (!Number.isSafeInteger(value) || value < -1 || value > MAX_KEYS) throw refused();
      result[name] = value;
    } else if (['reverse', 'keys', 'values'].includes(name)) {
      if (typeof value !== 'boolean') throw refused();
      result[name] = value;
    } else throw refused();
  }
  return result;
}
const matches = (key, options) =>
  ['gt', 'gte', 'lt', 'lte'].every((name) => {
    if (!options[name]) return true;
    const n = Buffer.compare(key, options[name]);
    return name === 'gt' ? n > 0 : name === 'gte' ? n >= 0 : name === 'lt' ? n < 0 : n <= 0;
  });
const overlaps = (page, options) =>
  (!options.gt || Buffer.compare(page.last, options.gt) > 0) &&
  (!options.gte || Buffer.compare(page.last, options.gte) >= 0) &&
  (!options.lt || Buffer.compare(page.first, options.lt) < 0) &&
  (!options.lte || Buffer.compare(page.first, options.lte) <= 0);
// The read policy is selected only by the fixed main-owned entry point below.
function openPagedStore({ handle, filename, key, binding, onFatal, create = false }, readOnly) {
  const context = getPrivacyContext(handle);
  if (
    context.subject.kind !== 'private-account' ||
    context.subject.protocol !== 'railgun' ||
    context.subject.role !== 'storage' ||
    context.subject.operation !== null ||
    typeof filename !== 'string' ||
    !path.isAbsolute(filename) ||
    !Buffer.isBuffer(key) ||
    key.length !== 32 ||
    typeof binding !== 'string' ||
    !/^[0-9a-f]{64}$/.test(binding) ||
    typeof onFatal !== 'function' ||
    typeof create !== 'boolean' ||
    (readOnly && create)
  )
    throw refused();
  filename = path.resolve(filename);
  if (opened.has(filename)) throw refused('RAILGUN_STORE_BUSY');
  const secret = Buffer.from(key);
  const aad = Buffer.from(
    JSON.stringify([
      'railgun-paged-store-v2',
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
  const snapshots = new Set();
  let db,
    directory = [],
    closed = false,
    closeFailure,
    readerBaseline,
    totalKeys = 0,
    totalBytes = 0,
    manifestBytes = 0,
    persistedPages = new Map(),
    writtenPages = new Map(),
    writtenBytes = 0,
    instanceId = create ? crypto.randomBytes(32).toString('hex') : null;
  const active = () => {
    if (closed) throw refused('RAILGUN_STORE_REVOKED');
    getPrivacyContext(handle);
  };
  const noSidecars = () => {
    for (const suffix of ['-journal', '-wal', '-shm']) {
      try {
        // existsSync would miss broken symlinks, which are also refused.
        fs.lstatSync(filename + suffix);
      } catch (error) {
        if (error.code === 'ENOENT') continue;
        throw error;
      }
      throw refused('RAILGUN_STORE_UNREADABLE');
    }
  };
  const readerStat = () => {
    const stat = fs.lstatSync(filename, { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 100n || stat.size > BigInt(MAX_DISK))
      throw refused('RAILGUN_STORE_UNREADABLE');
    return stat;
  };
  const sameReaderFile = (stat) =>
    stat.dev === readerBaseline.dev &&
    stat.ino === readerBaseline.ino &&
    stat.size === readerBaseline.size &&
    stat.mtimeNs === readerBaseline.mtimeNs;
  const notifyFatal = () => {
    try {
      onFatal();
    } catch {
      /* Already revoked. */
    }
  };
  const abortClose = () => {
    try {
      close();
    } catch {
      notifyFatal();
    }
  };
  const close = () => {
    if (closed) {
      if (closeFailure) throw closeFailure;
      return;
    }
    closed = true;
    stop.abort();
    context.signal.removeEventListener('abort', abortClose);
    const pages = new Set(directory);
    for (const snapshot of snapshots) {
      for (const page of snapshot.pages) pages.add(page);
      snapshot.close();
    }
    for (const page of pages) {
      page.first.fill(0);
      page.last.fill(0);
    }
    secret.fill(0);
    directory = [];
    for (const page of [...persistedPages.values(), ...writtenPages.values()]) {
      page.first?.fill(0);
      page.last?.fill(0);
    }
    persistedPages.clear();
    writtenPages.clear();
    try {
      db?.close();
    } catch {
      closeFailure = refused('RAILGUN_STORE_UNREADABLE');
    } finally {
      opened.delete(filename);
      if (readOnly && readerBaseline) {
        try {
          noSidecars();
          if (!sameReaderFile(readerStat())) closeFailure = refused('RAILGUN_STORE_UNREADABLE');
        } catch {
          closeFailure = refused('RAILGUN_STORE_UNREADABLE');
        }
      }
    }
    if (closeFailure) throw closeFailure;
  };
  const guarded = (work) => {
    try {
      active();
      return work();
    } catch (error) {
      try {
        close();
      } catch {
        /* Preserve failure while still notifying the owner. */
      }
      notifyFatal();
      if (closeFailure) throw closeFailure;
      if (error.code?.startsWith('RAILGUN_') || error.code?.startsWith('PRIVACY_')) throw error;
      throw refused('RAILGUN_STORE_UNREADABLE');
    }
  };
  const seal = (plain, id) => {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', secret, iv);
    cipher.setAAD(Buffer.concat([aad, Buffer.from(id)]));
    return Buffer.concat([iv, cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
  };
  const unseal = (bytes, id) => {
    if (!Buffer.isBuffer(bytes) || bytes.length < 28) throw refused();
    const cipher = crypto.createDecipheriv('aes-256-gcm', secret, bytes.subarray(0, 12));
    cipher.setAAD(Buffer.concat([aad, Buffer.from(id)]));
    cipher.setAuthTag(bytes.subarray(-16));
    return Buffer.concat([cipher.update(bytes.subarray(12, -16)), cipher.final()]);
  };
  const find = (pages, key) => {
    let lo = 0,
      hi = pages.length;
    while (lo < hi) {
      const middle = (lo + hi) >>> 1;
      if (Buffer.compare(pages[middle].last, key) < 0) lo = middle + 1;
      else hi = middle;
    }
    return lo;
  };
  const readPage = (page) => {
    const row = db
      .prepare('SELECT ciphertext FROM records WHERE id = ? AND length(ciphertext) = ?')
      .get(page.id, page.sealed);
    if (
      !row ||
      row.ciphertext.length !== page.sealed ||
      crypto.createHash('sha256').update(row.ciphertext).digest('hex') !== page.hash
    )
      throw refused();
    const plain = unseal(row.ciphertext, page.id),
      rows = [];
    let offset = 4,
      bytes = 0;
    try {
      if (plain.length > MAX_PAGE || plain.readUInt32BE(0) !== page.count) throw refused();
      for (let i = 0; i < page.count; i++) {
        if (offset + 8 > plain.length) throw refused();
        const kl = plain.readUInt32BE(offset),
          vl = plain.readUInt32BE(offset + 4);
        offset += 8;
        if (!kl || kl > 4096 || vl > MAX_VALUE || offset + kl + vl > plain.length) throw refused();
        const k = Buffer.from(plain.subarray(offset, offset + kl));
        const v = Buffer.from(plain.subarray(offset + kl, offset + kl + vl));
        rows.push([k, v]);
        if (i && Buffer.compare(rows[i - 1][0], k) >= 0) throw refused();
        offset += kl + vl;
        bytes += kl + vl;
      }
      if (
        offset !== plain.length ||
        bytes !== page.bytes ||
        !rows[0][0].equals(page.first) ||
        !rows.at(-1)[0].equals(page.last)
      )
        throw refused();
      return rows;
    } catch (error) {
      wipe(rows);
      throw error;
    } finally {
      plain.fill(0);
    }
  };
  const encodeDirectory = (pages, retained = new Map(pages.map((p) => [p.id, p]))) => {
    let keys = 0,
      bytes = 0,
      directoryKeys = 0;
    for (const page of pages) {
      keys += page.count;
      bytes += page.bytes;
      directoryKeys += page.first.length + page.last.length;
    }
    if (
      pages.length > MAX_PAGES ||
      keys > MAX_KEYS ||
      bytes > MAX_BYTES ||
      directoryKeys > MAX_DIRECTORY_KEYS
    )
      throw refused('RAILGUN_STORE_LIMIT');
    const currentIds = new Set(pages.map((p) => p.id));
    const retired = [...retained.values()]
      .filter((p) => !currentIds.has(p.id))
      .map((p) => [p.id, p.hash, p.sealed]);
    if (retired.length > MAX_PAGES * 2) throw refused('RAILGUN_STORE_LIMIT');
    const encoded = [];
    let size = 128 + retired.length * 128;
    let previous = Buffer.alloc(0);
    const prefix = (a, b) => {
      let n = 0;
      while (n < a.length && n < b.length && a[n] === b[n]) n++;
      return n;
    };
    for (const p of pages) {
      const firstPrefix = prefix(previous, p.first),
        lastPrefix = prefix(p.first, p.last);
      const item = [
        p.id,
        p.hash,
        firstPrefix,
        p.first.subarray(firstPrefix).toString('base64'),
        lastPrefix,
        p.last.subarray(lastPrefix).toString('base64'),
        p.count,
        p.bytes,
        p.sealed,
      ];
      size += JSON.stringify(item).length + 1;
      if (size > MAX_DIRECTORY) throw refused('RAILGUN_STORE_LIMIT');
      encoded.push(item);
      previous = p.last;
    }
    // Legacy v2 manifests remain readable but never acquire an identity by
    // inference. Only explicit creation installs this authenticated instance id.
    const manifest = [2, keys, bytes, encoded, retired];
    if (instanceId !== null) manifest.push(instanceId);
    const plain = Buffer.from(JSON.stringify(manifest));
    try {
      if (plain.length > MAX_DIRECTORY) throw refused('RAILGUN_STORE_LIMIT');
      return { ciphertext: seal(plain, 'manifest'), keys, bytes };
    } finally {
      plain.fill(0);
    }
  };
  const writePage = (rows) => {
    const bytes = rows.reduce((n, [k, v]) => n + k.length + v.length, 0);
    const length = 4 + rows.length * 8 + bytes;
    if (length > MAX_PAGE || writtenBytes + length + 28 > MAX_BATCH)
      throw refused('RAILGUN_STORE_LIMIT');
    const plain = Buffer.alloc(length);
    plain.writeUInt32BE(rows.length);
    let offset = 4;
    for (const [k, v] of rows) {
      plain.writeUInt32BE(k.length, offset);
      plain.writeUInt32BE(v.length, offset + 4);
      offset += 8;
      k.copy(plain, offset);
      offset += k.length;
      v.copy(plain, offset);
      offset += v.length;
    }
    const id = crypto.randomBytes(16).toString('hex');
    let ciphertext;
    try {
      ciphertext = seal(plain, id);
    } finally {
      plain.fill(0);
    }
    db.prepare('INSERT INTO records VALUES (?, ?)').run(id, ciphertext);
    const page = {
      id,
      hash: crypto.createHash('sha256').update(ciphertext).digest('hex'),
      first: Buffer.from(rows[0][0]),
      last: Buffer.from(rows.at(-1)[0]),
      count: rows.length,
      bytes,
      sealed: ciphertext.length,
    };
    writtenBytes += ciphertext.length;
    writtenPages.set(id, page);
    return page;
  };
  const split = (rows) => {
    const pages = [];
    let start = 0,
      bytes = 4;
    for (let i = 0; i < rows.length; i++) {
      const size = 8 + rows[i][0].length + rows[i][1].length;
      if (i > start && bytes + size > PAGE_TARGET) {
        pages.push(writePage(rows.slice(start, i)));
        start = i;
        bytes = 4;
      }
      bytes += size;
    }
    if (start < rows.length) pages.push(writePage(rows.slice(start)));
    return pages;
  };
  const collection = (pages) => {
    const pinned = new Map(pages.map((p) => [p.id, p]));
    for (const snapshot of snapshots) for (const page of snapshot.pages) pinned.set(page.id, page);
    const currentBytes = pages.reduce((n, p) => n + p.sealed, 0);
    const pinnedBytes = [...pinned.values()].reduce((n, p) => n + p.sealed, 0);
    if (pinnedBytes - currentBytes > MAX_REWRITE - MAX_BATCH) throw refused('RAILGUN_STORE_LIMIT');
    const retained = new Map([...persistedPages, ...writtenPages]),
      removed = [];
    let remaining = MAX_REWRITE - writtenBytes;
    for (const page of retained.values()) {
      if (!pinned.has(page.id) && page.sealed <= remaining) {
        remaining -= page.sealed;
        removed.push(page.id);
        retained.delete(page.id);
      }
    }
    if ([...retained.values()].reduce((n, p) => n + p.sealed, 0) > MAX_DISK / 2)
      throw refused('RAILGUN_STORE_LIMIT');
    return { retained, removed };
  };
  const compact = (pages) => {
    const result = [];
    let budget = Math.min(4 * 1024 * 1024, MAX_BATCH - writtenBytes);
    for (let i = 0; i < pages.length;) {
      let end = i + 1,
        bytes = pages[i].sealed - 28;
      while (end < pages.length && bytes + pages[end].sealed - 32 <= PAGE_TARGET) {
        bytes += pages[end].sealed - 32;
        end++;
      }
      if (end - i > 1 && bytes + 28 <= budget) {
        const rows = [];
        try {
          for (let j = i; j < end; j++) rows.push(...readPage(pages[j]));
          result.push(writePage(rows));
          budget -= bytes + 28;
        } finally {
          wipe(rows);
        }
      } else result.push(...pages.slice(i, end));
      i = end;
    }
    return result;
  };
  const publish = (makePages, maintenance = true) => {
    if (readOnly) throw refused('RAILGUN_STORE_READ_ONLY');
    let next, manifest, plan;
    writtenBytes = 0;
    writtenPages = new Map();
    db.transaction(() => {
      active();
      next = makePages();
      if (maintenance) next = compact(next);
      plan = collection(next);
      manifest = encodeDirectory(next, plan.retained);
      db.prepare('UPDATE records SET ciphertext = ? WHERE id = ?').run(
        manifest.ciphertext,
        'manifest'
      );
      const remove = db.prepare('DELETE FROM records WHERE id = ?');
      for (const id of plan.removed) remove.run(id);
    })();
    directory = next;
    persistedPages = plan.retained;
    writtenPages.clear();
    manifestBytes = manifest.ciphertext.length;
    totalKeys = manifest.keys;
    totalBytes = manifest.bytes;
  };
  try {
    active();
    if (readOnly) {
      let stat;
      try {
        stat = readerStat();
      } catch (error) {
        if (error.code === 'ENOENT') throw refused('RAILGUN_STORE_MISSING');
        throw error;
      }
      noSidecars();
      const fd = fs.openSync(filename, 'r');
      try {
        const header = Buffer.alloc(100);
        if (
          fs.readSync(fd, header, 0, header.length, 0) !== header.length ||
          !header.subarray(0, 16).equals(Buffer.from('SQLite format 3\0')) ||
          header[18] !== 1 ||
          header[19] !== 1
        )
          throw refused();
      } finally {
        fs.closeSync(fd);
      }
      readerBaseline = stat;
      if (!sameReaderFile(readerStat())) throw refused();
    } else {
      if (create) {
        fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
        fs.closeSync(fs.openSync(filename, 'wx', 0o600));
      } else if (!fs.existsSync(filename)) throw refused('RAILGUN_STORE_MISSING');
      if (fs.lstatSync(filename).isSymbolicLink() || fs.statSync(filename).size > MAX_DISK)
        throw refused();
    }
    const Database = require('better-sqlite3');
    db = new Database(filename, {
      fileMustExist: true,
      timeout: 0,
      ...(readOnly ? { readonly: true } : {}),
    });
    if (readOnly) {
      db.pragma('query_only = ON');
      db.pragma('temp_store = MEMORY');
      if (db.pragma('journal_mode', { simple: true }) !== 'delete') throw refused();
    } else {
      db.pragma('journal_mode = DELETE');
      db.pragma('synchronous = FULL');
      if (process.platform === 'darwin') db.pragma('fullfsync = ON');
      db.pragma('secure_delete = ON');
    }
    db.pragma('trusted_schema = OFF');
    db.pragma('cache_size = -4096');
    db.pragma('mmap_size = 0');
    if (readOnly) db.exec('BEGIN');
    else {
      db.pragma('locking_mode = EXCLUSIVE');
      db.exec('BEGIN EXCLUSIVE; COMMIT;');
      db.pragma(
        'max_page_count = ' + Math.floor(MAX_DISK / db.pragma('page_size', { simple: true }))
      );
    }
    if (create)
      db.transaction(() => {
        db.exec('CREATE TABLE records (id TEXT PRIMARY KEY, ciphertext BLOB NOT NULL)');
        db.prepare('INSERT INTO records VALUES (?, ?)').run(
          'manifest',
          encodeDirectory([]).ciphertext
        );
      })();
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
    const manifestSize = db
      .prepare("SELECT length(ciphertext) AS size FROM records WHERE id = 'manifest'")
      .get()?.size;
    if (!integer(manifestSize, MAX_DIRECTORY + 28) || manifestSize < 28) throw refused();
    const raw = unseal(
      db.prepare("SELECT ciphertext FROM records WHERE id = 'manifest'").get().ciphertext,
      'manifest'
    );
    let parsed;
    try {
      parsed = JSON.parse(raw.toString());
    } finally {
      raw.fill(0);
    }
    if (
      !Array.isArray(parsed) ||
      ![5, 6].includes(parsed.length) ||
      (parsed.length === 6 &&
        (typeof parsed[5] !== 'string' || !/^[0-9a-f]{64}$/.test(parsed[5]))) ||
      parsed[0] !== 2 ||
      !integer(parsed[1], MAX_KEYS) ||
      !integer(parsed[2], MAX_BYTES) ||
      !Array.isArray(parsed[3]) ||
      parsed[3].length > MAX_PAGES ||
      !Array.isArray(parsed[4]) ||
      parsed[4].length > MAX_PAGES * 2
    )
      throw refused();
    instanceId = parsed.length === 6 ? parsed[5] : null;
    const ids = new Set();
    let directoryKeys = 0,
      previous = Buffer.alloc(0);
    for (const p of parsed[3]) {
      if (
        !Array.isArray(p) ||
        p.length !== 9 ||
        typeof p[0] !== 'string' ||
        !/^[0-9a-f]{32}$/.test(p[0]) ||
        typeof p[1] !== 'string' ||
        !/^[0-9a-f]{64}$/.test(p[1]) ||
        ids.has(p[0]) ||
        !integer(p[2], previous.length) ||
        typeof p[3] !== 'string' ||
        p[3].length > 5464 ||
        !integer(p[4], 4096) ||
        typeof p[5] !== 'string' ||
        p[5].length > 5464 ||
        !integer(p[6], PAGE_TARGET / 8) ||
        !p[6] ||
        !integer(p[7], MAX_PAGE) ||
        !integer(p[8], MAX_PAGE + 28) ||
        p[8] < 32
      )
        throw refused();
      const firstSuffix = Buffer.from(p[3], 'base64'),
        lastSuffix = Buffer.from(p[5], 'base64');
      const first = Buffer.concat([previous.subarray(0, p[2]), firstSuffix]);
      if (p[4] > first.length) throw refused();
      const page = {
        id: p[0],
        hash: p[1],
        first,
        last: Buffer.concat([first.subarray(0, p[4]), lastSuffix]),
        count: p[6],
        bytes: p[7],
        sealed: p[8],
      };
      validKey(page.first);
      validKey(page.last);
      if (
        firstSuffix.toString('base64') !== p[3] ||
        lastSuffix.toString('base64') !== p[5] ||
        Buffer.compare(page.first, page.last) > 0 ||
        (directory.length && Buffer.compare(previous, page.first) >= 0)
      )
        throw refused();
      directoryKeys += page.first.length + page.last.length;
      if (directoryKeys > MAX_DIRECTORY_KEYS) throw refused();
      directory.push(page);
      previous = page.last;
      ids.add(page.id);
      persistedPages.set(page.id, page);
      totalKeys += page.count;
      totalBytes += page.bytes;
    }
    if (totalKeys !== parsed[1] || totalBytes !== parsed[2]) throw refused();
    // Persist snapshot-retained page digests too: an extra or substituted row is
    // corruption, never unauthenticated garbage silently discarded on startup.
    const retired = new Map();
    for (const p of parsed[4]) {
      if (
        !Array.isArray(p) ||
        p.length !== 3 ||
        typeof p[0] !== 'string' ||
        !/^[0-9a-f]{32}$/.test(p[0]) ||
        typeof p[1] !== 'string' ||
        !/^[0-9a-f]{64}$/.test(p[1]) ||
        ids.has(p[0]) ||
        !integer(p[2], MAX_PAGE + 28) ||
        p[2] < 32
      )
        throw refused();
      ids.add(p[0]);
      retired.set(p[0], p);
      persistedPages.set(p[0], { id: p[0], hash: p[1], sealed: p[2] });
    }
    const rows = db.prepare(
      "SELECT id, length(ciphertext) AS size FROM records WHERE id != 'manifest'"
    );
    let count = 0,
      diskBytes = manifestSize;
    for (const row of rows.iterate()) {
      if (++count > MAX_PAGES * 3 || !ids.has(row.id) || !integer(row.size, MAX_PAGE + 28))
        throw refused();
      diskBytes += row.size;
      if (diskBytes > MAX_DISK / 2) throw refused();
    }
    if (count !== ids.size) throw refused();
    for (const page of directory) wipe(readPage(page));
    for (const [id, hash, sealed] of retired.values()) {
      const row = db
        .prepare('SELECT ciphertext FROM records WHERE id = ? AND length(ciphertext) = ?')
        .get(id, sealed);
      if (!row || crypto.createHash('sha256').update(row.ciphertext).digest('hex') !== hash)
        throw refused();
    }
    manifestBytes = manifestSize;
    // Collection is safe only after complete current-state authentication.
    // A reader authenticates retired rows too, but must not collect or reseal them.
    if (!readOnly) while (persistedPages.size > directory.length) publish(() => directory, false);
    if (create && process.platform !== 'win32') {
      const parent = fs.openSync(path.dirname(filename), 'r');
      try {
        fs.fsyncSync(parent);
      } finally {
        fs.closeSync(parent);
      }
    }
    opened.add(filename);
    context.signal.addEventListener('abort', abortClose, { once: true });
    active();
  } catch (error) {
    try {
      close();
    } catch {
      /* Opening already failed; cleanup still completed. */
    }
    if (['RAILGUN_STORE_MISSING', 'RAILGUN_STORE_INCOMPLETE'].includes(error.code)) throw error;
    if (error.code === 'EEXIST') throw refused('RAILGUN_STORE_EXISTS');
    if (['SQLITE_BUSY', 'SQLITE_LOCKED'].includes(error.code)) throw refused('RAILGUN_STORE_BUSY');
    throw refused('RAILGUN_STORE_UNREADABLE');
  }
  const openSnapshot = (input = {}) =>
    guarded(() => {
      if (snapshots.size >= 2) throw refused('RAILGUN_STORE_LIMIT');
      const options = bounds(input),
        pages = directory.filter((page) => overlaps(page, options));
      let rows = [],
        pageIndex = options.reverse ? pages.length - 1 : 0;
      let position = 0,
        count = 0,
        disposed = false,
        target;
      const releaseRows = () => {
        wipe(rows);
        rows = [];
      };
      const snapshot = {
        pages,
        close() {
          if (disposed) return;
          disposed = true;
          clearTimeout(timer);
          clearTimeout(maximumLifetime);
          releaseRows();
          snapshots.delete(snapshot);
          for (const name of ['gt', 'gte', 'lt', 'lte']) options[name]?.fill(0);
          target?.fill(0);
        },
      };
      const timer = setTimeout(() => snapshot.close(), 300000);
      const maximumLifetime = setTimeout(() => snapshot.close(), 1800000);
      timer.unref?.();
      maximumLifetime.unref?.();
      snapshots.add(snapshot);
      const cursorActive = () => {
        if (disposed) throw refused('RAILGUN_STORE_REVOKED');
        timer.refresh();
      };
      return Object.freeze({
        close: snapshot.close,
        seek(key) {
          return guarded(() => {
            cursorActive();
            validKey(key);
            target?.fill(0);
            target = Buffer.from(key);
            releaseRows();
            pageIndex = find(pages, target);
            if (options.reverse && pageIndex === pages.length) pageIndex--;
            position = 0;
          });
        },
        next() {
          return guarded(() => {
            cursorActive();
            if (options.limit >= 0 && count >= options.limit) return null;
            for (;;) {
              if (position >= rows.length) {
                releaseRows();
                if (pageIndex < 0 || pageIndex >= pages.length) return null;
                rows = readPage(pages[pageIndex]);
                position = 0;
                pageIndex += options.reverse ? -1 : 1;
                if (options.reverse) rows.reverse();
              }
              const [k, v] = rows[position++];
              if (
                !matches(k, options) ||
                (target &&
                  (options.reverse ? Buffer.compare(k, target) > 0 : Buffer.compare(k, target) < 0))
              )
                continue;
              count++;
              return [Buffer.from(k), options.values === false ? Buffer.alloc(0) : Buffer.from(v)];
            }
          });
        },
      });
    });
  return Object.freeze({
    signal,
    close,
    assertActive: active,
    openSnapshot,
    getInstanceId: () => guarded(() => instanceId),
    stats: () =>
      guarded(() => ({
        keys: totalKeys,
        bytes: totalBytes,
        pages: directory.length,
        snapshots: snapshots.size,
        directoryBytes: manifestBytes,
        retiredPages: persistedPages.size - directory.length,
        pageFill: directory.length
          ? (totalBytes + totalKeys * 8 + directory.length * 4) /
            directory.reduce((n, p) => n + Math.max(PAGE_TARGET, p.sealed - 28), 0)
          : 1,
      })),
    get(k) {
      return guarded(() => {
        validKey(k);
        const index = find(directory, k);
        if (index === directory.length || Buffer.compare(k, directory[index].first) < 0)
          return null;
        const rows = readPage(directory[index]);
        try {
          const value = rows.find(([key]) => key.equals(k))?.[1];
          return value ? Buffer.from(value) : null;
        } finally {
          wipe(rows);
        }
      });
    },
    batch(operations) {
      return guarded(() => {
        if (readOnly) throw refused('RAILGUN_STORE_READ_ONLY');
        if (!Array.isArray(operations) || !operations.length || operations.length > 65536)
          throw refused();
        let bytes = 0;
        const updates = new Map();
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
          bytes += op.key.length + (op.type === 'put' ? op.value.length : 0);
          if (bytes > MAX_BATCH) throw refused('RAILGUN_STORE_LIMIT');
          updates.set(op.key.toString('hex'), op);
        }
        const groups = new Map();
        for (const op of updates.values()) {
          const index = Math.min(find(directory, op.key), Math.max(0, directory.length - 1));
          if (!groups.has(index)) groups.set(index, []);
          groups.get(index).push(op);
        }
        publish(() => {
          const next = [];
          for (let i = 0; i < Math.max(1, directory.length); i++) {
            if (!groups.has(i)) {
              next.push(directory[i]);
              continue;
            }
            const rows = directory[i] ? readPage(directory[i]) : [];
            try {
              const merged = new Map(rows.map((row) => [row[0].toString('hex'), row]));
              for (const op of groups.get(i)) {
                if (op.type === 'del') merged.delete(op.key.toString('hex'));
                else merged.set(op.key.toString('hex'), [op.key, op.value]);
              }
              next.push(...split([...merged.values()].sort((a, b) => Buffer.compare(a[0], b[0]))));
            } finally {
              wipe(rows);
            }
          }
          return next;
        });
      });
    },
    clear(input = {}) {
      return guarded(() => {
        if (readOnly) throw refused('RAILGUN_STORE_READ_ONLY');
        const options = bounds(input);
        let remaining = options.limit >= 0 ? options.limit : Infinity;
        try {
          publish(() => {
            const replacement = new Map();
            const indices = Array.from(directory.keys());
            if (options.reverse) indices.reverse();
            for (const i of indices) {
              if (!remaining) break;
              if (!overlaps(directory[i], options)) continue;
              if (
                remaining >= directory[i].count &&
                matches(directory[i].first, options) &&
                matches(directory[i].last, options)
              ) {
                replacement.set(i, []);
                remaining -= directory[i].count;
                continue;
              }
              const rows = readPage(directory[i]);
              try {
                const order = options.reverse ? [...rows].reverse() : rows;
                const removed = new Set();
                for (const row of order)
                  if (remaining && matches(row[0], options)) {
                    removed.add(row);
                    remaining--;
                  }
                if (removed.size)
                  replacement.set(i, split(rows.filter((row) => !removed.has(row))));
              } finally {
                wipe(rows);
              }
            }
            return directory.flatMap((page, i) => replacement.get(i) ?? [page]);
          });
        } finally {
          for (const name of ['gt', 'gte', 'lt', 'lte']) options[name]?.fill(0);
        }
      });
    },
  });
}
function createRailgunPagedStore(options) {
  return openPagedStore(options, false);
}
function openRailgunReadOnlyPagedStore(options) {
  return openPagedStore(options, true);
}
module.exports = { createRailgunPagedStore, openRailgunReadOnlyPagedStore };
