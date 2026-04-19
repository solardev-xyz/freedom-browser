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

document.getElementById('back-btn').onclick = () => {
  if (window.history.length > 1) {
    window.history.back();
  } else {
    window.location.href = 'home.html';
  }
};

document.getElementById('settings-btn').onclick = () => {
  window.freedomAPI?.ensOpenSettings?.();
};
