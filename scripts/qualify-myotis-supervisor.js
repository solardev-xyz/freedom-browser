// Finite disposable-host integration harness. Do not execute on the primary Mac.
// Loading this module for its pure unit tests launches nothing.
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const crypto = require('crypto');
const { fork } = require('child_process');
const { MyotisProcess, childEnvironment, supervisorPath } = require('../src/main/myotis/myotis-process');

const IDENTITY = 'freedom-myotis-benign-v1';
const FIXTURE = path.join(__dirname, 'fixtures/myotis-benign-addon.js');
const ROOT_MARKER = 'qualification-owner.json';
const CASE_MS = 25000;
const OVERALL_MS = 180000;

function hash(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
function writeJson(file, value) { fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); }
function deadline(promise, milliseconds, label) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} deadline exceeded`)), milliseconds);
  })]).finally(() => clearTimeout(timer));
}
function requireRuntime(runtime = process) {
  assert.equal(runtime.env.ELECTRON_RUN_AS_NODE, '1', 'Set ELECTRON_RUN_AS_NODE=1');
  assert.equal(runtime.versions.electron?.split('.')[0], '43', 'Use installed Electron 43');
  assert(['darwin', 'linux'].includes(runtime.platform), 'This harness currently qualifies POSIX only');
  assert.equal(runtime.env.FREEDOM_MYOTIS_DISPOSABLE, '1', 'Explicit disposable-host opt-in required');
}
function parseArguments(args) {
  assert.equal(args[0], '--disposable', 'Pass --disposable on a disposable host only');
  assert.equal(args[1], '--evidence-dir', 'Provide a fresh --evidence-dir');
  assert.equal(args.length, 3, 'Unexpected arguments');
  assert(path.isAbsolute(args[2]), 'Evidence directory must be absolute');
  return path.resolve(args[2]);
}
function readRecord(dataDir) {
  const value = fs.readFileSync(path.join(dataDir, '.freedom-myotis-owner'), 'utf8');
  assert(value.length <= 96, 'Oversized native record');
  return value;
}
function validateTerminal(client, forced) {
  assert.equal(client.exited, true, 'No native receipt + OS exit proof');
  assert.equal(client.supervisorExit?.code, 0);
  assert.equal(client.supervisorExit?.signal, null);
  assert.equal(client.terminalReceipt?.generation, client.generation);
  assert.equal(client.terminalReceipt?.forced, forced);
  if (forced) assert.equal(client.terminalReceipt.signal, 9);
  else assert.equal(client.terminalReceipt.exitCode, 0);
  assert.notEqual(client.terminalReceipt.exitCode, 78, 'Fixture expiry is not product cleanup');
}
function caseDirectory(root, name, mode) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { mode: 0o700 });
  fs.mkdirSync(path.join(dir, 'data'), { mode: 0o700 });
  fs.copyFileSync(FIXTURE, path.join(dir, 'addon.js'), fs.constants.COPYFILE_EXCL);
  writeJson(path.join(dir, 'fixture.json'), { identity: IDENTITY, mode });
  return dir;
}
function attachClient(dir, label = 'first') {
  const events = [];
  const record = (event) => {
    assert(events.length < 100, 'Unexpected event flood');
    events.push({ time: Date.now(), ...event });
    fs.appendFileSync(path.join(dir, `${label}-events.jsonl`), JSON.stringify(events.at(-1)) + '\n', { mode: 0o600 });
  };
  const client = new MyotisProcess({
    addonPath: path.join(dir, 'addon.js'), network: 'mainnet', dataDir: path.join(dir, 'data'),
    onStatus: (status) => record({ type: 'status', status }),
    onUnavailable: (message) => record({ type: 'unavailable', message }),
    onExit: () => record({ type: 'verified-exit' }),
  });
  record({ type: 'created', generation: client.generation });
  client.child.on('spawn', () => record({ type: 'supervisor-spawn', pid: client.child.pid }));
  client.child.on('exit', (code, signal) => record({ type: 'supervisor-os-exit', code, signal }));
  client.child.stdout.on('data', (data) => {
    assert(data.length <= 1024, 'Oversized native receipt');
    record({ type: 'native-receipt-bytes', text: data.toString('utf8') });
  });
  client.child.on('disconnect', () => record({ type: 'ipc-disconnect' }));
  return { client, events };
}
async function ready(client) { assert.equal(await deadline(client.startPromise, 18000, 'start'), true); }
async function finish(client, forced) {
  await deadline(client.exitPromise, 8000, 'verified child exit');
  validateTerminal(client, forced);
}
async function waitForRecord(dataDir, expected) {
  const until = Date.now() + 8000;
  while (Date.now() < until) {
    if (readRecord(dataDir) === expected) return expected;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Native durable retirement not observed');
}
function controllerOptions(groupSignal) {
  return {
    execPath: process.execPath, execArgv: [],
    env: { ...childEnvironment(), FREEDOM_MYOTIS_DISPOSABLE: '1' },
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    detached: groupSignal, // libuv must create a new POSIX session or fail spawn.
  };
}
async function runParentController(dir, groupSignal = false) {
  requireRuntime();
  const root = path.dirname(dir);
  const marker = JSON.parse(fs.readFileSync(path.join(root, ROOT_MARKER), 'utf8'));
  assert.equal(marker.identity, IDENTITY);
  assert.equal(hash(path.join(dir, 'addon.js')), hash(FIXTURE));
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'fixture.json'))).mode, 'blocked-stop');
  assert(process.connected && process.send, 'Task-owned controller IPC required');
  // No blocking work here. The group case waits for the outer launcher to
  // confirm its successful detached spawn, bound to this generation. Direct
  // invocation or missing confirmation expires without sending any signal.
  const emergency = setTimeout(() => process.exit(79), 18000);
  const { client } = attachClient(dir, 'lost-controller');
  await ready(client);
  writeJson(path.join(dir, 'controller-ready.json'), { identity: IDENTITY, generation: client.generation, pid: process.pid });
  if (groupSignal) {
    process.once('message', (message) => {
      assert.equal(message.type, 'isolated-group-confirmed');
      assert.equal(message.generation, client.generation);
      // The freshly detached controller targets only its own current group.
      // No stored PID/PGID, host-session fallback, or external signal authority.
      process.kill(0, 'SIGTERM');
      // Keep the 18s self-expiry armed if the expected signal exit fails.
    });
  }
  process.send({ type: 'ready', generation: client.generation }, () => {
    if (!groupSignal) {
      clearTimeout(emergency);
      process.exit(0); // Parent loss deliberately bypasses MyotisProcess.stop.
    }
  });
}
async function parentLoss(dir, groupSignal = false) {
  const controller = fork(__filename, [groupSignal ? '--group-controller' : '--parent-controller', dir],
    controllerOptions(groupSignal));
  let generation;
  controller.once('message', (message) => {
    assert.equal(message.type, 'ready');
    generation = message.generation;
    if (groupSignal) controller.send({ type: 'isolated-group-confirmed', generation });
  });
  const exit = await deadline(new Promise((resolve, reject) => {
    controller.once('exit', (code, signal) => resolve({ code, signal }));
    controller.once('error', reject);
  }), 20000, 'parent controller exit');
  assert.equal(exit.code, groupSignal ? null : 0);
  assert.equal(exit.signal, groupSignal ? 'SIGTERM' : null);
  assert(generation);
  const retiredRecord = await waitForRecord(path.join(dir, 'data'), `v1 retired ${generation}\n`);
  // Persist before a successor can overwrite the stable native owner record.
  writeJson(path.join(dir, 'old-retired-record.json'), { generation, record: retiredRecord });
  return {
    controllerExit: exit, generation, nativeDurableRetirement: true,
    oldSupervisorOsExitDirectlyObserved: false,
    scope: `${groupSignal ? 'Controller group SIGTERM' : 'Parent controller loss'}; native record only for old child. Not supervisor-loss qualification.`,
  };
}
async function runHarness(root) {
  requireRuntime();
  // No recursive mkdir or reuse: never overwrite an existing evidence root.
  fs.mkdirSync(root, { mode: 0o700 });
  root = fs.realpathSync(root);
  const sources = [__filename, FIXTURE, require.resolve('../src/main/myotis/myotis-process'),
    require.resolve('../src/main/myotis/myotis-child'), supervisorPath()];
  const manifest = {
    identity: IDENTITY, runId: crypto.randomUUID(), startedAt: new Date().toISOString(),
    execPath: process.execPath, versions: process.versions, platform: process.platform, arch: process.arch,
    inputs: sources.map((file) => ({ file, sha256: hash(file) })),
    noNetworkOrRealAddon: true, limits: { caseMs: CASE_MS, overallMs: OVERALL_MS, blockingFixtureMs: 15000 },
  };
  writeJson(path.join(root, ROOT_MARKER), manifest);
  const results = [];
  const owned = new Set();
  let accepting = true;
  const acquire = (dir, label) => {
    assert(accepting, 'Harness no longer accepts new clients');
    const { client } = attachClient(dir, label); owned.add(client); return client;
  };
  const runCase = async (name, mode, action) => {
    const dir = caseDirectory(root, name, mode);
    let result;
    try {
      const details = await deadline(action(dir), CASE_MS, name);
      result = { name, passed: true, details: details || null };
    } catch (error) {
      accepting = false;
      result = { name, passed: false, error: error.message };
    }
    // Bounded owned-control cleanup only. Unknown exit is retained as failure.
    for (const client of owned) {
      if (!client.exited) await deadline(client.stop(), 6000, 'cleanup').catch(() => false);
    }
    result.unconfirmedGenerations = [...owned].filter((client) => !client.exited && !client.supervisorExit)
      .map((client) => client.generation);
    if (result.unconfirmedGenerations.length) result.passed = false;
    writeJson(path.join(dir, 'result.json'), result);
    results.push(result);
    assert(result.passed, `${name} failed; stop at first failed case, evidence retained`);
  };
  let emergency;
  try {
    emergency = setTimeout(() => {
      accepting = false;
      for (const client of owned) client.child.stdin.end();
      writeJson(path.join(root, 'overall-timeout.json'), { passed: false, results });
      process.exit(1); // Failure self-disposal closes control; never signal another process.
    }, OVERALL_MS);
    await runCase('ipc-and-retired-reuse', 'healthy', async (dir) => {
      const first = acquire(dir); await ready(first);
      assert.deepEqual(await first.request('call'), { resultHex: '0x1234' });
      assert.equal((await first.request('status')).snapPeers, 1);
      assert.equal(await first.stop(), true); validateTerminal(first, false);
      assert.equal(readRecord(path.join(dir, 'data')), `v1 retired ${first.generation}\n`);
      const next = acquire(dir, 'second'); await ready(next);
      assert.notEqual(next.generation, first.generation);
      assert.equal(await next.stop(), true); validateTerminal(next, false);
    });
    await runCase('natural-exit', 'natural-exit', async (dir) => {
      const client = acquire(dir); await ready(client); await finish(client, false);
    });
    for (const [name, op] of [['blocked-read', 'call'], ['blocked-status', 'status']]) {
      await runCase(name, name, async (dir) => {
        const client = acquire(dir); await ready(client);
        await assert.rejects(client.request(op, [], 200), { code: 'MYOTIS_UNAVAILABLE' });
        assert.equal(client.accepting, false);
        assert.equal(client.active.size, 1, 'Timeout must retain native admission');
        await finish(client, true);
      });
    }
    await runCase('blocked-stop', 'blocked-stop', async (dir) => {
      const client = acquire(dir); await ready(client);
      assert.equal(await client.stop(), true); validateTerminal(client, true);
    });
    await runCase('control-eof', 'healthy', async (dir) => {
      const client = acquire(dir); await ready(client);
      client.child.stdin.end(); await finish(client, true);
    });
    await runCase('active-record-rejection', 'healthy', async (dir) => {
      // Simulated unknown ownership, not a live second writer or PID fixture.
      const activeGeneration = crypto.randomUUID();
      fs.writeFileSync(path.join(dir, 'data', '.freedom-myotis-owner'), `v1 active ${activeGeneration}\n`, { flag: 'wx' });
      const client = acquire(dir);
      assert.equal(await deadline(client.startPromise, 18000, 'rejected startup'), false);
      await deadline(new Promise((resolve) => {
        if (client.supervisorExit) resolve(); else client.child.once('exit', resolve);
      }), 5000, 'rejected supervisor exit');
      assert.equal(client.supervisorExit.code, 67);
      assert.equal(client.exited, false);
      assert.equal(client.terminalReceipt, undefined);
      assert.equal(fs.existsSync(path.join(dir, 'fixture-events.jsonl')), false);
      assert.equal(readRecord(path.join(dir, 'data')), `v1 active ${activeGeneration}\n`);
    });
    for (const [name, groupSignal] of [['parent-controller-loss', false], ['controller-group-sigterm', true]]) {
      await runCase(name, 'blocked-stop', async (dir) => {
        const evidence = await parentLoss(dir, groupSignal);
        const next = acquire(dir, 'after-parent-loss'); await ready(next);
        // Only the successor has full receipt+OS-exit proof. The old generation
        // has durable retirement proof, now snapshotted before guarded reuse.
        assert.equal(await next.stop(), true); validateTerminal(next, true);
        return evidence;
      });
    }
  } finally {
    clearTimeout(emergency);
    const inputsUnchanged = manifest.inputs.every(({ file, sha256 }) => hash(file) === sha256);
    writeJson(path.join(root, 'summary.json'), { results,
      passed: inputsUnchanged && results.length === 9 && results.every((result) => result.passed),
      inputsUnchanged,
      supervisorLossQualified: false, realAddonQualified: false,
    });
  }
}

if (require.main === module) {
  const controllerMode = ['--parent-controller', '--group-controller'].includes(process.argv[2]);
  const task = controllerMode
    ? runParentController(path.resolve(process.argv[3]), process.argv[2] === '--group-controller')
    : runHarness(parseArguments(process.argv.slice(2)));
  task.catch((error) => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { parseArguments, validateTerminal, requireRuntime, controllerOptions };
