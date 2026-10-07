// No network or user profiles. Exercise the actual compiled helper and real
// kernel boot identity. A modified fixture witness simulates a previous boot;
// this does NOT reboot the test host or claim a real reboot qualification.
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { randomUUID } = require('crypto');
const { spawn, spawnSync } = require('child_process');
const { supervisorPath, MyotisProcess } = require('../src/main/myotis/myotis-process');
const { loadOrCreateState } = require('../src/main/myotis/checkpoint-store');

async function check() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-owner-recovery-'));
  const id = randomUUID();
  function fixture() {
    const dir = path.join(root, randomUUID()); fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, '.freedom-myotis-owner'), `v1 active ${id}\n`);
    return dir;
  }
  function run(dir) {
    const result = spawnSync(supervisorPath(), ['--recover-owner', dir, randomUUID()], { timeout: 6000 });
    assert.ifError(result.error);
    assert.equal(result.signal, null);
    return result.status;
  }
  function previousBoot(dir) {
    const file = path.join(dir, '.freedom-myotis-boot');
    const bytes = fs.readFileSync(file);
    bytes.fill(0, 72, 136);
    bytes.write(process.platform === 'win32' ? '0000000000000001' : randomUUID(), 72);
    fs.writeFileSync(file, bytes);
  }
  const data = fixture();
  assert.equal(run(data), 10, 'old builds arm a reboot witness');
  assert.equal(run(data), 10, 'same boot stays blocked');
  assert.equal(fs.readFileSync(path.join(data, '.freedom-myotis-owner'), 'utf8'), `v1 active ${id}\n`);
  previousBoot(data);
  assert.equal(run(data), 11, 'previous boot allows fresh state, not snapshot resume');
  assert.match(fs.readFileSync(path.join(data, '.freedom-myotis-owner'), 'utf8'), /^v1 rebooted /);
  assert.equal(run(data), 11, 'recovery receipt survives restart before pointer publication');

  const changed = fixture(); assert.equal(run(changed), 10); previousBoot(changed);
  fs.writeFileSync(path.join(changed, '.freedom-myotis-owner'), `v1 active ${randomUUID()}\n`);
  assert.equal(run(changed), 10, 'a different owner cannot borrow the old boot proof');

  const foreign = fixture(); assert.equal(run(foreign), 10); previousBoot(foreign);
  const witness = path.join(foreign, '.freedom-myotis-boot');
  const bytes = fs.readFileSync(witness); bytes[8] ^= 1; fs.writeFileSync(witness, bytes);
  assert.equal(run(foreign), 12, 'a different machine cannot authorize recovery');

  const linked = fixture(); fs.linkSync(path.join(linked, '.freedom-myotis-owner'), path.join(linked, 'other-link'));
  assert.equal(run(linked), 12, 'hard-linked owners remain blocked');

  const missing = fixture();
  fs.writeFileSync(path.join(missing, '.freedom-myotis-owner'), `v1 leased ${id}\n`);
  assert.equal(run(missing), 12, 'a missing lifetime lease is not invented');

  const failedLaunch = path.join(root, 'failed-launch'); fs.mkdirSync(failedLaunch);
  await new Promise((resolve, reject) => {
    const helper = spawn(supervisorPath(), [path.join(root, 'missing-node'), __filename, randomUUID(), failedLaunch], {
      env: { ...require('../src/main/myotis/myotis-process').childEnvironment(), NODE_CHANNEL_FD: '3' },
      stdio: ['pipe', 'pipe', 'ignore', 'pipe'],
    });
    const timeout = setTimeout(() => { helper.kill('SIGKILL'); reject(new Error('launch failure hung')); }, 6000);
    helper.stdout.resume();
    helper.once('error', reject);
    helper.once('exit', () => { clearTimeout(timeout); resolve(); });
  });
  assert.equal(run(failedLaunch), 0, 'failed executable launch leaves confirmed retirement, not quarantine');

  const running = path.join(root, 'running'); fs.mkdirSync(running);
  fs.mkdirSync(path.join(running, 'data'));
  fs.copyFileSync(path.join(__dirname, 'fixtures/myotis-benign-addon.js'), path.join(running, 'addon.js'));
  fs.writeFileSync(path.join(running, 'fixture.json'), JSON.stringify({ identity: 'freedom-myotis-benign-v1', mode: 'healthy' }));
  const client = new MyotisProcess({ addonPath: path.join(running, 'addon.js'), network: 'mainnet',
    dataDir: path.join(running, 'data'), onStatus() {}, onUnavailable() {}, onExit() {} });
  try {
    assert.equal(await client.startPromise, true, 'benign native child starts');
    assert.equal(run(path.join(running, 'data')), 12, 'live owner is never recovered');
    assert(fs.existsSync(path.join(running, 'data', '.freedom-myotis-boot')), 'new starts record boot identity');
  } finally { assert.equal(await client.stop(), true, 'child and supervisor retire'); }
  assert.equal(run(path.join(running, 'data')), 0, 'ordinary clean retirement still works');

  // Kill only our retained, directly spawned supervisor object. The benign
  // child pauses for two seconds, then observes IPC loss and exits itself.
  // Windows additionally kills it via the supervisor's existing Job Object.
  // No process-name scan, guessed PID, native network or user data is involved.
  const base = path.join(root, 'crash');
  const original = await loadOrCreateState(base, 1);
  const addonDir = path.dirname(original.dataDir);
  // The fixture expects its data directory to be named 'data'. Point its
  // validation at the actual generation without changing production paths.
  const fixtureSource = fs.readFileSync(path.join(__dirname, 'fixtures/myotis-benign-addon.js'), 'utf8')
    .replace("path.join(__dirname, 'data')", 'config.dataDir');
  fs.writeFileSync(path.join(addonDir, 'addon.js'), fixtureSource);
  fs.writeFileSync(path.join(addonDir, 'fixture.json'), JSON.stringify({ identity: 'freedom-myotis-benign-v1',
    mode: 'orphan-window', dataDir: original.dataDir }));
  const crashed = new MyotisProcess({ addonPath: path.join(addonDir, 'addon.js'), network: 'mainnet',
    dataDir: original.dataDir, onStatus() {}, onUnavailable() {}, onExit() {} });
  const until = async (predicate) => {
    const deadline = Date.now() + 6000;
    while (!predicate()) {
      assert(Date.now() < deadline, 'bounded fixture wait');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };
  const events = () => fs.readFileSync(path.join(addonDir, 'fixture-events.jsonl'), 'utf8');
  try {
    assert.equal(await crashed.startPromise, true);
    assert.match(fs.readFileSync(path.join(original.dataDir, '.freedom-myotis-owner'), 'utf8'), /^v1 leased /);
    const reading = crashed.request('call').catch(() => {});
    await until(() => events().includes('lease-held'));
    const killedAt = Date.now();
    assert(crashed.child.kill('SIGKILL'), 'retained fixture supervisor terminated');
    await until(() => Boolean(crashed.supervisorExit));
    if (process.platform !== 'win32') {
      assert.equal(run(original.dataDir), 12, 'orphan child keeps its lease after supervisor exit');
      assert(!events().includes('lease-window-finished'), 'checked while child was still in its bounded wait');
    }
    await until(() => process.platform === 'win32' || events().includes('lease-window-finished'));
    let stopped = false;
    const deadline = Date.now() + 6000;
    while (!stopped && Date.now() < deadline) {
      stopped = await crashed.stop();
      if (!stopped) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert(stopped, 'native lifetime proof clears a previous failed stop without reboot');
    await reading;
    const fresh = await loadOrCreateState(base, 1);
    assert.notEqual(fresh.generation, original.generation, 'interrupted snapshots never resumed');
    assert(fs.existsSync(original.dataDir), 'old generation preserved');
    fs.writeFileSync(path.join(addonDir, 'fixture.json'), JSON.stringify({ identity: 'freedom-myotis-benign-v1',
      mode: 'healthy', dataDir: fresh.dataDir }));
    const replacement = new MyotisProcess({ addonPath: path.join(addonDir, 'addon.js'), network: 'mainnet',
      dataDir: fresh.dataDir, onStatus() {}, onUnavailable() {}, onExit() {} });
    try {
      assert.equal(await replacement.startPromise, true, 'replacement starts in the same browser process');
      assert.deepEqual(await replacement.request('call'), { resultHex: '0x1234' }, 'replacement serves a benign read');
    } finally { assert.equal(await replacement.stop(), true); }
    console.log(`Same-boot crash recovery: ${Date.now() - killedAt}ms (includes 2s POSIX fixture wait)`);
  } finally { await crashed.stop(); }
  console.log(`PASS ${process.platform}-${process.arch}: live child lifetime lock, same-boot crash recovery and fresh generation, retry after failed stop, legacy boot proof, missing lease, foreign host, hardlink, clean retirement`);
}
if (require.main === module) check().catch((error) => { console.error(error); process.exitCode = 1; });
module.exports = { check };
