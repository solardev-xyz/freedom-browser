'use strict';

// Custody outlives a model turn, Stop, and AI runtime disposal. Weak ownership
// disappears with the actual guest, or when the user explicitly takes control.
const agentPages = new WeakSet();
const custodyVersions = new WeakMap();
let nextCustodyVersion = 0;
// A guest the automation runtime may be creating for the Agent. Its first
// navigation starts at attach, well before the Agent's custody claim lands
// (creation resolves only after the first commit), so until custody is
// decided either way it is not a user page: it never pays from an x402 cap
// and a Swarm/Radicle auto-approve rule does not answer for it (refused like
// an Agent page). User navigation is not blocked: isAgentPage stays false.
const undecidedPages = new WeakSet();
function setAgentPageCustody(contents, owned) {
  if (!contents || typeof contents !== 'object') return;
  undecidedPages.delete(contents);
  if (Boolean(owned) !== agentPages.has(contents))
    custodyVersions.set(contents, ++nextCustodyVersion);
  if (owned) agentPages.add(contents);
  else agentPages.delete(contents);
}
const isAgentPage = contents => Boolean(contents && agentPages.has(contents));
function setPageCustodyUndecided(contents, undecided) {
  if (!contents || typeof contents !== 'object') return;
  if (undecided) undecidedPages.add(contents);
  else undecidedPages.delete(contents);
}
const isUndecided = (contents) => undecidedPages.has(contents);

function guestForId(webContentsId) {
  if (!Number.isInteger(webContentsId) || webContentsId < 0) return null;
  try {
    return require('electron').webContents?.fromId?.(webContentsId) || null;
  } catch {
    return null;
  }
}

// Main's own custody reading for a page request named by guest id.
const isAgentPageId = webContentsId => isAgentPage(guestForId(webContentsId));

// An automatic payment belongs to one uninterrupted period of user custody.
// A user -> Agent -> user round trip, or a replacement guest, invalidates it.
function userPageCustodyVersion(webContentsId) {
  const contents = guestForId(webContentsId);
  if (!contents || contents.isDestroyed?.() || isAgentPage(contents) || isUndecided(contents))
    return null;
  if (!custodyVersions.has(contents)) custodyVersions.set(contents, ++nextCustodyVersion);
  return custodyVersions.get(contents);
}
function hasUserPageCustodyVersion(webContentsId, version) {
  return Number.isSafeInteger(version) && version === userPageCustodyVersion(webContentsId);
}

// A site's auto-approve rule may answer only for a live guest of the chrome
// window that relayed the request, and never for one in Agent custody. An
// unattributable request is refused like an Agent one.
function autoApproveRefused(sender, webContentsId) {
  const contents = guestForId(webContentsId);
  if (!contents || contents.isDestroyed?.() || isAgentPage(contents) || isUndecided(contents))
    return true;
  return !Number.isInteger(sender?.id) || contents.hostWebContents?.id !== sender.id;
}

module.exports = {
  setAgentPageCustody,
  setPageCustodyUndecided,
  isAgentPage,
  isAgentPageId,
  userPageCustodyVersion,
  hasUserPageCustodyVersion,
  autoApproveRefused,
};
