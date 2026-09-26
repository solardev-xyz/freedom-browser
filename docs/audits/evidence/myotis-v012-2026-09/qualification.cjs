// Run with locked Electron: qualification.cjs <repository> [stopped-warm-cache-dir].
// The optional read-only cache input selects just the stale-recovery phase.
// Uses only a freshly-created OS temporary profile. No overrides or mocks of
// the production manager, supervisor, ENS resolver, quorum or Colibri verifier.
const fs = require('node:fs/promises');
const { watch } = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto');
const { app } = require('electron');
const repo = path.resolve(process.argv[2]);
const began = Date.now();
const events = [];
let manager;
let runDir;
let success = false;
function emit(type, detail = {}) {
  const event = { type, elapsedMs: Date.now() - began, ...detail };
  events.push(event);
  console.log(JSON.stringify(event));
}
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
async function generation(baseDir) {
  const pointer = JSON.parse(await fs.readFile(path.join(baseDir, 'verified-sync.json'), 'utf8'));
  return path.join(baseDir, 'verified-sync', pointer.generation);
}
async function waitForEns(phase, budgetMs = 480000) {
  const start = Date.now();
  let signature;
  let firstReady;
  let nextRead = 0;
  const { resolveEnsAddress } = require(path.join(repo, 'src/main/ens-resolver'));
  while (Date.now() - start < budgetMs) {
    const status = manager.publicStatus();
    const ready = manager.isReady();
    const summary = {
      phase,
      state: status.state,
      beaconState: status.beaconState,
      snapPeers: status.snapPeers,
      snapServingPeers: status.snapServingPeers,
      elReaderAvailable: status.elReaderAvailable,
      elHunting: status.elHunting,
      recovery: status.recovery,
      ready,
    };
    const serialized = JSON.stringify(summary);
    if (serialized !== signature) {
      signature = serialized;
      emit('status', summary);
    }
    if (ready) {
      assert(status.snapServingPeers > 0);
      firstReady ??= Date.now();
      if (Date.now() >= nextRead) {
        nextRead = Date.now() + 3000;
        const before = Date.now();
        try {
          const result = await resolveEnsAddress('vitalik.eth');
          emit('ens', {
            phase,
            ms: Date.now() - before,
            sinceReadyMs: Date.now() - firstReady,
            result,
          });
          if (
            result.success &&
            result.trust?.method === 'myotis' &&
            result.trust.level === 'verified'
          ) {
            assert.equal(
              result.address.toLowerCase(),
              '0xd8da6bf26964af9d7eed9e03e53415d37aa96045'
            );
            return;
          }
        } catch (error) {
          emit('read-error', { phase, message: error.message });
        }
      }
    }
    await pause(250);
  }
  throw new Error(`${phase}: no Myotis ENS result within ${budgetMs}ms`);
}
async function main() {
  runDir = await fs.mkdtemp(path.join(os.tmpdir(), 'freedom-myotis-v012-'));
  app.setPath('userData', runDir);
  process.env.FREEDOM_TEST_USER_DATA = runDir;
  await app.whenReady();
  manager = require(path.join(repo, 'src/main/myotis/myotis-manager'));
  const registry = require(path.join(repo, 'src/main/networks/network-registry'));
  registry.updateNetwork(1, { verification: { order: ['myotis'], preferVerified: true } });
  const baseDir = path.join(runDir, 'myotis', 'mainnet');
  emit('profile', {
    runDir,
    version: manager.publicStatus().version,
    abi: manager.publicStatus().abi,
  });
  let first;
  if (process.argv[3]) {
    first = path.resolve(process.argv[3]);
    await fs.mkdir(path.join(baseDir, 'verified-sync'), { recursive: true });
  } else {
    assert(await manager.startMyotis({ dataDir: baseDir }));
    await waitForEns('fresh-cold');
    assert(await manager.stopMyotis());
    first = await generation(baseDir);
  }
  const warm = new Map();
  for (const name of ['peers.cache', 'cl-peers.cache']) {
    warm.set(name, await fs.readFile(path.join(first, name)));
    emit('warm-cache', {
      name,
      bytes: warm.get(name).length,
      sha256: hash(warm.get(name)),
      snapok: (
        warm
          .get(name)
          .toString()
          .match(/snapok/g) || []
      ).length,
      snapbad: (
        warm
          .get(name)
          .toString()
          .match(/snapbad/g) || []
      ).length,
    });
  }
  assert(warm.get('peers.cache').includes('snapok'));
  if (!process.argv[3]) {
    // Reproduce the requested cold-EL restart while preserving CL/snapshot state.
    await fs.rename(path.join(first, 'peers.cache'), path.join(first, 'peers.cache.saved'));
    assert(await manager.startMyotis({ dataDir: baseDir }));
    await waitForEns('cold-el-restart');
    assert(await manager.stopMyotis());
  }

  // Genuine stale native checkpoint, with synthetic historical host metadata
  // solely to trigger recovery in this disposable fixture. No old snapshot.
  const { CHECKPOINT_NETWORKS } = require(path.join(repo, 'src/main/myotis/checkpoint-verifier'));
  const config = CHECKPOINT_NETWORKS[1];
  const stale = JSON.parse(
    await fs.readFile(
      path.join(
        repo,
        'docs/audits/evidence/myotis-recovery-spike-2026-09/native/stale-checkpoints.json'
      ),
      'utf8'
    )
  ).mainnet;
  const id = randomUUID();
  const staleDir = path.join(baseDir, 'verified-sync', id);
  await fs.mkdir(staleDir);
  const checkpoint = {
    schemaVersion: 1,
    chainId: 1,
    network: 'mainnet',
    root: stale.root,
    slot: stale.slot,
    source: config.source,
    verifiedAt: (config.genesis + stale.slot * 12) * 1000 + 600000,
    finalizedEpoch: Math.ceil(stale.slot / 32),
  };
  await fs.writeFile(
    path.join(staleDir, 'anchor.json'),
    JSON.stringify({
      schemaVersion: 1,
      chainId: 1,
      generation: id,
      nativeCheckpointApi: 29,
      origin: 'verified',
      checkpoint,
    }),
    { flag: 'wx' }
  );
  for (const [name, bytes] of warm)
    await fs.writeFile(path.join(staleDir, name), bytes, { flag: 'wx' });
  await fs.writeFile(
    path.join(baseDir, 'verified-sync.json'),
    JSON.stringify({ schemaVersion: 1, chainId: 1, generation: id })
  );
  let inherited = false;
  let importedAt;
  const watcher = watch(baseDir, async (_event, filename) => {
    if (filename !== 'verified-sync.json' || inherited) return;
    try {
      const current = await generation(baseDir);
      if (current === staleDir) return;
      importedAt = Date.now();
      for (const [name, bytes] of warm)
        assert.equal(hash(await fs.readFile(path.join(current, name))), hash(bytes));
      inherited = true;
      emit('inherited-at-pointer-swap', { matched: true });
    } catch (error) {
      emit('inheritance-error', { message: error.message });
    }
  });
  try {
    assert(await manager.startMyotis({ dataDir: baseDir }));
    await waitForEns('warm-stale-recovery', 300000);
    assert(inherited);
    const current = await generation(baseDir);
    assert.notEqual(current, staleDir);
    const anchor = JSON.parse(await fs.readFile(path.join(current, 'anchor.json'), 'utf8'));
    assert.equal(anchor.checkpoint.schemaVersion, 2);
    assert(anchor.checkpoint.sources.length >= 2);
    emit('recovery-complete', {
      sinceImportMs: Date.now() - importedAt,
      checkpoint: anchor.checkpoint,
    });
    assert(events.some((event) => event.beaconState === 'STALE_ANCHOR'));
    success = true;
  } finally {
    watcher.close();
  }
}
main()
  .catch((error) => emit('failure', { message: error.message, stack: error.stack }))
  .finally(async () => {
    const stopped = manager ? await manager.stopAllMyotis({ shutdown: true }) : true;
    success =
      success &&
      (Array.isArray(stopped) ? stopped.every((value) => value === true) : stopped === true);
    emit('complete', { success, stopped });
    if (runDir)
      await fs.writeFile(path.join(runDir, 'qualification.json'), JSON.stringify(events, null, 2));
    app.exit(success ? 0 : 1);
  });
