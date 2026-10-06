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

export function createAgentPrivacy(button, panel) {
  if (!button || !panel) return { update() {}, close() {}, escape() { return false; } };
  let summary = null;
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
    const local = routes.length && routes.every(isLocal);
    panel.append(el('p', local ? 'Messages go to a model server on this device. Freedom cannot tell whether that server sends data elsewhere.'
      : 'End-to-end encryption is off. The provider may be able to read your messages.'));
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
        el('p', `${route.providerId || 'Unknown provider'} · ${total} request${total === 1 ? '' : 's'}`));
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
      details.append(el('p', route.origin || 'Destination not recorded', 'agent-privacy-origin'));
      const encrypted = route.origin?.startsWith('https:');
      details.append(el('p', encrypted ? 'HTTPS encrypts traffic to the service. It is not end-to-end encryption to the model.' : 'This endpoint does not use HTTPS.'));
      const claims = [...new Set(group.map(r => r.claim).filter(c => c && c !== 'unknown'))];
      if (claims.length) details.append(el('p', `Provider claims: ${claims.join(', ')}. These labels are not independent proof.`));
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
      el('p', 'CPU checks obtain public Intel verification data through Phala. No chat content is sent there. Checks report evidence; they do not block requests.'));
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
    escape() { if (panel.hidden) return false; close(); button.focus(); return true; },
    update(value) {
      summary = value;
      button.hidden = !value;
      if (!value) close();
      render();
    },
  };
}
