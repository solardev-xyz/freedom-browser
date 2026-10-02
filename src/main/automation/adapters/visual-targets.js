'use strict';

const crypto = require('crypto');
const { AutomationError, ERROR_CODES } = require('../contract/errors');

function readVisualViewport() {
  if (!globalThis.__FREEDOM_VISUAL_REVISION__) {
    const state = { revision: 0 };
    const observer = new MutationObserver(() => {
      state.revision += 1;
    });
    observer.observe(document, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });
    globalThis.__FREEDOM_VISUAL_REVISION__ = state;
  }
  return {
    revision: globalThis.__FREEDOM_VISUAL_REVISION__.revision,
    width: innerWidth,
    height: innerHeight,
    x: scrollX,
    y: scrollY,
    dpr: devicePixelRatio,
    scale: visualViewport?.scale || 1,
    offsetX: visualViewport?.offsetLeft || 0,
    offsetY: visualViewport?.offsetTop || 0,
  };
}

// Fixed isolated-world code. Retain the exact DOM identity, including transparent
// overlays; a screenshot hash alone cannot establish which node receives input.
function inspectVisualPoint(ref, x, y, create) {
  const store = (globalThis.__FREEDOM_VISUAL_TARGETS__ ||= new Map());
  let hit = document.elementFromPoint(x, y);
  while (hit?.shadowRoot) {
    const next = hit.shadowRoot.elementFromPoint(x, y);
    if (!next || next === hit) break;
    hit = next;
  }
  if (
    !hit ||
    hit.getRootNode() !== document ||
    ['HTML', 'BODY', 'IFRAME', 'FRAME'].includes(hit.tagName)
  )
    return false;
  for (let node = hit; node; node = node.parentElement || node.getRootNode()?.host) {
    // Semantic and file controls must use their reference-specific policies.
    if (
      node.matches(
        'a,button,input,select,textarea,label,form,[contenteditable]:not([contenteditable="false"])'
      )
    )
      return false;
    const style = getComputedStyle(node);
    if (style.visibility !== 'visible' || Number(style.opacity) === 0 || node.inert) return false;
  }
  if (create) {
    store.set(ref, hit);
    while (store.size > 8) store.delete(store.keys().next().value);
  }
  return store.get(ref) === hit && hit.isConnected;
}

class VisualTargets {
  constructor({ capture, evaluate, identity, zoom, dispatch }) {
    Object.assign(this, { capture, evaluate, identity, zoom, dispatch });
    this.captures = new Map();
    this.targets = new Map();
    this.generation = 0;
  }

  clear() {
    this.generation += 1;
    this.captures.clear();
    this.targets.clear();
  }

  stale() {
    return new AutomationError(
      ERROR_CODES.STALE_ELEMENT_REFERENCE,
      'The visual target changed or expired; take a new screenshot and target it again',
      { retryable: true }
    );
  }

  async sample() {
    const before = await this.evaluate(readVisualViewport, []);
    const identity = this.identity();
    const generation = this.generation;
    const zoom = this.zoom();
    const png = await this.capture();
    const after = await this.evaluate(readVisualViewport, []);
    if (
      identity !== this.identity() ||
      generation !== this.generation ||
      zoom !== this.zoom() ||
      JSON.stringify(before) !== JSON.stringify(after) ||
      before.scale !== 1 ||
      before.offsetX ||
      before.offsetY ||
      !before.width ||
      !before.height ||
      png.length < 24
    )
      throw this.stale();
    return {
      png,
      identity,
      generation,
      zoom,
      viewport: before,
      width: png.readUInt32BE(16),
      height: png.readUInt32BE(20),
      digest: crypto.createHash('sha256').update(png).digest('hex'),
    };
  }

  async screenshot() {
    let sample;
    try {
      sample = await this.sample();
    } catch {
      // A changing viewport still yields an ordinary observation, without any
      // coordinate authority. The next screenshot may supply a stable binding.
      return { mediaType: 'image/png', base64: (await this.capture()).toString('base64') };
    }
    const captureRef = `capture_${crypto.randomUUID()}`;
    const { png, ...binding } = sample;
    this.captures.set(captureRef, { ...binding, expires: Date.now() + 300000 });
    while (this.captures.size > 4) this.captures.delete(this.captures.keys().next().value);
    return {
      mediaType: 'image/png',
      base64: png.toString('base64'),
      captureRef,
      width: binding.width,
      height: binding.height,
    };
  }

  async validate(binding) {
    if (
      !binding ||
      binding.expires < Date.now() ||
      binding.generation !== this.generation ||
      binding.identity !== this.identity()
    )
      throw this.stale();
    const current = await this.sample();
    if (
      current.identity !== binding.identity ||
      current.generation !== binding.generation ||
      current.zoom !== binding.zoom ||
      current.digest !== binding.digest ||
      JSON.stringify(current.viewport) !== JSON.stringify(binding.viewport)
    )
      throw this.stale();
  }

  async target({ captureRef, x, y }) {
    const binding = this.captures.get(captureRef);
    await this.validate(binding);
    const ref = `visual_${crypto.randomUUID()}`;
    const point = { x: x * binding.viewport.width, y: y * binding.viewport.height };
    if (!(await this.evaluate(inspectVisualPoint, [ref, point.x, point.y, true])))
      throw new AutomationError(
        ERROR_CODES.ELEMENT_NOT_INTERACTABLE,
        'Use a semantic control reference or read the embedded frame for this target'
      );
    const target = {
      ...binding,
      point,
      label: `Visual point (${Math.round(x * 100)}%, ${Math.round(y * 100)}%); effect unknown`,
    };
    this.targets.set(ref, target);
    while (this.targets.size > 8) this.targets.delete(this.targets.keys().next().value);
    await this.inspect(ref);
    return { ref, label: target.label, supportedActions: ['click'], singleUse: true };
  }

  async inspect(ref) {
    const target = this.targets.get(ref);
    await this.validate(target);
    if (!(await this.evaluate(inspectVisualPoint, [ref, target.point.x, target.point.y, false])))
      throw this.stale();
    return {
      label: target.label,
      effect: '',
      navigationTarget: '',
      formPayloadFingerprint: '',
      visual: true,
    };
  }

  async click(ref, authorization) {
    if (!authorization?.visual)
      throw new AutomationError(
        ERROR_CODES.POLICY_DENIED,
        'Visual interaction requires current action authorization'
      );
    const descriptor = await this.inspect(ref);
    if (descriptor.label !== authorization.label) throw this.stale();
    const target = this.targets.get(ref);
    this.targets.delete(ref);
    this.captures.clear();
    // Consume before input, including uncertain delivery. No automatic replay.
    await this.dispatch({
      x: Math.round(target.point.x * target.zoom),
      y: Math.round(target.point.y * target.zoom),
    });
    return { ref, clicked: true, visual: true };
  }
}

module.exports = { VisualTargets };
