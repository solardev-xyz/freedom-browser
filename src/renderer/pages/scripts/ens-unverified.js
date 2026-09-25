const params = new URLSearchParams(window.location.search);
const name = params.get('name') || '';
const uri = params.get('uri') || '';

document.getElementById('name-el').textContent = name;
document.getElementById('uri-el').textContent = uri;

const continueBtn = document.getElementById('continue-btn');
continueBtn.onclick = () => {
  // Guard against double-click: second activation is a no-op visually and
  // avoids firing a duplicate sendToHost that would trigger two loadTarget
  // calls on the shell side.
  continueBtn.disabled = true;
  window.freedomAPI?.ensContinueUnverified?.(name);
};

// Shell-driven traversal, not `window.history.back()`: see the comment on the
// same button in `ens-conflict.js` — a renderer-initiated hop back onto the
// blocked name is replayed through `loadTarget` and re-raises this page.
document.getElementById('back-btn').onclick = () => {
  window.freedomAPI?.interstitialGoBack?.();
};

document.getElementById('settings-btn').onclick = () => {
  window.freedomAPI?.ensOpenSettings?.();
};
