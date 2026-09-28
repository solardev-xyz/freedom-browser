// Link-behaviour test page: the "JavaScript window.open()" buttons. Wired
// here rather than through inline `onclick` attributes so the page's CSP can
// keep `script-src 'self'` (no 'unsafe-inline'), like every internal page.
document.querySelectorAll('button[data-open-url]').forEach((button) => {
  button.addEventListener('click', () => {
    const { openUrl, openTarget, openFeatures } = button.dataset;
    if (openTarget === undefined) {
      window.open(openUrl);
    } else if (openFeatures === undefined) {
      window.open(openUrl, openTarget);
    } else {
      window.open(openUrl, openTarget, openFeatures);
    }
  });
});
