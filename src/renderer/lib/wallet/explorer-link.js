/**
 * Wallet "View on explorer" links open in a tab, never a popup: the chrome
 * window denies every window open of its own (docs/security-audit-electron.md,
 * E-2), so a bare target="_blank" anchor in the sidebar would do nothing.
 *
 * Handles both activation gestures a link gets — a primary `click` and a
 * middle-button `auxclick` (which never arrives as `click`) — with the same
 * dispositions as a page link: plain click → foreground tab; Ctrl/Cmd+click
 * or middle-click → background tab; adding Shift brings it to the front.
 *
 * @param {Element|null|undefined} anchor
 * @param {() => string|null|undefined} getUrl - the URL at activation time
 * @param {(url: string, options: { background: boolean }) => void} openTab
 */
export function bindExplorerLink(anchor, getUrl, openTab) {
  if (!anchor) return;
  const activate = (event, middle) => {
    event.preventDefault();
    const url = getUrl();
    if (!url || url === '#') return;
    const modified = middle || !!event.ctrlKey || !!event.metaKey;
    openTab(url, { background: modified && !event.shiftKey });
  };
  anchor.addEventListener('click', (event) => activate(event, false));
  anchor.addEventListener('auxclick', (event) => {
    if (event.button !== 1) return;
    activate(event, true);
  });
}
