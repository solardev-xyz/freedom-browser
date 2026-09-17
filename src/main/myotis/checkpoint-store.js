const fs = require('fs/promises');
const { constants } = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { validateCheckpoint } = require('./checkpoint-verifier');

const SCHEMA_VERSION = 1;
const POINTER = 'verified-sync.json';
const GENERATIONS = 'verified-sync';
const OWNER = '.freedom-myotis-owner';
// Match both native supervisors, whose receipt generation permits every
// lowercase UUID-shaped value, not just UUIDv4 storage generation identifiers.
const RETIRED_OWNER = /^v1 retired [0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\n$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function classifyStorageError(error) {
  if (error.code === 'CHECKPOINT_OWNERSHIP') return error;
  if (['ENOSPC', 'EDQUOT', 'EACCES', 'EPERM', 'EROFS', 'EIO', 'EMFILE', 'ENFILE'].includes(error.code)) {
    const failure = new Error('Could not access Myotis sync storage');
    failure.code = 'CHECKPOINT_STORAGE_IO';
    return failure;
  }
  return storageError();
}

function storageError() {
  const error = new Error('Could not read or save Myotis recovery data');
  error.code = 'CHECKPOINT_STORAGE';
  return error;
}

function ownershipError() {
  const error = new Error(
    'Myotis native exit is unconfirmed; automatic checkpoint recovery is blocked'
  );
  error.code = 'CHECKPOINT_OWNERSHIP';
  return error;
}

// Migration must not escape an active/quarantined supervisor merely by choosing
// a new data directory. Native code writes retired only after waiting for its
// direct child. This is a durable-record gate, not a PID probe or a substitute
// for the browser profile lock and the supervisor's kernel ownership lock.
async function requireRetiredOwner(dataDir) {
  const filename = path.join(dataDir, OWNER);
  let before;
  try {
    before = await fs.lstat(filename);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw ownershipError();
  }
  let handle;
  try {
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size !== 48) {
      throw ownershipError();
    }
    handle = await fs.open(
      filename,
      constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0)
    );
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.nlink !== 1 ||
      opened.size !== 48 ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino
    )
      throw ownershipError();
    const bytes = Buffer.alloc(49);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead !== 48 || !RETIRED_OWNER.test(bytes.toString('utf8', 0, bytesRead))) {
      throw ownershipError();
    }
    const after = await handle.stat();
    if (after.size !== 48 || after.nlink !== 1) throw ownershipError();
  } catch {
    throw ownershipError();
  } finally {
    if (handle) await handle.close();
  }
}

async function directory(filename, create = false) {
  if (create) await fs.mkdir(filename, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(filename);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw storageError();
}

async function readBytes(filename) {
  const stat = await fs.lstat(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16384) throw storageError();
  const handle = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size > 16384 || opened.dev !== stat.dev || opened.ino !== stat.ino)
      throw storageError();
    const bytes = Buffer.alloc(16385);
    let bytesRead = 0;
    while (bytesRead < bytes.length) {
      const chunk = await handle.read(bytes, bytesRead, bytes.length - bytesRead, bytesRead);
      if (chunk.bytesRead === 0) break;
      bytesRead += chunk.bytesRead;
    }
    if (bytesRead > 16384) throw storageError();
    return bytes.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

async function readJson(filename) {
  return JSON.parse((await readBytes(filename)).toString('utf8'));
}

async function writeBytes(filename, bytes) {
  const handle = await fs.open(filename, 'wx', 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeJson(filename, value) {
  return writeBytes(filename, JSON.stringify(value) + '\n');
}

function validateIdentity(record, chainId) {
  if (
    record?.schemaVersion !== SCHEMA_VERSION ||
    record.chainId !== chainId ||
    !UUID.test(record.generation)
  )
    throw storageError();
}

async function prepareBase(baseDir, chainId) {
  if (!path.isAbsolute(baseDir) || ![1, 100].includes(chainId)) throw storageError();
  await directory(baseDir, true);
  await requireRetiredOwner(baseDir);
  await directory(path.join(baseDir, GENERATIONS), true);
}

async function requireCurrentOwnerRetired(baseDir, chainId) {
  let pointer;
  try {
    pointer = await readJson(path.join(baseDir, POINTER));
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  validateIdentity(pointer, chainId);
  const dataDir = path.join(baseDir, GENERATIONS, pointer.generation);
  await directory(dataDir);
  await requireRetiredOwner(dataDir);
}

// Repair cannot trust the pointer to identify the previous native child.
// Inspect every generation, including orphans. Unknown entries and any active
// or quarantined owner refuse repair; no ownership receipt is ever rewritten.
async function requireAllOwnersRetired(baseDir) {
  await directory(baseDir);
  await requireRetiredOwner(baseDir);
  const generations = path.join(baseDir, GENERATIONS);
  await directory(generations);
  for (const name of await fs.readdir(generations)) {
    if (!UUID.test(name)) throw storageError();
    const dataDir = path.join(generations, name);
    await directory(dataDir);
    await requireRetiredOwner(dataDir);
  }
}

async function createState(baseDir, chainId, checkpoint = null, repair = false) {
  await prepareBase(baseDir, chainId);
  const checkOwners = () => repair ? requireAllOwnersRetired(baseDir) : requireCurrentOwnerRetired(baseDir, chainId);
  await checkOwners();
  if (checkpoint) validateCheckpoint(checkpoint, chainId);
  const generation = randomUUID();
  const dataDir = path.join(baseDir, GENERATIONS, generation);
  await fs.mkdir(dataDir, { mode: 0o700 });
  const record = {
    schemaVersion: SCHEMA_VERSION,
    chainId,
    generation,
    nativeCheckpointApi: 26,
    origin: checkpoint ? 'verified' : 'bundled',
    checkpoint: checkpoint ? JSON.parse(JSON.stringify(checkpoint)) : null,
  };
  // This immutable anchor belongs to exactly one native state generation.
  // Old directories are retained; recovery never edits or copies old snapshots.
  await writeJson(path.join(dataDir, 'anchor.json'), record);
  const temporary = path.join(baseDir, `verified-sync-${randomUUID()}.tmp`);
  await writeJson(temporary, { schemaVersion: SCHEMA_VERSION, chainId, generation });
  await requireRetiredOwner(baseDir);
  await checkOwners();
  await fs.rename(temporary, path.join(baseDir, POINTER));
  return { ...record, dataDir };
}

async function loadOrCreateState(baseDir, chainId) {
  try {
    await prepareBase(baseDir, chainId);
    let pointer;
    try {
      pointer = await readJson(path.join(baseDir, POINTER));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      // Even if a legacy cache exists, start a new guarded generation. Older
      // builds could persist state after an explicit stale-anchor override.
      return await createState(baseDir, chainId);
    }
    validateIdentity(pointer, chainId);
    const dataDir = path.join(baseDir, GENERATIONS, pointer.generation);
    await directory(dataDir);
    await requireRetiredOwner(dataDir);
    const record = await readJson(path.join(dataDir, 'anchor.json'));
    validateIdentity(record, chainId);
    if (record.generation !== pointer.generation ||
        (record.nativeCheckpointApi !== undefined && record.nativeCheckpointApi !== 26)) throw storageError();
    if (record.origin === 'verified')
      validateCheckpoint(record.checkpoint, chainId, { fresh: false });
    else if (record.origin !== 'bundled' || record.checkpoint !== null) throw storageError();
    // The native marker is untrusted filesystem input too. Its absence is
    // valid before the first constructor; Myotis refuses an existing snapshot
    // without a marker. Existing markers must agree with our authenticated
    // record, and symlinks (including dangling ones) are never treated as absent.
    const markerPath = path.join(dataDir, chainId === 1 ? 'sync-anchor.json' : 'sync-anchor-gnosis.json');
    let markerPresent = true;
    try { await fs.lstat(markerPath); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      markerPresent = false;
    }
    if (markerPresent) {
      const marker = await readJson(markerPath);
      if (record.origin !== 'verified' ||
          marker.checkpointRoot !== record.checkpoint.root ||
          marker.checkpointSlot !== record.checkpoint.slot) throw storageError();
    }
    for (const name of [
      'sync-state.snapshot',
      'sync-state-gnosis.snapshot',
      'cl-peers.cache',
      'cl-peers-gnosis.cache',
    ]) {
      try {
        const stat = await fs.lstat(path.join(dataDir, name));
        if (!stat.isFile() || stat.isSymbolicLink()) throw storageError();
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    // Patched ABI 25 generations have no native anchor marker contract. Keep
    // them intact and bootstrap a new bundled generation; if its anchor is
    // stale, normal quorum + Colibri recovery supplies a fresh checkpoint.
    // Never manufacture a native marker to adopt an old snapshot.
    if (record.nativeCheckpointApi === undefined && record.origin === 'verified')
      return await createState(baseDir, chainId);
    return { ...record, dataDir };
  } catch (error) {
    throw classifyStorageError(error);
  }
}

async function replaceCheckpoint(baseDir, chainId, checkpoint) {
  try {
    return await createState(baseDir, chainId, checkpoint);
  } catch (error) {
    throw classifyStorageError(error);
  }
}

async function repairState(baseDir, chainId) {
  try {
    await prepareBase(baseDir, chainId);
    await requireAllOwnersRetired(baseDir);
    // Keep the old pointer too, even when malformed. A linked or oversized
    // pointer is not automatically repairable. Switching the pointer is atomic;
    // it is never removed, so failed repair cannot open a missing-pointer escape.
    let bytes;
    try { bytes = await readBytes(path.join(baseDir, POINTER)); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (bytes) await writeBytes(path.join(baseDir, `verified-sync-backup-${randomUUID()}.json`), bytes);
    return await createState(baseDir, chainId, null, true);
  } catch (error) {
    throw classifyStorageError(error);
  }
}

module.exports = { loadOrCreateState, replaceCheckpoint, repairState };
