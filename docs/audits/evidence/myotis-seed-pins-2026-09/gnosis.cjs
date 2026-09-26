// Real production manager in a disposable profile; no ENS or RPC fallback.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { app } = require('electron');
const repo = path.resolve(process.argv[2]);
const began = Date.now();
const events = [];
let manager,
  runDir,
  success = false;
function emit(type, fields = {}) {
  const event = { type, elapsedMs: Date.now() - began, ...fields };
  events.push(event);
  console.log(JSON.stringify(event));
}
async function main() {
  runDir = await fs.mkdtemp(path.join(os.tmpdir(), 'freedom-myotis-gnosis-seeds-'));
  app.setPath('userData', runDir);
  process.env.FREEDOM_TEST_USER_DATA = runDir;
  await app.whenReady();
  manager = require(path.join(repo, 'src/main/myotis/myotis-manager'));
  emit('profile', { runDir });
  assert(
    await manager.startMyotis({ chainId: 100, dataDir: path.join(runDir, 'myotis', 'gnosis') })
  );
  let firstReady;
  while (Date.now() - began < 120000) {
    const status = manager.publicStatus(100);
    emit('status', {
      state: status.state,
      beaconState: status.beaconState,
      snapPeers: status.snapPeers,
      snapServingPeers: status.snapServingPeers,
    });
    if (manager.isReady(100)) {
      firstReady ??= Date.now() - began;
      const before = Date.now();
      try {
        const result = await manager.getAccount('0x0000000000000000000000000000000000000001', 100);
        assert(result.peerProofValid && result.blsVerified && result.beaconChainVerified);
        emit('account', { firstReadyMs: firstReady, ms: Date.now() - before, result });
        const log = await fs.readFile(path.join(runDir, 'logs', 'main.log'), 'utf8');
        const pinCount = require(path.join(repo, 'src/main/myotis/seeds/gnosis.json')).length;
        assert(log.includes(`[myotis] gnosis seed pins (${pinCount}) applied`));
        assert(!log.includes(`seed pins (${pinCount}) refused`));
        success = true;
        return;
      } catch (error) {
        emit('read-error', { message: error.message });
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error('No Gnosis verified account read within two minutes');
}
main()
  .catch((error) => emit('failure', { message: error.message }))
  .finally(async () => {
    const stopped = manager ? await manager.stopAllMyotis({ shutdown: true }) : [true];
    emit('complete', { success, stopped });
    if (runDir)
      await fs.writeFile(path.join(runDir, 'qualification.json'), JSON.stringify(events, null, 2));
    app.exit(success && stopped.every(Boolean) ? 0 : 1);
  });
