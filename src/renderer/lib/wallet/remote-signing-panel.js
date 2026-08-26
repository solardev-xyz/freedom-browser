/**
 * Remote-signing QR panel.
 *
 * When main asks a phone account to sign (dapp tx/sign, manual send,
 * x402 payment), the session broker starts a job and emits lifecycle
 * events; this panel renders them: QR code to scan, connection status,
 * cancel, and a fresh-QR retry. It overlays whichever approval screen
 * triggered the signature — by that point the user has already
 * confirmed the request there.
 *
 * Connect-phone discovery jobs (kind 'connect') have their own screen
 * and are ignored here.
 */

import { getRemoteSessionBroker, PHASE_STATUS_TEXT } from './remote-session.js';
import { generateScannableQr } from './wallet-utils.js';

// DOM references
let panel;
let requestLabel;
let qrImage;
let statusText;
let newCodeBtn;
let cancelBtn;

let activeJobId = null;

const REQUEST_LABELS = {
  personal_sign: 'A site asks you to sign a message.',
  eth_signTypedData_v4: 'A site asks you to sign structured data.',
  eth_sendTransaction: 'Approve and send the transaction from your phone.',
};

const CLOSING_PHASES = new Set(['done', 'cancelled', 'aborted', 'error']);

export function initRemoteSigningPanel() {
  panel = document.getElementById('sidebar-remote-signing');
  requestLabel = document.getElementById('remote-signing-request-label');
  qrImage = document.getElementById('remote-signing-qr-image');
  statusText = document.getElementById('remote-signing-status-text');
  newCodeBtn = document.getElementById('remote-signing-new-code');
  cancelBtn = document.getElementById('remote-signing-cancel');

  cancelBtn?.addEventListener('click', () => {
    if (activeJobId) getRemoteSessionBroker()?.cancelJob(activeJobId);
  });
  newCodeBtn?.addEventListener('click', () => {
    if (!activeJobId) return;
    setStatus('Preparing a new code…');
    if (qrImage) qrImage.src = '';
    getRemoteSessionBroker()?.retryJob(activeJobId);
  });

  getRemoteSessionBroker()?.onJobEvent(handleJobEvent);
}

function handleJobEvent(event) {
  // Discovery jobs render in the connect-phone screen, not here.
  if (event.kind !== 'signing') return;

  if (event.jobId === activeJobId && CLOSING_PHASES.has(event.phase)) {
    hidePanel();
    return;
  }

  if (event.phase === 'qr') {
    activeJobId = event.jobId;
    showPanel(event);
    renderQr(event.bridgeUrl);
    return;
  }

  if (event.jobId === activeJobId && PHASE_STATUS_TEXT[event.phase]) {
    setStatus(PHASE_STATUS_TEXT[event.phase]);
  }
}

function showPanel(event) {
  if (requestLabel) {
    requestLabel.textContent = REQUEST_LABELS[event.method] || 'Signature request';
  }
  setStatus('Waiting for your phone…');
  // Machine-readable copy of what the QR encodes (E2E tests scan this
  // instead of the pixels; a human can copy it via devtools too).
  if (panel) panel.dataset.bridgeUrl = event.bridgeUrl;
  panel?.classList.remove('hidden');
}

function hidePanel() {
  activeJobId = null;
  if (panel) delete panel.dataset.bridgeUrl;
  renderSeq++; // in-flight QR renders must not repopulate a hidden panel
  if (qrImage) qrImage.src = '';
  panel?.classList.add('hidden');
}

// Retries reuse the jobId, so QR renders are sequenced separately: only
// the latest render may touch the image — an earlier generateQR IPC
// resolving late must not overwrite a live code with a dead session's.
let renderSeq = 0;

async function renderQr(bridgeUrl) {
  const seq = ++renderSeq;
  const result = await generateScannableQr(bridgeUrl);
  if (seq !== renderSeq) return;
  if (result.success && qrImage) {
    qrImage.src = result.dataUrl;
  }
}

function setStatus(message) {
  if (statusText) statusText.textContent = message;
}
