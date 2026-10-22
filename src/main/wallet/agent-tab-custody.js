'use strict';

// Custody outlives a model turn, Stop, and AI runtime disposal. Weak ownership
// disappears with the actual guest, or when the user explicitly takes control.
const agentPages = new WeakSet();
function setAgentPageCustody(contents, owned) {
  if (!contents || typeof contents !== 'object') return;
  if (owned) agentPages.add(contents);
  else agentPages.delete(contents);
}
const isAgentPage = contents => Boolean(contents && agentPages.has(contents));

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

// A site's auto-approve rule may answer only for a live guest of the chrome
// window that relayed the request, and never for one in Agent custody. An
// unattributable request is refused like an Agent one.
function autoApproveRefused(sender, webContentsId) {
  const contents = guestForId(webContentsId);
  if (!contents || contents.isDestroyed?.() || isAgentPage(contents)) return true;
  return !Number.isInteger(sender?.id) || contents.hostWebContents?.id !== sender.id;
}

module.exports = { setAgentPageCustody, isAgentPage, isAgentPageId, autoApproveRefused };
