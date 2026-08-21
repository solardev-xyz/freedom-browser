'use strict';

const crypto = require('crypto');
const { EventEmitter } = require('events');
const { AutomationError, ERROR_CODES } = require('../contract/errors');

const AUTOMATION_WORLD_ID = 1001;
const MAX_PAGE_TEXT_LENGTH = 12_000;
const MAX_SNAPSHOT_ELEMENTS = 250;
const MAX_RETAINED_REFERENCES = 1_000;
const WAIT_POLL_INTERVAL_MS = 100;

function defaultReferenceIdFactory() {
  return `ref_${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`;
}

function buildInvocation(fn, args, dependencies = []) {
  const declarations = dependencies
    .map((dependency) => `const ${dependency.name} = ${dependency.toString()};`)
    .join('');
  const invocation = `(${fn.toString()})(${args.map((value) => JSON.stringify(value)).join(',')})`;
  return declarations ? `(() => {${declarations}return ${invocation};})()` : invocation;
}

function collectPageSnapshot(maxTextLength, maxElements) {
  const normalize = (value) =>
    String(value || '')
      .replace(/\s+/g, ' ')
      .trim();
  const visible = (element) => {
    const style = window.getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
      return false;
    }
    return element.getClientRects().length > 0;
  };
  const accessibleName = (element) => {
    const labelledBy = element.getAttribute('aria-labelledby');
    if (labelledBy) {
      const label = labelledBy
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent || '')
        .join(' ');
      if (normalize(label)) return normalize(label);
    }
    return normalize(
      element.getAttribute('aria-label') ||
        element.getAttribute('alt') ||
        element.getAttribute('title') ||
        element.getAttribute('placeholder') ||
        element.innerText ||
        (element.tagName === 'INPUT' && element.type !== 'password' ? element.value : '')
    );
  };
  const implicitRole = (element) => {
    const tag = element.tagName.toLowerCase();
    if (tag === 'a' && element.hasAttribute('href')) return 'link';
    if (tag === 'button') return 'button';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'input') {
      if (['button', 'submit', 'reset'].includes(element.type)) return 'button';
      if (element.type === 'checkbox') return 'checkbox';
      if (element.type === 'radio') return 'radio';
      if (element.type === 'range') return 'slider';
      return 'textbox';
    }
    return element.isContentEditable ? 'textbox' : 'generic';
  };
  const selectorFor = (element) => {
    const parts = [];
    let current = element;
    while (current && current.nodeType === Node.ELEMENT_NODE) {
      const tag = current.tagName.toLowerCase();
      if (current === document.documentElement) {
        parts.unshift(tag);
        break;
      }
      const parent = current.parentElement;
      if (!parent) return null;
      const index = Array.prototype.indexOf.call(parent.children, current) + 1;
      parts.unshift(`${tag}:nth-child(${index})`);
      current = parent;
    }
    return parts.join(' > ');
  };
  const fingerprintFor = (element, role, name) =>
    [
      element.tagName.toLowerCase(),
      element.getAttribute('type') || '',
      role,
      name.slice(0, 200),
    ].join('|');

  const candidates = document.querySelectorAll(
    'a[href],button,input:not([type="hidden"]),select,textarea,[role],[contenteditable="true"],[tabindex]:not([tabindex="-1"])'
  );
  const elements = [];
  for (const element of candidates) {
    if (elements.length >= maxElements || !visible(element)) continue;
    const selector = selectorFor(element);
    if (!selector) continue;
    const role = element.getAttribute('role') || implicitRole(element);
    const name = accessibleName(element);
    elements.push({
      selector,
      fingerprint: fingerprintFor(element, role, name),
      role,
      name,
      tag: element.tagName.toLowerCase(),
      disabled: element.matches(':disabled') || element.getAttribute('aria-disabled') === 'true',
      focused: element === document.activeElement,
      editable:
        element.matches('input:not([readonly]),textarea:not([readonly])') ||
        element.isContentEditable,
    });
  }

  return {
    url: window.location.href,
    title: document.title,
    text: normalize(document.body?.innerText || '').slice(0, maxTextLength),
    elements,
    truncated: candidates.length > elements.length && elements.length >= maxElements,
  };
}

function inspectReferencedElement(selector, expectedFingerprint, action) {
  const normalize = (value) =>
    String(value || '')
      .replace(/\s+/g, ' ')
      .trim();
  const accessibleName = (element) => {
    const labelledBy = element.getAttribute('aria-labelledby');
    if (labelledBy) {
      const label = labelledBy
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent || '')
        .join(' ');
      if (normalize(label)) return normalize(label);
    }
    return normalize(
      element.getAttribute('aria-label') ||
        element.getAttribute('alt') ||
        element.getAttribute('title') ||
        element.getAttribute('placeholder') ||
        element.innerText ||
        (element.tagName === 'INPUT' && element.type !== 'password' ? element.value : '')
    );
  };
  const implicitRole = (element) => {
    const tag = element.tagName.toLowerCase();
    if (tag === 'a' && element.hasAttribute('href')) return 'link';
    if (tag === 'button') return 'button';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'input') {
      if (['button', 'submit', 'reset'].includes(element.type)) return 'button';
      if (element.type === 'checkbox') return 'checkbox';
      if (element.type === 'radio') return 'radio';
      if (element.type === 'range') return 'slider';
      return 'textbox';
    }
    return element.isContentEditable ? 'textbox' : 'generic';
  };
  const element = document.querySelector(selector);
  if (!element) return { ok: false, reason: 'not_found' };
  const role = element.getAttribute('role') || implicitRole(element);
  const name = accessibleName(element);
  const fingerprint = [
    element.tagName.toLowerCase(),
    element.getAttribute('type') || '',
    role,
    name.slice(0, 200),
  ].join('|');
  if (fingerprint !== expectedFingerprint) return { ok: false, reason: 'changed' };

  const style = window.getComputedStyle(element);
  const unavailable =
    style.display === 'none' ||
    style.visibility === 'hidden' ||
    style.opacity === '0' ||
    element.getClientRects().length === 0 ||
    element.matches(':disabled') ||
    element.getAttribute('aria-disabled') === 'true';
  if (unavailable) return { ok: false, reason: 'not_interactable' };

  if (action === 'click') {
    element.scrollIntoView({ block: 'center', inline: 'center' });
    const rect = element.getBoundingClientRect();
    const x = Math.round(Math.max(0, Math.min(window.innerWidth - 1, rect.left + rect.width / 2)));
    const y = Math.round(Math.max(0, Math.min(window.innerHeight - 1, rect.top + rect.height / 2)));
    const hit = document.elementFromPoint(x, y);
    if (!hit || (hit !== element && !element.contains(hit))) {
      return { ok: false, reason: 'not_interactable' };
    }
    return { ok: true, point: { x, y } };
  }

  const editable =
    element.matches('input:not([readonly]),textarea:not([readonly])') || element.isContentEditable;
  if (!editable) return { ok: false, reason: 'not_interactable' };
  element.scrollIntoView({ block: 'center', inline: 'center' });
  element.focus();
  return { ok: true, contentEditable: element.isContentEditable };
}

function prepareTextInsertion(selector, expectedFingerprint, replace) {
  const inspected = inspectReferencedElement(selector, expectedFingerprint, 'type');
  if (!inspected.ok) return inspected;
  const element = document.querySelector(selector);
  if (replace && typeof element.select === 'function') {
    element.select();
  } else if (replace && element.isContentEditable) {
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(element);
    selection.removeAllRanges();
    selection.addRange(range);
  } else if (!replace && typeof element.setSelectionRange === 'function') {
    const end = String(element.value || '').length;
    element.setSelectionRange(end, end);
  }
  return { ok: true };
}

function pageContainsText(text) {
  return String(document.body?.innerText || '').includes(text);
}

class WebContentsPageAdapter extends EventEmitter {
  constructor(webContents, options = {}) {
    super();
    if (!webContents || typeof webContents.loadURL !== 'function') {
      throw new TypeError('WebContentsPageAdapter requires Electron WebContents');
    }
    this.webContents = webContents;
    this.kind = options.kind || 'unknown';
    this.navigationId = 0;
    this.navigationInProgress = false;
    this.destroyed = false;
    this.referenceIdFactory = options.referenceIdFactory || defaultReferenceIdFactory;
    this.references = new Map();
    this.activeWaits = new Set();
    this.listeners = {
      'did-start-navigation': (_event, _url, isInPlace, isMainFrame) => {
        if (isMainFrame === false || isInPlace === true) return;
        this.navigationInProgress = true;
        this.navigationId += 1;
        this.#pruneReferences();
        this.emit('navigation-started', this.getState());
      },
      'did-navigate': () => {
        this.navigationInProgress = false;
        this.emit('navigation-committed', this.getState());
      },
      'did-navigate-in-page': (_event, _url, isMainFrame) => {
        if (isMainFrame === false) return;
        this.navigationId += 1;
        this.#pruneReferences();
        this.emit('navigation-committed', this.getState());
      },
      'did-stop-loading': () => {
        this.navigationInProgress = false;
        this.emit('navigation-finished', this.getState());
      },
      destroyed: () => {
        this.destroyed = true;
        this.#cancelWaits();
        this.references.clear();
        this.emit('destroyed');
      },
    };
    if (typeof webContents.on === 'function') {
      for (const [event, listener] of Object.entries(this.listeners)) {
        webContents.on(event, listener);
      }
    }
  }

  getState() {
    const unavailable = this.destroyed || this.webContents.isDestroyed?.() === true;
    return {
      kind: this.kind,
      url: unavailable ? '' : this.webContents.getURL?.() || '',
      title: unavailable ? '' : this.webContents.getTitle?.() || '',
      loading: unavailable ? false : this.webContents.isLoading?.() === true,
      navigationId: this.navigationId,
      available: !unavailable,
    };
  }

  async navigate(url) {
    this.#assertAvailable();
    try {
      await this.webContents.loadURL(url);
    } catch (error) {
      throw new AutomationError(ERROR_CODES.NAVIGATION_FAILED, `Navigation failed: ${url}`, {
        retryable: true,
        cause: error,
      });
    }
    return { url: this.webContents.getURL?.() || url };
  }

  async snapshot() {
    this.#assertAvailable();
    const navigationId = this.navigationId;
    const snapshot = await this.#execute(
      collectPageSnapshot,
      [MAX_PAGE_TEXT_LENGTH, MAX_SNAPSHOT_ELEMENTS],
      false
    );
    if (!snapshot || !Array.isArray(snapshot.elements)) {
      throw new AutomationError(
        ERROR_CODES.CAPABILITY_UNAVAILABLE,
        'The page did not produce a semantic snapshot'
      );
    }
    if (navigationId !== this.navigationId) throw this.#staleReferenceError();

    const elements = snapshot.elements.map(({ selector, fingerprint, ...publicNode }) => {
      const ref = this.referenceIdFactory();
      this.references.set(ref, { navigationId, selector, fingerprint });
      return { ref, ...publicNode };
    });
    this.#pruneReferences();
    return { ...snapshot, elements, navigationId };
  }

  async click(ref) {
    this.#assertAvailable();
    const reference = this.#requireReference(ref);
    const result = await this.#execute(
      inspectReferencedElement,
      [reference.selector, reference.fingerprint, 'click'],
      true
    );
    this.#assertActionResult(result);
    if (!result.point || typeof this.webContents.sendInputEvent !== 'function') {
      throw new AutomationError(
        ERROR_CODES.CAPABILITY_UNAVAILABLE,
        'Trusted pointer input is unavailable for this page'
      );
    }
    this.webContents.focus?.();
    const pointer = { x: result.point.x, y: result.point.y, button: 'left' };
    this.webContents.sendInputEvent({ type: 'mouseMove', x: pointer.x, y: pointer.y });
    this.webContents.sendInputEvent({ type: 'mouseDown', ...pointer, clickCount: 1 });
    this.webContents.sendInputEvent({ type: 'mouseUp', ...pointer, clickCount: 1 });
    return { clicked: true, ref };
  }

  async type(ref, text, { replace = true } = {}) {
    this.#assertAvailable();
    const reference = this.#requireReference(ref);
    const result = await this.#execute(
      prepareTextInsertion,
      [reference.selector, reference.fingerprint, replace],
      true,
      [inspectReferencedElement]
    );
    this.#assertActionResult(result);
    if (typeof this.webContents.insertText !== 'function') {
      throw new AutomationError(
        ERROR_CODES.CAPABILITY_UNAVAILABLE,
        'Text insertion is unavailable for this page'
      );
    }
    await this.webContents.insertText(text);
    return { typed: true, ref, characters: text.length };
  }

  async screenshot() {
    this.#assertAvailable();
    if (typeof this.webContents.capturePage !== 'function') {
      throw new AutomationError(
        ERROR_CODES.CAPABILITY_UNAVAILABLE,
        'Screenshots are unavailable for this page'
      );
    }
    const image = await this.webContents.capturePage();
    return {
      mediaType: 'image/png',
      base64: image.toPNG().toString('base64'),
    };
  }

  async wait(options) {
    this.#assertAvailable();
    const waitController = new AbortController();
    this.activeWaits.add(waitController);
    const deadline = Date.now() + options.timeoutMs;
    try {
      while (true) {
        if (waitController.signal.aborted) throw this.#cancelledWaitError();
        const matched = await this.#waitConditionMatches(options);
        if (waitController.signal.aborted) throw this.#cancelledWaitError();
        if (matched) {
          return {
            matched: true,
            condition: options.condition,
            url: this.webContents.getURL?.() || '',
            navigationId: this.navigationId,
          };
        }
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          throw new AutomationError(
            ERROR_CODES.WAIT_TIMEOUT,
            `Timed out waiting for page condition: ${options.condition}`,
            {
              retryable: true,
              details: { condition: options.condition, timeoutMs: options.timeoutMs },
            }
          );
        }
        await this.#waitDelay(Math.min(WAIT_POLL_INTERVAL_MS, remaining), waitController.signal);
      }
    } finally {
      this.activeWaits.delete(waitController);
    }
  }

  async stopLoading() {
    this.#assertAvailable();
    const cancelledWaits = this.#cancelWaits();
    this.webContents.stop?.();
    return { stopped: true, cancelledWaits };
  }

  dispose() {
    if (typeof this.webContents.off === 'function') {
      for (const [event, listener] of Object.entries(this.listeners)) {
        this.webContents.off(event, listener);
      }
    }
    this.#cancelWaits();
    this.references.clear();
  }

  async #execute(fn, args, userGesture, dependencies = []) {
    if (typeof this.webContents.executeJavaScriptInIsolatedWorld !== 'function') {
      throw new AutomationError(
        ERROR_CODES.CAPABILITY_UNAVAILABLE,
        'Isolated page execution is unavailable for this page'
      );
    }
    const code = buildInvocation(fn, args, dependencies);
    return this.webContents.executeJavaScriptInIsolatedWorld(
      AUTOMATION_WORLD_ID,
      [{ code, url: 'freedom://automation' }],
      userGesture
    );
  }

  #requireReference(ref) {
    const reference = this.references.get(ref);
    if (!reference) {
      throw new AutomationError(
        ERROR_CODES.ELEMENT_NOT_FOUND,
        `Element reference not found: ${ref}`,
        {
          retryable: true,
          suggestedAction: 'Take a new snapshot',
        }
      );
    }
    if (reference.navigationId !== this.navigationId || this.navigationInProgress) {
      throw this.#staleReferenceError();
    }
    return reference;
  }

  #staleReferenceError() {
    return new AutomationError(
      ERROR_CODES.STALE_ELEMENT_REFERENCE,
      'The page navigated after this element reference was created',
      { retryable: true, suggestedAction: 'Take a new snapshot' }
    );
  }

  #assertActionResult(result) {
    if (result?.ok) return;
    if (result?.reason === 'not_interactable') {
      throw new AutomationError(
        ERROR_CODES.ELEMENT_NOT_INTERACTABLE,
        'The referenced element is not interactable',
        { retryable: true, suggestedAction: 'Take a new snapshot' }
      );
    }
    if (result?.reason === 'changed') throw this.#staleReferenceError();
    throw new AutomationError(
      ERROR_CODES.ELEMENT_NOT_FOUND,
      'The referenced element no longer exists',
      {
        retryable: true,
        suggestedAction: 'Take a new snapshot',
      }
    );
  }

  #assertAvailable() {
    if (this.destroyed || this.webContents.isDestroyed?.() === true) {
      throw new AutomationError(ERROR_CODES.TAB_NOT_FOUND, 'The automation tab was closed');
    }
  }

  async #waitConditionMatches(options) {
    switch (options.condition) {
      case 'load':
        return !this.navigationInProgress && this.webContents.isLoading?.() !== true;
      case 'navigation':
        return this.navigationId > options.sinceNavigationId;
      case 'url':
        return this.webContents.getURL?.() === options.url;
      case 'text':
        return (await this.#execute(pageContainsText, [options.text], false)) === true;
      default:
        return false;
    }
  }

  #waitDelay(delayMs, signal) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      }, delayMs);
      const onAbort = () => {
        clearTimeout(timer);
        reject(this.#cancelledWaitError());
      };
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  #cancelWaits() {
    const count = this.activeWaits.size;
    for (const waitController of this.activeWaits) waitController.abort();
    return count;
  }

  #cancelledWaitError() {
    return new AutomationError(ERROR_CODES.USER_CANCELLED, 'The page wait was cancelled', {
      retryable: true,
    });
  }

  #pruneReferences() {
    for (const [ref, reference] of this.references) {
      if (reference.navigationId < this.navigationId - 3) this.references.delete(ref);
    }
    while (this.references.size > MAX_RETAINED_REFERENCES) {
      this.references.delete(this.references.keys().next().value);
    }
  }
}

module.exports = {
  AUTOMATION_WORLD_ID,
  WebContentsPageAdapter,
};
