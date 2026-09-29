// Tag <html data-platform="…"> with the OS before first paint.
//
// Loaded as a classic, parser-blocking <script> from index.html's <head> so it
// runs before <body> is parsed — unlike index.js (a deferred module) or the
// async electronAPI.getPlatform() IPC, either of which could let the first
// frame paint with the wrong per-platform layout and then jump (e.g. the tab
// strip starting at 12px on macOS, then shifting right to clear the traffic
// lights). The preload can't set this itself: it runs before <html> exists.
document.documentElement.dataset.platform = window.electronAPI?.platform || '';
