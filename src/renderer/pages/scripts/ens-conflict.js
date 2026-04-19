const params = new URLSearchParams(window.location.search);
const name = params.get('name') || '';
const blockJson = params.get('block');
const groupsJson = params.get('groups');

document.getElementById('name-el').textContent = name;

let block = null;
try {
  block = blockJson ? JSON.parse(blockJson) : null;
} catch (err) {
  console.warn('[ens-conflict] failed to parse block payload', err);
}
if (block && block.number) {
  const short = block.hash ? block.hash.slice(0, 10) + '…' + block.hash.slice(-4) : '';
  document.getElementById('block-el').textContent =
    `at block #${block.number}${short ? '  ' + short : ''}`;
}

let groups = [];
try {
  groups = groupsJson ? JSON.parse(groupsJson) : [];
} catch (err) {
  console.warn('[ens-conflict] failed to parse groups payload', err);
}

// Show raw content-hash bytes (truncated) for display only. The renderer
// shell owns the canonical decoding path; a second decoder here would
// drift out of sync and the strict CSP blocks the base58 library anyway.
function preview(hex) {
  if (!hex || hex === '0x') return '(empty)';
  const h = String(hex).toLowerCase();
  // Swarm manifest is the one codec we can render verbatim — the tail IS
  // the canonical bzz:// hash and fits on a line.
  const swarm = h.match(/^0xe40101fa011b20([0-9a-f]{64})$/);
  if (swarm) return 'bzz://' + swarm[1];
  if (h.length > 28) return h.slice(0, 16) + '…' + h.slice(-10);
  return h;
}

const groupsEl = document.getElementById('groups-el');
for (const g of groups) {
  const valueText = g.reason
    ? `(${g.reason}) — no content hash returned`
    : preview(g.resolvedData);

  const groupDiv = document.createElement('div');
  groupDiv.className = 'group';
  const hostsDiv = document.createElement('div');
  hostsDiv.className = 'group-hosts';
  hostsDiv.textContent = (g.urls || []).join(', ');
  const valueDiv = document.createElement('div');
  valueDiv.className = 'group-value' + (g.reason ? ' group-reason' : '');
  valueDiv.textContent = valueText;
  groupDiv.appendChild(hostsDiv);
  groupDiv.appendChild(valueDiv);
  groupsEl.appendChild(groupDiv);
}

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
