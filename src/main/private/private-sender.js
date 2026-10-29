/**
 * Fail-closed private-window check for an IPC sender (R-9).
 *
 * Handlers that leave lasting state behind (Radicle seeding policies and
 * fetched repositories, say) refuse a private window's sender. A sender
 * main cannot classify counts as private: none at all, a destroyed one, one
 * whose host is destroyed, or one whose check throws. This is the same
 * fail-closed reading client-certificate.js applies.
 */

const { isPrivateWebContents } = require('./private-windows');

/**
 * @param {Electron.IpcMainInvokeEvent|null|undefined} event
 * @returns {boolean} true when the sender is private or cannot be read
 */
function isPrivateSender(event) {
  try {
    const sender = event?.sender;
    if (!sender) return true;
    if (typeof sender.isDestroyed === 'function' && sender.isDestroyed()) return true;
    const host = sender.hostWebContents;
    if (host && typeof host.isDestroyed === 'function' && host.isDestroyed()) return true;
    return isPrivateWebContents(sender);
  } catch {
    return true;
  }
}

module.exports = { isPrivateSender };
