/**
 * Popup blocker for tab webviews (#442).
 *
 * Chrome's popup blocker (`blocked_content::MaybeBlockPopup`) lives in the
 * `chrome/` layer, which Electron does not ship, so without this every
 * `window.open(...)` and every scripted `target="_blank"` activation became a
 * tab. The rule is Chrome's:
 *
 *   internal page (renderer/pages/*)  → allowed, no gesture needed (Freedom's
 *                                       own pages keep their behaviour)
 *   site holds the "popups" allow     → allowed ("Always allow pop-ups on
 *                                       this site", a site permission)
 *   user gesture in the last 5 s      → allowed once: the gesture is consumed,
 *                                       so one click opens one popup
 *   anything else                     → blocked, and the owning window is
 *                                       told so it can show the address-bar
 *                                       "Pop-up blocked" icon for that tab
 *
 * The gesture is the per-guest input tracking external-protocol.js keeps
 * (`trackUserGestures` / `consumeUserGesture`): Electron does not expose
 * Chromium's user-activation bit to the window-open handler, so trusted
 * input on the guest stands in for it. It is one budget shared with
 * external-protocol launches, as Chromium's single transient activation is.
 * It is cleared when a new document commits in the tab's top frame, as
 * Chromium's activation does not survive a cross-document navigation.
 *
 * Known gap — the budget is per tab, not per frame. Chromium's activation
 * is per frame: a click on the host page activates the host (and its
 * ancestors), not an embedded cross-origin iframe, so Chrome blocks an ad
 * iframe's `window.open` the user never clicked in. Here any frame of the
 * tab may spend the tab's gesture, so for 5 s after input anywhere on the
 * page an unclicked iframe can open one popup (still only one: it consumes
 * the gesture). Closing it needs the frame of both the input and the open,
 * and Electron 44 reports neither: `input-event` carries no frame, and the
 * window-open handler's details are url/frameName/features/disposition/
 * referrer/postBody only — the referrer can't stand in, since a frame can
 * suppress it (`referrerpolicy="no-referrer"`) exactly like a legitimate
 * `rel=noreferrer` link on the top page.
 *
 * Two callers ask:
 *
 *   - webcontents-setup.js's `setWindowOpenHandler`, for everything Chromium
 *     routes there (http(s), bzz:, `window.open` to any URL);
 *   - webview-preload.js, over `popups:claim`, for the `ipfs:`/`ipns:`/
 *     `web3:` links it intercepts itself before Chromium sees them (#443).
 *     It used to keep its own activation budget; asking here instead means
 *     one notion of a gesture and one consumption, so a click that opened a
 *     dweb tab cannot also pay for a `window.open`, or the other way round.
 *
 * Chrome- and main-initiated tab opens (menus, the context menu, internal
 * pages' own IPC) never reach either path and are unaffected.
 */

const { ipcMain } = require('electron');
const log = require('./logger');
const IPC = require('../shared/ipc-channels');
const { consumeUserGesture } = require('./external-protocol');
const {
  getEffectiveDecision,
  siteOriginForWebContents,
  allowSitePermission,
} = require('./permissions/permissions-manager');
const { getPartitionForWebContents } = require('./private/private-windows');
const { internalPageFileForUrl } = require('./ipc-sender-policy');

// Storage key of the per-site allow in the permissions store.
const POPUPS_PERMISSION_KEY = 'popups';

// What the preload may ask to open: the schemes `getHostRoutedHref` routes
// to the host (dweb links, plus everything an onchain `web3:` document's
// links may reach). Anything else is not a link the preload intercepts.
const CLAIMABLE_URL = /^(?:ipfs|ipns|web3|bzz|https?|rad|ens|freedom|ethereum):/i;
const MAX_URL_LENGTH = 8192;
const MAX_TARGET_NAME_LENGTH = 256;

function isInternalPageContents(contents) {
  try {
    return !!internalPageFileForUrl(contents.getURL());
  } catch {
    return false;
  }
}

/**
 * May `contents` open a popup (a new tab or window) now? Consumes the
 * guest's gesture when that is what allows it.
 *
 * @param {Electron.WebContents} contents - the requesting tab guest
 * @param {{ now?: number }} [options]
 * @returns {{ allowed: boolean,
 *             reason: 'internal-page'|'site-allowed'|'gesture'|'no-gesture',
 *             origin: string|null }}
 */
function claimPopup(contents, { now = Date.now() } = {}) {
  if (!contents) return { allowed: false, reason: 'no-gesture', origin: null };
  if (isInternalPageContents(contents)) {
    return { allowed: true, reason: 'internal-page', origin: null };
  }

  let origin;
  try {
    origin = siteOriginForWebContents(contents);
  } catch {
    origin = null;
  }

  // The site allow is checked before the gesture, so an allowed site does
  // not spend the gesture an external-app launch could still use. It is read
  // in the guest's own scope: a private window's partition tier, the normal
  // profile otherwise. If the scope can't be determined, the allow is not
  // consulted (the gesture rule still applies).
  if (origin) {
    let partition;
    let scopeKnown = true;
    try {
      partition = getPartitionForWebContents(contents) || null;
    } catch {
      scopeKnown = false;
    }
    if (scopeKnown && getEffectiveDecision(origin, POPUPS_PERMISSION_KEY, partition) === 'allow') {
      return { allowed: true, reason: 'site-allowed', origin };
    }
  }

  if (consumeUserGesture(contents, now)) {
    return { allowed: true, reason: 'gesture', origin };
  }
  return { allowed: false, reason: 'no-gesture', origin };
}

/**
 * Tell the chrome window hosting `contents` that a popup was blocked, so it
 * can show the "Pop-up blocked" icon for that tab. Nothing is logged here:
 * the URL of a private tab's popup must not reach the persistent log.
 *
 * `reuseOnly` marks a plain named-target open (`target="viewer"`,
 * `window.open(url, 'viewer')`): Chrome lets that navigate a tab that
 * already carries the name without a gesture, so the renderer tries that
 * first and only records a blocked popup when no such tab exists.
 *
 * @returns {boolean} whether a window was told
 */
function reportBlockedPopup(
  contents,
  { url, targetName = null, reuseOnly = false, origin = null }
) {
  let host;
  try {
    host = contents?.hostWebContents;
    if (!host || host.isDestroyed?.()) return false;
    host.send(IPC.POPUPS_BLOCKED, {
      guestId: contents.id,
      url,
      targetName: targetName || null,
      reuseOnly: reuseOnly === true,
      origin: origin || null,
    });
    return true;
  } catch {
    // The host window is tearing down.
    return false;
  }
}

function registerPopupBlockerIpc() {
  // webview-preload.js asks before it opens a new tab for a dweb link it
  // intercepted (see the file header). Answers true when it may; when it
  // may not, the blocked popup is reported to the owning window here, so the
  // preload does nothing further.
  ipcMain.handle(IPC.POPUPS_CLAIM, (event, request) => {
    const contents = event?.sender;
    try {
      if (contents?.getType?.() !== 'webview') return false;
      // The preload only intercepts links in the tab's top frame.
      if (event.senderFrame !== contents.mainFrame) return false;
    } catch {
      return false;
    }
    const url = typeof request?.url === 'string' ? request.url : '';
    if (!url || url.length > MAX_URL_LENGTH || !CLAIMABLE_URL.test(url)) return false;
    const rawTarget = typeof request?.targetName === 'string' ? request.targetName : '';
    const targetName =
      rawTarget && !rawTarget.startsWith('_') && rawTarget.length <= MAX_TARGET_NAME_LENGTH
        ? rawTarget
        : null;

    const verdict = claimPopup(contents);
    if (verdict.allowed) return true;
    log.info('[popup-blocker] blocked a dweb-link popup opened without a user gesture');
    reportBlockedPopup(contents, {
      url,
      targetName,
      reuseOnly: request?.reuseOnly === true && !!targetName,
      origin: verdict.origin,
    });
    return false;
  });

  // The address-bar icon's "Always allow pop-ups on this site". Chrome only:
  // the channel has no tier for webviews in ipc-sender-policy.js. The scope
  // is the asking window's — a private window's allow lives and dies with
  // its partition — resolved from the sender, never from the renderer.
  ipcMain.handle(IPC.POPUPS_ALLOW_SITE, (event, origin) => {
    let privatePartition;
    try {
      privatePartition = getPartitionForWebContents(event?.sender) || null;
    } catch {
      // Privacy unknown: refuse rather than persist a private window's allow.
      return false;
    }
    return allowSitePermission(origin, POPUPS_PERMISSION_KEY, { privatePartition });
  });
}

module.exports = {
  POPUPS_PERMISSION_KEY,
  claimPopup,
  reportBlockedPopup,
  registerPopupBlockerIpc,
};
