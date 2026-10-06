/** Disposable public-state fence probe. No wallet/engine/profile imports. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createInterface } = require('node:readline');
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

function atOriginalCommit(Database, pause, use) {
  const descriptor = Object.getOwnPropertyDescriptor(Database.prototype, 'exec');
  assert.equal(typeof descriptor.value, 'function');
  let commits = 0;
  Object.defineProperty(Database.prototype, 'exec', {
    ...descriptor,
    value: function (...args) {
      const result = Reflect.apply(descriptor.value, this, args);
      if (args.length === 1 && args[0] === 'COMMIT') {
        assert.equal(++commits, 1);
        pause();
      }
      return result;
    },
  });
  try {
    const result = use();
    assert.equal(commits, 1, 'Expected the exact original initialization COMMIT');
    return result;
  } finally {
    Object.defineProperty(Database.prototype, 'exec', descriptor);
  }
}
function waitGate(fd, now = () => performance.now()) {
  const deadline = now() + 20000;
  const byte = Buffer.alloc(1);
  for (;;) {
    assert.ok(now() < deadline, 'Control gate deadline');
    try {
      assert.equal(fs.readSync(fd, byte, 0, 1, null), 1, 'Control pipe ended');
      assert.equal(byte[0], 71, 'Unexpected control byte');
      return;
    } catch (error) {
      if (!['EAGAIN', 'EWOULDBLOCK'].includes(error.code)) throw error;
      // Some hosts expose child pipes as nonblocking sockets. The actual byte,
      // not this bounded wait, is the identity-preserving release condition.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
  }
}
function journalState(directory) {
  const database = fs.lstatSync(path.join(directory, 'writer-fence.sqlite'));
  for (const suffix of ['-wal', '-shm']) {
    let sidecar;
    try {
      sidecar = fs.lstatSync(path.join(directory, 'writer-fence.sqlite' + suffix));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    assert.equal(sidecar, undefined);
  }
  let journal;
  try {
    journal = fs.lstatSync(path.join(directory, 'writer-fence.sqlite-journal'));
  } catch (error) {
    if (error.code === 'ENOENT') return 'absent';
    throw error;
  }
  assert.ok(
    journal.isFile() && !journal.isSymbolicLink() && journal.nlink === 1 && journal.size === 0
  );
  assert.ok(journal.dev !== database.dev || journal.ino !== database.ino);
  return 'zero-length';
}
function createProbe({ role, directories, openFence, Database, emit, gate }) {
  const owned = new Map();
  const statePath = (name) => path.join(directories[name], 'synthetic-state.json');
  const view = (name) => {
    const file = statePath(name);
    if (!fs.existsSync(file)) return null;
    const stat = fs.lstatSync(file);
    assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size < 1024);
    const bytes = fs.readFileSync(file),
      value = JSON.parse(bytes);
    assert.deepEqual(Object.keys(value), ['schema', 'generation', 'writer']);
    assert.equal(value.schema, 'public-fence-fixture-v1');
    assert.ok(Number.isSafeInteger(value.generation) && value.generation >= 1);
    assert.ok(['A', 'B'].includes(value.writer));
    return { sha256: hash(bytes), generation: value.generation };
  };
  function write(name, pause, id) {
    const item = owned.get(name);
    item.fence.assertCurrent();
    const before = view(name);
    const bytes = Buffer.from(
      JSON.stringify({
        schema: 'public-fence-fixture-v1',
        generation: (before?.generation || 0) + 1,
        writer: role,
      }) + '\n'
    );
    const temporary = path.join(directories[name], role + '-synthetic.next');
    const fd = fs.openSync(temporary, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, bytes);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    if (pause) {
      emit({ id, event: 'before-rename', name, before });
      gate();
    }
    item.fence.assertCurrent();
    fs.renameSync(temporary, statePath(name));
    const parent = fs.openSync(directories[name], 'r');
    try {
      fs.fsyncSync(parent);
    } finally {
      fs.closeSync(parent);
    }
    return view(name);
  }
  const command = async function (message) {
    const { id, action, name } = message;
    assert.ok(Number.isSafeInteger(id) && id > 0);
    assert.ok(Object.hasOwn(directories, name));
    const reply = (event, extra = {}) => emit({ id, event, name, ...extra });
    if (action === 'inspect-journal') {
      assert.ok(!owned.has(name));
      reply('journal-inspected', { journal: journalState(directories[name]) });
      return;
    }
    if (action === 'acquire' || action === 'probe') {
      assert.ok(!owned.has(name));
      const acquire = () =>
        openFence({ directory: directories[name], create: message.create === true });
      let fence;
      try {
        fence = message.commitPause
          ? atOriginalCommit(
              Database,
              () => {
                reply('after-commit', { journal: journalState(directories[name]) });
                gate();
              },
              acquire
            )
          : acquire();
      } catch (error) {
        if (action !== 'probe' || error.code !== 'RAILGUN_ACCOUNT_FENCE_BUSY') throw error;
        reply('busy', { state: view(name) });
        return;
      }
      const item = { fence, closed: false, settle: null };
      owned.set(name, item);
      Promise.prototype.then.call(fence.closed, () => {
        item.closed = true;
      });
      reply('acquired', { state: view(name) });
      return;
    }
    const item = owned.get(name);
    assert.ok(item);
    if (action === 'write') {
      let result;
      assert.equal(
        item.fence.run(() => {
          result = write(name, message.pause === true, id);
        }),
        undefined
      );
      reply('written', { state: result });
    } else if (action === 'hold') {
      const original = new Promise((resolve) => {
        item.settle = resolve;
      });
      assert.equal(
        item.fence.run(() => original),
        original
      );
      reply('held', { exactOriginalPromise: true });
    } else if (action === 'revoke-held') {
      assert.equal(typeof item.settle, 'function');
      item.fence.close();
      await Promise.resolve();
      assert.equal(item.closed, false);
      assert.equal(item.fence.signal.aborted, true);
      reply('revoked-held', { closed: false });
    } else if (action === 'settle') {
      item.settle();
      await item.fence.closed;
      assert.equal(item.closed, true);
      reply('closed');
      owned.delete(name);
    } else if (action === 'unknown') {
      const original = Promise.resolve();
      Object.defineProperty(original, 'constructor', {
        get() {
          throw Error('public observation fault');
        },
      });
      assert.throws(() => item.fence.run(() => original), {
        code: 'RAILGUN_ACCOUNT_FENCE_DRAIN_UNOBSERVED',
      });
      item.fence.close();
      await Promise.resolve();
      assert.equal(item.closed, false);
      assert.equal(item.fence.signal.aborted, true);
      reply('unknown-retained', { closed: false });
    } else if (action === 'descriptor-control') {
      // Deliberately violate the integration restriction on a separate public
      // fixture only. This close may release this process's POSIX inode locks.
      item.fence.assertCurrent();
      const bytes = fs.readFileSync(path.join(directories[name], 'writer-fence.sqlite'));
      assert.ok(bytes.length > 0);
      reply('descriptor-closed');
    } else if (action === 'close') {
      item.fence.close();
      await item.fence.closed;
      assert.equal(item.closed, true);
      reply('closed');
      owned.delete(name);
    } else {
      throw Error('Unknown fixture command');
    }
  };
  return { command, assertReleased: () => assert.equal(owned.size, 0) };
}
async function main() {
  const { verifyInputs, readConfig } = require('../qualify-railgun-account-fence.js');
  const [filename, digest, role] = process.argv.slice(2);
  assert.ok(['A', 'B'].includes(role));
  const config = readConfig(filename, digest);
  verifyInputs(config);
  assert.equal(fs.realpathSync(process.execPath), config.electron);
  for (const [key, value] of Object.entries(config.expectedRuntime))
    assert.equal(
      key === 'platform' ? process.platform : key === 'arch' ? process.arch : process.versions[key],
      value
    );
  const Database = require(config.sqliteRoot);
  assert.equal(
    require(config.sqliteRoot + '/lib/binding').getPrebuildPath(),
    config.sqliteRoot + '/prebuilds/darwin-arm64.node'
  );
  const { openRailgunAccountFence } = require(
    path.join(config.sourceRoot, 'src/main/wallet/railgun-account-fence.js')
  );
  const emit = (value) => fs.writeSync(1, JSON.stringify({ role, ...value }) + '\n');
  const directories = Object.fromEntries(
    ['commit', 'held', 'descriptor', 'unknown', 'termination'].map((name) => [
      name,
      path.join(config.output, name),
    ])
  );
  const probe = createProbe({
    role,
    directories,
    Database,
    openFence: openRailgunAccountFence,
    emit,
    gate: () => waitGate(3),
  });
  emit({ event: 'ready', id: 0 });
  let previous = 0;
  for await (const line of createInterface({ input: process.stdin })) {
    assert.ok(Buffer.byteLength(line) < 4096);
    const message = JSON.parse(line);
    assert.equal(message.id, ++previous);
    if (message.action === 'exit') {
      probe.assertReleased();
      verifyInputs(config);
      emit({ id: message.id, event: 'bye' });
      return;
    }
    await probe.command(message);
  }
  throw Error('Parent control stream ended before exit');
}
if (require.main === module)
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
module.exports = { atOriginalCommit, createProbe, waitGate, journalState };
