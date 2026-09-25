// Real Electron main-process qualification; no module replacement or network mocks.
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const [repo, runDir, chainText, budgetText = '600'] = process.argv.slice(2);
const chainId = Number(chainText);
const { app } = require('electron');
app.setPath('userData', path.join(runDir, 'electron-user-data'));
process.env.FREEDOM_TEST_USER_DATA = runDir;
const manager = require(path.join(repo, 'src/main/myotis/myotis-manager'));
const { CHECKPOINT_NETWORKS } = require(path.join(repo, 'src/main/myotis/checkpoint-verifier'));
const config = CHECKPOINT_NETWORKS[chainId];
const began = Date.now();
const deadline = began + Number(budgetText) * 1000;
let trace = '';
let success = false;
const events = [];
function emit(type, detail = {}) {
  const event = { type, at: new Date().toISOString(), elapsedMs: Date.now() - began, chainId, ...detail };
  events.push(event);
  console.log(JSON.stringify(event));
}
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function stateRecord(baseDir) {
  const pointer = JSON.parse(await fs.readFile(path.join(baseDir, 'verified-sync.json'), 'utf8'));
  return JSON.parse(await fs.readFile(path.join(baseDir, 'verified-sync', pointer.generation, 'anchor.json'), 'utf8'));
}
async function waitForRead(phase) {
  let nextRead = 0;
  while (Date.now() < deadline) {
    const status = manager.publicStatus(chainId);
    const native = manager.getStatus(chainId);
    const ready = manager.isReady(chainId);
    const signature = JSON.stringify({ state: status.state, recovery: status.recovery, native, ready });
    if (signature !== trace) { trace = signature; emit('status', { phase, status, native, ready }); }
    if (ready && Date.now() >= nextRead) {
      nextRead = Date.now() + 15000;
      try {
        const result = await manager.getAccount('0x0000000000000000000000000000000000000000', chainId);
        emit('account-read', { phase, result });
        if (result && !result.error && result.status !== 'error' && result.status !== 'unavailable') return true;
      } catch (error) { emit('account-read-error', { phase, code: error.code || null, message: error.message }); }
    }
    await pause(1000);
  }
  return false;
}
async function main() {
  await app.whenReady();
  const stale = JSON.parse(await fs.readFile(path.join(repo, 'docs/audits/evidence/myotis-recovery-spike-2026-09/native/stale-checkpoints.json'), 'utf8'))[config.network];
  const baseDir = path.join(runDir, 'myotis');
  const generation = randomUUID();
  const checkpoint = {
    schemaVersion: 1, chainId, network: config.network, root: stale.root, slot: stale.slot,
    source: config.source, verifiedAt: (config.genesis + stale.slot * config.secondsPerSlot) * 1000 + 600000,
    finalizedEpoch: Math.ceil(stale.slot / config.slotsPerEpoch),
  };
  const directory = path.join(baseDir, 'verified-sync', generation);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, 'anchor.json'), JSON.stringify({ schemaVersion: 1, chainId, generation, origin: 'verified', checkpoint }), { flag: 'wx' });
  await fs.writeFile(path.join(baseDir, 'verified-sync.json'), JSON.stringify({ schemaVersion: 1, chainId, generation }), { flag: 'wx' });
  emit('fixture', { checkpoint, generation, provenance: 'Authentic v0.1.7 historic root/slot; synthetic persisted verification metadata for isolated stale-cache lifecycle fixture. No snapshot.' });
  manager.onAvailabilityTransition((event) => emit('availability', event));
  emit('start-result', { started: await manager.startMyotis({ chainId, dataDir: baseDir }) });
  const initialRead = await waitForRead('recovery');
  const fresh = await stateRecord(baseDir);
  emit('generation-after-recovery', { record: fresh, changed: fresh.generation !== generation });
  const firstStop = await manager.stopMyotis(chainId);
  emit('stop-result', { phase: 'recovery', stopped: firstStop, ready: manager.isReady(chainId) });
  let restarted = false;
  let restartRead = false;
  if (initialRead && firstStop && Date.now() < deadline) {
    restarted = await manager.startMyotis({ chainId, dataDir: baseDir });
    emit('restart-result', { started: restarted });
    restartRead = await waitForRead('restart');
  }
  const final = await stateRecord(baseDir);
  const names = await fs.readdir(path.join(baseDir, 'verified-sync', final.generation));
  success = initialRead && firstStop && restarted && restartRead && fresh.generation !== generation && final.generation === fresh.generation;
  emit('qualification', { success, initialRead, firstStop, restarted, restartRead, sameGenerationOnRestart: final.generation === fresh.generation, snapshotFiles: names.filter((name) => name.endsWith('.snapshot')), finalCheckpoint: final.checkpoint });
}
main().catch((error) => emit('harness-error', { message: error.message, code: error.code || null })).finally(async () => {
  const stopped = await manager.stopAllMyotis({ shutdown: true });
  emit('final-stop', { stopped });
  const addon = await fs.readFile(path.join(repo, 'myotis-bin/mac-arm64/myotis-node.node'));
  await fs.writeFile(path.join(runDir, 'result.json'), JSON.stringify({ schemaVersion: 1, success, chainId, electron: process.versions.electron, node: process.versions.node, addonSha256: createHash('sha256').update(addon).digest('hex'), events }, null, 2));
  app.exit(success ? 0 : 1);
});
