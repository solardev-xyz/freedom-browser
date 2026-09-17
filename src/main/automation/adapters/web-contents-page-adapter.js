'use strict';

const crypto = require('crypto');
const { EventEmitter } = require('events');
const { AutomationError, ERROR_CODES } = require('../contract/errors');
const { OwnedFrameObserver } = require('./owned-frame-observer');

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
const UPLOAD_MARKER_ATTRIBUTE = 'data-freedom-agent-upload';

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

// Shared by observations and approval inspection. This is a bounded-purpose
// DOM name fallback, not a complete implementation of the accessible-name spec.
function readElementName(element) {
  const normalize = (value) =>
    String(value || '')
      .replace(/\s+/g, ' ')
      .trim();
  const labelledBy = element.getAttribute('aria-labelledby');
  if (labelledBy) {
    const root = element.getRootNode();
    const name = normalize(
      labelledBy
        .split(/\s+/)
        .map((id) => root.getElementById?.(id)?.textContent || '')
        .join(' ')
    );
    if (name) return name;
  }
  const ariaLabel = normalize(element.getAttribute('aria-label'));
  if (ariaLabel) return ariaLabel;
  // The browser resolves explicit, wrapping and multiple labels in tree order,
  // within the control's own document/shadow root.
  const associatedLabel = normalize(
    Array.from(element.labels || [], (label) => {
      const parts = [];
      const walker = label.ownerDocument.createTreeWalker(label, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        // A wrapping label must not absorb the labelled control's own subtree
        // (notably every option of a select or the contents of a textarea).
        if (!element.contains(node)) parts.push(node.textContent || '');
      }
      return parts.join('');
    }).join(' ')
  );
  if (associatedLabel) return associatedLabel;
  return normalize(
    element.getAttribute('alt') ||
      element.getAttribute('title') ||
      element.getAttribute('placeholder') ||
      element.innerText ||
      (element.tagName === 'INPUT' && ['button', 'submit', 'reset'].includes(element.type)
        ? element.value
        : '')
  );
}

function readScrollState(element) {
  const view = element.ownerDocument.defaultView;
  const style = view.getComputedStyle(element);
  const isViewport = element === element.ownerDocument.scrollingElement;
  const permits = (overflow) =>
    isViewport ? !['hidden', 'clip'].includes(overflow) : ['auto', 'scroll'].includes(overflow);
  const width = isViewport ? view.innerWidth : element.clientWidth;
  const height = isViewport ? view.innerHeight : element.clientHeight;
  const rangeX = Math.max(0, element.scrollWidth - element.clientWidth);
  const rangeY = Math.max(0, element.scrollHeight - element.clientHeight);
  const rtl = style.direction === 'rtl';
  return {
    x: element.scrollLeft,
    y: element.scrollTop,
    width,
    height,
    minX: rtl ? -rangeX : 0,
    maxX: rtl ? 0 : rangeX,
    maxY: rangeY,
    horizontal: permits(style.overflowX) && rangeX > 1,
    vertical: permits(style.overflowY) && rangeY > 1,
  };
}

// No scrolling/focusing during inspection. Only wheel points whose nearest
// scroll container is the requested reference are eligible; this avoids
// accidentally scrolling an inner list when the caller requested the page.
function inspectScrollReference(ref, direction, requirePoint = true) {
  const reference = globalThis.__FREEDOM_AUTOMATION_ELEMENT_REFERENCES__?.refs?.get(ref);
  if (!reference) return { ok: false, reason: 'changed' };
  const { element, frameWindow } = reference;
  if (!reference.scrollTarget) return { ok: false, reason: 'not_interactable' };
  try {
    if (!element.isConnected || element.ownerDocument !== frameWindow.document) {
      return { ok: false, reason: 'changed' };
    }
    const scroll = readScrollState(element);
    if (!requirePoint) return { ok: true, scroll };
    const horizontal = ['left', 'right'].includes(direction);
    const axis = horizontal ? 'horizontal' : 'vertical';
    if (!scroll[axis]) return { ok: true, scroll, boundary: true };
    const coordinate = horizontal ? scroll.x : scroll.y;
    const minimum = horizontal ? scroll.minX : 0;
    const maximum = horizontal ? scroll.maxX : scroll.maxY;
    const forward = ['down', 'right'].includes(direction);
    if (forward ? coordinate >= maximum - 1 : coordinate <= minimum + 1) {
      return { ok: true, scroll, boundary: true };
    }
    const parentOf = (node) => node.parentElement || node.getRootNode()?.host;
    const deepestHit = (root, x, y) => {
      let hit = root.elementFromPoint(x, y);
      while (hit?.shadowRoot) {
        const nested = hit.shadowRoot.elementFromPoint(x, y);
        if (!nested || nested === hit) break;
        hit = nested;
      }
      return hit;
    };
    const isViewport = element === element.ownerDocument.scrollingElement;
    const rect = isViewport
      ? { left: 0, top: 0, right: frameWindow.innerWidth, bottom: frameWindow.innerHeight }
      : element.getBoundingClientRect();
    const left = Math.max(0, rect.left),
      top = Math.max(0, rect.top);
    const right = Math.min(frameWindow.innerWidth, rect.right);
    const bottom = Math.min(frameWindow.innerHeight, rect.bottom);
    if (right - left < 2 || bottom - top < 2) return { ok: false, reason: 'not_interactable' };
    for (const fy of [0.5, 0.15, 0.85]) {
      for (const fx of [0.5, 0.15, 0.85]) {
        let x = Math.floor(left + (right - left) * fx);
        let y = Math.floor(top + (bottom - top) * fy);
        let hit = deepestHit(element.ownerDocument, x, y);
        let nearest = null;
        while (hit) {
          if (readScrollState(hit)[axis]) {
            nearest = hit;
            break;
          }
          hit = parentOf(hit);
        }
        if (nearest !== element) continue;
        let view = frameWindow;
        let usable = true;
        while (view !== view.top) {
          const frame = view.frameElement;
          if (!frame) return { ok: false, reason: 'changed' };
          // Coordinate conversion below supports ordinary same-origin frames.
          // Transformed frames require a different geometry path.
          for (let ancestor = frame; ancestor; ancestor = parentOf(ancestor)) {
            if (ancestor.ownerDocument.defaultView.getComputedStyle(ancestor).transform !== 'none')
              usable = false;
          }
          const frameRect = frame.getBoundingClientRect();
          x += frameRect.left + frame.clientLeft;
          y += frameRect.top + frame.clientTop;
          view = view.parent;
          if (deepestHit(view.document, x, y) !== frame) usable = false;
        }
        if (usable && x >= 0 && y >= 0 && x < view.innerWidth && y < view.innerHeight) {
          return { ok: true, scroll, point: { x: Math.round(x), y: Math.round(y) } };
        }
      }
    }
    return { ok: false, reason: 'not_interactable' };
  } catch {
    return { ok: false, reason: 'changed' };
  }
}

function readControlState(element, role) {
  const checkedRoles = new Set([
    'checkbox',
    'radio',
    'switch',
    'menuitemcheckbox',
    'menuitemradio',
    'option',
    'treeitem',
  ]);
  const selectedRoles = new Set([
    'option',
    'tab',
    'row',
    'gridcell',
    'columnheader',
    'rowheader',
    'treeitem',
  ]);
  const expandedRoles = new Set([
    'application',
    'button',
    'checkbox',
    'combobox',
    'gridcell',
    'link',
    'listbox',
    'menuitem',
    'row',
    'rowheader',
    'columnheader',
    'tab',
    'treeitem',
    'menuitemcheckbox',
    'menuitemradio',
    'switch',
  ]);
  const result = {};
  const ariaState = (attribute, mixed = false) => {
    const value = element.getAttribute(attribute)?.trim().toLowerCase();
    if (value === 'true' || value === 'false') return value === 'true';
    if (mixed && value === 'mixed') return 'mixed';
    return undefined;
  };
  const add = (key, value) => {
    if (value !== undefined) result[key] = value;
  };
  if (element.tagName === 'INPUT' && ['checkbox', 'radio'].includes(element.type)) {
    // Native state wins over conflicting ARIA markup.
    result.checked =
      element.type === 'checkbox' && element.indeterminate ? 'mixed' : element.checked;
  } else if (checkedRoles.has(role)) {
    const checked = ariaState('aria-checked', true);
    add(
      'checked',
      checked === 'mixed' && ['radio', 'menuitemradio', 'switch'].includes(role) ? false : checked
    );
  }
  if (role === 'button') add('pressed', ariaState('aria-pressed', true));
  if (selectedRoles.has(role)) add('selected', ariaState('aria-selected'));
  if (expandedRoles.has(role)) add('expanded', ariaState('aria-expanded'));
  return result;
}

function collectPageSnapshot(
  maxTextLength,
  maxElements,
  maxRetainedReferences,
  maxSelectOptions,
  snapshotToken,
  { query = '', textQuery = '', elementOffset = 0, textOffset = 0 } = {}
) {
  const stateKey = '__FREEDOM_AUTOMATION_ELEMENT_REFERENCES__';
  const state = globalThis[stateKey] || { refs: new Map() };
  globalThis[stateKey] = state;
  const normalize = (value) =>
    String(value || '')
      .replace(/\s+/g, ' ')
      .trim();
  let fieldsTruncated = false;
  const shorten = (value, limit = 2_000) => {
    const text = String(value || '');
    if (text.length <= limit) return text;
    fieldsTruncated = true;
    const end = /[\uD800-\uDBFF]/.test(text[limit - 1]) ? limit - 1 : limit;
    return text.slice(0, end);
  };
  const displayField = (key, value, limit) => {
    const text = String(value || '');
    return {
      [key]: shorten(text, limit),
      ...(text.length > (limit || 2_000) && { [`${key}Truncated`]: true }),
    };
  };
  // URL and option values are identities, not display text. Omit oversized
  // values rather than returning a shortened string that looks actionable.
  const exactField = (key, value, limit) => {
    if (value.length <= limit) return { [key]: value };
    fieldsTruncated = true;
    return { [`${key}Omitted`]: true };
  };
  const encodedSize = (value) => new TextEncoder().encode(JSON.stringify(value)).length;
  let elementBytes = 0;
  let elementBudgetReached = false;
  let frameBytes = 0;
  const addFrame = (frame) => {
    if (frameBytes + encodedSize(frame) > 32_000) {
      fieldsTruncated = true;
      frame = {
        frameId: frame.frameId,
        parentFrameId: frame.parentFrameId,
        depth: frame.depth,
        accessible: frame.accessible,
        ...(frame.viewport && { viewport: frame.viewport }),
        metadataOmitted: true,
      };
    }
    frameBytes += encodedSize(frame);
    frames.push(frame);
  };
  const selectState = (element) => {
    const result = { ...exactField('value', element.value, 2_000), options: [] };
    let bytes = 0;
    for (let index = 0; index < Math.min(element.options.length, maxSelectOptions); index += 1) {
      const option = element.options[index];
      if (option.value.length > 2_000) {
        result.optionsTruncated = true;
        continue;
      }
      const entry = {
        value: option.value,
        ...displayField('label', normalize(option.label || option.textContent)),
        disabled: option.matches(':disabled'),
        selected: option.selected,
      };
      const size = encodedSize(entry);
      if (bytes + size > 8_000) {
        result.optionsTruncated = true;
        continue;
      }
      bytes += size;
      result.options.push(entry);
    }
    if (element.options.length > maxSelectOptions) result.optionsTruncated = true;
    if (result.optionsTruncated) fieldsTruncated = true;
    return result;
  };
  const styleCache = new WeakMap();
  const styleFor = (element) => {
    let style = styleCache.get(element);
    if (!style) {
      style = element.ownerDocument.defaultView.getComputedStyle(element);
      styleCache.set(element, style);
    }
    return style;
  };
  const visible = (element) => {
    const style = styleFor(element);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
      return false;
    }
    return element.getClientRects().length > 0;
  };
  const implicitRole = (element) => {
    const tag = element.tagName.toLowerCase();
    if (tag === 'a' && element.hasAttribute('href')) return 'link';
    if (tag === 'button') return 'button';
    if (tag === 'select') return element.multiple || element.size > 1 ? 'listbox' : 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'input') {
      if (element.type === 'file') return 'button';
      if (['button', 'submit', 'reset'].includes(element.type)) return 'button';
      if (element.type === 'checkbox') return 'checkbox';
      if (element.type === 'radio') return 'radio';
      if (element.type === 'range') return 'slider';
      return 'textbox';
    }
    return element.isContentEditable ? 'textbox' : 'generic';
  };
  const semanticCandidateSelector =
    'a[href],button,input:not([type="hidden"]),select,textarea,[role],[contenteditable="true"],[tabindex]:not([tabindex="-1"])';
  const isExplicitClickTarget = (element) =>
    element.hasAttribute('onclick') || typeof element.onclick === 'function';
  const isPointerBoundary = (element) => {
    if (['HTML', 'BODY'].includes(element.tagName)) return false;
    if (styleFor(element).cursor !== 'pointer') return false;
    const parent = element.parentElement;
    // Cursor is inherited. Keep the outer boundary so a clickable card and
    // each of its text/icon descendants do not all become separate targets.
    return !parent || styleFor(parent).cursor !== 'pointer';
  };
  const elements = [];
  const frames = [];
  const pageText = [];
  const textSources = [];
  let collectedTextLength = 0;
  let candidateCount = 0;
  let visitedNodes = 0;
  let scanTruncated = false;
  let textCollectionTruncated = false;
  let remainingText = 1_000_000;
  const search = normalize(query).toLowerCase();

  const composedActiveElement = (frameDocument) => {
    let active = frameDocument.activeElement;
    while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
    return active;
  };

  const visitDocument = (frameWindow, parentFrameId, depth, frameElement) => {
    if (depth > 16 || frames.length >= 64 || visitedNodes >= 20_000) {
      scanTruncated = true;
      return;
    }
    const frameId = depth === 0 ? 'frame_main' : `frame_${snapshotToken}_${String(frames.length)}`;
    let frameDocument;
    try {
      frameDocument = frameWindow.document;
      void frameDocument.documentElement;
    } catch {
      addFrame({
        frameId,
        parentFrameId,
        depth,
        ...displayField('name', frameElement?.getAttribute('name') || ''),
        ...exactField('url', frameElement?.src || '', 8_192),
        accessible: false,
      });
      return;
    }

    const viewportRef = `${frameId}_${snapshotToken}_viewport`;
    const scrollingElement = frameDocument.scrollingElement;
    const viewport = scrollingElement
      ? { ref: viewportRef, ...readScrollState(scrollingElement) }
      : null;
    if (scrollingElement)
      state.refs.set(viewportRef, { element: scrollingElement, frameWindow, scrollTarget: true });
    addFrame({
      ...(viewport && { viewport }),
      frameId,
      parentFrameId,
      depth,
      ...displayField('name', frameElement?.getAttribute('name') || ''),
      ...exactField('url', frameWindow.location.href, 8_192),
      accessible: true,
    });
    // innerText retains the browser's rendered-text semantics. Its layout cost
    // is browser-owned; these limits bound retained text and our own traversal,
    // not a hard deadline for Chromium's layout work.
    const rawText = frameDocument.body?.innerText || '';
    if (rawText.length > remainingText) textCollectionTruncated = true;
    const text = normalize(rawText.slice(0, remainingText));
    remainingText = Math.max(0, remainingText - rawText.length);
    if (text) {
      const start = collectedTextLength + (pageText.length ? 1 : 0);
      pageText.push(text);
      textSources.push({ frameId, start, end: start + text.length });
      collectedTextLength = start + text.length;
    }

    const childFrames = [];
    const visitRoot = (root, shadowDepth = 0) => {
      if (shadowDepth > 16) {
        scanTruncated = true;
        return;
      }
      const shadowRoots = [];
      const walker = frameDocument.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
      for (let element = walker.nextNode(); element; element = walker.nextNode()) {
        if (visitedNodes >= 20_000) {
          scanTruncated = true;
          break;
        }
        visitedNodes += 1;
        if (element.shadowRoot) shadowRoots.push(element.shadowRoot);
        if (element.matches('iframe,frame')) childFrames.push(element);
        if (element === frameDocument.scrollingElement) continue;
        const scroll = readScrollState(element);
        const scrollable = scroll.horizontal || scroll.vertical;
        const semantic = element.matches(semanticCandidateSelector);
        const inferred =
          !semantic && (isExplicitClickTarget(element) || isPointerBoundary(element));
        if (!semantic && !inferred && !scrollable) continue;
        if (!visible(element)) continue;
        const name = readElementName(element);
        if (inferred && !name && !scrollable) continue;
        if (search && !name.toLowerCase().includes(search)) continue;
        candidateCount += 1;
        if (
          candidateCount <= elementOffset ||
          elements.length >= maxElements ||
          elementBudgetReached
        )
          continue;
        const role =
          element.getAttribute('role') ||
          (inferred ? 'button' : scrollable && !semantic ? 'region' : implicitRole(element));
        const ref = `${snapshotToken}_${String(elements.length)}`;
        const tag = element.tagName.toLowerCase();
        const inputType = normalize(element.getAttribute('type')).toLowerCase();
        const uploadsFile = tag === 'input' && inputType === 'file';
        const submitsForm =
          Boolean(element.form) &&
          ((tag === 'button' && (!inputType || inputType === 'submit')) ||
            (tag === 'input' && ['submit', 'image'].includes(inputType)));
        const downloadsFile =
          tag === 'a' && element.hasAttribute('href') && element.hasAttribute('download');
        const entry = {
          ref,
          frameId,
          ...displayField('role', role, 128),
          ...displayField('name', name),
          ...displayField('tag', tag, 128),
          ...(inferred && { inferred: true }),
          disabled:
            element.matches(':disabled') || element.getAttribute('aria-disabled') === 'true',
          focused: element === composedActiveElement(frameDocument),
          editable:
            (!uploadsFile && element.matches('input:not([readonly]),textarea:not([readonly])')) ||
            element.isContentEditable,
          ...readControlState(element, role),
          ...(scrollable && { scrollable: scroll }),
          ...(scrollable && !semantic && !inferred && { scrollOnly: true }),
          ...(uploadsFile
            ? { effect: 'file_upload' }
            : downloadsFile
              ? { effect: 'file_download' }
              : submitsForm
                ? { effect: 'form_submission' }
                : {}),
          ...(uploadsFile && {
            accept: normalize(element.getAttribute('accept')).slice(0, 500),
            multiple: element.multiple === true,
          }),
          ...(tag === 'select' && selectState(element)),
        };
        const size = encodedSize(entry);
        if (elementBytes + size > 128_000) {
          elementBudgetReached = true;
          continue;
        }
        elementBytes += size;
        state.refs.set(ref, { element, frameWindow, scrollTarget: scrollable });
        elements.push(entry);
      }
      for (const shadowRoot of shadowRoots) {
        if (visitedNodes >= 20_000) {
          scanTruncated = true;
          break;
        }
        visitRoot(shadowRoot, shadowDepth + 1);
      }
    };

    visitRoot(frameDocument);

    for (const childFrame of childFrames) {
      const childWindow = childFrame.contentWindow;
      if (childWindow) visitDocument(childWindow, frameId, depth + 1, childFrame);
    }
  };

  visitDocument(window, null, 0, null);
  while (state.refs.size > maxRetainedReferences) {
    state.refs.delete(state.refs.keys().next().value);
  }

  const fullText = pageText.join(' ');
  // Offsets count UTF-16 code units, but emitted pages must not split a pair.
  let textStart = Math.min(textOffset, fullText.length);
  if (
    textStart > 0 &&
    /[\uDC00-\uDFFF]/.test(fullText[textStart] || '') &&
    /[\uD800-\uDBFF]/.test(fullText[textStart - 1])
  )
    textStart -= 1;
  let textMatch = null;
  let excerptLength = maxTextLength;
  if (textQuery) {
    // Escape literal text rather than allowing model-supplied regular expressions.
    // Unicode regexp indices stay in the original text, unlike lowercasing it
    // first (which can change the length of characters such as dotted I).
    const literal = normalize(textQuery).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    let matchedSource;
    for (const source of textSources) {
      const from = Math.max(textStart, source.start);
      if (from >= source.end) continue;
      const match = new RegExp(literal, 'iu').exec(fullText.slice(from, source.end));
      if (!match) continue;
      const start = from + match.index;
      textMatch = { start, end: start + match[0].length, frameId: source.frameId };
      matchedSource = source;
      break;
    }
    if (textMatch) {
      textStart = Math.max(matchedSource.start, textMatch.start - 240);
      if (/[\uDC00-\uDFFF]/.test(fullText[textStart] || '') && textStart > 0) textStart -= 1;
      excerptLength = Math.min(matchedSource.end, textMatch.end + 240) - textStart;
    } else {
      excerptLength = 0;
    }
  }
  let textEnd = Math.min(textStart + excerptLength, fullText.length);
  if (
    textEnd < fullText.length &&
    /[\uDC00-\uDFFF]/.test(fullText[textEnd]) &&
    /[\uD800-\uDBFF]/.test(fullText[textEnd - 1])
  )
    textEnd -= 1;
  const moreElements = candidateCount > elementOffset + elements.length;
  const moreText = textEnd < fullText.length;

  return {
    ...exactField('url', window.location.href, 8_192),
    ...displayField('title', document.title),
    text: fullText.slice(textStart, textEnd),
    frames,
    elements,
    elementOffset,
    textOffset: textStart,
    ...(query && { query }),
    ...(moreElements && { nextElementOffset: elementOffset + elements.length }),
    ...(!textQuery && moreText && { nextTextOffset: textEnd }),
    ...(textQuery && {
      textQuery,
      textMatch,
      ...(textMatch && textMatch.end < fullText.length && { nextMatchOffset: textMatch.end }),
    }),
    elementsTruncated: moreElements || scanTruncated,
    textTruncated: moreText || textCollectionTruncated || scanTruncated,
    scanTruncated,
    textCollectionTruncated,
    fieldsTruncated,
    truncated:
      moreElements || moreText || scanTruncated || textCollectionTruncated || fieldsTruncated,
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

  if (action === 'verify_focus') {
    let active = element.ownerDocument.activeElement;
    while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
    return active === element ? { ok: true } : { ok: false, reason: 'not_interactable' };
  }

  if (action === 'upload') {
    const tag = element.tagName.toLowerCase();
    const inputType = String(element.getAttribute('type') || '').toLowerCase();
    return tag === 'input' && inputType === 'file'
      ? { ok: true }
      : { ok: false, reason: 'not_interactable' };
  }

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
    const deepElementFromPoint = (root, pointX, pointY) => {
      let hit = root.elementFromPoint(pointX, pointY);
      while (hit?.shadowRoot) {
        const nested = hit.shadowRoot.elementFromPoint(pointX, pointY);
        if (!nested || nested === hit) break;
        hit = nested;
      }
      return hit;
    };
    const hit = deepElementFromPoint(element.ownerDocument, x, y);
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
      const parentHit = deepElementFromPoint(parentDocument, x, y);
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
  let active = element.ownerDocument.activeElement;
  while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
  if (active !== element) {
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
  const label = readElementName(element);
  const tag = element.tagName.toLowerCase();
  const inputType = normalize(element.getAttribute('type')).toLowerCase();
  const uploadsFile = action === 'upload' && tag === 'input' && inputType === 'file';
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
    ...(uploadsFile
      ? { effect: 'file_upload' }
      : downloadsFile
        ? { effect: 'file_download' }
        : formSubmission
          ? { effect: 'form_submission' }
          : {}),
    ...(uploadsFile && {
      accept: normalize(element.getAttribute('accept')).slice(0, 500),
      multiple: element.multiple === true,
    }),
    ...(navigationTarget && { navigationTarget }),
    ...(formPayloadFingerprint && { formPayloadFingerprint }),
  };
}

function markReferencedFileInput(ref, marker) {
  const inspected = inspectReferencedElement(ref, 'upload');
  if (!inspected.ok) return inspected;
  const element = globalThis.__FREEDOM_AUTOMATION_ELEMENT_REFERENCES__.refs.get(ref).element;
  element.setAttribute('data-freedom-agent-upload', marker);
  return { ok: true };
}

function clearReferencedFileInputMarker(ref, marker) {
  const reference = globalThis.__FREEDOM_AUTOMATION_ELEMENT_REFERENCES__?.refs?.get(ref);
  const element = reference?.element;
  if (element?.getAttribute('data-freedom-agent-upload') === marker) {
    element.removeAttribute('data-freedom-agent-upload');
  }
  return { ok: true };
}

function describeAttachedFile(ref) {
  const inspected = inspectReferencedElement(ref, 'upload');
  if (!inspected.ok) return inspected;
  const element = globalThis.__FREEDOM_AUTOMATION_ELEMENT_REFERENCES__.refs.get(ref).element;
  const file = element.files?.[0];
  if (!file) return { ok: false, reason: 'selection_not_applied' };
  return {
    ok: true,
    filename: String(file.name || '').slice(0, 255),
    bytes: Number.isSafeInteger(file.size) && file.size >= 0 ? file.size : 0,
    mimeType: String(file.type || '').slice(0, 200),
    fileCount: element.files.length,
  };
}

function selectOptionByValue(ref, value) {
  const inspected = inspectReferencedElement(ref, 'press');
  if (!inspected.ok) return inspected;
  const { element, frameWindow } =
    globalThis.__FREEDOM_AUTOMATION_ELEMENT_REFERENCES__.refs.get(ref);
  if (element.tagName.toLowerCase() !== 'select' || element.multiple) {
    return { ok: false, reason: 'unsupported_select' };
  }
  const option = Array.from(element.options).find(
    (candidate) => candidate.value === value && !candidate.matches(':disabled')
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

function referencedElementMatchesState(ref, expectedState) {
  const reference = globalThis.__FREEDOM_AUTOMATION_ELEMENT_REFERENCES__?.refs?.get(ref);
  if (!reference) return { ok: false, reason: 'changed' };
  const { element, frameWindow } = reference;
  try {
    if (element.ownerDocument !== frameWindow.document) return { ok: false, reason: 'changed' };
    if (!element.isConnected) return { ok: true, matched: expectedState === 'hidden' };
    const style = frameWindow.getComputedStyle(element);
    const visible =
      style.display !== 'none' &&
      style.visibility !== 'hidden' &&
      style.opacity !== '0' &&
      element.getClientRects().length > 0;
    if (expectedState === 'hidden') return { ok: true, matched: !visible };
    if (!visible) return { ok: true, matched: false };
    const disabled =
      element.matches(':disabled') || element.getAttribute('aria-disabled') === 'true';
    const role =
      element.getAttribute('role') ||
      {
        BUTTON: 'button',
        A: 'link',
        SELECT: element.multiple || element.size > 1 ? 'listbox' : 'combobox',
      }[element.tagName] ||
      'generic';
    const state = readControlState(element, role);
    return {
      ok: true,
      matched:
        {
          visible: true,
          enabled: !disabled,
          disabled,
          checked: state.checked === true,
          unchecked: state.checked === false,
          expanded: state.expanded === true,
          collapsed: state.expanded === false,
        }[expectedState] === true,
    };
  } catch {
    return { ok: false, reason: 'changed' };
  }
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
    this.documentId = `document_${crypto.randomUUID()}`;
    this.navigationInProgress = false;
    this.destroyed = false;
    this.referenceIdFactory = options.referenceIdFactory || defaultReferenceIdFactory;
    this.navigateHandler = options.navigate || null;
    this.stopLoadingHandler = options.stopLoading || null;
    this.references = new Map();
    this.activeWaits = new Set();
    this.frameObserver = new OwnedFrameObserver(webContents, (snapshotOptions) =>
      buildInvocation(
        collectPageSnapshot,
        [
          MAX_PAGE_TEXT_LENGTH,
          MAX_SNAPSHOT_ELEMENTS,
          MAX_RETAINED_REFERENCES,
          MAX_SELECT_OPTIONS,
          this.referenceIdFactory(),
          snapshotOptions,
        ],
        [readElementName, readScrollState, readControlState]
      )
    );
    this.listeners = {
      'did-start-navigation': (_event, _url, isInPlace, isMainFrame) => {
        if (isInPlace === true) return;
        if (isMainFrame !== false) this.navigationInProgress = true;
        this.navigationId += 1;
        this.documentId = `document_${crypto.randomUUID()}`;
        this.#pruneReferences();
        if (isMainFrame !== false) this.emit('navigation-started', this.getState());
      },
      'did-navigate': () => {
        this.navigationInProgress = false;
        this.emit('navigation-committed', this.getState());
      },
      'did-navigate-in-page': (_event, _url, isMainFrame) => {
        this.navigationId += 1;
        this.documentId = `document_${crypto.randomUUID()}`;
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

  async listFrames() {
    this.#assertAvailable();
    return this.frameObserver.list();
  }

  async readFrame(frameRef, options, authorizeFrame) {
    this.#assertAvailable();
    return this.frameObserver.read(frameRef, options, authorizeFrame);
  }

  async snapshot(options = {}) {
    this.#assertAvailable();
    const navigationId = this.navigationId;
    const documentId = this.documentId;
    if (
      (options.navigationId !== undefined && options.navigationId !== navigationId) ||
      (options.documentId !== undefined && options.documentId !== documentId)
    ) {
      throw this.#staleReferenceError();
    }
    const snapshotToken = this.referenceIdFactory();
    const snapshot = await this.#execute(
      collectPageSnapshot,
      [
        MAX_PAGE_TEXT_LENGTH,
        MAX_SNAPSHOT_ELEMENTS,
        MAX_RETAINED_REFERENCES,
        MAX_SELECT_OPTIONS,
        snapshotToken,
        options,
      ],
      false,
      [readElementName, readScrollState, readControlState]
    );
    if (!snapshot || !Array.isArray(snapshot.elements)) {
      throw new AutomationError(
        ERROR_CODES.CAPABILITY_UNAVAILABLE,
        'The page did not produce a semantic snapshot'
      );
    }
    if (navigationId !== this.navigationId) throw this.#staleReferenceError();

    const elements = snapshot.elements.map((publicNode) => {
      this.references.set(publicNode.ref, {
        navigationId,
        effect: publicNode.effect || '',
        scrollOnly: publicNode.scrollOnly === true,
      });
      return publicNode;
    });
    for (const frame of snapshot.frames || []) {
      if (frame.viewport?.ref)
        this.references.set(frame.viewport.ref, { navigationId, effect: '', scrollOnly: true });
    }
    this.#pruneReferences();
    return { ...snapshot, elements, navigationId, documentId };
  }

  async scroll(ref, { direction, pages = 1 }) {
    this.#assertAvailable();
    this.#requireReference(ref, true);
    this.#requireTrustedKeyInput();
    const navigationId = this.navigationId;
    const inspect = async (requirePoint) => {
      const result = await this.#execute(
        inspectScrollReference,
        [ref, direction, requirePoint],
        false,
        [readScrollState]
      );
      this.#assertActionResult(result);
      if (navigationId !== this.navigationId) throw this.#staleReferenceError();
      return result;
    };
    const prepared = await inspect(true);
    const before = prepared.scroll;
    if (prepared.boundary)
      return { ref, direction, moved: false, outcome: 'boundary', before, after: before };
    this.webContents.focus?.();
    // Focusing may run page handlers; resolve the point and position again.
    const confirmed = await inspect(true);
    if (confirmed.boundary)
      return {
        ref,
        direction,
        moved: false,
        outcome: 'boundary',
        before: confirmed.scroll,
        after: confirmed.scroll,
      };
    const horizontal = ['left', 'right'].includes(direction);
    const forward = ['down', 'right'].includes(direction);
    const start = confirmed.scroll;
    const coordinate = horizontal ? start.x : start.y;
    const remaining = forward
      ? (horizontal ? start.maxX : start.maxY) - coordinate
      : coordinate - (horizontal ? start.minX : 0);
    const distance = Math.max(
      1,
      Math.floor(Math.min(remaining, pages * (horizontal ? start.width : start.height)))
    );
    const delta = (forward ? -1 : 1) * distance;
    this.webContents.sendInputEvent({
      type: 'mouseWheel',
      ...confirmed.point,
      deltaX: horizontal ? delta : 0,
      deltaY: horizontal ? 0 : delta,
      hasPreciseScrollingDeltas: true,
      canScroll: true,
    });
    const started = Date.now();
    let changedAt = started;
    let after = start;
    let settled = false;
    while (Date.now() - started < 1_000) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      const next = (await inspect(false)).scroll;
      if (next.x !== after.x || next.y !== after.y) changedAt = Date.now();
      after = next;
      if (Date.now() - started >= 150 && Date.now() - changedAt >= 100) {
        settled = true;
        break;
      }
    }
    const moved = after.x !== start.x || after.y !== start.y;
    return {
      ref,
      direction,
      moved,
      outcome: moved ? 'moved' : 'no_movement',
      settled,
      before: start,
      after,
      deltaX: after.x - start.x,
      deltaY: after.y - start.y,
    };
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
    if (reference.effect === 'file_upload') {
      throw new AutomationError(
        ERROR_CODES.CAPABILITY_UNAVAILABLE,
        'Use browser_upload for file inputs so Freedom can ask you to choose a file',
        { retryable: true }
      );
    }
    return this.#trustedClick(ref);
  }

  async download(ref) {
    this.#assertAvailable();
    this.#requireReference(ref);
    const described = await this.#execute(describeReferencedElement, [ref, 'download', ''], false, [
      readElementName,
    ]);
    this.#assertActionResult(described);
    if (described.effect !== 'file_download') {
      throw new AutomationError(
        ERROR_CODES.ELEMENT_NOT_INTERACTABLE,
        'The referenced element is not a downloadable link'
      );
    }
    return this.#trustedClick(ref);
  }

  async upload(ref, filePath) {
    this.#assertAvailable();
    const reference = this.#requireReference(ref);
    if (reference.effect !== 'file_upload') {
      throw new AutomationError(
        ERROR_CODES.ELEMENT_NOT_INTERACTABLE,
        'The referenced element is not a file input'
      );
    }
    if (typeof filePath !== 'string' || !filePath) {
      throw new AutomationError(ERROR_CODES.INVALID_ARGUMENT, 'A selected file is required');
    }
    const marker = crypto.randomUUID();
    const marked = await this.#execute(markReferencedFileInput, [ref, marker], true, [
      inspectReferencedElement,
    ]);
    this.#assertActionResult(marked);
    const debuggerApi = this.webContents.debugger;
    if (
      !debuggerApi ||
      typeof debuggerApi.attach !== 'function' ||
      typeof debuggerApi.sendCommand !== 'function'
    ) {
      await this.#execute(clearReferencedFileInputMarker, [ref, marker], false).catch(() => {});
      throw new AutomationError(
        ERROR_CODES.CAPABILITY_UNAVAILABLE,
        'Native file attachment is unavailable for this page'
      );
    }
    let attachedDebugger = false;
    let searchId = '';
    try {
      if (debuggerApi.isAttached?.()) {
        throw new AutomationError(
          ERROR_CODES.CAPABILITY_UNAVAILABLE,
          'Close the page debugger before attaching a file'
        );
      }
      debuggerApi.attach('1.3');
      attachedDebugger = true;
      await debuggerApi.sendCommand('DOM.enable');
      // Prime the DOM domain without serializing the page tree into main.
      await debuggerApi.sendCommand('DOM.getDocument', { depth: 0, pierce: true });
      const search = await debuggerApi.sendCommand('DOM.performSearch', {
        query: `[${UPLOAD_MARKER_ATTRIBUTE}="${marker}"]`,
        includeUserAgentShadowDOM: true,
      });
      searchId = search?.searchId || '';
      if (!searchId || search.resultCount !== 1) throw this.#staleReferenceError();
      const matches = await debuggerApi.sendCommand('DOM.getSearchResults', {
        searchId,
        fromIndex: 0,
        toIndex: 1,
      });
      const nodeId = matches?.nodeIds?.[0];
      if (!Number.isInteger(nodeId) || nodeId < 1) throw this.#staleReferenceError();
      await debuggerApi.sendCommand('DOM.setFileInputFiles', { nodeId, files: [filePath] });
      const result = await this.#execute(describeAttachedFile, [ref], false, [
        inspectReferencedElement,
      ]);
      this.#assertActionResult(result);
      return {
        attached: true,
        ref,
        filename: result.filename,
        bytes: result.bytes,
        ...(result.mimeType && { mimeType: result.mimeType }),
        fileCount: result.fileCount,
      };
    } catch (error) {
      if (error instanceof AutomationError) throw error;
      throw new AutomationError(
        ERROR_CODES.CAPABILITY_UNAVAILABLE,
        'Freedom could not attach the selected file to this page',
        { retryable: true, cause: error }
      );
    } finally {
      if (searchId) {
        await debuggerApi.sendCommand('DOM.discardSearchResults', { searchId }).catch(() => {});
      }
      await this.#execute(clearReferencedFileInputMarker, [ref, marker], false).catch(() => {});
      if (attachedDebugger) {
        try {
          debuggerApi.detach();
        } catch {
          // The file-selection result is authoritative even if Chromium already detached.
        }
      }
    }
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

  async inspectAction(
    ref,
    { operation = 'browser_click', key = '', direction = 'down', pages = 1 } = {}
  ) {
    this.#assertAvailable();
    this.#requireReference(ref, operation === 'browser_scroll');
    if (operation === 'browser_scroll') {
      const result = await this.#execute(inspectScrollReference, [ref, 'down', false], false, [
        readScrollState,
      ]);
      this.#assertActionResult(result);
      return {
        label: `Scroll ${direction} by ${pages} viewport(s) in the observed page or container`,
      };
    }
    const action =
      operation === 'browser_press'
        ? 'press'
        : operation === 'browser_upload'
          ? 'upload'
          : operation === 'browser_type'
            ? 'type'
            : operation === 'browser_select'
              ? 'select'
              : 'click';
    if (action === 'press' || action === 'upload') {
      const prepared = await this.#execute(inspectReferencedElement, [ref, action], true);
      this.#assertActionResult(prepared);
    }
    const describeAction = operation === 'browser_download' ? 'download' : action;
    const result = await this.#execute(
      describeReferencedElement,
      [ref, describeAction, key],
      false,
      [readElementName]
    );
    this.#assertActionResult(result);
    return {
      label: typeof result.label === 'string' ? result.label : '',
      ...(['form_submission', 'file_download', 'file_upload'].includes(result.effect) && {
        effect: result.effect,
      }),
      ...(result.effect === 'file_upload' && {
        accept: typeof result.accept === 'string' ? result.accept : '',
        multiple: result.multiple === true,
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
    await this.#confirmFocusedReference(ref);
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
    this.#requireReference(ref);
    this.#requireTrustedKeyInput();
    this.webContents.focus?.();
    await this.#confirmFocusedReference(ref);
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
            ...(options.condition === 'element' && { ref: options.ref, state: options.state }),
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
    this.frameObserver.cancel();
    if (this.stopLoadingHandler) {
      await this.stopLoadingHandler();
    } else {
      this.webContents.stop?.();
    }
    return { stopped: true, cancelledWaits };
  }

  dispose() {
    this.frameObserver.dispose();
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

  #requireReference(ref, allowScrollOnly = false) {
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
    if (reference.scrollOnly && !allowScrollOnly) {
      throw new AutomationError(
        ERROR_CODES.CAPABILITY_UNAVAILABLE,
        'This reference is only available for browser_scroll; use a control reference for other interactions'
      );
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

  async #confirmFocusedReference(ref) {
    this.#assertAvailable();
    this.#requireReference(ref);
    // Preparation and native dispatch cross renderer queues. Do not restore
    // focus here: a redirected focus or replacement is evidence to reread.
    const confirmed = await this.#execute(inspectReferencedElement, [ref, 'verify_focus'], false);
    this.#assertActionResult(confirmed);
    this.#assertAvailable();
    this.#requireReference(ref);
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
      case 'element': {
        this.#requireReference(options.ref);
        const navigationId = this.navigationId;
        const result = await this.#execute(
          referencedElementMatchesState,
          [options.ref, options.state],
          false,
          [readControlState]
        );
        if (navigationId !== this.navigationId) throw this.#staleReferenceError();
        this.#assertActionResult(result);
        return result.matched === true;
      }
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
