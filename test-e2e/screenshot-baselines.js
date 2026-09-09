// Every surface `renderer-screenshots.spec.js` holds a baseline for, in the
// order it takes them. One entry per surface: the two committed files are
// `dark-<name>.png` and `light-<name>.png` under `SCREENSHOT_DIR`.
//
// This list exists because the guard was only ever one-way. Playwright fails a
// run whose baseline is *missing*, so a surface cannot ship uncompared — but
// nothing at all fails a baseline that is still committed and no longer taken.
// A renamed or deleted `snap()` name left its two PNGs in the tree for good:
// present, reviewed as part of every baseline diff, reading as coverage the
// surface had silently lost.
//
// So the comparison is made two-way against this file. The spec takes every
// shot through `declared()`, which fails a name that is not listed here, and
// `renderer-screenshots-gate.test.js` asserts the committed PNGs are exactly
// this list across both themes — neither a stranded file nor a missing one.
// Renaming a surface is therefore one edit here plus the renamed baselines;
// deleting one is an edit here plus `git rm`.

const THEMES = ['dark', 'light'];

// Kept in sync with `playwright.config.js`'s `snapshotPathTemplate`, which the
// gate test pins — a template pointed somewhere else would leave the check
// reading an empty directory and passing forever.
const SCREENSHOT_DIR = 'test-e2e/__screenshots__';

const BASELINES = [
  // chrome surfaces
  '01-landing',
  '02-nodes-menu',
  '03-app-menu',
  '04-find-bar',
  '05-find-bar-no-match',
  '06-permission-prompt',
  '07-permission-indicator-open',
  '08-download-shelf',
  '09-tab-context-menu',
  '10-tab-pinned-muted',
  '11-sidebar-default',
  // wallet screens
  '12-send-form',
  '13-send-review',
  '14-send-pending',
  '15-send-success',
  '16-dapp-tx',
  '17-dapp-sign',
  '18-dapp-connect',
  '19-swarm-connect',
  '20-swarm-publish',
  '21-swarm-messaging',
  '22-swarm-feed',
  '23-dapp-permissions',
  // back on chrome
  '24-onchain-trust-popover',
  // internal pages and interstitials
  '25-tez-unverified',
  '26-tez-conflict',
  '27-error-page',
  // settings sections
  '30-settings-appearance',
  '31-settings-search',
  '32-settings-profile',
  '33-settings-nodes',
  '34-settings-startup',
  '35-settings-downloads',
  '36-settings-shortcuts',
  '37-settings-chains',
  '38-settings-rpc',
  '39-settings-ens',
  '40-settings-adblock',
  '41-settings-permissions',
  '42-settings-experimental',
  '43-settings-updates',
  '45-settings-shortcut-conflict',
  // internal pages, continued
  '49-page-home',
  '50-page-downloads',
  '51-page-history',
  '52-page-profiles',
  '53-page-payments',
  // private window
  '60-private-window',
  '61-private-sidebar',
];

/** Every file the surfaces above are committed as, both themes. */
const baselineFiles = () =>
  THEMES.flatMap((theme) => BASELINES.map((name) => `${theme}-${name}.png`));

module.exports = { THEMES, SCREENSHOT_DIR, BASELINES, baselineFiles };
