/**
 * Swarm upload smoke test (manual / local).
 *
 * Exercises the exact bee-js client path Freedom uses for publishing against a
 * running node (antd in light mode, or a real bee light node), so we can verify
 * end-to-end upload parity and catch HTTP response-shape mismatches before
 * wiring a new antd release into the app.
 *
 * Flow (mirrors stamp-service.js + publish-service.js):
 *   1. GET /node            — assert the node reports a publish-capable mode
 *   2. storage.getCost      — price a small batch
 *   3. storage.buy          — purchase a postage batch (waitForUsable: false)
 *   4. stamp.getAll         — poll until the new batch is usable
 *   5. file.upload          — upload content stamped with that batch
 *   6. file.download        — read it back and assert the bytes match
 *
 * Usage:
 *   ANT_API=http://127.0.0.1:1633 node scripts/smoke-upload.js
 *
 * Env:
 *   ANT_API           node HTTP API base URL (default http://127.0.0.1:1633)
 *   SMOKE_SIZE_GB     batch size in GB        (default 0.01)
 *   SMOKE_DAYS        batch duration in days  (default 1)
 *   SMOKE_USABLE_MS   max wait for usability  (default 180000)
 *   SMOKE_BATCH_ID    skip buying; reuse an existing usable batch id
 */

const { Bee, Size, Duration } = require('@ethersphere/bee-js');

const API = process.env.ANT_API || 'http://127.0.0.1:1633';
const SIZE_GB = Number(process.env.SMOKE_SIZE_GB || 0.01);
const DAYS = Number(process.env.SMOKE_DAYS || 1);
const USABLE_TIMEOUT_MS = Number(process.env.SMOKE_USABLE_MS || 180000);
const PRESET_BATCH = process.env.SMOKE_BATCH_ID || '';

function log(step, msg) {
  console.log(`[smoke] ${step}: ${msg}`);
}

function toHex(value) {
  if (value && typeof value.toHex === 'function') return value.toHex();
  return String(value || '');
}

async function getNodeMode() {
  const res = await fetch(`${API}/node`);
  if (!res.ok) throw new Error(`GET /node -> HTTP ${res.status}`);
  const body = await res.json();
  return body.beeMode || body.mode || '';
}

async function waitForUsableBatch(bee, batchId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastSeen = 'unknown';
  while (Date.now() < deadline) {
    const batches = await bee.stamp.getAll();
    const match = batches.find((b) => toHex(b.batchID).toLowerCase() === batchId.toLowerCase());
    if (match) {
      lastSeen = `usable=${match.usable}`;
      if (match.usable === true) return match;
    } else {
      lastSeen = 'not-listed';
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error(`batch ${batchId} did not become usable within ${timeoutMs}ms (last: ${lastSeen})`);
}

async function main() {
  log('config', `API=${API} size=${SIZE_GB}GB days=${DAYS}`);
  const bee = new Bee(API);

  const mode = await getNodeMode();
  log('node', `beeMode=${mode || '(empty)'}`);
  if (mode === 'ultra-light' || mode === 'ultralight') {
    throw new Error('node is in ultra-light mode — uploads require light mode (blockchain-rpc-endpoint configured + funded wallet)');
  }

  let batchId = PRESET_BATCH;
  if (batchId) {
    log('buy', `skipped — reusing SMOKE_BATCH_ID=${batchId}`);
  } else {
    const cost = await bee.storage.getCost(Size.fromGigabytes(SIZE_GB), Duration.fromDays(DAYS));
    log('cost', `~${cost.toSignificantDigits(4)} xBZZ`);

    const bought = await bee.storage.buy(
      Size.fromGigabytes(SIZE_GB),
      Duration.fromDays(DAYS),
      { waitForUsable: false },
      { timeout: 300000 }
    );
    batchId = toHex(bought);
    log('buy', `batchID=${batchId}`);
  }

  const usable = await waitForUsableBatch(bee, batchId, USABLE_TIMEOUT_MS);
  log('usable', `batch ${batchId} usable (depth/size ok)`);
  void usable;

  const deferred = process.env.SMOKE_DEFERRED !== 'false';
  const payload = `freedom-ant-upload-smoke ${new Date().toISOString()} ${Math.random()}`;
  const uploaded = await bee.file.upload(batchId, payload, 'smoke.txt', {
    pin: true,
    deferred,
    contentType: 'text/plain',
  });
  const reference = toHex(uploaded.reference);
  log('upload', `reference=${reference} (deferred=${deferred})`);

  // Newly-stamped chunks need a moment to land on neighbourhood peers; retry the
  // read-back a few times before giving up.
  const attempts = Number(process.env.SMOKE_DOWNLOAD_ATTEMPTS || 10);
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      const got = await bee.file.download(reference);
      const text = got.data.toUtf8 ? got.data.toUtf8() : got.data.toString();
      if (text !== payload) {
        throw new Error(`download mismatch:\n  sent: ${payload}\n  got:  ${text}`);
      }
      log('download', `content round-trip OK (attempt ${i})`);
      log('result', `PASS — bzz://${reference}`);
      return;
    } catch (err) {
      lastErr = err;
      log('download', `attempt ${i}/${attempts} not ready (${err.message}); retrying...`);
      await new Promise((r) => setTimeout(r, 6000));
    }
  }
  throw new Error(`download failed after ${attempts} attempts: ${lastErr && lastErr.message}`);
}

main().catch((err) => {
  console.error(`[smoke] FAIL: ${err.message}`);
  if (err.stack) console.error(err.stack);
  process.exit(1);
});
