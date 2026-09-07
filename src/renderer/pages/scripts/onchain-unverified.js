const params = new URLSearchParams(window.location.search);
const target = params.get('target') || '';
const token = params.get('token') || '';
const network = params.get('network') || 'Unknown network';
const chain = params.get('chain') || '?';
const contract = params.get('contract') || 'Unknown contract';
const hash = params.get('hash') || 'Unknown';
const source = params.get('source') || 'Unknown RPC';
const dissented = params.get('dissented') || '';
const isConflict = params.get('conflict') === '1';

document.getElementById('network-el').textContent = `${network} (chain ${chain})`;
document.getElementById('contract-el').textContent = contract;
document.getElementById('source-el').textContent = source;
document.getElementById('hash-el').textContent = hash;

const continueBtn = document.getElementById('continue-btn');
const retryBtn = document.getElementById('retry-btn');

if (isConflict) {
  document.body.classList.remove('unverified');
  document.body.classList.add('conflict');
  document.title = 'RPC servers disagreed about this app';
  document.getElementById('heading-el').textContent = 'RPC servers disagreed about this app';
  document.getElementById('summary-el').textContent =
    'Public RPC endpoints returned different app code. Freedom blocked the load; no app code has run.';
  document.getElementById('learn-more-el').textContent =
    'Try again in case the endpoints were briefly at different chain heads, or configure an RPC you explicitly trust.';
  document.getElementById('dissented-el').textContent = dissented;
  document.querySelectorAll('.conflict-only').forEach((element) => {
    element.hidden = false;
  });
  continueBtn.hidden = true;
} else {
  retryBtn.hidden = true;
}

continueBtn.onclick = () => {
  continueBtn.disabled = true;
  window.freedomAPI?.onchainContinueUnverified?.({ target, token });
};

retryBtn.onclick = () => {
  retryBtn.disabled = true;
  window.freedomAPI?.onchainRetry?.(target);
};

document.getElementById('back-btn').onclick = () => {
  if (window.history.length > 1) {
    window.history.back();
  } else {
    window.location.href = 'home.html';
  }
};

document.getElementById('settings-btn').onclick = () => {
  window.freedomAPI?.onchainOpenRpcSettings?.();
};
