import { placePopoverAtPoint } from './popover-bounds.js';

let dismissPrivacy = () => {};
export const closeAgentPrivacy = () => dismissPrivacy();

const el = (tag, text, className) => {
  const node = document.createElement(tag);
  node.textContent = text;
  if (className) node.className = className;
  return node;
};
const isLocal = route => route.providerId === 'ollama' &&
  /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(route.origin);

// Outline symbols describe capabilities/settings, never a completed verification.
const PRIVACY_SYMBOLS = {
  device: '<rect x="4" y="3" width="16" height="12" rx="2"/><path d="M2 20h20M9 15v5m6-5v5"/>',
  server: '<rect x="3" y="3" width="18" height="7" rx="2"/><rect x="3" y="14" width="18" height="7" rx="2"/><path d="M7 6.5h.01M7 17.5h.01"/>',
  shield: '<path d="M12 3 3 7v5c0 5 9 9 9 9s9-4 9-9V7z"/>',
  lock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3"/>',
  'partial-lock': '<rect x="5" y="10" width="14" height="11" rx="2" stroke-dasharray="2 3"/><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3"/>',
  'no-retention': '<path d="M4 6v12c0 2 4 3 8 3 2 0 4-.3 5.5-1M20 14V6M4 12c0 2 4 3 8 3M3 3l18 18"/><path d="M8 3.4A20 20 0 0 1 12 3c4 0 8 1 8 3 0 1.2-1.5 2-4 2.6M4 6c0 1 1.2 1.8 3 2.3"/>',
  retention: '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 4 16 4 16 0V5M4 12c0 4 16 4 16 0"/>',
  policy: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M8 13h8M8 17h5"/>',
  external: '<circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><path d="M3 12h18"/>',
  unknown: '<circle cx="12" cy="12" r="9"/><path d="M9 9a3 3 0 0 1 6 0c0 2-3 2-3 4M12 17h.01"/>',
};

function modelPrivacySymbols(providerId, model, baseUrl, settings) {
  // Keep direct lab connections visually plain; marketplace routes still show
  // their own protections, regardless of which lab made the underlying model.
  if (['openai', 'openai-chatgpt', 'openai-codex', 'anthropic', 'anthropic-claude', 'meta', 'meta-subscription'].includes(providerId)) return [];
  const symbols = [];
  const add = (kind, label, detail) => symbols.push({ kind, label, detail });
  if (providerId === 'ollama') {
    const local = isLocal({ providerId, origin: baseUrl.replace(/\/v1\/?$/, '').replace(/\/$/, '') });
    add(local ? 'device' : 'server', local ? 'On this device' : 'Your model server',
      local ? 'Requests go to this device. The model server could still forward data elsewhere.' : 'Requests go to your configured Ollama server, which may be on another device.');
    return symbols;
  }
  if (providerId === 'openrouter') {
    const required = settings.requireZeroRetention !== false;
    add(required ? 'no-retention' : 'retention', required ? 'Zero retention required' : 'Zero retention not required',
      required ? 'Only zero-retention routes are allowed. Availability and price depend on eligible providers. This is a provider policy, not encryption.'
        : 'This chat does not require zero-retention routes. Your OpenRouter account may still enforce them.');
  }
  const hardware = model.attestation === true || model.privacy === 'tee';
  if (hardware) add('shield', 'Protected hardware advertised',
    'The provider offers hardware evidence. Checks run when used; this symbol does not mean the hardware has passed verification.');
  if (hardware && providerId === 'near-ai') add('lock', 'End-to-end encryption enabled',
    'Messages and tool contents are encrypted to a hardware-attested model key. Routing metadata remains visible; hardware health is checked when used.');
  else if (model.e2ee === true || model.privacy === 'e2ee') add('partial-lock', 'End-to-end encryption when supported',
    'Supported text requests are encrypted. Venice requests with tools, attachments, assistant history or non-streaming output fall back to HTTPS without E2EE.');
  if (!symbols.length) {
    if (model.privacy === 'external') add('external', 'External model provider', 'An external provider handles requests. No hardware or end-to-end encryption guarantees are established for this route.');
    else if (!model.privacy || model.privacy === 'unknown') add('unknown', 'Privacy not reported', 'Privacy capabilities are not reported. Refresh the catalog for current information.');
    else add('policy', model.privacy === 'private' ? 'Private by provider policy' : model.privacy === 'anonymized' ? 'Anonymization claimed' : 'Provider privacy policy',
      'Privacy relies on the provider’s policy. Message contents are not end-to-end encrypted or independently verified by Freedom.');
  }
  return symbols;
}

export function createModelPrivacySymbols(info) {
  const group = el('span', '', 'agent-model-privacy');
  for (const symbol of info.symbols) {
    const node = el('span', '', 'agent-model-privacy-symbol');
    node.dataset.privacy = symbol.kind;
    node.title = `${symbol.label}. ${symbol.detail}`;
    node.setAttribute('role', 'img');
    node.setAttribute('aria-label', node.title);
    // Static, local SVG paths only; catalog/provider strings never enter markup.
    node.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${PRIVACY_SYMBOLS[symbol.kind]}</svg>`;
    group.appendChild(node);
  }
  return group;
}

// Catalog capabilities describe what can be checked, never a passed check.
// In particular, a model name containing "e2ee" does not enable encryption.
export function modelPrivacyInfo(providerId, model = {}, baseUrl = '', settings = {}) {
  const symbols = modelPrivacySymbols(providerId, model, baseUrl, settings);
  let label = 'Provider policy';
  let detail = 'Privacy depends on the provider’s data policy; Freedom does not independently verify this model’s inference.';
  if (providerId === 'ollama') {
    const local = isLocal({ providerId, origin: baseUrl.replace(/\/v1\/?$/, '').replace(/\/$/, '') });
    return { symbols, label: local ? 'On this device' : 'Your Ollama server',
      detail: local ? 'Requests go to this device. Freedom cannot verify whether the model server forwards data elsewhere.'
        : 'Requests go to the configured Ollama server. This is not necessarily on this device.' };
  }
  const hardware = model.attestation === true || model.privacy === 'tee';
  if (hardware) {
    label = 'Protected hardware (claimed)';
    detail = 'The provider advertises hardware isolation. This is not proof of fully private inference.';
  } else if (model.privacy === 'private') {
    label = 'Private (provider claim)';
    detail = 'The provider labels this model private. This is a policy claim, not independently verified protection.';
  } else if (model.privacy === 'anonymized') {
    label = 'Anonymized (provider claim)';
    detail = 'The provider advertises anonymization; that does not establish that the model operator cannot read the content.';
  } else if (model.privacy === 'external') {
    label = 'External model provider';
    detail = 'Requests are handled by an external model provider. Freedom does not verify protected hardware for this route.';
  } else if (providerId === 'openrouter') {
    label = settings.requireZeroRetention === false ? 'Zero retention not required' : 'Zero retention required';
    detail = 'New chats require zero-retention routes by default. Change this in Conversation privacy. Availability and price depend on the eligible endpoints; this is a provider policy, not encryption.';
  } else if (!model.privacy || model.privacy === 'unknown') {
    label = 'Privacy not reported';
    detail = 'The catalog does not report this model’s privacy capabilities. Refresh the catalog for current information.';
  }
  if (hardware && providerId === 'near-ai') {
    label += ' · Connection + response checks';
    detail += ' When used, Freedom checks CPU evidence, the connection and available response signatures. Gateway signatures do not prove which model produced a response.';
  } else if (hardware && providerId === 'venice') {
    label += ' · Hardware check only';
    detail += ' Freedom checks CPU endpoint evidence, but cannot yet verify Venice’s exact request/response exchange.';
  }
  if (hardware && providerId === 'near-ai') {
    label += ' · E2EE enabled';
    detail += ' Freedom encrypts messages and tool contents to a hardware-attested model key. Routing metadata remains visible.';
  } else if (model.e2ee === true || model.privacy === 'e2ee') {
    label += ' · E2EE when supported';
    detail += ' Freedom encrypts supported text requests. Venice requests with tools, attachments, assistant history or non-streaming output use HTTPS without E2EE.';
  } else detail += ' End-to-end encryption is not available on this route.';
  if (hardware) detail += ' Hardware health is checked when used; GPU and approved server software are not yet verified.';
  return { label, detail, symbols };
}

export function privacyLabel(summary) {
  const routes = summary?.routes || [];
  if (routes.some(route => route.binding?.failed)) return 'Some verification checks failed';
  if (routes.some(route => route.hardware?.status === 'failed')) return 'Hardware evidence rejected';
  if (routes.some(route => route.hardware?.status === 'advisory')) return 'Hardware needs security updates';
  if (routes.some(route => route.hardware?.status === 'pending')) return 'Checking hardware evidence';
  if (routes.some(route => route.binding?.pending)) return 'Checking request evidence';
  if (routes.some(route => route.hardware?.status === 'unavailable')) return 'Hardware check unavailable';
  if (routes.some(route => route.hardware?.status === 'checked')) return 'Hardware checked; privacy not proven';
  if (summary?.earlierUnknown || summary?.omittedRequests) return 'Incomplete privacy history';
  if (routes.length && routes.every(isLocal)) return 'Local model endpoint';
  return routes.length ? 'Provider privacy claims' : 'Privacy coverage unknown';
}

export function createAgentPrivacy(button, panel, saveSettings = async () => {}) {
  if (!button || !panel) return { update() {}, close() {}, setProvider() {}, settings: () => ({ requireZeroRetention: true }), escape() { return false; } };
  let summary = null;
  let providerId = '';
  let settings = { requireZeroRetention: true };
  let saving = false;
  const close = () => {
    panel.hidden = true;
    panel.hidePopover?.();
    button.setAttribute('aria-expanded', 'false');
  };
  dismissPrivacy = close;
  const place = () => {
    const rect = button.getBoundingClientRect();
    placePopoverAtPoint(panel, Math.max(8, rect.right - 360), rect.bottom + 8);
  };
  const render = () => {
    const label = privacyLabel(summary);
    button.title = `Conversation privacy: ${label}`;
    button.setAttribute('aria-label', `Conversation privacy: ${label}`);
    button.dataset.state = summary?.routes?.some(route => route.binding?.failed || ['failed', 'advisory'].includes(route.hardware?.status)) ? 'advisory' : 'neutral';
    panel.replaceChildren(el('h3', 'Conversation privacy'), el('p', label, 'agent-privacy-status'));
    if (summary?.earlierUnknown || summary?.omittedRequests) {
      panel.append(el('p', 'Some earlier or additional requests have no retained privacy details.', 'agent-privacy-warning'));
    }
    const routes = summary?.routes || [];
    if (providerId === 'openrouter' || routes.some(r => r.providerId === 'openrouter')) {
      const label = el('label', '', 'agent-privacy-control');
      const input = document.createElement('input');
      input.type = 'checkbox'; input.checked = settings.requireZeroRetention; input.disabled = saving;
      input.addEventListener('change', async () => {
        saving = true; input.disabled = true;
        const next = { requireZeroRetention: input.checked };
        try {
          await saveSettings(next);
          settings = next;
        } catch {
          input.checked = settings.requireZeroRetention;
          panel.append(el('p', 'Could not save this privacy setting.', 'agent-privacy-warning'));
        } finally { saving = false; input.disabled = false; }
      });
      label.append(input, el('span', 'Require zero data retention'));
      panel.append(label, el('p', 'Applies to future requests in this chat. Eligible routes may have different prices or be unavailable. Your OpenRouter account may enforce this even when switched off.', 'agent-privacy-detail-note'));
    }
    const encrypted = routes.reduce((n, r) => n + (r.encryption?.encrypted || 0), 0);
    const attempts = routes.reduce((n, r) => n + r.requests, 0);
    const local = routes.length && routes.every(isLocal);
    panel.append(el('p', local ? 'Messages go to a model server on this device. Freedom cannot tell whether that server sends data elsewhere.'
      : encrypted ? `${encrypted} of ${attempts} requests encrypted their message contents to a hardware-attested model key. Routing metadata remains visible.`
        : 'End-to-end encryption is off. The provider may be able to read your messages.'));
    if (encrypted && encrypted < attempts) panel.append(el('p', 'Some requests were not end-to-end encrypted. The provider may have received conversation history in those requests.', 'agent-privacy-warning'));
    if (routes.some(route => route.origin?.startsWith('http:') && !isLocal(route))) {
      panel.append(el('p', 'Some requests used an unencrypted network connection.', 'agent-privacy-warning'));
    }
    const groups = new Map();
    for (const route of routes) {
      const key = JSON.stringify([route.providerId, route.modelId, route.origin]);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(route);
    }
    for (const group of groups.values()) {
      const route = group[0];
      const section = el('section', '', 'agent-privacy-route');
      const total = group.reduce((n, r) => n + r.requests, 0);
      const sum = key => group.reduce((n, r) => n + (r.binding?.[key] || 0), 0);
      const hardware = group.map(r => r.hardware).filter(Boolean);
      section.append(el('strong', route.modelId || 'Unknown model'),
        el('p', `${route.providerName || route.providerId || 'Unknown provider'} · ${total} request${total === 1 ? '' : 's'}`));
      const encryptedRequests = group.reduce((n, r) => n + (r.encryption?.encrypted || 0), 0);
      if (encryptedRequests) section.append(el('p', `${encryptedRequests} request${encryptedRequests === 1 ? '' : 's'} sent encrypted message contents.`));
      if (group.some(r => r.encryption?.failed || r.encryption?.blocked)) section.append(el('p', 'An encrypted request was blocked or did not complete successfully.', 'agent-privacy-warning'));
      const reasons = [...new Set(group.flatMap(r => r.encryption?.reasons || []))];
      if (reasons.length) {
        const names = { tools: 'tool use', attachments: 'attachments', history: 'assistant history', 'non-streaming': 'non-streaming output' };
        section.append(el('p', `Venice E2EE does not support ${reasons.map(r => names[r]).join(', ')}. Those requests used HTTPS without E2EE.`));
      }
      if (route.providerId === 'openrouter') {
        const required = group.filter(r => r.retention === 'required').reduce((n, r) => n + r.requests, 0);
        section.append(el('p', `${required} of ${total} requests required zero-retention routes.`));
      }
      if (sum('attempts')) {
        section.append(el('p', `${sum('connections')} of ${total} connections matched the hardware evidence.`));
        const signed = sum('gateway') + sum('model');
        section.append(el('p', `${signed} of ${total} responses have a checked signature.`));
        if (sum('gateway')) section.append(el('p', 'Gateway signatures confirm what the service sent back, not which model produced it.', 'agent-privacy-detail-note'));
        if (sum('model')) section.append(el('p', 'Model signatures match a hardware-attested signing key. The model software is not yet verified.', 'agent-privacy-detail-note'));
        if (sum('pending')) section.append(el('p', 'Checking this request…'));
        if (sum('failed')) section.append(el('p', 'Some connection or response evidence did not match.', 'agent-privacy-warning'));
      } else {
        section.append(el('p', 'Responses are not independently verified.'));
      }
      if (hardware.some(h => h.status === 'advisory')) section.append(el('p', 'Hardware needs security updates. This does not mean your messages were exposed.', 'agent-privacy-warning'));
      else if (hardware.some(h => h.status === 'failed')) section.append(el('p', 'Hardware evidence did not pass verification.', 'agent-privacy-warning'));
      else if (hardware.some(h => h.status === 'unavailable')) section.append(el('p', 'Hardware evidence could not be checked.'));
      else if (hardware.some(h => h.status === 'pending')) section.append(el('p', 'Checking hardware…'));
      const details = el('details', '');
      details.append(el('summary', 'Technical details'));
      const viaClaude = route.providerId === 'anthropic-claude';
      details.append(el('p', viaClaude ? 'Connection handled by installed Claude Code' : route.origin || 'Destination not recorded', 'agent-privacy-origin'));
      const encrypted = route.origin?.startsWith('https:');
      details.append(el('p', viaClaude ? 'Messages go to Anthropic through your Claude login. Freedom does not inspect the CLI’s network connection, retries or background context requests. Claude may keep its own diagnostics locally; Freedom stores this conversation in its history.' : encrypted ? 'HTTPS encrypts traffic to the service. It is not end-to-end encryption to the model.' : 'This endpoint does not use HTTPS.'));
      const claims = [...new Set(group.map(r => r.claim).filter(c => c && c !== 'unknown'))];
      if (claims.length) details.append(el('p', `Provider claims: ${claims.join(', ')}. These labels are not independent proof.`));
      if (route.providerId === 'openrouter') details.append(el('p', 'Zero retention is an endpoint policy enforced through routing, not a cryptographic guarantee. OpenRouter account-level prompt logging is controlled separately in your OpenRouter account.'));
      if (route.providerId === 'venice') details.append(el('p', 'Response verification through Venice is not supported yet. Its proxy receipts cannot currently be matched to the exact exchange seen by Freedom.'));
      for (const r of group) details.append(el('p', `${r.role === 'permission' ? 'Permission checks' : r.role === 'helper' ? 'Helpers' : 'Agent and context management'} · ${r.requests} request attempt${r.requests === 1 ? '' : 's'}`));
      const seen = new Set();
      for (const h of hardware) {
        const key = JSON.stringify(h);
        if (seen.has(key)) continue;
        seen.add(key);
        for (const [index, report] of (h.reports || []).entries()) {
          const name = route.providerId === 'near-ai' ? (index === 0 ? 'Gateway CPU' : `Model CPU ${index}`) : 'CPU';
          details.append(el('p', `${name}: ${report.tcb}${report.advisories?.length ? ` · ${report.advisories.join(', ')}` : ''}`));
        }
        if (h.checkedAt) details.append(el('p', `Hardware evidence checked ${new Date(h.checkedAt).toLocaleString()}. An endpoint check alone does not verify a request.`));
      }
      details.append(el('p', 'GPU evidence and approved server software are not verified. These checks do not establish fully private inference.'));
      section.append(details);
      panel.append(section);
    }
    const scope = el('details', '', 'agent-privacy-detail-note');
    scope.append(el('summary', 'What this covers'), el('p', 'Model requests, including helpers and permission checks. Browser actions and connected services can share data separately. Chat history and attachments are stored on this device.'),
      el('p', 'CPU checks obtain public Intel verification data through Phala. No chat content is sent there. Encryption requires an authenticated model key. Failed key checks block encrypted requests. Hardware update warnings remain visible.'));
    panel.append(scope);
    if (!panel.hidden) place();
  };
  button.addEventListener('click', () => {
    if (!panel.hidden) return close();
    panel.hidden = false;
    panel.showPopover?.();
    button.setAttribute('aria-expanded', 'true');
    render();
    panel.focus();
  });
  document.addEventListener('click', event => {
    if (!panel.hidden && !panel.contains(event.target) && !button.contains(event.target)) close();
  });
  // No menu backdrop: clicking the guest must dismiss these read-only details.
  window.addEventListener('blur', close);
  window.addEventListener('resize', close);
  return {
    close,
    settings: () => ({ ...settings }),
    setProvider(value) { providerId = value || ''; button.hidden = !summary && providerId !== 'openrouter'; },
    escape() { if (panel.hidden) return false; close(); button.focus(); return true; },
    update(value) {
      summary = value;
      settings = { requireZeroRetention: value?.settings?.requireZeroRetention !== false };
      button.hidden = !value && providerId !== 'openrouter';
      if (!value) close();
      render();
    },
  };
}
