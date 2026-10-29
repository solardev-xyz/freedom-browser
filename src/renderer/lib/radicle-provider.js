/**
 * Radicle Provider Handler (Renderer Side)
 *
 * Routes window.radicle requests from webviews through consent UX and
 * forwards them to the main-process authority (radicle-provider-ipc.js).
 * Mirrors swarm-provider.js.
 *
 * webview (window.radicle) → renderer (this) → main (the authority)
 */

import { getPermissionKey } from './dapp-provider.js';
import { getDisplayUrlForWebview, isTabAgentOwned } from './tabs.js';
import { trackGuestMainFrame, isFromGuestMainFrame } from './guest-main-frame.js';
import {
  showRadicleConnect,
  showRadicleSeedApproval,
  showRadicleUnseedApproval,
  showRadicleSigningApproval,
  showRadicleSignedWriteApproval,
  dismissRadicleConsent,
} from './radicle-consent.js';

const ERRORS = {
  UNAUTHORIZED: { code: 4100, message: 'Origin not authorized' },
  INTERNAL_ERROR: { code: -32603, message: 'Internal error' },
  NAVIGATED: { code: 4900, message: 'Document navigated away before the request completed' },
};

// Node-tier methods that mutate the user's seeding policy for one repo.
// Each takes a per-repo consent prompt (unless auto-approve is on).
const NODE_METHODS = new Set(['radicle_seed', 'radicle_unseed']);

// Signing-tier methods that sign and publish with the user's node identity
// (radicle_getIdentity only discloses it).
const SIGNED_WRITE_METHODS = new Set([
  'radicle_createIssue',
  'radicle_commentIssue',
  'radicle_editIssueState',
  'radicle_commentPatch',
]);

const SIGNING_METHODS = new Set(['radicle_getIdentity', ...SIGNED_WRITE_METHODS]);

// Per-webview navigation generation, bumped on every committed navigation
// and on webview destruction. Requests capture the generation on arrival;
// consent, grants, execution, and response delivery are all bound to it, so
// approvals granted while a prompt was open can never apply to a replacement
// document, and responses (whose ids a new document could reuse) are never
// delivered into a document that didn't make the request.
const navigationGenerations = new WeakMap();
const providerWebviews = new Set();

const getNavigationGeneration = (webview) => navigationGenerations.get(webview) ?? 0;

/** Called from tabs.js when creating a webview. */
export function setupRadicleProvider(webview) {
  if (!webview) return;
  providerWebviews.add(webview);

  trackGuestMainFrame(webview);
  webview.addEventListener('ipc-message', (event) => {
    if (event.channel === 'radicle:provider-request') {
      // Top frame only — see guest-main-frame.js (audit O-6).
      if (!isFromGuestMainFrame(webview, event)) return;
      handleRadicleRequest(webview, event.args[0]);
    }
  });

  const invalidateDocument = () => {
    navigationGenerations.set(webview, getNavigationGeneration(webview) + 1);
    // A consent prompt opened for the replaced (or closed) document is moot;
    // leaving it up would let the user approve on behalf of a page that no
    // longer exists.
    dismissRadicleConsent(webview);
  };
  webview.addEventListener('did-navigate', invalidateDocument);
  webview.addEventListener('destroyed', () => {
    providerWebviews.delete(webview);
    invalidateDocument();
  });
}

window.radicleProvider?.onEvent?.(({ event, origin, data }) => {
  for (const webview of providerWebviews) {
    if (getPermissionKey(getDisplayUrlForWebview(webview)) === origin) {
      sendRadicleEvent(webview, event, data);
    }
  }
});

async function handleRadicleRequest(webview, request) {
  const { id, method, params } = request;

  const displayUrl = getDisplayUrlForWebview(webview);
  const permissionKey = getPermissionKey(displayUrl);
  const generation = getNavigationGeneration(webview);
  // Throws if the webview committed a navigation (or was destroyed) after
  // this request arrived. Checked after every consent prompt and before
  // every grant/forward so nothing executes on behalf of a stale document.
  const assertSameDocument = () => {
    if (getNavigationGeneration(webview) !== generation) {
      throw { ...ERRORS.NAVIGATED };
    }
  };

  try {
    let result;

    if (method === 'radicle_requestAccess') {
      result = await handleRequestAccess(webview, permissionKey, assertSameDocument);
    } else if (method === 'radicle_getCapabilities') {
      result = await forwardToMain(method, params, permissionKey);
    } else if (NODE_METHODS.has(method)) {
      // Node tier: both directions of the seeding policy are a per-repo
      // decision (see docs/radicle-provider-api.md, "Node actions").
      // Seeding commits disk and bandwidth; unseeding silently drops a
      // policy the user chose — and a connected origin can enumerate
      // targets through radicle_listSeededRepos — so neither may run off
      // the lightweight connection grant alone.
      // A tab in Agent custody is always prompted (as dapp-provider.js does
      // for wallet rules); main refuses an automatic one on its own custody
      // reading, so the request names its guest and the path it took.
      await requirePermission(permissionKey);
      const autoApproved =
        Boolean(await window.radiclePermissions.getAutoApprove(permissionKey, 'node')) &&
        isTabAgentOwned?.(Number(webview.dataset?.tabId)) !== true;
      if (!autoApproved) {
        const showApproval =
          method === 'radicle_seed' ? showRadicleSeedApproval : showRadicleUnseedApproval;
        await showApproval(permissionKey, params?.rid ?? '', webview);
      }
      assertSameDocument();
      result = await forwardToMain(method, params, permissionKey, {
        webContentsId: guestIdOf(webview),
        approval: autoApproved ? 'auto' : 'user',
      });
    } else if (SIGNING_METHODS.has(method)) {
      await requirePermission(permissionKey);
      const hasGrant = await window.radiclePermissions.hasSigningGrant(permissionKey);
      if (!hasGrant) {
        // One deliberate grant covers the tier — forge UX, like an OAuth
        // scope, not a per-comment prompt. The prompt copy says exactly that.
        await showRadicleSigningApproval(permissionKey, webview);
        assertSameDocument();
        await window.radiclePermissions.grantSigning(permissionKey);
      }
      assertSameDocument();
      if (!SIGNED_WRITE_METHODS.has(method)) {
        result = await forwardToMain(method, params, permissionKey);
      } else {
        result = await signedWrite(webview, method, params, permissionKey, assertSameDocument);
      }
    } else {
      // Remaining connection-tier methods: getNodeStatus, listSeededRepos,
      // sync, getSeedStatus, disconnect.
      await requirePermission(permissionKey);
      assertSameDocument();
      result = await forwardToMain(method, params, permissionKey);
      if (method === 'radicle_disconnect') {
        // Symmetric with the 'connect' event above. NOTE: if a chrome-side
        // revocation surface (permission-management UI) ever appears, the
        // event should move to main — the authority — so every revocation
        // path emits it, not just this request path.
        assertSameDocument();
        sendRadicleEvent(webview, 'disconnect', { origin: permissionKey });
      }
    }

    if (getNavigationGeneration(webview) !== generation) return;
    sendRadicleResponse(webview, id, result, null);
  } catch (error) {
    // Never deliver a stale response (success or error) into a replacement
    // document — request ids can be reused across navigations.
    if (getNavigationGeneration(webview) !== generation) return;
    sendRadicleResponse(webview, id, null, {
      code: error.code || ERRORS.INTERNAL_ERROR.code,
      message: error.message || ERRORS.INTERNAL_ERROR.message,
      data: error.data,
    });
  }
}

/**
 * One COB write (R-6). The grant lets a site ask; each write still needs
 * the user: its own prompt, showing the content, or the site's "always
 * allow writes" rule (autoApprove.signing), which the prompt's checkbox
 * sets. Main counts rule-answered writes per origin and refuses one past
 * its limit (`auto_write_limit`); that write falls back to the prompt. A
 * tab in Agent custody always prompts, and its prompt offers no rule.
 */
async function signedWrite(webview, method, params, permissionKey, assertSameDocument) {
  const meta = { webContentsId: guestIdOf(webview) };
  const agentHeld = isTabAgentOwned?.(Number(webview.dataset?.tabId)) === true;
  const ruleOn =
    !agentHeld && Boolean(await window.radiclePermissions.getAutoApprove(permissionKey, 'signing'));
  if (ruleOn) {
    assertSameDocument();
    try {
      return await forwardToMain(method, params, permissionKey, { ...meta, approval: 'auto' });
    } catch (error) {
      if (error?.data?.reason !== 'auto_write_limit') throw error;
    }
  }
  const answer = await showRadicleSignedWriteApproval(permissionKey, method, params, webview, {
    agentHeld,
    alwaysAllow: ruleOn,
  });
  assertSameDocument();
  if (!agentHeld && typeof answer?.alwaysAllow === 'boolean' && answer.alwaysAllow !== ruleOn) {
    await window.radiclePermissions.setAutoApprove(permissionKey, 'signing', answer.alwaysAllow);
    assertSameDocument();
  }
  return forwardToMain(method, params, permissionKey, { ...meta, approval: 'user' });
}

async function handleRequestAccess(webview, permissionKey, assertSameDocument) {
  const existing = await window.radiclePermissions.getPermission(permissionKey);
  if (!existing) {
    await showRadicleConnect(permissionKey, webview);
    assertSameDocument();
    await window.radiclePermissions.grantPermission(permissionKey);
    assertSameDocument();
    sendRadicleEvent(webview, 'connect', { origin: permissionKey });
  }
  assertSameDocument();
  return forwardToMain('radicle_requestAccess', {}, permissionKey);
}

async function requirePermission(permissionKey) {
  const permission = await window.radiclePermissions.getPermission(permissionKey);
  if (!permission) {
    throw {
      ...ERRORS.UNAUTHORIZED,
      message: 'Origin not authorized. Call radicle_requestAccess first.',
    };
  }
}

function guestIdOf(webview) {
  try {
    return webview.getWebContentsId?.();
  } catch {
    return undefined;
  }
}

async function forwardToMain(method, params, permissionKey, meta) {
  const response = await (meta
    ? window.radicleProvider.execute(method, params, permissionKey, meta)
    : window.radicleProvider.execute(method, params, permissionKey));
  if (response.error) throw response.error;
  return response.result;
}

function sendRadicleResponse(webview, id, result, error) {
  if (webview && webview.send) {
    webview.send('radicle:provider-response', { id, result, error });
  }
}

export function sendRadicleEvent(webview, event, data) {
  if (webview && webview.send) {
    webview.send('radicle:provider-event', { event, data });
  }
}
