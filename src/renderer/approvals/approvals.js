/**
 * The approvals document's script (freedom-core design 0011, "The approvals
 * document" and "Rendering a page's data"; APS-1).
 *
 * It shows the one prompt main shows this window, and sends back the user's
 * decision for that handle alone. Much of what a prompt shows is a hostile
 * page's choice, and script running here could approve by itself, so:
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
 * APS-1 renders one kind, `test.prompt`, which main issues only under the
 * E2E harness. Every other kind shows the fixed error until its schema and
 * template arrive (APS-2, APS-3).
 *
 * A classic script, not a module: the document loads nothing it doesn't
 * need. Node's tests require it for the pure parts below.
 */
(function approvalsDocument(root) {
  'use strict';

  const INPUT_DELAY_MS = 500;
  const MAX_VIEW_BYTES = 256 * 1024;
  const MAX_DEPTH = 8;
  // Characters of a value shown before it is cut.
  const CUT_AT = 160;
  const HANDLE = /^[0-9a-f]{64}$/;
  const MESSAGE_KEYS = ['handle', 'guest', 'kind', 'site', 'view'];

  // --- The closed schemas --------------------------------------------------

  const text = (max, { multiline = false } = {}) => Object.freeze({ type: 'text', max, multiline });
  const list = (max, item) => Object.freeze({ type: 'list', max, item });
  const record = (fields) => Object.freeze({ type: 'record', fields: Object.freeze(fields) });

  const SITE = record({ key: text(2048), label: text(2048) });

  const SCHEMAS = Object.freeze({
    // The harness's prompt (APS-1): every field is the test's choice, and is
    // treated as a page's.
    'test.prompt': record({
      title: text(120),
      message: text(4096, { multiline: true }),
      rows: list(16, record({ label: text(64), value: text(4096) })),
    }),
  });

  const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

  function isPlainObject(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
  }

  /** Whether `value` is exactly what `schema` allows: no more, no less. */
  function conforms(value, schema, depth = 0) {
    if (!schema || depth > MAX_DEPTH) return false;
    if (schema.type === 'text') return typeof value === 'string' && value.length <= schema.max;
    if (schema.type === 'list') {
      if (!Array.isArray(value) || value.length > schema.max) return false;
      if (Object.keys(value).length !== value.length) return false;
      return value.every((item) => conforms(item, schema.item, depth + 1));
    }
    if (schema.type === 'record') {
      if (!isPlainObject(value)) return false;
      const names = Object.keys(schema.fields);
      const keys = Object.keys(value);
      if (keys.length !== names.length || !keys.every((key) => hasOwn(schema.fields, key))) return false;
      return names.every((name) => hasOwn(value, name) && conforms(value[name], schema.fields[name], depth + 1));
    }
    return false;
  }

  function viewBytes(view) {
    try {
      const json = JSON.stringify(view);
      return typeof json === 'string' ? new TextEncoder().encode(json).length : Infinity;
    } catch {
      return Infinity;
    }
  }

  /**
   * A `page:prompt` message, checked. Null when it names no handle (there
   * is nothing to answer); otherwise the handle, and its site and view only
   * when the whole message fits its kind's schema (`valid`). An invalid one
   * shows the fixed error and can only be rejected.
   */
  function checkMessage(message) {
    if (!isPlainObject(message)) return null;
    const { handle } = message;
    if (typeof handle !== 'string' || !HANDLE.test(handle)) return null;
    const keys = Object.keys(message);
    const kind = typeof message.kind === 'string' && hasOwn(SCHEMAS, message.kind) ? message.kind : null;
    const valid =
      kind !== null &&
      keys.length === MESSAGE_KEYS.length &&
      keys.every((key) => MESSAGE_KEYS.includes(key)) &&
      Number.isInteger(message.guest) &&
      conforms(message.site, SITE) &&
      viewBytes(message.view) <= MAX_VIEW_BYTES &&
      conforms(message.view, SCHEMAS[kind]);
    return valid
      ? { handle, kind, site: message.site, view: message.view, valid: true }
      : { handle, kind: null, site: null, view: null, valid: false };
  }

  // --- Text, encoded for where it shows ------------------------------------

  // Control, format (bidi controls, zero-width characters, the BOM, tags),
  // surrogate, private-use and unassigned code points, the line and
  // paragraph separators, and the blank fillers and variation selectors.
  const INVISIBLE =
    /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\u115F\u1160\u3164\uFFA0]|\u034F|[\uFE00-\uFE0F]|[\u{E0100}-\u{E01EF}]/gu;

  const escapeOf = (char) => `\\u{${char.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}}`;

  /** `value` with every invisible character shown as an escape. */
  function visible(value, { multiline = false } = {}) {
    return String(value).replace(INVISIBLE, (char) => (multiline && char === '\n' ? char : escapeOf(char)));
  }

  /** A shown value cut at `CUT_AT` characters, with a visible mark. */
  function cut(value) {
    const chars = Array.from(value);
    if (chars.length <= CUT_AT) return { short: value, cut: false };
    return { short: `${chars.slice(0, CUT_AT).join('')} … (${chars.length - CUT_AT} more characters below)`, cut: true };
  }

  // --- Input: the delay, and what counts as an activation -------------------

  const KEY_EVENTS = new Set(['keydown', 'keypress', 'keyup']);
  const PRESS_EVENTS = new Set(['pointerdown', 'mousedown', 'touchstart', 'keydown']);
  const INPUT_EVENTS = [
    'pointerdown',
    'pointerup',
    'mousedown',
    'mouseup',
    'touchstart',
    'touchend',
    'click',
    'dblclick',
    'auxclick',
    'contextmenu',
    'keydown',
    'keypress',
    'keyup',
  ];

  const isEnter = (key, code) => key === 'Enter' || code === 'Enter' || code === 'NumpadEnter';

  /**
   * The document's input gate. `arm()` restarts the delay; until it has run
   * out, no input reaches the controls. An activation counts only if the
   * press that made it (a pointer down, or Space down on that very control)
   * also came after the delay.
   */
  function createInputGate({ now, delayMs = INPUT_DELAY_MS }) {
    let armedAt = null;
    let press = null;
    const open = (at) => armedAt !== null && at - armedAt >= delayMs;
    return {
      arm() {
        armedAt = now();
        press = null;
      },
      disarm() {
        armedAt = null;
        press = null;
      },
      isOpen: () => open(now()),
      /** Whether a raw input event may reach the controls. */
      admit(type, { key = '', code = '', repeat = false, target = null } = {}) {
        const at = now();
        if (KEY_EVENTS.has(type) && isEnter(key, code)) return false;
        if (!open(at)) {
          if (PRESS_EVENTS.has(type) && !repeat) press = null;
          return false;
        }
        if (type === 'pointerdown' || type === 'mousedown' || type === 'touchstart') {
          press = { by: 'pointer', at };
        } else if (type === 'keydown' && !repeat) {
          press = { by: 'key', key, target, at };
        }
        return true;
      },
      /** Whether a click on `control` counts. Spends the press. */
      activates(control, { detail = 0, isTrusted = false } = {}) {
        const at = now();
        const made = press;
        press = null;
        if (!isTrusted || !open(at) || !made || made.at - armedAt < delayMs) return false;
        if (detail > 0) return made.by === 'pointer';
        return made.by === 'key' && made.key === ' ' && made.target === control;
      },
    };
  }

  const api = Object.freeze({
    INPUT_DELAY_MS,
    MAX_VIEW_BYTES,
    CUT_AT,
    SCHEMAS,
    INPUT_EVENTS,
    conforms,
    checkMessage,
    visible,
    cut,
    createInputGate,
  });

  if (typeof module === 'object' && module.exports) {
    module.exports = api;
    return;
  }

  // --- The document ---------------------------------------------------------

  const bridge = root.approvals;
  const doc = root.document;
  if (!bridge || !doc) return;

  const el = {
    panel: doc.getElementById('panel'),
    heading: doc.getElementById('heading'),
    site: doc.getElementById('site'),
    body: doc.getElementById('body'),
    error: doc.getElementById('error'),
    reject: doc.getElementById('reject'),
    approve: doc.getElementById('approve'),
  };

  const gate = createInputGate({ now: () => root.performance.now() });
  let current = null; // the checked prompt shown, or null
  let deciding = false;
  let armTimer = null;
  let armFrame = null;

  const node = (tag, className) => {
    const out = doc.createElement(tag);
    out.className = className;
    return out;
  };

  function field(label, value, { multiline = false } = {}) {
    const wrap = node('div', 'field');
    const name = node('div', 'field-label');
    name.textContent = visible(label);
    const shown = visible(value, { multiline });
    const { short, cut: isCut } = cut(shown);
    const body = node('div', multiline ? 'field-value multiline' : 'field-value');
    body.textContent = short;
    wrap.append(name, body);
    if (isCut) {
      const full = node('div', 'field-full');
      full.tabIndex = 0;
      full.textContent = shown;
      wrap.append(full);
    }
    return wrap;
  }

  // The templates, by kind: fixed text from here, values as text.
  const TEMPLATES = Object.freeze({
    'test.prompt': (view) => {
      el.heading.textContent = 'Test request';
      el.body.append(field('Title', view.title), field('Message', view.message, { multiline: true }));
      for (const row of view.rows) el.body.append(field(row.label, row.value));
    },
  });

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

  function render(prompt) {
    current = prompt;
    deciding = false;
    el.body.replaceChildren();
    el.site.textContent = prompt.valid ? visible(prompt.site.label) : '';
    el.error.hidden = prompt.valid;
    if (prompt.valid) {
      TEMPLATES[prompt.kind](prompt.view);
    } else {
      el.heading.textContent = 'Request';
    }
    el.panel.hidden = false;
    setButtons();
    // Focus starts on Reject.
    el.reject.focus();
    rearm();
  }

  function clear(handle) {
    if (!current || current.handle !== handle) return;
    current = null;
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
    const handle = current.handle;
    deciding = true;
    setButtons();
    let answer;
    try {
      answer = await bridge.decide(handle, approve, undefined);
    } catch {
      answer = null;
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

  el.approve.addEventListener('click', (event) => {
    if (gate.activates('approve', event)) decide(true);
  });
  el.reject.addEventListener('click', (event) => {
    if (gate.activates('reject', event)) decide(false);
  });

  bridge.onPrompt((message) => {
    const prompt = checkMessage(message);
    if (prompt) render(prompt);
  });
  bridge.onHidden((message) => clear(message?.handle));
  bridge.onClosed((message) => clear(message?.handle));
  bridge.onMoved(() => rearm());
  root.addEventListener('resize', () => rearm());
  doc.addEventListener('visibilitychange', () => {
    if (doc.visibilityState === 'visible') rearm();
  });

  // The chrome's theme: main sets the app's colour scheme from Settings >
  // Appearance, and the chrome's tokens key the light palette on this.
  const dark = root.matchMedia('(prefers-color-scheme: dark)');
  const applyTheme = () => {
    if (dark.matches) doc.documentElement.removeAttribute('data-theme');
    else doc.documentElement.setAttribute('data-theme', 'light');
  };
  applyTheme();
  dark.addEventListener('change', applyTheme);

  setButtons();
  bridge.ready();
})(typeof window === 'undefined' ? globalThis : window);
