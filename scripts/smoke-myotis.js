#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');

// Cross-platform live smoke for the exact addon Freedom ships. This is kept
// separate from the Playwright spec so CI can cache a cleanly-stopped sync
// data directory even when the first cold run needs another attempt.
const EXPECTED_ABI = 22;
const VITALIK_ADDRESS = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';
const network = process.env.MYOTIS_NETWORK || 'mainnet';
const POLL_INTERVAL_MS = 5000;
const QUERY_TIMEOUT_MS = 120000;

const TARGET_DIRS = {
  'darwin-arm64': 'mac-arm64',
  'darwin-x64': 'mac-x64',
  'linux-arm64': 'linux-arm64',
  'linux-x64': 'linux-x64',
  'win32-x64': 'win-x64',
};

const target = `${process.platform}-${process.arch}`;
const targetDir = TARGET_DIRS[target];
if (!targetDir) {
  console.error(`No Myotis release addon is expected for ${target}`);
  process.exit(1);
}

const addonPath = path.resolve(
  process.env.MYOTIS_NODE_PATH ||
    path.join(__dirname, '..', 'myotis-bin', targetDir, 'myotis-node.node')
);
const dataDir = path.resolve(
  process.env.MYOTIS_DATA_DIR || path.join(os.tmpdir(), `freedom-myotis-smoke-${target}`)
);
const syncTimeoutMinutes = Number(process.env.MYOTIS_SMOKE_TIMEOUT_MIN) || 75;
const syncTimeoutMs = syncTimeoutMinutes * 60 * 1000;
const syncStallMinutes = Number(process.env.MYOTIS_SMOKE_STALL_MIN) || 10;
const syncStallMs = syncStallMinutes * 60 * 1000;
const queryAttempts = Number(process.env.MYOTIS_SMOKE_QUERY_ATTEMPTS) || 8;
const readRecoveryAttempts = Number(process.env.MYOTIS_SMOKE_RECOVERY_ATTEMPTS) || 3;
const syncRecoveryAttempts = Number(process.env.MYOTIS_SMOKE_SYNC_RECOVERY_ATTEMPTS) || 3;

let addon = null;
let handle = -1;
let stopped = false;
const startedAt = Date.now();

function elapsed() {
  return `${((Date.now() - startedAt) / 1000).toFixed(1)}s`;
}

function log(...args) {
  console.log(`[myotis-smoke ${elapsed()}]`, ...args);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout(promise, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${label} timed out after ${QUERY_TIMEOUT_MS}ms`)),
        QUERY_TIMEOUT_MS
      );
    }),
  ]).finally(() => clearTimeout(timer));
}

function drainLogs() {
  if (!addon) return;
  const batch = addon.drainLogs(100);
  for (const line of batch.split('\n')) {
    if (/ERROR|WARN/.test(line)) console.log(`  [myotis-engine] ${line}`);
  }
}

function stop() {
  if (stopped) return;
  stopped = true;
  if (addon && handle >= 1) {
    try {
      addon.stop(handle);
      log('stopped cleanly');
    } catch (err) {
      console.error(`Myotis stop failed: ${err.message}`);
    }
  }
  handle = -1;
}

process.once('SIGINT', () => {
  stop();
  process.exit(130);
});
process.once('SIGTERM', () => {
  stop();
  process.exit(143);
});

async function verifiedReads() {
  let lastError = null;
  for (let attempt = 1; attempt <= queryAttempts; attempt++) {
    try {
      if (network === 'gnosis') {
        const account = JSON.parse(
          await withTimeout(
            addon.requestAccountJson(handle, VITALIK_ADDRESS),
            'Gnosis account read'
          )
        );
        log(`verified read attempt ${attempt}:`, JSON.stringify({ account }));
        if (account.error) throw new Error(`account read: ${account.error}`);
        if (account.peerProofValid !== true || account.beaconChainVerified !== true) {
          throw new Error(`account was not chain verified: ${JSON.stringify(account)}`);
        }
        if (account.balanceWei == null || account.nonce == null) {
          throw new Error(`account response incomplete: ${JSON.stringify(account)}`);
        }
        return;
      }
      const address = JSON.parse(
        await withTimeout(
          addon.ensRecordJson(
            handle,
            JSON.stringify({ method: 'addr', name: 'vitalik.eth', root: 'finalized' })
          ),
          'ENS address read'
        )
      );
      const contenthash = JSON.parse(
        await withTimeout(
          addon.ensRecordJson(
            handle,
            JSON.stringify({ method: 'contenthash', name: 'vitalik.eth', root: 'finalized' })
          ),
          'ENS contenthash read'
        )
      );
      const reverse = JSON.parse(
        await withTimeout(
          addon.ensRecordJson(
            handle,
            JSON.stringify({
              method: 'reverse',
              addressHex: VITALIK_ADDRESS,
              root: 'finalized',
            })
          ),
          'ENS reverse read'
        )
      );
      log(`verified read attempt ${attempt}:`, JSON.stringify({ address, contenthash, reverse }));

      if (address.error) throw new Error(`address read: ${address.error}`);
      if (address.status !== 'ok' || address.verified !== true) {
        throw new Error(`address was not finalized-root verified: ${JSON.stringify(address)}`);
      }
      if (address.addressHex?.toLowerCase() !== VITALIK_ADDRESS.toLowerCase()) {
        throw new Error(`address mismatch: ${address.addressHex || JSON.stringify(address)}`);
      }
      if (contenthash.error) throw new Error(`contenthash read: ${contenthash.error}`);
      if (contenthash.status !== 'ok' || !contenthash.dataHex) {
        throw new Error(`contenthash not resolved: ${JSON.stringify(contenthash)}`);
      }
      if (contenthash.verified !== true) {
        throw new Error(
          `contenthash was not finalized-root verified: ${JSON.stringify(contenthash)}`
        );
      }
      if (reverse.error) throw new Error(`reverse read: ${reverse.error}`);
      if (reverse.status !== 'ok' || reverse.verified !== true) {
        throw new Error(`reverse was not finalized-root verified: ${JSON.stringify(reverse)}`);
      }
      if (reverse.name?.toLowerCase() !== 'vitalik.eth') {
        throw new Error(`reverse mismatch: ${reverse.name || JSON.stringify(reverse)}`);
      }
      return;
    } catch (err) {
      lastError = err;
      drainLogs();
      if (attempt < queryAttempts) {
        log(`verified read attempt ${attempt} failed (${err.message}); retrying in 15s`);
        await delay(15000);
      }
    }
  }
  throw lastError || new Error('verified reads failed');
}

async function waitUntilReady(deadline) {
  let lastSummary = '';
  let lastPeriod = -1;
  let lastProgressAt = Date.now();
  let recoveries = 0;
  for (;;) {
    const status = JSON.parse(addon.statusJson(handle));
    const summary =
      `beacon=${status.beaconState} peers=${status.peerCount} snapPeers=${status.snapPeers} ` +
      `period=${status.currentPeriod}/${status.targetPeriod} ` +
      `el=${status.elReaderAvailable} hunting=${status.elHunting}`;
    if (summary !== lastSummary) {
      log(summary);
      lastSummary = summary;
    }
    drainLogs();

    if (status.currentPeriod > lastPeriod) {
      lastPeriod = status.currentPeriod;
      lastProgressAt = Date.now();
    }

    const ready =
      status.beaconState === 'SYNCED' &&
      status.elReaderAvailable === true &&
      status.elHunting !== true &&
      status.snapPeers > 0;
    if (ready) return;
    if (Date.now() >= deadline) {
      throw new Error(
        `Myotis did not become ready within ${syncTimeoutMinutes} minutes; last status: ` +
          JSON.stringify(status)
      );
    }
    if (
      Date.now() - lastProgressAt >= syncStallMs &&
      recoveries < syncRecoveryAttempts &&
      (status.lcHunting === true || status.peerCount === 0)
    ) {
      recoveries += 1;
      await recoverPeerPool(
        `beacon catch-up stalled at period ${status.currentPeriod} for ${syncStallMinutes} minutes ` +
          `(recovery ${recoveries}/${syncRecoveryAttempts})`
      );
      lastProgressAt = Date.now();
      lastSummary = '';
      continue;
    }
    await delay(POLL_INTERVAL_MS);
  }
}

async function recoverPeerPool(reason) {
  log(`${reason}; recreating the native handle from the warm snapshot`);
  addon.stop(handle);
  handle = -1;
  await delay(1000);
  handle = addon.create(network, dataDir);
  if (handle < 1) throw new Error(`Myotis recreate failed with handle ${handle}`);
  if (!addon.start(handle)) throw new Error('Myotis restart failed during peer-pool recovery');
}

async function main() {
  if (!fs.existsSync(addonPath)) throw new Error(`Myotis addon not found: ${addonPath}`);
  fs.mkdirSync(dataDir, { recursive: true });

  addon = require(addonPath);
  const abi = addon.init();
  if (abi !== EXPECTED_ABI) {
    throw new Error(`Myotis ABI mismatch: expected ${EXPECTED_ABI}, got ${abi}`);
  }
  log(`loaded ${target} addon (ABI ${abi}) from ${addonPath}`);

  handle = addon.create(network, dataDir);
  if (handle < 1) throw new Error(`Myotis create failed with handle ${handle}`);
  if (!addon.start(handle)) throw new Error('Myotis start failed');
  log(`started handle ${handle}; data dir ${dataDir}`);

  const deadline = Date.now() + syncTimeoutMs;
  for (let recovery = 0; recovery <= readRecoveryAttempts; recovery++) {
    await waitUntilReady(deadline);
    log(`node ready; performing verified ${network} reads`);
    try {
      await verifiedReads();
      log(`PASS: released addon started and served verified ${network} reads`);
      return;
    } catch (err) {
      if (recovery >= readRecoveryAttempts) throw err;
      log(`verified reads failed after peer-pool attempt ${recovery + 1}: ${err.message}`);
      await recoverPeerPool('verified reads exhausted the current execution peer pool');
    }
  }
}

main()
  .catch((err) => {
    console.error(`myotis smoke failed: ${err.stack || err.message}`);
    process.exitCode = 1;
  })
  .finally(stop);
