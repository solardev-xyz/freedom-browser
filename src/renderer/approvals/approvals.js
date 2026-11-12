/**
 * The approvals document's page (freedom-core design 0011, "The approvals
 * document" and "Rendering a page's data"; APS-1, APS-2).
 *
 * It shows the one prompt main shows this window, from its kind's template
 * (approvals-kinds.js), and sends back the user's decision for that handle
 * alone. Much of what a prompt shows is a hostile page's choice, and script
 * running here could approve by itself, so (approvals-core.js):
 *
 *   - a closed, bounded schema per kind: an unknown kind or field, a wrong
 *     type, a value over its bound, or a view over 256 KiB shows a fixed
 *     error, and the prompt can then only be rejected;
 *   - text only: every value goes in with `textContent`, from fixed
 *     templates; nothing from a page is ever markup, a style, a URL or an
 *     attribute (and the CSP's Trusted Types make every markup sink throw);
 *   - control, invisible and direction-changing characters show as visible
 *     escapes, and a long value is cut with a visible mark and shown in full
 *     in a scrolling box;
 *   - clicks and keys do nothing for 500 ms after a prompt appears, its
 *     content changes, or the panel is shown again or moves; an activation
 *     counts only if its press, too, came after the delay;
 *   - Enter never approves: no button is the default, focus starts on
 *     Reject, Enter does nothing anywhere, and approving by keyboard is
 *     Space on a focused Approve.
 *
 * A classic script, loaded last of the three.
 */
(function approvalsDocument(root) {
  'use strict';

  const core = root.ApprovalsCore;
  const kinds = root.ApprovalsKinds;
  const bridge = root.approvals;
  const doc = root.document;
  if (!core || !kinds || !bridge || !doc) return;
  const { INPUT_DELAY_MS, INPUT_EVENTS, visible, createInputGate, createBuilders } = core;

  const el = {
    panel: doc.getElementById('panel'),
    heading: doc.getElementById('heading'),
    site: doc.getElementById('site'),
    body: doc.getElementById('body'),
    error: doc.getElementById('error'),
    waiting: doc.getElementById('waiting'),
    reject: doc.getElementById('reject'),
    approve: doc.getElementById('approve'),
  };

  const ui = createBuilders(doc);
  const gate = createInputGate({ now: () => root.performance.now() });
  let current = null; // the checked prompt shown, or null
  let form = null; // what its template reads the user's choices from
  let deciding = false;
  // An approval for an account that signs on a device: `{ handle, closed }`
  // while the panel says where to confirm, until main answers it.
  let waiting = null;
  let armTimer = null;
  let armFrame = null;

  function setButtons() {
    el.approve.hidden = !current || !current.valid;
    el.approve.disabled = !current || !current.valid || deciding;
    el.reject.disabled = !current || deciding;
  }

  function stopArming() {
    if (armFrame !== null) root.cancelAnimationFrame(armFrame);
    if (armTimer !== null) root.clearTimeout(armTimer);
    armFrame = null;
    armTimer = null;
  }

  // Restart the delay once the prompt is on screen, and tell main.
  function rearm() {
    gate.disarm();
    stopArming();
    if (!current) return;
    el.panel.classList.add('arming');
    const handle = current.handle;
    armFrame = root.requestAnimationFrame(() => {
      armFrame = root.requestAnimationFrame(() => {
        armFrame = null;
        if (current?.handle !== handle) return;
        gate.arm();
        bridge.shown(handle);
        armTimer = root.setTimeout(() => {
          armTimer = null;
          el.panel.classList.remove('arming');
        }, INPUT_DELAY_MS);
      });
    });
  }

  const WAITING_COPY = Object.freeze({
    ledger: 'Confirm on your Ledger…',
    remote: 'Confirm on your phone: its code is in the sidebar…',
  });
  // A page's prompt, or a Safe board's owner (APS-3b): the wallet's other
  // prompts are answered once their token is minted, and the chrome's screen
  // says where to confirm after that.
  const deviceOf = (prompt, choices) => {
    const device = kinds.deviceOf(prompt, choices);
    return device !== null && Object.prototype.hasOwnProperty.call(WAITING_COPY, device) ? device : null;
  };

  function stopWaiting() {
    waiting = null;
    el.waiting.hidden = true;
    el.waiting.textContent = '';
  }

  function render(prompt) {
    stopWaiting();
    current = prompt;
    form = null;
    deciding = false;
    el.body.replaceChildren();
    el.site.textContent = prompt.valid ? visible(prompt.site.label) : '';
    el.error.hidden = prompt.valid;
    if (prompt.valid) {
      const kind = kinds.KINDS[prompt.kind];
      el.heading.textContent = kind.heading(prompt.view);
      el.approve.textContent = kind.approve(prompt.view);
      el.reject.textContent = typeof kind.reject === 'function' ? kind.reject(prompt.view) : 'Reject';
      form = kind.render(prompt.view, ui, el.body) || null;
      // A board's choice names what Approve does (APS-3b): its label follows.
      if (form && typeof form.watch === 'function') {
        const handle = prompt.handle;
        form.watch((label) => {
          if (current?.handle === handle && typeof label === 'string') el.approve.textContent = label;
        });
      }
    } else {
      el.heading.textContent = 'Request';
      el.approve.textContent = 'Approve';
      el.reject.textContent = 'Reject';
    }
    el.panel.hidden = false;
    setButtons();
    // Focus starts on Reject.
    el.reject.focus();
    rearm();
  }

  function clear(handle) {
    if (!current || current.handle !== handle) return;
    // Still signing on its device: the panel stays until main answers.
    if (waiting && waiting.handle === handle) {
      waiting.closed = true;
      return;
    }
    current = null;
    form = null;
    deciding = false;
    gate.disarm();
    stopArming();
    el.panel.hidden = true;
    el.body.replaceChildren();
    el.site.textContent = '';
    setButtons();
  }

  async function decide(approve) {
    if (!current || deciding || (approve && !current.valid)) return;
    // What the user chose, as the template reads it; nothing to approve yet
    // (an empty password, say) leaves the prompt as it is.
    let choices;
    if (approve && form && typeof form.choices === 'function') {
      choices = form.choices();
      if (choices === null) return;
    }
    const handle = current.handle;
    deciding = true;
    setButtons();
    const device = approve ? deviceOf(current, choices) : null;
    if (device) {
      waiting = { handle, closed: false };
      el.waiting.textContent = WAITING_COPY[device];
      el.waiting.hidden = false;
    }
    let answer;
    try {
      answer = await bridge.decide(handle, approve, choices);
    } catch {
      answer = null;
    }
    if (waiting && waiting.handle === handle) {
      const closed = waiting.closed;
      stopWaiting();
      if (closed) {
        clear(handle);
        return;
      }
    }
    // Refused (too soon for main, say): the user can try again.
    if (current?.handle === handle && answer?.ok !== true) {
      deciding = false;
      setButtons();
    }
  }

  const controlOf = (target) => (target === el.approve ? 'approve' : target === el.reject ? 'reject' : 'other');

  for (const type of INPUT_EVENTS) {
    root.addEventListener(
      type,
      (event) => {
        const admitted = gate.admit(type, {
          key: event.key,
          code: event.code,
          repeat: event.repeat === true,
          target: controlOf(event.target),
        });
        if (!admitted) {
          event.preventDefault();
          event.stopImmediatePropagation();
        }
      },
      true
    );
  }
  // No form ever submits.
  doc.addEventListener('submit', (event) => event.preventDefault(), true);

  el.approve.addEventListener('click', (event) => {
    if (gate.activates('approve', event)) decide(true);
  });
  el.reject.addEventListener('click', (event) => {
    if (gate.activates('reject', event)) decide(false);
  });

  bridge.onPrompt((message) => {
    const prompt = kinds.checkMessage(message);
    if (prompt) render(prompt);
  });
  bridge.onHidden((message) => clear(message?.handle));
  bridge.onClosed((message) => clear(message?.handle));
  bridge.onMoved(() => rearm());
  root.addEventListener('resize', () => rearm());
  doc.addEventListener('visibilitychange', () => {
    if (doc.visibilityState === 'visible') rearm();
  });

  // Settings > Appearance, which main sends (it doesn't reach
  // `prefers-color-scheme` on every platform): 'system' follows the OS. The
  // chrome's tokens key the light palette on this attribute.
  const dark = root.matchMedia('(prefers-color-scheme: dark)');
  let theme = 'system';
  const applyTheme = () => {
    const isDark = theme === 'dark' || (theme !== 'light' && dark.matches);
    if (isDark) doc.documentElement.removeAttribute('data-theme');
    else doc.documentElement.setAttribute('data-theme', 'light');
  };
  applyTheme();
  dark.addEventListener('change', applyTheme);
  bridge.onTheme((message) => {
    theme = message?.theme === 'light' || message?.theme === 'dark' ? message.theme : 'system';
    applyTheme();
  });

  setButtons();
  bridge.ready();
})(typeof window === 'undefined' ? globalThis : window);
