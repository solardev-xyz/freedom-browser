'use strict';

// Third-party cookies (#474): blocked by default, as Safari, Firefox and Brave
// block them. A tracker embedded on many sites (an ad iframe, a social widget,
// a pixel) can otherwise set one cookie and recognise the user on all of them;
// the ad blocker stops only the trackers its lists know.
//
// What blocks them. Electron has no session option for it, and of Chromium's
// own switches only this one works in Electron 45.2.1 (probed 2026-11-13 with
// two HTTPS sites on loopback):
//
//   - `--test-third-party-cookie-phaseout`, Chromium's switch for testing the
//     third-party cookie phase-out: an embedded third party neither receives
//     its cookies on requests nor reads or writes them through
//     `document.cookie`. Partitioned cookies (CHIPS), which a site keeps per
//     top-level site and so can't use to follow anyone, keep working, and so
//     does everything first-party: top-level navigations, SSO redirects and
//     login popups are first-party where they land.
//   - The `ForceThirdPartyCookieBlocking` feature changes nothing in Electron.
//
// No per-site exceptions. The switch covers the whole network service, and
// Electron gives no way past it for one site: the Storage Access API is what
// an embed would ask with, but a grant from Electron's permission handler
// resolves the page's request without ever reaching the network service, so
// the cookies stay blocked (`hasStorageAccess()` stays false). Putting the
// cookies back by hand in `webRequest` covers requests but not
// `document.cookie`, and would re-implement cookie matching. The way out for a
// site that breaks is turning this off, in Settings → Privacy and security →
// Cookies.
//
// A command-line switch is read once at launch, so the stored choice takes
// effect from the next start, and it covers private windows too. Chromium
// hands it to the network service it starts again after a crash
// (test-e2e/third-party-cookies.spec.js kills it and checks again).
//
// It is a testing switch, and Google dropped the phase-out in 2025, so a later
// Chromium may remove it without a word: unknown switches are ignored.
// chromium-feature-switches.test.js checks the shipped Electron still has it,
// and the E2E spec that an embedded third party really can't see its cookie.
//
// The switch blocks only while third-party storage is partitioned, which
// Chromium does by default (`ThirdPartyStoragePartitioning`). With that
// feature disabled it blocks nothing at all, so a launch that disables it would
// quietly let trackers back in. Playwright's Electron launcher does exactly
// that (microsoft/playwright#32230), which would also have every E2E run test
// an app that doesn't behave like the shipped one. So when blocking, the
// feature is taken out of `--disable-features`. Listing it in
// `--enable-features` instead doesn't help: when a feature is in both lists,
// Chromium disables it.

const IPC = require('../shared/ipc-channels');

const BLOCK_THIRD_PARTY_COOKIES_SWITCH = 'test-third-party-cookie-phaseout';
const STORAGE_PARTITIONING_FEATURE = 'ThirdPartyStoragePartitioning';

// A feature-list entry's feature name: Chromium also reads `*Name` and
// `Name<Trial` (and `Name:param/value`) as that feature.
const featureNameOf = (entry) => entry.replace(/^\*/, '').split(/[<:]/)[0];

// Re-append `--disable-features` without storage partitioning. The rest of
// the list is the launcher's own and stays; nothing new is toggled.
function keepStoragePartitioning(app, logger) {
  const disabled = String(app.commandLine.getSwitchValue('disable-features') || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  const isPartitioning = (entry) => featureNameOf(entry) === STORAGE_PARTITIONING_FEATURE;
  if (!disabled.some(isPartitioning)) return false;
  const rest = disabled.filter((entry) => !isPartitioning(entry));
  app.commandLine.removeSwitch('disable-features');
  if (rest.length) app.commandLine.appendSwitch('disable-features', rest.join(','));
  logger?.warn?.(
    `[cookies] ${STORAGE_PARTITIONING_FEATURE} was disabled at launch; re-enabled, since ` +
      'third-party cookie blocking depends on it'
  );
  return true;
}

// Anything but an explicit false blocks: a missing or hand-edited value falls
// back to the default rather than quietly allowing tracking.
function blocksThirdPartyCookies(settings) {
  return settings?.blockThirdPartyCookies !== false;
}

// What this launch actually decided, so Settings can offer a restart when the
// stored choice differs from it. null until main/index.js applies it.
let blockedAtLaunch = null;

/** Append the switch when the stored choice blocks. Call before app ready. */
function applyThirdPartyCookieBlocking(app, settings, { logger } = {}) {
  const block = blocksThirdPartyCookies(settings);
  if (block) {
    app.commandLine.appendSwitch(BLOCK_THIRD_PARTY_COOKIES_SWITCH);
    keepStoragePartitioning(app, logger);
  }
  blockedAtLaunch = block;
  logger?.info?.(`[cookies] third-party cookies ${block ? 'blocked' : 'allowed'} for this launch`);
  return block;
}

function thirdPartyCookiesBlockedAtLaunch() {
  return blockedAtLaunch;
}

function registerThirdPartyCookiesIpc(ipcMain) {
  ipcMain.handle(IPC.THIRD_PARTY_COOKIES_LAUNCH_STATE, () => ({ blockedAtLaunch }));
}

module.exports = {
  BLOCK_THIRD_PARTY_COOKIES_SWITCH,
  STORAGE_PARTITIONING_FEATURE,
  blocksThirdPartyCookies,
  applyThirdPartyCookieBlocking,
  thirdPartyCookiesBlockedAtLaunch,
  registerThirdPartyCookiesIpc,
};
