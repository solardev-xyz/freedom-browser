'use strict';

// A URL in free text, cut down to its origin. Its user info, path, query
// and fragment can carry a secret: a keyed RPC provider's URL has the
// user's API key in its path (#1040), and a browsing URL says where the
// user went. The diagnostics buffer the renderer reads and main's RPC
// errors (wallet/rpc-errors.js) both redact with this one rule.
const URL_IN_TEXT = /\b(?:https?|wss?|bzz|ipfs|ipns|rad|web3):\/\/[^\s"'<>]+/gi;

function redactUrls(text) {
  return String(text).replace(URL_IN_TEXT, (value) => {
    try {
      const url = new URL(value);
      return (url.origin === 'null' ? url.protocol : url.origin) + '/[path redacted]';
    } catch {
      return '[URL redacted]';
    }
  });
}

module.exports = { redactUrls };
