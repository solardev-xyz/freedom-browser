/**
 * Guest main-frame attribution for `<webview>` `ipc-message` events.
 *
 * Provider requests (window.ethereum / window.swarm / window.radicle) reach
 * the chrome through `ipcRenderer.sendToHost`, and the chrome handles them
 * under the tab's top-level origin and its grants. The webview preload only
 * installs the providers in the top frame, but with
 * `nodeIntegrationInSubFrames` every sub-frame's renderer also has
 * `ipcRenderer.sendToHost`, so a compromised cross-origin iframe process can
 * forge a provider request that would otherwise be attributed to the top page
 * (security audit O-6, #433).
 *
 * Electron (checked against 44.4.5) hands the embedder
 * `ipc-message.frameId` as `[processId, routingId]` of the sending frame. It
 * exposes no "main frame id" property on the webview, but its
 * `did-frame-navigate` event carries `isMainFrame` together with
 * `frameProcessId`/`frameRoutingId` for every committed frame navigation. We
 * record the pair from the latest main-frame commit and accept a message only
 * when its `frameId` matches it exactly.
 *
 * Probed in real Electron 44.4.5 under Xvfb (2026-09-28): the main frame's
 * `did-frame-navigate` reaches the embedder before any `ipc-message` from
 * the new document, including one sent at preload time; the pair changes on
 * cross-process navigations, reloads and back/forward traversals, and is
 * re-reported on each; a sub-frame's pair (same- or cross-process) never
 * equals the main frame's. Before the first main-frame commit nothing is
 * accepted (fail closed).
 *
 * What this does not do: tell two documents of the main frame apart. The
 * pair names a frame, not a document, and Chromium may keep the same
 * RenderFrame (hence the same pair) across a same-process navigation, e.g.
 * a same-site one. A message the outgoing document sent that only reaches
 * the embedder after the new document's `did-frame-navigate` would then
 * still pass. That is no wider than before this guard (every message was
 * accepted then), and the sender is the tab's own previous top-level page
 * rather than an embedded frame. The providers' per-webview navigation
 * generation only covers the neighbouring case (a request that arrived
 * before the commit gets no answer after it); a late arrival is handled
 * under the new document. This guard exists to keep sub-frames out; it is
 * not a per-document identity.
 */

const mainFrames = new WeakMap();

/**
 * Start tracking the guest's main frame. Idempotent per webview, so each
 * provider bridge can call it from its own setup.
 */
export function trackGuestMainFrame(webview) {
  if (!webview || mainFrames.has(webview)) return;
  mainFrames.set(webview, null);
  webview.addEventListener('did-frame-navigate', (event) => {
    if (event?.isMainFrame !== true) return;
    mainFrames.set(webview, [event.frameProcessId, event.frameRoutingId]);
  });
}

/**
 * True only when the `ipc-message` event was sent by the guest's current
 * main frame.
 */
export function isFromGuestMainFrame(webview, event) {
  const mainFrame = mainFrames.get(webview);
  const frameId = event?.frameId;
  if (!mainFrame || !Array.isArray(frameId) || frameId.length !== 2) return false;
  const [processId, routingId] = frameId;
  return (
    Number.isInteger(processId) &&
    Number.isInteger(routingId) &&
    processId === mainFrame[0] &&
    routingId === mainFrame[1]
  );
}
