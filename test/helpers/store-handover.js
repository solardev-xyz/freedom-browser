/* global jest */
/**
 * Helpers for PRF-6's store handover tests against the real freedom-cored
 * (freedom-core design 0013, "One writer per store: `store_moved`"): the
 * pinned binary and the previous release (design 0013's "previous core
 * release", scripts/fetch-freedom-cored-previous.js), a client whose hello
 * names the stores a test chooses, a spy on main's writes, a watch of every
 * touch of a store's files with whose it was (SWM-6's gates), file digests
 * and directory snapshots, a process's open files, and one request per
 * write of each set-A store.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync, spawn } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const quietLog = { info() {}, warn() {}, error() {}, debug() {} };

/**
 * `{ current, previous }`: the pinned freedom-cored, `FREEDOM_CORED_PATH` or,
 * with `FREEDOM_CORED_STORES_TEST=1`, the binary core-process.js runs (as
 * grants.integration.test.js resolves it), and otherwise null; and the
 * previous release, `FREEDOM_CORED_PREVIOUS_PATH` or
 * `freedom-cored-bin-previous/<os>-<arch>/freedom-cored[.exe]`. With
 * `FREEDOM_CORED_STORES_TEST=1` a missing binary throws, naming the npm
 * script that fetches it.
 */
function coredBinaries() {
  const required = process.env.FREEDOM_CORED_STORES_TEST === '1';
  const current =
    process.env.FREEDOM_CORED_PATH ||
    (required ? require('../../src/main/core/cored-binary').getCoredBinaryPath() : null);
  const os = { darwin: 'mac', linux: 'linux', win32: 'win' }[process.platform] || process.platform;
  const name = process.platform === 'win32' ? 'freedom-cored.exe' : 'freedom-cored';
  const previous =
    process.env.FREEDOM_CORED_PREVIOUS_PATH ||
    path.join(ROOT, 'freedom-cored-bin-previous', `${os}-${process.arch}`, name);
  if (required) {
    if (!fs.existsSync(current)) {
      throw new Error('FREEDOM_CORED_STORES_TEST=1 needs freedom-cored: run npm run core:download');
    }
    if (!fs.existsSync(previous)) {
      throw new Error(
        'FREEDOM_CORED_STORES_TEST=1 needs the previous freedom-cored: run npm run core:download:previous'
      );
    }
  }
  return { current, previous };
}

/**
 * A started CoreClient on `binary`, with its identity and lock directories
 * under `root`, which is also its grant root unless `grantRoot` names
 * another. With `storeMoved`, its hello names those stores (and takes an
 * echo of those only) rather than the build's `STORE_MOVED`; with
 * `userDataDir`, it names that as the profile's directory (PRF-8b-lite).
 * The client passes both as `serve`'s arguments too (freedom-core design
 * 0017, C1), unless `grantArgs` is false: the previous release (0.22.0)
 * doesn't know them, and is run with `grantArgs: false`.
 * `beforeStart(client)` runs (and is awaited) before the client starts: a
 * test loads main's modules on it there, so what listens for the handshake
 * hears it.
 */
async function startCore({
  binary,
  root,
  storeMoved,
  grantRoot = root,
  userDataDir,
  grantArgs = true,
  beforeStart = null,
}) {
  const { CoreClient, _internal } = require('../../src/main/core/core-client');
  const client = new CoreClient({
    spawn,
    command: binary,
    args: [
      'serve',
      '--data-dir',
      path.join(root, 'identity'),
      '--lock-dir',
      path.join(root, 'locks'),
    ],
    log: quietLog,
    shellVersion: 'jest',
    grantRoot,
    userDataDir,
    grantArgs,
  });
  if (storeMoved) client.service = _internal.coreService(storeMoved);
  if (beforeStart) await beforeStart(client);
  await client.start();
  return client;
}

// APB-2's lists (signing-confirmation.integration.test.js), and the calls
// that change a file's mode or make a directory.
const FS_WRITES = [
  'writeFileSync',
  'appendFileSync',
  'renameSync',
  'copyFileSync',
  'truncateSync',
  'unlinkSync',
  'rmSync',
  'openSync',
  'chmodSync',
  'mkdirSync',
];
const FS_PROMISE_WRITES = [
  'writeFile',
  'appendFile',
  'rename',
  'copyFile',
  'truncate',
  'unlink',
  'rm',
  'open',
  'chmod',
];
// With `forbidReads`, reads of the file offend too.
const FS_READS = ['readFileSync', 'createReadStream'];
const FS_PROMISE_READS = ['readFile'];

/**
 * Spies on main's writes (and, with `forbidReads`, its reads) of any path
 * matching `pattern`: `offending()` lists each call that touched one, as
 * `{ name, args }`, and `restore()` removes the spies. An open with no
 * flags or `'r'` is a read, allowed unless `forbidReads`.
 */
function watchWrites(pattern, { forbidReads = false } = {}) {
  const names = [...FS_WRITES, ...(forbidReads ? FS_READS : [])];
  const promiseNames = [...FS_PROMISE_WRITES, ...(forbidReads ? FS_PROMISE_READS : [])];
  const spies = [
    ...names.map((name) => [name, jest.spyOn(fs, name)]),
    ...promiseNames.map((name) => [`promises.${name}`, jest.spyOn(fs.promises, name)]),
  ];
  const isOpen = (name) => name === 'openSync' || name === 'promises.open';
  const matches = (value) =>
    (typeof value === 'string' || value instanceof URL || Buffer.isBuffer(value)) &&
    pattern.test(String(value));
  return {
    offending() {
      const out = [];
      for (const [name, spy] of spies) {
        for (const args of spy.mock.calls) {
          const [target, second] = args;
          if (isOpen(name) && !forbidReads && (second === undefined || second === 'r')) continue;
          if (matches(target) || (typeof second === 'string' && matches(second))) {
            out.push({ name, args });
          }
        }
      }
      return out;
    },
    restore() {
      for (const [, spy] of spies) spy.mockRestore();
    },
  };
}

// Every `fs` call that takes a path, for `watchFileTouches`: opens, reads,
// writes, stats, streams and watches, sync, callback and promise forms.
const FS_PATH_CALLS = [
  'access',
  'appendFile',
  'chmod',
  'chown',
  'copyFile',
  'cp',
  'createReadStream',
  'createWriteStream',
  'exists',
  'lchown',
  'link',
  'lstat',
  'lutimes',
  'mkdir',
  'open',
  'openAsBlob',
  'readFile',
  'readlink',
  'realpath',
  'rename',
  'rm',
  'rmdir',
  'stat',
  'statfs',
  'symlink',
  'truncate',
  'unlink',
  'utimes',
  'watch',
  'watchFile',
  'writeFile',
];
const FS_PATH_CALLS_SYNC = FS_PATH_CALLS.filter(
  (name) =>
    !['createReadStream', 'createWriteStream', 'openAsBlob', 'watch', 'watchFile'].includes(name)
).map((name) => `${name}Sync`);
const FS_PROMISE_PATH_CALLS = FS_PATH_CALLS.filter(
  (name) =>
    !['createReadStream', 'createWriteStream', 'exists', 'openAsBlob', 'watchFile'].includes(name)
).concat(['lchmod']);

const REFERENCE_MODULES = path.join(ROOT, 'test', 'helpers', 'reference-');

/** The files of a V8 stack's frames, innermost first. */
function stackFiles(stack) {
  const files = [];
  for (const line of String(stack).split('\n').slice(1)) {
    const found = /\(([^()]+):\d+:\d+\)$/.exec(line) || /at ([^\s()]+):\d+:\d+$/.exec(line);
    if (found) files.push(found[1]);
  }
  return files;
}

/**
 * Whether a touch's stack is main's: its innermost frame outside Node,
 * node_modules and the watching files (`skip`) is a module under src/ that
 * isn't a test, and no frame is a reference module's
 * (test/helpers/reference-*.js), which may call main's helpers.
 */
function isMainStack(files, skip) {
  if (files.some((file) => file.startsWith(REFERENCE_MODULES))) return false;
  const inner = files.find(
    (file) =>
      path.isAbsolute(file) && !file.split(/[\\/]/).includes('node_modules') && !skip.includes(file)
  );
  if (!inner) return false;
  const rel = path.relative(ROOT, inner);
  return rel.split(/[\\/]/)[0] === 'src' && !/\.test\.js$/.test(rel);
}

/**
 * Watches every touch of a file whose path `matches` (a function of the
 * path's text), by any `fs` call that takes a path (`FS_PATH_CALLS`, each
 * form), across every module registry (Node's `fs` is shared), until
 * `restore()`. `record(name, target)` records another kind of touch (a
 * spied better-sqlite3 open) from where it is called. Each touch is `{
 * name, path, files, main }`: the call, the path, its stack's files, and
 * whether main made it (`isMainStack`, `skip` naming the files whose frames
 * are the watch's own, a test file that records from its spies). `mark()`
 * and `since(mark)` read the touches from a point on; `allowed(fn)` runs
 * `fn` with main's touches kept apart (`allowedTouches()`), for a run
 * where main is the files' writer by design (the JS backend's).
 */
function watchFileTouches(matches, { skip = [] } = {}) {
  const touches = [];
  const allowed = [];
  let allowing = 0;
  const own = [__filename, ...skip];
  const matching = (value) =>
    (typeof value === 'string' || value instanceof URL || Buffer.isBuffer(value)) &&
    matches(String(value));
  const record = (name, target) => {
    const limit = Error.stackTraceLimit;
    Error.stackTraceLimit = 100;
    const { stack } = new Error();
    Error.stackTraceLimit = limit;
    const files = stackFiles(stack);
    const touch = { name, path: String(target), files, main: isMainStack(files, own) };
    (touch.main && allowing > 0 ? allowed : touches).push(touch);
  };
  const restores = [];
  const wrap = (target, name, label) => {
    const original = target[name];
    if (typeof original !== 'function') return;
    const wrapper = function watched(...args) {
      for (const arg of args.slice(0, 2)) {
        if (matching(arg)) {
          record(label, arg);
          break;
        }
      }
      return original.apply(this, args);
    };
    for (const key of Reflect.ownKeys(original)) {
      if (['length', 'name', 'prototype'].includes(key)) continue;
      Object.defineProperty(wrapper, key, Object.getOwnPropertyDescriptor(original, key));
    }
    target[name] = wrapper;
    restores.push(() => {
      target[name] = original;
    });
  };
  for (const name of [...FS_PATH_CALLS, ...FS_PATH_CALLS_SYNC]) wrap(fs, name, name);
  for (const name of FS_PROMISE_PATH_CALLS) wrap(fs.promises, name, `promises.${name}`);
  return {
    record,
    touches: () => [...touches],
    mainTouches: () => touches.filter((touch) => touch.main),
    mark: () => touches.length,
    since: (mark) => touches.slice(mark),
    async allowed(fn) {
      allowing += 1;
      try {
        return await fn();
      } finally {
        allowing -= 1;
      }
    },
    allowedTouches: () => [...allowed],
    restore() {
      for (const undo of restores.splice(0).reverse()) undo();
    },
  };
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** `{ [path]: sha256 }` of each of `paths`, null for one that doesn't exist. */
function digests(paths) {
  return Object.fromEntries(paths.map((p) => [p, fs.existsSync(p) ? sha256(p) : null]));
}

/**
 * A file's sha256, or `'locked'` for one another process holds locked
 * (Windows: the core's lifetime lock file reads EBUSY while it runs).
 */
function lockedOr(file) {
  try {
    return sha256(file);
  } catch (err) {
    if (process.platform === 'win32' && (err.code === 'EBUSY' || err.code === 'EPERM')) {
      return 'locked';
    }
    throw err;
  }
}

/**
 * Everything under `dir`, recursively, by its path relative to `dir`: a
 * directory's mtime, and a file's size, mtime and sha256 (`'locked'` for
 * one held locked on Windows, whose size and mtime still count).
 */
function snapshot(dir) {
  const out = {};
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      const rel = path.relative(dir, full);
      const stat = fs.lstatSync(full);
      if (entry.isDirectory()) {
        out[rel] = { dir: true, mtimeMs: stat.mtimeMs };
        walk(full);
      } else {
        out[rel] = {
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          sha256: entry.isFile() ? lockedOr(full) : null,
        };
      }
    }
  };
  walk(dir);
  return out;
}

/**
 * What process `pid` holds open (`/proc/<pid>/fd`): Linux only, else null.
 * The core makes itself non-dumpable, so its `fd` directory is root's: as
 * another user (CI's runner), it is read through `sudo -n`, and a host that
 * allows neither throws.
 */
function openFiles(pid) {
  if (process.platform !== 'linux') return null;
  const dir = `/proc/${pid}/fd`;
  let fds;
  try {
    fds = fs.readdirSync(dir);
  } catch (err) {
    if (err.code !== 'EACCES' && err.code !== 'EPERM') throw err;
    const listed = execFileSync(
      'sudo',
      ['-n', 'find', dir, '-mindepth', '1', '-maxdepth', '1', '-printf', '%l\\n'],
      {
        encoding: 'utf8',
      }
    );
    return listed.split('\n').filter(Boolean);
  }
  const out = [];
  for (const fd of fds) {
    try {
      out.push(fs.readlinkSync(path.join(dir, fd)));
    } catch {
      // Closed since the listing.
    }
  }
  return out;
}

const SAFE = '0xC1c1C1c1c1C1C1C1c1C1c1c1C1C1c1c1c1C1C1c1';
const SENDER = '0xd1D1d1D1D1d1d1d1D1D1d1D1d1d1D1D1D1D1d1d1';
const RUN = '00000000-0000-4000-8000-000000000001';
const INTENT = '00000000-0000-4000-8000-000000000002';
const HASH = `0x${'ab'.repeat(32)}`;

/**
 * One valid request per write method of each set-A store, as its store's
 * module would send it, for design 0013's `not_moved` sweep: every
 * `accounts.*` write, every `intents.*` write, every `payments.*` method
 * (the core opens no database that isn't named, for reads either), the
 * two `safe_pending.*` writes, and all four `secrets.*` RPC-key methods
 * (the core never opens `rpc-api-keys.json` before the name). Each goes as
 * `shell`, which reaches every one of them.
 */
const SET_A_WRITES = Object.freeze(
  [
    ['vault_meta', 'accounts.add_mnemonic', { name: 'Spare' }],
    [
      'vault_meta',
      'accounts.add_ledger',
      { address: '0xA1A1a1a1A1A1A1A1A1a1a1a1a1a1A1A1a1A1a1a1', path: "44'/60'/0'/0/0" },
    ],
    [
      'vault_meta',
      'accounts.add_remote',
      { address: '0xB1B1B1B1b1B1b1b1b1B1B1B1B1b1b1B1b1b1B1B1' },
    ],
    ['vault_meta', 'accounts.record_address_check', { type: 'ledger', index: 1, matched: true }],
    [
      'vault_meta',
      'accounts.add_safe',
      { address: SAFE, owners: [0], threshold: 1, salt_nonce: '0' },
    ],
    ['vault_meta', 'accounts.mark_safe_deployed', { index: 1, chain_id: 100 }],
    ['vault_meta', 'accounts.set_active', { index: 0 }],
    ['vault_meta', 'accounts.rename', { index: 0, name: 'Main' }],
    ['vault_meta', 'accounts.remove', { index: 1, swarm_references: [] }],
    [
      'intents',
      'intents.commit',
      {
        run: RUN,
        intent_id: INTENT,
        chain_id: 100,
        sender: SENDER,
        nonce: 0,
        hash: HASH,
        raw: '0x02',
        via: 'wallet',
      },
    ],
    ['intents', 'intents.handoff', { run: RUN, intent_id: INTENT, hash: HASH }],
    [
      'intents',
      'intents.outcome',
      { run: RUN, intent_id: INTENT, handoff_id: 'h1', outcome: 'accepted' },
    ],
    [
      'intents',
      'intents.settle',
      { run: RUN, intent_id: INTENT, label: 'confirmed', hash: HASH, block: 1 },
    ],
    ['intents', 'intents.void', { run: RUN, intent_id: INTENT, lock: true }],
    [
      'intents',
      'intents.retire',
      { run: RUN, intent_id: INTENT, block: 1, hashes: [HASH], lock: true },
    ],
    ['intents', 'intents.track', { run: RUN, intent_id: INTENT, bracket: null }],
    ['intents', 'intents.withdraw_origin', { intent_id: INTENT }],
    ['intents', 'intents.compact', {}],
    [
      'payments',
      'payments.append',
      { entry: { type: 'send', status: 'pending', chainId: 100, from: SENDER, txHash: HASH } },
    ],
    ['payments', 'payments.update', { id: 1, patch: { status: 'pending' } }],
    ['payments', 'payments.mark_confirmed', { id: 1, receipt: { blockNumber: 1 } }],
    ['payments', 'payments.mark_failed', { id: 1, info: { error: 'reverted' } }],
    ['payments', 'payments.mark_dropped', { id: 1 }],
    ['payments', 'payments.set_dropped_seen', { id: 1, seen_at: 1 }],
    ['payments', 'payments.pending', {}],
    ['payments', 'payments.get_recent', { filters: {} }],
    ['payments', 'payments.get_by_id', { id: 1 }],
    ['payments', 'payments.get_count', { filters: {} }],
    ['payments', 'payments.clear', {}],
    ['safe_pending', 'safe_pending.set', { index: 1, entry: { safeTxHash: HASH } }],
    ['safe_pending', 'safe_pending.clear', { index: 1 }],
    ['rpc_api_keys', 'secrets.set_rpc_api_key', { id: 'alchemy', api_key: 'k' }],
    ['rpc_api_keys', 'secrets.remove_rpc_api_key', { id: 'alchemy' }],
    ['rpc_api_keys', 'secrets.rpc_api_key_status', { id: 'alchemy' }],
    ['rpc_api_keys', 'secrets.rpc_api_keys', {}],
  ].map(([store, method, params]) => Object.freeze({ store, method, params }))
);

module.exports = {
  coredBinaries,
  startCore,
  watchWrites,
  watchFileTouches,
  digests,
  snapshot,
  openFiles,
  SET_A_WRITES,
};
