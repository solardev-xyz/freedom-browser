import { placePopoverAtPoint } from './popover-bounds.js';

let dismissPrivacy = () => {};
export const closeAgentPrivacy = () => dismissPrivacy();

const el = (tag, text, className) => {
  const node = document.createElement(tag);
  node.textContent = text;
  if (className) node.className = className;
  return node;
};

export function privacyLabel(summary) {
  const routes = summary?.routes || [];
  if (routes.some(route => route.hardware?.status === 'failed')) return 'Hardware evidence rejected';
  if (routes.some(route => route.hardware?.status === 'advisory')) return 'Hardware security advisories';
  if (routes.some(route => route.hardware?.status === 'pending')) return 'Checking hardware evidence';
  if (routes.some(route => route.hardware?.status === 'unavailable')) return 'Hardware check unavailable';
  if (routes.some(route => route.hardware?.status === 'checked')) return 'Hardware checked · partial coverage';
  if (summary?.earlierUnknown || summary?.omittedRequests) return 'Incomplete privacy history';
  if (routes.length && routes.every(route => route.providerId === 'ollama' &&
    /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(route.origin))) return 'Local model endpoint';
  return routes.length ? 'Provider privacy policy' : 'Privacy coverage unknown';
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
    button.dataset.state = summary?.routes?.some(route => ['failed', 'advisory'].includes(route.hardware?.status)) ? 'advisory' : 'neutral';
    panel.replaceChildren(el('h3', 'Conversation privacy'), el('p', label, 'agent-privacy-status'));
    if (summary?.earlierUnknown || summary?.omittedRequests) {
      panel.append(el('p', 'Some earlier or additional requests have no retained privacy details.', 'agent-privacy-warning'));
    }
    for (const route of summary?.routes || []) {
      const section = el('section', '', 'agent-privacy-route');
      section.append(el('strong', route.modelId || 'Unknown model'),
        el('p', `${route.providerId || 'Unknown provider'} · ${route.role === 'permission' ? 'Permission checks' : route.role === 'helper' ? 'Helpers' : 'Agent and context management'} · ${route.requests} request attempts`),
        el('p', route.origin || 'Destination not recorded', 'agent-privacy-origin'));
      if (route.claim && route.claim !== 'unknown') section.append(el('p', `Provider classification: ${route.claim.toUpperCase()} (provider claim)`));
      const hardware = route.hardware;
      if (hardware) {
        const message = { pending: 'Checking a fresh CPU attestation report…',
          checked: 'CPU quote signature, nonce and signing identity checked. Intel security status: up to date.',
          advisory: 'CPU evidence has security advisories. This does not meet an up-to-date hardware policy.',
          failed: 'The CPU evidence failed verification. Freedom cannot confirm its hardware claims.',
          unavailable: 'Could not validate the CPU evidence. This is not proof of a privacy breach.',
          unsupported: 'Independent hardware verification is unavailable for this model.' }[hardware.status];
        section.append(el('p', message || 'CPU evidence not verified.'));
        for (const report of hardware.reports || []) {
          section.append(el('p', `${report.tcb}${report.advisories?.length ? ` · ${report.advisories.join(', ')}` : ''}`));
        }
        if (hardware.checkedAt) section.append(el('p', `Endpoint checked ${new Date(hardware.checkedAt).toLocaleString()}. This is a historical endpoint check, not proof of which hardware served your requests.`, 'agent-privacy-detail-note'));
      }
      panel.append(section);
    }
    panel.append(el('p', 'Inference is not independently verified. GPU evidence, approved server software, connection binding and response signatures are not verified by Freedom.', 'agent-privacy-detail-note'),
      el('p', 'End-to-end encryption is not enabled. HTTPS endpoints provide transport encryption, not end-to-end encryption; the service handling the connection can access the content. HTTP endpoints do not provide transport encryption. A local endpoint does not prove the model server is offline.', 'agent-privacy-detail-note'),
      el('p', 'Browser actions and connected services can share information separately. Conversation history and attachments are stored on this device. CPU checks retrieve public Intel-signed collateral through Phala; no conversation content is sent there.', 'agent-privacy-detail-note'));
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
