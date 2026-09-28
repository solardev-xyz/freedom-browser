/**
 * TLS client-certificate selection (docs/security-audit-electron.md, O-10).
 *
 * When a server asks for a client certificate, Electron's default is to send
 * the first matching one from the OS store without asking. That certificate
 * is a stable identifier: any site can ask for it and learn who the user is,
 * across sites and across private windows. This module takes the decision
 * away from that default:
 *
 *   private window (or privacy unknown)  → no certificate, never a prompt
 *   normal window                        → the user picks one, or none
 *   nothing to choose from / no window   → no certificate
 *
 * The chooser is a native message box listing the candidates, with "Don't
 * send a certificate" as both the default and the cancel answer, so Enter,
 * Esc and closing the box all send nothing. Chromium remembers the answer
 * for the host for the rest of the session, so it is asked once per host,
 * not once per request.
 */

const { app, BrowserWindow, dialog } = require('electron');
const log = require('./logger');
const { isPrivateWebContents } = require('./private/private-windows');

const DONT_SEND_LABEL = "Don't send a certificate";

// Fail closed: if privacy cannot be determined, treat the request as private.
// isPrivateWebContents() does NOT give that guarantee on its own: it swallows
// its own errors and answers `false` ("not private") when the webContents was
// torn down mid-check, since its session and window can no longer be read.
// So a missing or destroyed webContents is refused here explicitly, before
// the lookup, rather than relying on ownerWindowOf() happening to find no
// window later on. The try/catch covers a throw the lookup doesn't catch,
// the same way webcontents-setup.js's isPrivateSender does.
function isPrivate(webContents) {
  try {
    if (!webContents) return true;
    if (typeof webContents.isDestroyed === 'function' && webContents.isDestroyed()) return true;
    const host = webContents.hostWebContents;
    if (host && typeof host.isDestroyed === 'function' && host.isDestroyed()) return true;
    return isPrivateWebContents(webContents);
  } catch {
    return true;
  }
}

function hostOf(url) {
  try {
    return new URL(url).host || String(url);
  } catch {
    return String(url || 'this site');
  }
}

function formatExpiry(seconds) {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return null;
  try {
    return new Date(seconds * 1000).toISOString().slice(0, 10);
  } catch {
    return null;
  }
}

/** One chooser button per certificate: who it names, who issued it, expiry. */
function certificateLabel(certificate) {
  const subject = certificate?.subjectName || 'Unnamed certificate';
  const parts = [subject];
  if (certificate?.issuerName) parts.push(`issued by ${certificate.issuerName}`);
  const expiry = formatExpiry(certificate?.validExpiry);
  if (expiry) parts.push(`expires ${expiry}`);
  return parts.join(' · ');
}

function ownerWindowOf(webContents) {
  try {
    const host = webContents?.hostWebContents || webContents;
    const win = host ? BrowserWindow.fromWebContents(host) : null;
    return win && !win.isDestroyed() ? win : null;
  } catch {
    return null;
  }
}

/**
 * `app` 'select-client-certificate' listener. Always prevents Electron's
 * first-match default and always answers `callback` exactly once — with a
 * certificate the user picked, or with nothing (send no certificate).
 */
function handleSelectClientCertificate(event, webContents, url, list, callback) {
  event.preventDefault();

  let answered = false;
  const answer = (certificate) => {
    if (answered) return;
    answered = true;
    if (certificate) callback(certificate);
    else callback();
  };

  const certificates = Array.isArray(list) ? list.filter(Boolean) : [];

  // PRIVATE MODE GUARD (client certificates): a certificate identifies the
  // user; a private window must never send one, and must not even offer to
  // (one careless click would tie the private session to the identity).
  // Unknown privacy (a torn-down webContents) counts as private; see isPrivate.
  if (isPrivate(webContents)) {
    log.info('[client-cert] private window: no client certificate sent');
    answer();
    return;
  }

  const host = hostOf(url);
  if (certificates.length === 0) {
    answer();
    return;
  }

  const win = ownerWindowOf(webContents);
  if (!win) {
    log.info(`[client-cert] ${host}: no window to ask in, no certificate sent`);
    answer();
    return;
  }

  const buttons = [...certificates.map(certificateLabel), DONT_SEND_LABEL];
  const dontSendIndex = buttons.length - 1;

  let pending;
  try {
    pending = dialog.showMessageBox(win, {
      type: 'question',
      title: 'Select a certificate',
      message: `${host} is asking for a certificate`,
      detail:
        'Sending a certificate tells this site who you are. Choose one only if you ' +
        'trust this site and expected it to ask.',
      buttons,
      defaultId: dontSendIndex,
      cancelId: dontSendIndex,
      noLink: true,
    });
  } catch (err) {
    log.warn(`[client-cert] chooser failed: ${err?.message || err}`);
    answer();
    return;
  }

  Promise.resolve(pending)
    .then((result) => {
      const index = result?.response;
      const chosen =
        Number.isInteger(index) && index >= 0 && index < certificates.length
          ? certificates[index]
          : null;
      log.info(`[client-cert] ${host}: ${chosen ? 'certificate sent' : 'no certificate sent'}`);
      answer(chosen);
    })
    .catch((err) => {
      log.warn(`[client-cert] chooser failed: ${err?.message || err}`);
      answer();
    });
}

function registerClientCertificateHandler() {
  app.on('select-client-certificate', handleSelectClientCertificate);
}

module.exports = {
  registerClientCertificateHandler,
  handleSelectClientCertificate,
  certificateLabel,
  DONT_SEND_LABEL,
};
