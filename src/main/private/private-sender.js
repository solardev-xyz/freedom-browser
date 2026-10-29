/**
 * Fail-closed private-window check for an IPC sender (R-9).
 *
 * Handlers that leave lasting state behind (Radicle seeding policies,
 * fetched repositories, signed COB writes, provider grants) refuse a
 * private window's sender. A sender main cannot classify as a known public
 * window counts as private: none at all, a destroyed one, one whose host is
 * destroyed, one with no window main can find, or one whose lookup throws.
 * The classification is private-windows.js classifyWebContents.
 */

const { classifyWebContents } = require('./private-windows');

/**
 * @param {Electron.IpcMainInvokeEvent|null|undefined} event
 * @returns {boolean} true unless the sender is a known public window's
 */
function isPrivateSender(event) {
  return classifyWebContents(event?.sender) !== 'public';
}

module.exports = { isPrivateSender };
