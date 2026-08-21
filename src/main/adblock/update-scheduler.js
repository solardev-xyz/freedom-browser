/**
 * Schedules Swarm filter-list update cycles (WP5 5.B3).
 *
 * No cross-process owner-lock is needed: filter lists are written to
 * per-profile userData/adblock/updated, and profile-lock already guarantees a
 * single process per profile — so each profile keeps its own lists fresh
 * independently. (Contrast the app updater, which is global and therefore
 * lock-guarded.)
 *
 * A cycle is a no-op unless the feed trust anchor is configured and both
 * `adblockEnabled` and `adblockAutoUpdate` are on. runUpdateOnce tolerates the
 * node not being ready yet (it just returns feed_unavailable), so the first
 * check is merely delayed to let the Ant node warm up, then retried on the
 * periodic tick.
 */

const log = require('../logger');
const { loadSettings } = require('../settings-store');
const { isTrustAnchorConfigured } = require('./feed-config');
const { runUpdateOnce } = require('./update-manager');

// Let the embedded Ant node warm up before the first feed read; lists carry
// 1–4 day expiry, so a 6h cadence keeps clients comfortably fresh.
const INITIAL_DELAY_MS = 45_000;
const PERIOD_MS = 6 * 60 * 60 * 1000;

let initialTimer = null;
let periodTimer = null;

function updatesEnabled() {
  const settings = loadSettings();
  return (
    isTrustAnchorConfigured() &&
    settings.adblockEnabled !== false &&
    settings.adblockAutoUpdate !== false
  );
}

async function tick() {
  if (!updatesEnabled()) return null;
  try {
    const result = await runUpdateOnce();
    if (result.status === 'applied') {
      log.info(`[adblock-update] applied filter-list version ${result.version}`);
    }
    return result;
  } catch (err) {
    log.warn(`[adblock-update] update cycle failed: ${err.message}`);
    return { status: 'error', reason: err.message };
  }
}

function clearTimers() {
  if (initialTimer) clearTimeout(initialTimer);
  if (periodTimer) clearInterval(periodTimer);
  initialTimer = null;
  periodTimer = null;
}

/** Start the periodic scheduler. No-op (with a log) when there's no anchor. */
function installAdblockUpdater() {
  if (!isTrustAnchorConfigured()) {
    log.info('[adblock-update] no feed trust anchor compiled in — live updates disabled');
    return;
  }
  clearTimers();
  initialTimer = setTimeout(tick, INITIAL_DELAY_MS);
  periodTimer = setInterval(tick, PERIOD_MS);
  if (periodTimer.unref) periodTimer.unref();
  try {
    require('electron').app.on('will-quit', clearTimers);
  } catch {
    // Outside Electron (tests).
  }
}

module.exports = {
  installAdblockUpdater,
  _tick: tick,
  _updatesEnabled: updatesEnabled,
  _clearTimers: clearTimers,
};
