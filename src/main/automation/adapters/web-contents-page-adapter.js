'use strict';

const crypto = require('crypto');
const { EventEmitter } = require('events');
const { AutomationError, ERROR_CODES } = require('../contract/errors');

const AUTOMATION_WORLD_ID = 1001;
const MAX_PAGE_TEXT_LENGTH = 12_000;
const MAX_SNAPSHOT_ELEMENTS = 250;
const MAX_RETAINED_REFERENCES = 1_000;
const MAX_SELECT_OPTIONS = 100;
const WAIT_POLL_INTERVAL_MS = 100;
const ELECTRON_KEY_CODES = Object.freeze({
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
});
const CHARACTER_KEYS = new Set(['Enter', 'Space']);

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

function collectPageSnapshot(
  maxTextLength,
  maxElements,
  maxRetainedReferences,
  maxSelectOptions,
  snapshotToken
) {
  const stateKey = '__FREEDOM_AUTOMATION_ELEMENT_REFERENCES__';
  const state = globalThis[stateKey] || { refs: new Map() };
  globalThis[stateKey] = state;
  const normalize = (value) =>
    String(value || '')
      .replace(/\s+/g, ' ')
      .trim();
  const visible = (element) => {
    const style = element.ownerDocument.defaultView.getComputedStyle(element);
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
        .map((id) => element.ownerDocument.getElementById(id)?.textContent || '')
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
  const candidateSelector =
    'a[href],button,input:not([type="hidden"]),select,textarea,[role],[contenteditable="true"],[tabindex]:not([tabindex="-1"])';
  const elements = [];
  const frames = [];
  const pageText = [];
  let candidateCount = 0;

  const visitDocument = (frameWindow, parentFrameId, depth, frameElement) => {
    const frameId = depth === 0 ? 'frame_main' : `frame_${snapshotToken}_${String(frames.length)}`;
    let frameDocument;
    try {
      frameDocument = frameWindow.document;
      void frameDocument.documentElement;
    } catch {
      frames.push({
        frameId,
        parentFrameId,
        depth,
        name: frameElement?.getAttribute('name') || '',
        url: frameElement?.src || '',
        accessible: false,
      });
      return;
    }

    frames.push({
      frameId,
      parentFrameId,
      depth,
      name: frameElement?.getAttribute('name') || '',
      url: frameWindow.location.href,
      accessible: true,
    });
    const text = normalize(frameDocument.body?.innerText || '');
    if (text) pageText.push(text);

    const candidates = frameDocument.querySelectorAll(candidateSelector);
    candidateCount += candidates.length;
    for (const element of candidates) {
      if (elements.length >= maxElements || !visible(element)) continue;
      const role = element.getAttribute('role') || implicitRole(element);
      const name = accessibleName(element);
      const ref = `${snapshotToken}_${String(elements.length)}`;
      const tag = element.tagName.toLowerCase();
      const inputType = normalize(element.getAttribute('type')).toLowerCase();
      const submitsForm =
        Boolean(element.form) &&
        ((tag === 'button' && (!inputType || inputType === 'submit')) ||
          (tag === 'input' && ['submit', 'image'].includes(inputType)));
      const downloadsFile = tag === 'a' && element.hasAttribute('href') && element.hasAttribute('download');
      state.refs.set(ref, { element, frameWindow });
      elements.push({
        ref,
        frameId,
        role,
        name,
        tag,
        disabled: element.matches(':disabled') || element.getAttribute('aria-disabled') === 'true',
        focused: element === frameDocument.activeElement,
        editable:
          element.matches('input:not([readonly]),textarea:not([readonly])') ||
          element.isContentEditable,
        ...(downloadsFile
          ? { effect: 'file_download' }
          : submitsForm
            ? { effect: 'form_submission' }
            : {}),
        ...(tag === 'select' && {
          value: element.value,
          options: Array.from(element.options)
            .slice(0, maxSelectOptions)
            .map((option) => ({
              value: option.value,
              label: normalize(option.label || option.textContent),
              disabled: option.disabled,
              selected: option.selected,
            })),
          ...(element.options.length > maxSelectOptions && { optionsTruncated: true }),
        }),
      });
    }

    for (const childFrame of frameDocument.querySelectorAll('iframe,frame')) {
      const childWindow = childFrame.contentWindow;
      if (childWindow) visitDocument(childWindow, frameId, depth + 1, childFrame);
    }
  };

  visitDocument(window, null, 0, null);
  while (state.refs.size > maxRetainedReferences) {
    state.refs.delete(state.refs.keys().next().value);
  }

  return {
    url: window.location.href,
    title: document.title,
    text: normalize(pageText.join(' ')).slice(0, maxTextLength),
    frames,
    elements,
    truncated: candidateCount > elements.length && elements.length >= maxElements,
  };
}

function inspectReferencedElement(ref, action) {
  const state = globalThis.__FREEDOM_AUTOMATION_ELEMENT_REFERENCES__;
  const reference = state?.refs?.get(ref);
  if (!reference) return { ok: false, reason: 'changed' };
  const { element, frameWindow } = reference;
  try {
    if (!element.isConnected || element.ownerDocument !== frameWindow.document) {
      return { ok: false, reason: 'changed' };
    }
  } catch {
    return { ok: false, reason: 'changed' };
  }

  const style = frameWindow.getComputedStyle(element);
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
    let ancestorWindow = frameWindow;
    while (ancestorWindow !== ancestorWindow.top) {
      const ancestorFrame = ancestorWindow.frameElement;
      if (!ancestorFrame) return { ok: false, reason: 'changed' };
      ancestorFrame.scrollIntoView({ block: 'center', inline: 'center' });
      ancestorWindow = ancestorWindow.parent;
    }

    const rect = element.getBoundingClientRect();
    let x = rect.left + rect.width / 2;
    let y = rect.top + rect.height / 2;
    const hit = element.ownerDocument.elementFromPoint(x, y);
    if (!hit || (hit !== element && !element.contains(hit))) {
      return { ok: false, reason: 'not_interactable' };
    }

    let currentWindow = frameWindow;
    while (currentWindow !== currentWindow.top) {
      const currentFrame = currentWindow.frameElement;
      if (!currentFrame) return { ok: false, reason: 'changed' };
      const frameRect = currentFrame.getBoundingClientRect();
      x += frameRect.left + currentFrame.clientLeft;
      y += frameRect.top + currentFrame.clientTop;
      const parentDocument = currentWindow.parent.document;
      const parentHit = parentDocument.elementFromPoint(x, y);
      if (!parentHit || (parentHit !== currentFrame && !currentFrame.contains(parentHit))) {
        return { ok: false, reason: 'not_interactable' };
      }
      currentWindow = currentWindow.parent;
    }
    if (x < 0 || y < 0 || x >= currentWindow.innerWidth || y >= currentWindow.innerHeight) {
      return { ok: false, reason: 'not_interactable' };
    }
    return { ok: true, point: { x: Math.round(x), y: Math.round(y) } };
  }

  const editable =
    element.matches('input:not([readonly]),textarea:not([readonly])') || element.isContentEditable;
  if (action !== 'press' && !editable) return { ok: false, reason: 'not_interactable' };
  element.scrollIntoView({ block: 'center', inline: 'center' });
  element.focus();
  if (element.ownerDocument.activeElement !== element) {
    return { ok: false, reason: 'not_interactable' };
  }
  return { ok: true, contentEditable: element.isContentEditable };
}

async function describeReferencedElement(ref, action, key) {
  const state = globalThis.__FREEDOM_AUTOMATION_ELEMENT_REFERENCES__;
  const reference = state?.refs?.get(ref);
  if (!reference) return { ok: false, reason: 'changed' };
  const { element, frameWindow } = reference;
  try {
    if (!element.isConnected || element.ownerDocument !== frameWindow.document) {
      return { ok: false, reason: 'changed' };
    }
  } catch {
    return { ok: false, reason: 'changed' };
  }

  const normalize = (value) =>
    String(value || '')
      .replace(/\s+/g, ' ')
      .trim();
  const labelledBy = element.getAttribute('aria-labelledby');
  const labelledByText = labelledBy
    ? labelledBy
        .split(/\s+/)
        .map((id) => element.ownerDocument.getElementById(id)?.textContent || '')
        .join(' ')
    : '';
  const label = normalize(
    labelledByText ||
      element.getAttribute('aria-label') ||
      element.getAttribute('title') ||
      element.innerText ||
      element.value
  );
  const tag = element.tagName.toLowerCase();
  const inputType = normalize(element.getAttribute('type')).toLowerCase();
  const submitsForm =
    Boolean(element.form) &&
    ((tag === 'button' && (!inputType || inputType === 'submit')) ||
      (tag === 'input' && ['submit', 'image'].includes(inputType)));
  const activatesElement =
    action === 'click' ||
    action === 'download' ||
    (action === 'press' && ['Enter', 'Space'].includes(key));
  const downloadsFile =
    tag === 'a' &&
    element.hasAttribute('href') &&
    (element.hasAttribute('download') || action === 'download') &&
    activatesElement;
  const implicitlySubmitsForm =
    action === 'press' &&
    key === 'Enter' &&
    Boolean(element.form) &&
    tag === 'input' &&
    ![
      'button',
      'checkbox',
      'color',
      'file',
      'hidden',
      'image',
      'radio',
      'range',
      'reset',
      'submit',
    ].includes(inputType);
  const formSubmission = (submitsForm && activatesElement) || implicitlySubmitsForm;
  let actionLabel = label;
  let navigationTarget = '';
  let formPayloadFingerprint = '';
  if (tag === 'a' && element.hasAttribute('href') && activatesElement) {
    navigationTarget = element.href;
  } else if (formSubmission) {
    const defaultSubmitter = implicitlySubmitsForm
      ? Array.from(element.form.elements).find((candidate) => {
          const candidateTag = candidate.tagName?.toLowerCase();
          const candidateType = normalize(candidate.getAttribute?.('type')).toLowerCase();
          return (
            !candidate.disabled &&
            ((candidateTag === 'button' && (!candidateType || candidateType === 'submit')) ||
              (candidateTag === 'input' && ['submit', 'image'].includes(candidateType)))
          );
        })
      : element;
    if (implicitlySubmitsForm && defaultSubmitter) {
      actionLabel = normalize(
        defaultSubmitter.getAttribute('aria-label') ||
          defaultSubmitter.getAttribute('title') ||
          defaultSubmitter.innerText ||
          defaultSubmitter.value ||
          label
      );
    }
    navigationTarget = defaultSubmitter?.hasAttribute('formaction')
      ? defaultSubmitter.formAction
      : element.form.action;
    const formWindow = element.ownerDocument.defaultView;
    const formData = defaultSubmitter
      ? new formWindow.FormData(element.form, defaultSubmitter)
      : new formWindow.FormData(element.form);
    const entries = Array.from(formData.entries(), ([name, value]) => [
      name,
      typeof value === 'string'
        ? { kind: 'text', value }
        : {
            kind: 'file',
            name: value.name,
            size: value.size,
            type: value.type,
            lastModified: value.lastModified,
          },
    ]);
    const serializedPayload = JSON.stringify({
      action: navigationTarget,
      method: defaultSubmitter?.hasAttribute('formmethod')
        ? defaultSubmitter.formMethod
        : element.form.method,
      enctype: defaultSubmitter?.hasAttribute('formenctype')
        ? defaultSubmitter.formEnctype
        : element.form.enctype,
      target: defaultSubmitter?.hasAttribute('formtarget')
        ? defaultSubmitter.formTarget
        : element.form.target,
      entries,
    });
    const payloadDigest = await formWindow.crypto.subtle.digest(
      'SHA-256',
      new formWindow.TextEncoder().encode(serializedPayload)
    );
    formPayloadFingerprint = Array.from(new Uint8Array(payloadDigest), (byte) =>
      byte.toString(16).padStart(2, '0')
    ).join('');
  }
  return {
    ok: true,
    label: actionLabel,
    ...(downloadsFile
      ? { effect: 'file_download' }
      : formSubmission
        ? { effect: 'form_submission' }
        : {}),
    ...(navigationTarget && { navigationTarget }),
    ...(formPayloadFingerprint && { formPayloadFingerprint }),
  };
}

function selectOptionByValue(ref, value) {
  const inspected = inspectReferencedElement(ref, 'press');
  if (!inspected.ok) return inspected;
  const { element, frameWindow } =
    globalThis.__FREEDOM_AUTOMATION_ELEMENT_REFERENCES__.refs.get(ref);
  if (element.tagName.toLowerCase() !== 'select' || element.multiple || element.size > 1) {
    return { ok: false, reason: 'unsupported_select' };
  }
  const option = Array.from(element.options).find(
    (candidate) => candidate.value === value && !candidate.disabled
  );
  if (!option) return { ok: false, reason: 'option_unavailable' };
  const valueSetter = Object.getOwnPropertyDescriptor(
    frameWindow.HTMLSelectElement.prototype,
    'value'
  )?.set;
  if (typeof valueSetter !== 'function') return { ok: false, reason: 'unsupported_select' };
  valueSetter.call(element, value);
  element.dispatchEvent(new frameWindow.Event('input', { bubbles: true }));
  element.dispatchEvent(new frameWindow.Event('change', { bubbles: true }));
  return element.value === value
    ? { ok: true, trusted: false }
    : { ok: false, reason: 'selection_not_applied' };
}

function prepareTextInsertion(ref, replace) {
  const inspected = inspectReferencedElement(ref, 'type');
  if (!inspected.ok) return inspected;
  const element = globalThis.__FREEDOM_AUTOMATION_ELEMENT_REFERENCES__.refs.get(ref).element;
  if (replace && typeof element.select === 'function') {
    element.select();
  } else if (replace && element.isContentEditable) {
    const selection = element.ownerDocument.defaultView.getSelection();
    const range = element.ownerDocument.createRange();
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
  const containsText = (frameWindow) => {
    try {
      if (String(frameWindow.document.body?.innerText || '').includes(text)) return true;
      for (const childFrame of frameWindow.document.querySelectorAll('iframe,frame')) {
        if (childFrame.contentWindow && containsText(childFrame.contentWindow)) return true;
      }
    } catch {
      return false;
    }
    return false;
  };
  return containsText(window);
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
    this.navigateHandler = options.navigate || null;
    this.stopLoadingHandler = options.stopLoading || null;
    this.references = new Map();
    this.activeWaits = new Set();
    this.listeners = {
      'did-start-navigation': (_event, _url, isInPlace, isMainFrame) => {
        if (isInPlace === true) return;
        if (isMainFrame !== false) this.navigationInProgress = true;
        this.navigationId += 1;
        this.#pruneReferences();
        if (isMainFrame !== false) this.emit('navigation-started', this.getState());
      },
      'did-navigate': () => {
        this.navigationInProgress = false;
        this.emit('navigation-committed', this.getState());
      },
      'did-navigate-in-page': (_event, _url, isMainFrame) => {
        this.navigationId += 1;
        this.#pruneReferences();
        if (isMainFrame !== false) this.emit('navigation-committed', this.getState());
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
      if (this.navigateHandler) {
        await this.navigateHandler(url);
      } else {
        await this.webContents.loadURL(url);
      }
    } catch (error) {
      if (error instanceof AutomationError) throw error;
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
    const snapshotToken = this.referenceIdFactory();
    const snapshot = await this.#execute(
      collectPageSnapshot,
      [
        MAX_PAGE_TEXT_LENGTH,
        MAX_SNAPSHOT_ELEMENTS,
        MAX_RETAINED_REFERENCES,
        MAX_SELECT_OPTIONS,
        snapshotToken,
      ],
      false
    );
    if (!snapshot || !Array.isArray(snapshot.elements)) {
      throw new AutomationError(
        ERROR_CODES.CAPABILITY_UNAVAILABLE,
        'The page did not produce a semantic snapshot'
      );
    }
    if (navigationId !== this.navigationId) throw this.#staleReferenceError();

    const elements = snapshot.elements.map((publicNode) => {
      this.references.set(publicNode.ref, { navigationId, effect: publicNode.effect || '' });
      return publicNode;
    });
    this.#pruneReferences();
    return { ...snapshot, elements, navigationId };
  }

  async click(ref) {
    this.#assertAvailable();
    const reference = this.#requireReference(ref);
    if (reference.effect === 'file_download') {
      throw new AutomationError(
        ERROR_CODES.CAPABILITY_UNAVAILABLE,
        'Use browser_download for file downloads so Freedom can track the artifact',
        { retryable: true }
      );
    }
    return this.#trustedClick(ref);
  }

  async download(ref) {
    this.#assertAvailable();
    this.#requireReference(ref);
    const described = await this.#execute(describeReferencedElement, [ref, 'download', ''], false);
    this.#assertActionResult(described);
    if (described.effect !== 'file_download') {
      throw new AutomationError(
        ERROR_CODES.ELEMENT_NOT_INTERACTABLE,
        'The referenced element is not a downloadable link'
      );
    }
    return this.#trustedClick(ref);
  }

  async #trustedClick(ref) {
    const result = await this.#execute(inspectReferencedElement, [ref, 'click'], true);
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
    const confirmed = await this.#execute(inspectReferencedElement, [ref, 'click'], true);
    this.#assertActionResult(confirmed);
    if (!confirmed.point) {
      throw new AutomationError(
        ERROR_CODES.CAPABILITY_UNAVAILABLE,
        'Trusted pointer input is unavailable for this page'
      );
    }
    const confirmedPointer = {
      x: confirmed.point.x,
      y: confirmed.point.y,
      button: 'left',
    };
    this.webContents.sendInputEvent({ type: 'mouseDown', ...confirmedPointer, clickCount: 1 });
    this.webContents.sendInputEvent({ type: 'mouseUp', ...confirmedPointer, clickCount: 1 });
    return { clicked: true, ref };
  }

  async inspectAction(ref, { operation = 'browser_click', key = '' } = {}) {
    this.#assertAvailable();
    this.#requireReference(ref);
    const action =
      operation === 'browser_press'
        ? 'press'
        : operation === 'browser_type'
          ? 'type'
          : operation === 'browser_select'
            ? 'select'
            : 'click';
    if (action === 'press') {
      const prepared = await this.#execute(inspectReferencedElement, [ref, action], true);
      this.#assertActionResult(prepared);
    }
    const describeAction = operation === 'browser_download' ? 'download' : action;
    const result = await this.#execute(
      describeReferencedElement,
      [ref, describeAction, key],
      false
    );
    this.#assertActionResult(result);
    return {
      label: typeof result.label === 'string' ? result.label : '',
      ...(['form_submission', 'file_download'].includes(result.effect) && {
        effect: result.effect,
      }),
      ...(typeof result.navigationTarget === 'string' &&
        result.navigationTarget && { navigationTarget: result.navigationTarget }),
      ...(typeof result.formPayloadFingerprint === 'string' &&
        result.formPayloadFingerprint && {
          formPayloadFingerprint: result.formPayloadFingerprint,
        }),
    };
  }

  async type(ref, text, { replace = true } = {}) {
    this.#assertAvailable();
    this.#requireReference(ref);
    const result = await this.#execute(prepareTextInsertion, [ref, replace], true, [
      inspectReferencedElement,
    ]);
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

  async select(ref, value) {
    this.#assertAvailable();
    this.#requireReference(ref);
    const result = await this.#execute(selectOptionByValue, [ref, value], true, [
      inspectReferencedElement,
    ]);
    this.#assertSelectResult(result);
    return { selected: true, ref, value, trusted: result.trusted === true };
  }

  async press(ref, key) {
    this.#assertAvailable();
    this.#requireReference(ref);
    const prepared = await this.#execute(inspectReferencedElement, [ref, 'press'], true);
    this.#assertActionResult(prepared);
    this.#requireTrustedKeyInput();
    this.webContents.focus?.();
    this.#sendKey(key);
    return { pressed: true, ref, key };
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
    if (this.stopLoadingHandler) {
      await this.stopLoadingHandler();
    } else {
      this.webContents.stop?.();
    }
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

  #assertSelectResult(result) {
    if (result?.ok) return;
    if (result?.reason === 'unsupported_select') {
      throw new AutomationError(
        ERROR_CODES.CAPABILITY_UNAVAILABLE,
        'Only single-select controls are supported'
      );
    }
    if (result?.reason === 'option_unavailable') {
      throw new AutomationError(
        ERROR_CODES.ELEMENT_NOT_FOUND,
        'The requested select option is unavailable',
        { retryable: true, suggestedAction: 'Take a new snapshot' }
      );
    }
    if (result?.reason === 'selection_not_applied') {
      throw new AutomationError(
        ERROR_CODES.ELEMENT_NOT_INTERACTABLE,
        'The requested select option could not be applied',
        { retryable: true, suggestedAction: 'Take a new snapshot' }
      );
    }
    this.#assertActionResult(result);
  }

  #requireTrustedKeyInput() {
    if (typeof this.webContents.sendInputEvent !== 'function') {
      throw new AutomationError(
        ERROR_CODES.CAPABILITY_UNAVAILABLE,
        'Trusted keyboard input is unavailable for this page'
      );
    }
  }

  #sendKey(key) {
    const keyCode = ELECTRON_KEY_CODES[key] || key;
    this.webContents.sendInputEvent({ type: 'keyDown', keyCode });
    if (CHARACTER_KEYS.has(key)) {
      this.webContents.sendInputEvent({ type: 'char', keyCode });
    }
    this.webContents.sendInputEvent({ type: 'keyUp', keyCode });
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
      case 'text': {
        const navigationId = this.navigationId;
        try {
          const matched = await this.#execute(pageContainsText, [options.text], false);
          return navigationId === this.navigationId && matched === true;
        } catch (error) {
          this.#assertAvailable();
          if (
            navigationId !== this.navigationId ||
            this.navigationInProgress ||
            this.webContents.isLoading?.() === true
          ) {
            return false;
          }
          throw error;
        }
      }
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
