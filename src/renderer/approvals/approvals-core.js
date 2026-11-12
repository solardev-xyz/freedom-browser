/**
 * The approvals document's rules, shared by its kinds and its page
 * (freedom-core design 0011, "Rendering a page's data"; APS-1, APS-2):
 *
 *   - a closed, bounded schema language: a view is exactly what its kind's
 *     schema allows (no unknown or missing field, no wrong type, nothing
 *     over its bound), and at most 256 KiB in all;
 *   - text encoded for where it shows: control, invisible and
 *     direction-changing characters as visible escapes, a long value cut
 *     with a visible mark;
 *   - the input gate: nothing for 500 ms after a prompt appears, changes,
 *     shows again or moves; an activation counts only if its press came
 *     after the delay too; Enter never approves;
 *   - the builders every template uses: elements from fixed tags and
 *     classes, every value set as text.
 *
 * A classic script (the document loads its three scripts in order: this
 * one, approvals-kinds.js, approvals.js). Node's tests require it.
 */
(function approvalsCore(root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else Object.defineProperty(root, 'ApprovalsCore', { value: api });
})(typeof window === 'undefined' ? globalThis : window, function core() {
  'use strict';

  const INPUT_DELAY_MS = 500;
  const MAX_VIEW_BYTES = 256 * 1024;
  const MAX_DEPTH = 8;
  // Characters of a value shown before it is cut.
  const CUT_AT = 160;

  // --- The schema language -------------------------------------------------

  const text = (max, { multiline = false, pattern = null } = {}) => Object.freeze({ type: 'text', max, multiline, pattern });
  const integer = ({ min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER } = {}) =>
    Object.freeze({ type: 'integer', min, max });
  const boolean = () => Object.freeze({ type: 'boolean' });
  const oneOf = (...values) => Object.freeze({ type: 'oneOf', values: Object.freeze(values) });
  const list = (max, item) => Object.freeze({ type: 'list', max, item });
  const record = (fields, { optional = [] } = {}) =>
    Object.freeze({ type: 'record', fields: Object.freeze(fields), optional: Object.freeze([...optional]) });
  const nullable = (schema) => Object.freeze({ type: 'nullable', schema });

  const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

  function isPlainObject(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
  }

  /** Whether `value` is exactly what `schema` allows: no more, no less. */
  function conforms(value, schema, depth = 0) {
    if (!schema || depth > MAX_DEPTH) return false;
    switch (schema.type) {
      case 'text':
        return (
          typeof value === 'string' && value.length <= schema.max && (schema.pattern === null || schema.pattern.test(value))
        );
      case 'integer':
        return Number.isSafeInteger(value) && value >= schema.min && value <= schema.max;
      case 'boolean':
        return value === true || value === false;
      case 'oneOf':
        return schema.values.includes(value);
      case 'nullable':
        return value === null || conforms(value, schema.schema, depth);
      case 'list':
        if (!Array.isArray(value) || value.length > schema.max) return false;
        if (Object.keys(value).length !== value.length) return false;
        return value.every((item) => conforms(item, schema.item, depth + 1));
      case 'record': {
        if (!isPlainObject(value)) return false;
        const keys = Object.keys(value);
        if (!keys.every((key) => hasOwn(schema.fields, key))) return false;
        return Object.keys(schema.fields).every((name) =>
          hasOwn(value, name)
            ? conforms(value[name], schema.fields[name], depth + 1)
            : schema.optional.includes(name)
        );
      }
      default:
        return false;
    }
  }

  function viewBytes(view) {
    try {
      const json = JSON.stringify(view);
      return typeof json === 'string' ? new TextEncoder().encode(json).length : Infinity;
    } catch {
      return Infinity;
    }
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


  // --- The builders ----------------------------------------------------------

  /**
   * Element builders over `doc`: fixed tags and classes from here, every
   * value as text. A template gets these and nothing else.
   */
  function createBuilders(doc) {
    const node = (tag, className) => {
      const out = doc.createElement(tag);
      if (className) out.className = className;
      return out;
    };
    const textNode = (tag, className, value) => {
      const out = node(tag, className);
      out.textContent = value;
      return out;
    };

    /** A labelled value from main: shown as it is. */
    function own(label, value) {
      const wrap = node('div', 'field own');
      wrap.append(textNode('div', 'field-label', label), textNode('div', 'field-value', visible(value)));
      return wrap;
    }

    /**
     * A labelled value a page chose: encoded, cut when long with its full
     * text in a scrolling box, and marked as the page's.
     */
    function page(label, value, { multiline = false, mono = false } = {}) {
      const wrap = node('div', 'field page');
      wrap.append(textNode('div', 'field-label', label));
      const shown = visible(value, { multiline });
      const { short, cut: isCut } = cut(shown);
      const classes = ['field-value'];
      if (multiline) classes.push('multiline');
      if (mono) classes.push('mono');
      wrap.append(textNode('div', classes.join(' '), short));
      if (isCut) {
        const full = textNode('div', 'field-full', shown);
        full.tabIndex = 0;
        wrap.append(full);
      }
      return wrap;
    }

    /** A fixed line of the document's own copy. */
    const note = (value, className = 'note') => textNode('p', className, value);

    /** A section heading of the document's own copy. */
    const section = (value) => textNode('h2', 'section', value);

    /** A group of labelled rows. */
    const group = (...children) => {
      const out = node('div', 'group');
      out.append(...children);
      return out;
    };

    /**
     * Radio choices: `options` of `{ value, label, detail }`, labels and
     * details as text; `selected` the value checked first. Returns the
     * element and a reader for the value checked.
     */
    function radios(name, options, selected) {
      const fieldset = node('fieldset', 'choices');
      const inputs = [];
      for (const option of options) {
        const row = node('label', 'choice');
        const input = node('input');
        input.type = 'radio';
        input.name = name;
        input.checked = option.value === selected;
        inputs.push([input, option.value]);
        const words = node('span', 'choice-words');
        words.append(textNode('span', 'choice-label', visible(option.label)));
        if (option.detail) words.append(textNode('span', 'choice-detail', visible(option.detail)));
        row.append(input, words);
        fieldset.append(row);
      }
      const value = () => {
        const checked = inputs.find(([input]) => input.checked);
        return checked ? checked[1] : undefined;
      };
      return { element: fieldset, value };
    }

    /** A checkbox with fixed copy. Returns the element and its reader. */
    function checkbox(label, { checked = false } = {}) {
      const row = node('label', 'check');
      const input = node('input');
      input.type = 'checkbox';
      input.checked = checked;
      row.append(input, textNode('span', 'check-label', label));
      return { element: row, value: () => input.checked === true };
    }

    /** A password field with fixed copy. Returns the element and its reader. */
    function password(label) {
      const row = node('label', 'password');
      const input = node('input');
      input.type = 'password';
      input.autocomplete = 'current-password';
      input.spellcheck = false;
      row.append(textNode('span', 'field-label', label), input);
      return { element: row, input, value: () => String(input.value || '') };
    }

    return { node, own, page, note, section, group, radios, checkbox, password };
  }

  return Object.freeze({
    INPUT_DELAY_MS,
    MAX_VIEW_BYTES,
    CUT_AT,
    INPUT_EVENTS,
    schema: Object.freeze({ text, integer, boolean, oneOf, list, record, nullable }),
    isPlainObject,
    conforms,
    viewBytes,
    visible,
    cut,
    createInputGate,
    createBuilders,
  });
});
