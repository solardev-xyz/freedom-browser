'use strict';

const { isChromeIndexUrl } = require('../ipc-sender-policy');

// A grant exists only between an explicit dictation start and stop. It is not
// a site permission, and never applies to a guest or a chrome subframe.
const captures = new Map();

function grantDictationCapture(sender, id) {
  captures.set(sender, id);
}

function revokeDictationCapture(sender, id) {
  if (!id || captures.get(sender) === id) captures.delete(sender);
}

function permitsDictationCapture(sender, details = {}, checking = false) {
  if (!captures.has(sender) || sender.isDestroyed?.() || sender.getType?.() !== 'window' ||
      !isChromeIndexUrl(sender.getURL?.()) || details.isMainFrame === false ||
      (details.requestingUrl && !isChromeIndexUrl(details.requestingUrl))) return false;
  if (checking) return !details.mediaType || details.mediaType === 'audio';
  return Array.isArray(details.mediaTypes) && details.mediaTypes.length === 1 && details.mediaTypes[0] === 'audio';
}

module.exports = { grantDictationCapture, revokeDictationCapture, permitsDictationCapture };
