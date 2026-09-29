// Protocol test page: flip each media element's status line once it loads or
// fails. Wired here rather than through inline `onload`/`onerror` attributes
// so the page's CSP can keep `script-src 'self'` (no 'unsafe-inline').
function setStatus(media, ok) {
  const status = media.parentElement.querySelector('.status');
  if (!status) return;
  status.className = ok ? 'status success' : 'status error';
  status.textContent = ok ? '✓ Loaded successfully' : '✗ Failed to load';
}

document.querySelectorAll('[data-load-status]').forEach((media) => {
  const isVideo = media.tagName === 'VIDEO';
  media.addEventListener(isVideo ? 'loadeddata' : 'load', () => setStatus(media, true));
  media.addEventListener('error', () => setStatus(media, false));

  // This script runs after the elements are parsed, so a fast (cached or
  // immediately failing) load may already have settled before the
  // listeners above were attached — the inline attributes never had that
  // race. Settle those now from the element's own state.
  if (isVideo) {
    if (media.error) setStatus(media, false);
    else if (media.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) setStatus(media, true);
  } else if (media.complete) {
    setStatus(media, media.naturalWidth > 0);
  }
});
