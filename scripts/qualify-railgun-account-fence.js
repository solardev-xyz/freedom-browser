/** Explicitly approved disposable two-process probe, never a wallet launcher. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawn } = require('node:child_process');
const hash = (value) => createHash('sha256').update(value).digest('hex');
const SOURCES = [
  'src/main/wallet/railgun-account-fence.js',
  'src/main/wallet/railgun-account-fence.test.js',
  'scripts/fixtures/railgun-account-fence-process.js',
  'scripts/fixtures/railgun-account-fence-process.test.js',
  'scripts/qualify-railgun-account-fence.js',
  'scripts/qualify-railgun-account-fence.test.js',
];
const SQLITE_FILES = [
  'package.json',
  'lib/index.js',
  'lib/database.js',
  'lib/binding.js',
  'lib/util.js',
  'lib/sqlite-error.js',
  'lib/methods/aggregate.js',
  'lib/methods/backup.js',
  'lib/methods/explain.js',
  'lib/methods/function.js',
  'lib/methods/inspect.js',
  'lib/methods/pragma.js',
  'lib/methods/serialize.js',
  'lib/methods/table.js',
  'lib/methods/transaction.js',
  'lib/methods/wrappers.js',
  'prebuilds/darwin-arm64.node',
];
function regular(filename) {
  assert.ok(path.isAbsolute(filename) && path.normalize(filename) === filename);
  assert.equal(fs.realpathSync(filename), filename);
  const stat = fs.lstatSync(filename);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1);
  return fs.readFileSync(filename);
}
function readConfig(filename, digest) {
  assert.match(digest, /^[a-f0-9]{64}$/);
  const bytes = regular(filename);
  assert.ok(bytes.length < 65536);
  assert.equal(hash(bytes), digest);
  const config = JSON.parse(bytes);
  assert.deepEqual(
    Object.keys(config).sort(),
    [
      'approvedForNative',
      'electron',
      'expectedRuntime',
      'output',
      'runtimeFiles',
      'sourceRoot',
      'sources',
      'sqliteRoot',
      'version',
    ].sort()
  );
  assert.equal(config.version, 1);
  assert.equal(config.approvedForNative, true);
  assert.deepEqual(config.expectedRuntime, {
    platform: 'darwin',
    arch: 'arm64',
    electron: '44.5.1',
    modules: '149',
  });
  assert.equal(fs.realpathSync(config.sourceRoot), config.sourceRoot);
  assert.equal(fs.realpathSync(config.sqliteRoot), config.sqliteRoot);
  assert.ok(path.isAbsolute(config.output) && path.normalize(config.output) === config.output);
  assert.equal(fs.realpathSync(path.dirname(config.output)), path.dirname(config.output));
  for (const input of [
    filename,
    config.sourceRoot,
    config.sqliteRoot,
    ...Object.keys(config.runtimeFiles),
  ]) {
    assert.ok(input !== config.output && !input.startsWith(config.output + path.sep));
    assert.ok(config.output !== input && !config.output.startsWith(input + path.sep));
  }
  return config;
}
function verifyInputs(config) {
  assert.deepEqual(Object.keys(config.sources).sort(), [...SOURCES].sort());
  for (const name of SOURCES)
    assert.equal(hash(regular(path.join(config.sourceRoot, name))), config.sources[name]);
  const framework = path.resolve(
    config.electron,
    '../../Frameworks/Electron Framework.framework/Versions/A/Electron Framework'
  );
  const expected = [
    config.electron,
    framework,
    ...SQLITE_FILES.map((name) => path.join(config.sqliteRoot, name)),
  ];
  assert.deepEqual(Object.keys(config.runtimeFiles).sort(), expected.sort());
  for (const [filename, pin] of Object.entries(config.runtimeFiles)) {
    const bytes = regular(filename);
    assert.deepEqual({ bytes: bytes.length, sha256: hash(bytes) }, pin);
  }
  for (const name of [
    'lib/package.json',
    'lib/methods/package.json',
    'build/Debug/better_sqlite3.node',
    'build/Release/better_sqlite3.node',
  ])
    assert.equal(
      fs.existsSync(path.join(config.sqliteRoot, name)),
      false,
      'Unexpected SQLite resolution input'
    );
  const manifest = JSON.parse(regular(path.join(config.sqliteRoot, 'package.json')));
  assert.equal(manifest.name, 'better-sqlite3');
  assert.equal(manifest.version, '13.0.3');
  assert.equal(manifest.main, 'lib/index.js');
  assert.equal(manifest.exports['.'], './lib/index.js');
  assert.equal(
    require.resolve('better-sqlite3', { paths: [path.join(config.sourceRoot, 'src/main/wallet')] }),
    path.join(config.sqliteRoot, 'lib/index.js')
  );
  const methods = [...fs.readdirSync(path.join(config.sqliteRoot, 'lib/methods'))].sort();
  assert.deepEqual(
    methods,
    SQLITE_FILES.filter((name) => name.startsWith('lib/methods/'))
      .map((name) => path.basename(name))
      .sort()
  );
  for (const name of SQLITE_FILES.filter((name) => name.endsWith('.js'))) {
    const stem = path.join(config.sqliteRoot, name.slice(0, -3));
    assert.equal(fs.existsSync(stem), false, 'Unexpected extensionless SQLite shadow');
  }
}
function actor(role, config, filename, digest, records, spawnChild = spawn) {
  const env = { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, ELECTRON_RUN_AS_NODE: '1' };
  const child = spawnChild(
    config.electron,
    [
      path.join(config.sourceRoot, 'scripts/fixtures/railgun-account-fence-process.js'),
      filename,
      digest,
      role,
    ],
    { cwd: config.sourceRoot, env, stdio: ['pipe', 'pipe', 'pipe', 'pipe'] }
  );
  const record = {
    role,
    pid: child.pid || null,
    exitObserved: false,
    exitCode: null,
    signal: null,
    intentionalTermination: false,
    cleanupTerminate: false,
    cleanupKill: false,
  };
  records.push(record);
  const queue = [],
    transcript = [];
  let pending,
    buffer = '',
    stderr = '',
    failure,
    id = 0,
    closed = false;
  const drain = () => {
    if (pending && (queue.length || failure || closed)) {
      const target = pending;
      pending = undefined;
      clearTimeout(target.timer);
      if (failure) target.reject(failure);
      else if (queue.length) target.resolve(queue.shift());
      else target.reject(Error('Original child closed before expected event'));
    }
  };
  child.on('error', (error) => {
    failure = error;
    drain();
  });
  for (const stream of child.stdio)
    stream?.on('error', (error) => {
      failure = error;
      drain();
    });
  child.stdout.on('data', (bytes) => {
    try {
      buffer += bytes.toString('utf8');
      assert.ok(buffer.length < 65536);
      for (;;) {
        const end = buffer.indexOf('\n');
        if (end < 0) break;
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        assert.ok(line.length < 4096);
        const value = JSON.parse(line);
        assert.equal(value.role, role);
        assert.ok(transcript.length < 64);
        transcript.push(value);
        queue.push(value);
      }
    } catch (error) {
      failure = error;
    }
    drain();
  });
  child.stderr.on('data', (bytes) => {
    stderr += bytes.toString('utf8');
    if (stderr.length > 65536) {
      failure = Error('Child stderr bound');
      drain();
    }
  });
  const originalClose = new Promise((resolve) => {
    child.on('exit', (code, signal) => {
      Object.assign(record, { exitObserved: true, exitCode: code, signal });
    });
    child.on('close', () => {
      closed = true;
      drain();
      resolve();
    });
  });
  const deadline = (promise, ms) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('Original child close deadline')), ms);
      promise.then(
        (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        (e) => {
          clearTimeout(timer);
          reject(e);
        }
      );
    });
  return {
    role,
    record,
    transcript,
    send(action, name, extra = {}) {
      const value = { id: ++id, action, name, ...extra };
      child.stdin.write(JSON.stringify(value) + '\n');
      return id;
    },
    async next(expected) {
      assert.equal(pending, undefined);
      const value = await new Promise((resolve, reject) => {
        pending = {
          resolve,
          reject,
          timer: setTimeout(() => {
            pending = undefined;
            reject(Error('Child event deadline'));
          }, 10000),
        };
        drain();
      });
      for (const [key, wanted] of Object.entries(expected)) assert.deepEqual(value[key], wanted);
      return value;
    },
    gate() {
      child.stdio[3].write('G');
    },
    async terminateOriginal() {
      record.intentionalTermination = true;
      assert.equal(child.kill('SIGTERM'), true);
      await deadline(originalClose, 5000);
      assert.equal(record.signal, 'SIGTERM');
    },
    async finish() {
      const id = this.send('exit', 'commit');
      await this.next({ id, event: 'bye' });
      child.stdin.end();
      await deadline(originalClose, 5000);
      assert.equal(record.exitCode, 0);
      assert.equal(record.signal, null);
      assert.equal(queue.length, 0);
      assert.equal(buffer, '');
    },
    async cleanup() {
      if (!closed) {
        record.cleanupTerminate = true;
        child.kill('SIGTERM');
        try {
          await deadline(originalClose, 3000);
        } catch {
          record.cleanupKill = true;
          child.kill('SIGKILL');
          await deadline(originalClose, 3000);
        }
      }
      fs.writeFileSync(path.join(config.output, role + '-stderr.log'), stderr, { flag: 'wx' });
      fs.writeFileSync(
        path.join(config.output, role + '-events.json'),
        JSON.stringify(transcript, null, 2) + '\n',
        { flag: 'wx' }
      );
    },
  };
}
async function campaign(A, B) {
  await A.next({ id: 0, event: 'ready' });
  await B.next({ id: 0, event: 'ready' });
  const invoke = async (who, action, name, event, extra = {}) => {
    const id = who.send(action, name, extra);
    return who.next({ id, name, event });
  };
  const busy = async (name, state) => {
    const reply = await invoke(B, 'probe', name, 'busy');
    assert.deepEqual(reply.state, state);
  };
  const commit = A.send('acquire', 'commit', { create: true, commitPause: true });
  const committed = await A.next({ id: commit, name: 'commit', event: 'after-commit' });
  assert.equal(committed.journal, 'zero-length');
  await busy('commit', null);
  A.gate();
  await A.next({ id: commit, name: 'commit', event: 'acquired', state: null });
  const write = A.send('write', 'commit', { pause: true });
  await A.next({ id: write, name: 'commit', event: 'before-rename', before: null });
  await busy('commit', null);
  A.gate();
  const written = await A.next({ id: write, name: 'commit', event: 'written' });
  assert.equal(written.state.generation, 1);
  await invoke(A, 'close', 'commit', 'closed');
  const acquired = await invoke(B, 'acquire', 'commit', 'acquired');
  assert.deepEqual(acquired.state, written.state);
  const rotated = await invoke(B, 'write', 'commit', 'written');
  assert.equal(rotated.state.generation, 2);
  await invoke(B, 'close', 'commit', 'closed');
  await invoke(A, 'acquire', 'held', 'acquired', { create: true });
  const held = await invoke(A, 'hold', 'held', 'held');
  assert.equal(held.exactOriginalPromise, true);
  const revoked = await invoke(A, 'revoke-held', 'held', 'revoked-held');
  assert.equal(revoked.closed, false);
  await busy('held', null);
  await invoke(A, 'settle', 'held', 'closed');
  await invoke(B, 'acquire', 'held', 'acquired');
  await invoke(B, 'close', 'held', 'closed');
  await invoke(A, 'acquire', 'descriptor', 'acquired', { create: true });
  await invoke(A, 'descriptor-control', 'descriptor', 'descriptor-closed');
  const descriptorId = B.send('probe', 'descriptor');
  const descriptor = await B.next({ id: descriptorId, name: 'descriptor' });
  assert.equal(descriptor.event, 'acquired', 'Expected POSIX same-inode descriptor-close hazard');
  assert.equal(descriptor.state, null);
  await invoke(B, 'close', 'descriptor', 'closed');
  await invoke(A, 'close', 'descriptor', 'closed');
  await invoke(A, 'acquire', 'unknown', 'acquired', { create: true });
  const unknown = await invoke(A, 'unknown', 'unknown', 'unknown-retained');
  assert.equal(unknown.closed, false);
  await busy('unknown', null);
  await invoke(A, 'acquire', 'termination', 'acquired', { create: true });
  const initial = await invoke(A, 'write', 'termination', 'written');
  assert.equal(initial.state.generation, 1);
  const paused = A.send('write', 'termination', { pause: true });
  await A.next({ id: paused, name: 'termination', event: 'before-rename', before: initial.state });
  await busy('termination', initial.state);
  await A.terminateOriginal();
  const cold = await invoke(B, 'inspect-journal', 'termination', 'journal-inspected');
  assert.equal(cold.journal, 'zero-length');
  const afterKill = await invoke(B, 'acquire', 'termination', 'acquired');
  assert.deepEqual(afterKill.state, initial.state);
  const rewritten = await invoke(B, 'write', 'termination', 'written');
  assert.equal(rewritten.state.generation, 2);
  await invoke(B, 'close', 'termination', 'closed');
  await invoke(B, 'acquire', 'unknown', 'acquired');
  await invoke(B, 'close', 'unknown', 'closed');
  await B.finish();
  return {
    unsafeSameProcessDescriptorClose: {
      contenderAcquired: descriptor.event === 'acquired',
      diagnosticOnly: true,
      retentionDoesNotEstablishPortableSafety: true,
    },
    journalAfterCommit: committed.journal,
    journalBeforeColdReacquisition: cold.journal,
    retainedAcrossOriginalCommit: true,
    contentionBeforeRename: true,
    cleanReleaseAndPublicStateRotation: true,
    closeWaitedForOriginalCallback: true,
    unknownRetainedUntilOriginalTermination: true,
    intentionalTerminationBeforeRename: true,
    oldPublicStateSurvivedTermination: true,
    reacquiredAfterObservedOriginalExit: true,
    publicStates: {
      first: written.state,
      rotated: rotated.state,
      beforeTermination: initial.state,
      afterTermination: rewritten.state,
    },
  };
}
async function main() {
  const [filename, digest] = process.argv.slice(2),
    config = readConfig(filename, digest);
  verifyInputs(config);
  assert.equal(fs.existsSync(config.output), false);
  fs.mkdirSync(config.output, { mode: 0o700 });
  for (const name of ['commit', 'held', 'descriptor', 'unknown', 'termination'])
    fs.mkdirSync(path.join(config.output, name), { mode: 0o700 });
  const records = [],
    children = [];
  let result, error;
  try {
    children.push(actor('A', config, filename, digest, records));
    children.push(actor('B', config, filename, digest, records));
    result = await campaign(...children);
  } catch (caught) {
    error = caught;
  } finally {
    for (const child of children) {
      try {
        await child.cleanup();
      } catch (caught) {
        error ||= caught;
      }
    }
    fs.writeFileSync(
      path.join(config.output, 'processes.json'),
      JSON.stringify(records, null, 2) + '\n',
      { flag: 'wx' }
    );
    try {
      verifyInputs(config);
    } catch (caught) {
      error ||= caught;
    }
  }
  if (error) {
    fs.writeFileSync(path.join(config.output, 'failure.txt'), String(error.stack || error), {
      flag: 'wx',
    });
    throw error;
  }
  assert.equal(records.length, 2);
  assert.ok(records.every((r) => r.exitObserved && !r.cleanupKill && !r.cleanupTerminate));
  const report = {
    schema: 'railgun-account-fence-native-v1',
    cases: result,
    processes: records,
    sourceSha256: config.sources,
    manifestSha256: digest,
    scope: {
      platform: config.expectedRuntime,
      actualEnrollmentIntegrated: false,
      privateDataUsed: false,
      networkUsed: false,
      engineUsed: false,
      rollbackProtection: false,
      physicalUtilityDrainProved: false,
      crossPlatformQualified: false,
      nativeRunUsesCommitBoundaryInstrumentation: true,
    },
  };
  fs.writeFileSync(
    path.join(config.output, 'report.json'),
    JSON.stringify(report, null, 2) + '\n',
    { flag: 'wx' }
  );
}
if (require.main === module)
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
module.exports = { SOURCES, SQLITE_FILES, readConfig, verifyInputs, actor, campaign };
