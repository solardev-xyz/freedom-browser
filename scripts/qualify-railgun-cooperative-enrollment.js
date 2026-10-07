/** Disposable cooperative enrollment across original main-process lifetimes.
 * No scan, signing, relay authority or live fence-file hashing. */
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const { createHash } = require('crypto');
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const modes = ['create', 'cold', 'legacy'];
const policy = '2'.repeat(64);
const { SOURCES } = require('./fixtures/railgun-kohaku-adapter-sources');

function verifyInputs(config) {
  assert.equal(config.approvedForNative, true);
  assert.equal(config.schema, 'railgun-cooperative-enrollment-native-v1');
  assert.equal(fs.realpathSync(config.sourceRoot), config.sourceRoot);
  assert.equal(path.resolve(__dirname, '..'), config.sourceRoot);
  assert.ok(path.isAbsolute(config.output));
  assert.equal(fs.realpathSync(path.dirname(config.output)), path.dirname(config.output));
  const observedLinks = {};
  for (const [name, digest] of Object.entries(config.sources)) {
    assert.ok(
      /^(src|scripts)\//.test(name) ||
        ['package.json', 'package-lock.json'].includes(name) ||
        SOURCES.includes(name)
    );
    assert.equal(path.posix.normalize(name), name);
    assert.ok(!name.split('/').includes('..'));
    const file = path.join(config.sourceRoot, name);
    const stat = fs.lstatSync(file);
    const target = fs.realpathSync(file);
    if (stat.isSymbolicLink()) {
      assert.ok(Object.hasOwn(config.sourceLinks, name));
      observedLinks[name] = fs.readlinkSync(file);
      assert.equal(observedLinks[name], config.sourceLinks[name]);
      assert.ok(target.startsWith(config.sourceRoot + path.sep));
      assert.ok(fs.statSync(file).isFile());
    } else {
      assert.ok(stat.isFile());
      assert.equal(target, file);
    }
    // Existing dependency-bin links are pinned by exact text AND target bytes.
    // Never recursively traverse a link or include a disposable profile here.
    assert.equal(sha(fs.readFileSync(file)), digest);
  }
  assert.deepEqual(observedLinks, config.sourceLinks);
  // New caller configs must pin the installed compatibility closure as well as
  // application sources; historical archived configs remain historical evidence.
  for (const needed of [
    ...SOURCES,
    'scripts/qualify-railgun-cooperative-enrollment.js',
    'src/main/wallet/railgun-account-enrollment.js',
    'src/main/wallet/railgun-account-fence.js',
    'src/main/wallet/railgun-identity.js',
  ])
    assert.ok(Object.hasOwn(config.sources, needed));
  const sqlitePrefix = path.join(config.sourceRoot, 'node_modules/better-sqlite3/');
  assert.equal(
    Object.keys(config.runtimeInputs).filter((p) => p.startsWith(sqlitePrefix)).length,
    17
  );
  for (const [file, pin] of Object.entries(config.runtimeInputs)) {
    assert.ok(file.startsWith(config.sourceRoot + path.sep));
    assert.ok(!file.startsWith(config.output + path.sep));
    // Electron's patched fs presents an ASAR as a virtual directory. Hash the
    // archive file itself through raw fs, never its virtual contents.
    const inputFs = file === config.archive ? require('original-fs') : fs;
    assert.equal(inputFs.realpathSync(file), file);
    assert.ok(inputFs.lstatSync(file).isFile());
    const bytes = inputFs.readFileSync(file);
    assert.deepEqual({ bytes: bytes.length, sha256: sha(bytes) }, pin);
  }
  assert.ok(Object.hasOwn(config.runtimeInputs, config.archive));
  assert.equal(fs.existsSync(config.archive + '.unpacked'), false);
  const sqlite = require('./qualify-railgun-account-fence');
  const runtimeFiles = Object.fromEntries(
    Object.entries(config.runtimeInputs).filter(([p]) => p !== config.archive)
  );
  sqlite.verifyInputs({
    sourceRoot: config.sourceRoot,
    sources: Object.fromEntries(sqlite.SOURCES.map((p) => [p, config.sources[p]])),
    electron: config.electron,
    sqliteRoot: path.join(config.sourceRoot, 'node_modules/better-sqlite3'),
    runtimeFiles,
  });
}

function installIdentityObserver(runtime, expectedGuards, violations) {
  const original = runtime.startRailgunProcess,
    rows = [],
    owned = [];
  const check = (callback) => {
    try {
      callback();
    } catch (error) {
      violations.push(error);
    }
  };
  const wrapped = function (...args) {
    const options = args[0],
      input = JSON.parse(options.input);
    assert.equal(options.filename, require.resolve('../src/main/wallet/railgun-identity-job'));
    assert.equal(input.purpose, ['spending-public', 'viewing-identity'][rows.length]);
    if (rows.length) assert.equal(rows.at(-1).closedObserved, true);
    assert.equal(options.binaryKey, true);
    const row = {
      purpose: input.purpose,
      messages: 0,
      keyRequests: 0,
      resultMessages: 0,
      closedObserved: false,
    };
    rows.push(row);
    const broker = options.broker,
      dispatch = broker.dispatch;
    const observedDispatch = function (...values) {
      check(() => {
        const message = JSON.parse(values[0]);
        assert.equal(message.id, ++row.messages);
        if (message.method === 'key') {
          assert.equal(message.id, 1);
          assert.equal(message.purpose, row.purpose);
          row.keyRequests++;
        } else {
          assert.equal(message.method, 'result');
          assert.equal(message.id, 2);
          row.resultMessages++;
          assert.deepEqual(message.guards, expectedGuards);
          row.guards = structuredClone(message.guards);
        }
      });
      return Reflect.apply(dispatch, this, values);
    };
    broker.dispatch = observedDispatch;
    owned.push({ broker, dispatch, observedDispatch });
    const task = Reflect.apply(original, this, args);
    Promise.prototype.then.call(
      task.closed,
      (closed) =>
        check(() => {
          assert.equal(closed.code, 'RAILGUN_PROCESS_CLOSED');
          assert.equal(closed.exitCode, 15);
          assert.equal(closed.escalated, false);
          assert.equal(closed.peerDisconnected, false);
          row.closed = structuredClone(closed);
          row.closedObserved = true;
        }),
      (error) => violations.push(error)
    );
    return task;
  };
  runtime.startRailgunProcess = wrapped;
  return {
    finish() {
      assert.deepEqual(violations, []);
      assert.equal(rows.length, 2);
      for (const row of rows) {
        assert.equal(row.closedObserved, true);
        assert.equal(row.messages, 2);
        assert.equal(row.keyRequests, 1);
        assert.equal(row.resultMessages, 1);
      }
      return structuredClone(rows);
    },
    restore() {
      assert.equal(runtime.startRailgunProcess, wrapped);
      runtime.startRailgunProcess = original;
      for (const item of owned) {
        assert.equal(item.broker.dispatch, item.observedDispatch);
        item.broker.dispatch = item.dispatch;
      }
    },
  };
}

async function scenario(mode, api, identity, expectedGeneration) {
  assert.ok(modes.includes(mode));
  const generic = api.openRailgunAccountEnrollment;
  const cooperative = api.openRailgunCooperativeAccountEnrollment;
  const fenced = api.assertRailgunFencedAccountEnrollment;
  let entry;
  try {
    entry = await (mode === 'create' ? cooperative : generic)({
      identity,
      create: mode !== 'cold',
    });
    if (mode === 'legacy') assert.throws(() => fenced(entry));
    else fenced(entry);
    const candidate =
      mode === 'cold' ? await entry.catalog.resume() : await entry.catalog.begin(policy);
    assert.match(candidate.id, /^[0-9a-f]{64}$/);
    assert.equal(candidate.policy, policy);
    if (mode === 'cold') assert.equal(candidate.id, expectedGeneration);
    const directory = entry.directory;
    if (mode === 'legacy') {
      assert.equal(fs.existsSync(path.join(directory, 'writer-fence.sqlite')), false);
    } else {
      const stat = fs.lstatSync(path.join(directory, 'writer-fence.sqlite'));
      assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1);
    }
    entry.close();
    assert.equal(entry.signal.aborted, true);
    assert.throws(() => fenced(entry));
    if (mode !== 'legacy') {
      for (const open of [generic, cooperative])
        await assert.rejects(open({ identity }), { code: 'RAILGUN_ACCOUNT_ENROLLMENT_REFUSED' });
    } else {
      entry = await generic({ identity });
      assert.equal((await entry.catalog.resume()).id, candidate.id);
      assert.throws(() => fenced(entry));
    }
    return {
      mode,
      generation: candidate.id,
      policy,
      genuineFencedEnrollment: mode !== 'legacy',
      bothSameProcessReopensRefused: mode !== 'legacy',
      genericColdReopen: mode === 'cold',
      legacySameProcessReopen: mode === 'legacy',
      closedEnrollmentProvenanceRefused: true,
      fenceBytesRead: false,
      scansPerformed: false,
      signingPerformed: false,
      relayAuthority: false,
      submissions: 0,
    };
  } finally {
    entry?.close();
  }
}

async function main() {
  const [configFile, configHash, mode, priorHash] = process.argv.slice(2);
  assert.ok(modes.includes(mode));
  const bytes = fs.readFileSync(configFile);
  assert.equal(sha(bytes), configHash);
  const config = JSON.parse(bytes);
  verifyInputs(config);
  const { app } = require('electron');
  assert.equal(process.type, 'browser');
  assert.deepEqual(
    {
      electron: process.versions.electron,
      modules: process.versions.modules,
      platform: process.platform,
      arch: process.arch,
    },
    config.expectedRuntime
  );
  const profileDirectory = path.join(
    config.output,
    mode === 'legacy' ? 'legacy-profile' : 'cooperative-profile'
  );
  let expectedGeneration;
  if (mode === 'cold') {
    const previous = fs.readFileSync(path.join(config.output, 'create', 'report.json'));
    assert.equal(sha(previous), priorHash);
    const prior = JSON.parse(previous);
    assert.equal(prior.mode, 'create');
    assert.equal(prior.bothSameProcessReopensRefused, true);
    expectedGeneration = prior.generation;
    assert.ok(fs.lstatSync(profileDirectory).isDirectory());
  } else assert.equal(fs.existsSync(profileDirectory), false);
  const reportDirectory = path.join(config.output, mode);
  assert.equal(fs.existsSync(reportDirectory), false);
  fs.mkdirSync(reportDirectory, { mode: 0o700 });
  const profile = require('../src/main/profile-resolver').initializeProfile(app, {
    env: { FREEDOM_TEST_USER_DATA: profileDirectory },
  });
  const { acquireProfileLock, releaseProfileLock } = require('../src/main/profile-lock');
  const lock = acquireProfileLock(profile, { onCompromised: () => app.exit(1) });
  app.dock?.hide();
  await app.whenReady();
  const vault = require('../src/main/identity/vault');
  assert.equal(!!require.cache[require.resolve('../src/main/wallet/railgun-identity')], false);
  const violations = [];
  const observer = installIdentityObserver(
    require('../src/main/wallet/railgun-process'),
    config.guards,
    violations
  );
  let identity;
  try {
    const vaultDirectory = path.join(profile.userDataDir, 'identity');
    const password = 'public-fixture-password-not-a-user-credential';
    if (mode !== 'cold')
      await vault.importVault(
        vaultDirectory,
        password,
        'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
      );
    await vault.unlockVault(vaultDirectory, password, 0);
    identity = await require('../src/main/wallet/railgun-identity').openRailgunIdentity({
      archive: config.archive,
    });
    const originalJobs = observer.finish();
    const result = await scenario(
      mode,
      require('../src/main/wallet/railgun-account-enrollment'),
      identity,
      expectedGeneration
    );
    assert.deepEqual(violations, []);
    verifyInputs(config);
    fs.writeFileSync(
      path.join(reportDirectory, 'report.json'),
      JSON.stringify(
        {
          schema: 'railgun-cooperative-enrollment-report-v1',
          ...result,
          publicVaultFixture: true,
          originalJobs,
          sourceSha256: config.sources,
        },
        null,
        2
      ) + '\n',
      { flag: 'wx', mode: 0o600 }
    );
  } finally {
    identity?.close();
    vault.lockVault();
    observer.restore();
    releaseProfileLock(lock);
  }
}
if (process.type === 'browser' || require.main === module)
  main().then(
    () => require('electron').app.exit(0),
    (error) => {
      console.error(error.stack);
      require('electron').app.exit(1);
    }
  );
module.exports = { scenario, installIdentityObserver, verifyInputs };
