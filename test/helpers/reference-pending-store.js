// The reference: src/main/wallet/safe/pending-store.js as the build before
// PRF-6(d) has it (freedom-browser integration/rust-core at 9d4ea6251,
// freedom-core design 0013's STORES_REFERENCE_COMMIT, which
// vectors/stores.json pins), verbatim but for its require path. It is how
// an older build reads and writes safe-pending.json: for the simulated core
// of the unit suites (simulated-store-core.js), and for the rollback and
// rollout tests of the file the identity core writes from PRF-6(d)
// (src/main/wallet/safe/pending-store.integration.test.js). Never main's
// code.
/**
 * Pending SafeTx store — the half-signed transaction that survives a
 * restart, as interim JSON (same posture as the other wallet JSON
 * stores; migrates into the unified wallet-history SQLite later).
 *
 * One pending SafeTx per Safe at a time, by design (research doc B.4):
 * a single slot sidesteps the nonce-replacement/ordering swamp that
 * Safe's hosted service exists to manage. Collected signatures are just
 * bytes — safe to persist, useless without the Safe and its chain state.
 */

const { getFreedomDataPath } = require('../../src/main/freedom-root');
const fs = require('fs');

const PENDING_FILE = 'safe-pending.json';

let cache = null;

function getFilePath() {
  return getFreedomDataPath(PENDING_FILE);
}

function load() {
  if (cache !== null) {
    return cache;
  }
  try {
    cache = fs.existsSync(getFilePath())
      ? JSON.parse(fs.readFileSync(getFilePath(), 'utf-8'))
      : {};
  } catch (err) {
    console.error('[SafePending] Failed to load pending store:', err);
    cache = {};
  }
  return cache;
}

function save() {
  try {
    fs.writeFileSync(getFilePath(), JSON.stringify(cache, null, 2), 'utf-8');
  } catch (err) {
    console.error('[SafePending] Failed to save pending store:', err);
  }
}

/** @returns {Object|null} The pending entry for a safe wallet index */
function getPending(safeIndex) {
  return load()[safeIndex] || null;
}

function setPending(safeIndex, entry) {
  load()[safeIndex] = entry;
  save();
}

function clearPending(safeIndex) {
  const store = load();
  if (safeIndex in store) {
    delete store[safeIndex];
    save();
  }
}

/** Safe wallet indexes that currently have a pending SafeTx. */
function listPendingIndexes() {
  return Object.keys(load()).map(Number);
}

module.exports = { getPending, setPending, clearPending, listPendingIndexes };
