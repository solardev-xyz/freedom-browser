const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  actor,
  campaign,
  readConfig,
  verifyInputs,
  SOURCES,
  SQLITE_FILES,
} = require('./qualify-railgun-account-fence');
function modeledActors(fault) {
  const locks = new Map(),
    states = new Map();
  const make = (role) => {
    let id = 0,
      gate,
      exiting = false;
    const owned = new Set(),
      queue = [{ role, id: 0, event: 'ready' }];
    const emit = (id, name, event, extra = {}) => queue.push({ role, id, name, event, ...extra });
    const state = (name) => states.get(name) || null;
    const instance = {
      send(action, name, extra = {}) {
        const seq = ++id;
        const acquired = () => {
          locks.set(name, role);
          owned.add(name);
          emit(seq, name, 'acquired', { state: state(name) });
        };
        if (['acquire', 'probe'].includes(action)) {
          if (locks.has(name)) emit(seq, name, 'busy', { state: state(name) });
          else if (extra.commitPause) {
            if (fault !== 'commit') locks.set(name, role);
            gate = acquired;
            emit(seq, name, 'after-commit', {
              journal:
                fault === 'hot-commit'
                  ? 'nonempty'
                  : fault === 'absent-commit'
                    ? 'absent'
                    : 'zero-length',
            });
          } else acquired();
        } else if (action === 'inspect-journal')
          emit(seq, name, 'journal-inspected', {
            journal:
              fault === 'hot-cold'
                ? 'nonempty'
                : fault === 'absent-cold'
                  ? 'absent'
                  : 'zero-length',
          });
        else if (action === 'write') {
          const before = state(name);
          const finish = () => {
            const next = {
              generation: (before?.generation || 0) + 1,
              sha256: role + name + ((before?.generation || 0) + 1),
            };
            states.set(name, next);
            emit(seq, name, 'written', { state: next });
          };
          if (extra.pause) {
            if (fault === 'rename') locks.delete(name);
            gate = finish;
            emit(seq, name, 'before-rename', { before });
          } else finish();
        } else if (action === 'hold') emit(seq, name, 'held', { exactOriginalPromise: true });
        else if (action === 'revoke-held') {
          if (fault === 'close') locks.delete(name);
          emit(seq, name, 'revoked-held', { closed: false });
        } else if (action === 'unknown') {
          if (fault === 'unknown') locks.delete(name);
          emit(seq, name, 'unknown-retained', { closed: false });
        } else if (action === 'descriptor-control') {
          if (fault !== 'descriptor') locks.delete(name);
          emit(seq, name, 'descriptor-closed');
        } else if (['settle', 'close'].includes(action)) {
          locks.delete(name);
          owned.delete(name);
          emit(seq, name, 'closed');
        } else throw Error('Unknown modeled action');
        return seq;
      },
      async next(expected) {
        const actual = queue.shift();
        if (!actual) throw Error('Missing modeled event');
        for (const [key, value] of Object.entries(expected)) expect(actual[key]).toEqual(value);
        return actual;
      },
      gate() {
        const original = gate;
        gate = null;
        original();
      },
      async terminateOriginal() {
        expect(role).toBe('A');
        expect(locks.get('termination')).toBe('A');
        exiting = true;
        for (const name of owned) locks.delete(name);
      },
      async finish() {
        expect(role).toBe('B');
        expect(owned.size).toBe(0);
      },
      isTerminated: () => exiting,
    };
    return instance;
  };
  return [make('A'), make('B')];
}
test('whole source-only campaign uses deterministic gates and separates deliberate unsafe diagnostic', async () => {
  const actors = modeledActors();
  const result = await campaign(...actors);
  expect(result).toMatchObject({
    retainedAcrossOriginalCommit: true,
    closeWaitedForOriginalCallback: true,
    unknownRetainedUntilOriginalTermination: true,
    unsafeSameProcessDescriptorClose: { contenderAcquired: true },
  });
  expect(actors[0].isTerminated()).toBe(true);
});
test.each([
  'commit',
  'rename',
  'close',
  'unknown',
  'descriptor',
  'hot-commit',
  'hot-cold',
  'absent-commit',
  'absent-cold',
])('campaign distinguishes premature release or missing hazard control: %s', async (fault) => {
  await expect(campaign(...modeledActors(fault))).rejects.toThrow();
});
function fakeChild() {
  const child = new EventEmitter();
  child.pid = 123;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdio = [child.stdin, child.stdout, child.stderr, new PassThrough()];
  child.kill = jest.fn((signal) => {
    queueMicrotask(() => {
      child.emit('exit', null, signal);
      child.emit('close');
    });
    return true;
  });
  return child;
}
test('original child handle termination is explicitly attributed and observed before return', async () => {
  const child = fakeChild(),
    rows = [],
    output = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fence-driver-unit-')));
  const original = actor(
    'A',
    { electron: '/fixture/electron', sourceRoot: '/fixture', output },
    '/fixture/config',
    'a'.repeat(64),
    rows,
    () => child
  );
  child.stdout.write(JSON.stringify({ role: 'A', id: 0, event: 'ready' }) + '\n');
  await original.next({ id: 0, event: 'ready' });
  await original.terminateOriginal();
  await original.cleanup();
  expect(child.kill).toHaveBeenCalledTimes(1);
  expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  expect(rows).toEqual([
    {
      role: 'A',
      pid: 123,
      exitObserved: true,
      exitCode: null,
      signal: 'SIGTERM',
      intentionalTermination: true,
      cleanupTerminate: false,
      cleanupKill: false,
    },
  ]);
});
test('stdio failures are observed and cleanup retains the original child handle', async () => {
  const child = fakeChild(),
    rows = [],
    output = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fence-driver-unit-')));
  const original = actor(
    'B',
    { electron: '/fixture/electron', sourceRoot: '/fixture', output },
    '/fixture/config',
    'a'.repeat(64),
    rows,
    () => child
  );
  child.stdin.emit('error', Error('write failure'));
  await expect(original.next({ id: 0, event: 'ready' })).rejects.toThrow('write failure');
  await original.cleanup();
  expect(rows[0].cleanupTerminate).toBe(true);
  expect(rows[0].exitObserved).toBe(true);
});
test('unapproved and unbound manifests refuse before launching anything', () => {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fence-manifest-unit-'))),
    filename = path.join(directory, 'config.json');
  fs.writeFileSync(filename, JSON.stringify({ approvedForNative: false }));
  const digest = require('node:crypto')
    .createHash('sha256')
    .update(fs.readFileSync(filename))
    .digest('hex');
  expect(() => readConfig(filename, '0'.repeat(64))).toThrow();
  expect(() => readConfig(filename, digest)).toThrow();
});

function syntheticInputs() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fence-inputs-unit-')));
  const sourceRoot = path.join(root, 'source'),
    sqliteRoot = path.join(sourceRoot, 'node_modules/better-sqlite3');
  const electron = path.join(root, 'Electron.app/Contents/MacOS/Electron');
  const framework = path.resolve(
    electron,
    '../../Frameworks/Electron Framework.framework/Versions/A/Electron Framework'
  );
  const sources = {},
    runtimeFiles = {};
  const hash = (bytes) => require('node:crypto').createHash('sha256').update(bytes).digest('hex');
  const write = (filename, value) => {
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, value);
    return Buffer.from(value);
  };
  for (const name of SOURCES)
    sources[name] = hash(write(path.join(sourceRoot, name), '// synthetic source'));
  for (const name of SQLITE_FILES) {
    const filename = path.join(sqliteRoot, name);
    const text =
      name === 'package.json'
        ? JSON.stringify({
            name: 'better-sqlite3',
            version: '13.0.3',
            main: 'lib/index.js',
            exports: { '.': './lib/index.js' },
          })
        : '// synthetic input, never imported';
    const bytes = write(filename, text);
    runtimeFiles[filename] = { bytes: bytes.length, sha256: hash(bytes) };
  }
  for (const filename of [electron, framework]) {
    const bytes = write(filename, 'synthetic binary, never executed');
    runtimeFiles[filename] = { bytes: bytes.length, sha256: hash(bytes) };
  }
  return { sourceRoot, sqliteRoot, electron, sources, runtimeFiles };
}
test('full input verifier accepts only the exact synthetic graph without loading its modules', () => {
  expect(() => verifyInputs(syntheticInputs())).not.toThrow();
});
test.each([
  'lib/database',
  'lib/package.json',
  'lib/methods/package.json',
  'build/Debug/better_sqlite3.node',
  'build/Release/better_sqlite3.node',
])('input verifier refuses additional resolution input %s', (name) => {
  const config = syntheticInputs();
  const filename = path.join(config.sqliteRoot, name);
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, 'throw Error("must never execute")');
  expect(() => verifyInputs(config)).toThrow();
});
