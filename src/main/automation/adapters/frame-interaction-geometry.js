'use strict';

// Serialized into the parent's isolated world and bound to the engine-resolved
// frame owner node. The model cannot supply this function or a DOM selector.
function inspectFrameOwner(point, childViewport, requireFocus, prepare) {
  const frame = this;
  if (!frame.isConnected || !['IFRAME', 'FRAME'].includes(frame.tagName))
    return { ok: false, reason: 'changed' };
  const parentOf = (node) => node.parentElement || node.getRootNode()?.host;
  for (let node = frame; node; node = parentOf(node)) {
    const style = getComputedStyle(node);
    if (
      style.transform !== 'none' ||
      ['translate', 'rotate', 'scale', 'perspective'].some(
        (key) => style[key] && style[key] !== 'none'
      ) ||
      Number(style.zoom || 1) !== 1 ||
      style.display === 'none' ||
      style.visibility !== 'visible' ||
      Number(style.opacity) === 0
    )
      return { ok: false, reason: 'not_interactable' };
  }
  const style = getComputedStyle(frame);
  if (
    ['paddingLeft', 'paddingRight', 'paddingTop', 'paddingBottom'].some(
      (key) => parseFloat(style[key]) !== 0
    )
  )
    return { ok: false, reason: 'not_interactable' };
  if (
    window.visualViewport &&
    (visualViewport.scale !== 1 ||
      visualViewport.offsetLeft !== 0 ||
      visualViewport.offsetTop !== 0)
  )
    return { ok: false, reason: 'not_interactable' };
  if (prepare) frame.scrollIntoView({ block: 'center', inline: 'center' });
  if (
    Math.abs(frame.clientWidth - childViewport.width) > 1 ||
    Math.abs(frame.clientHeight - childViewport.height) > 1
  )
    return { ok: false, reason: 'not_interactable' };
  if (point.x < 0 || point.y < 0 || point.x >= frame.clientWidth || point.y >= frame.clientHeight)
    return { ok: false, reason: 'not_interactable' };
  const rect = frame.getBoundingClientRect();
  const x = rect.left + frame.clientLeft + point.x;
  const y = rect.top + frame.clientTop + point.y;
  if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight)
    return { ok: false, reason: 'not_interactable' };
  let hit = document.elementFromPoint(x, y);
  while (hit?.shadowRoot) {
    const next = hit.shadowRoot.elementFromPoint(x, y);
    if (!next || next === hit) break;
    hit = next;
  }
  if (hit !== frame) return { ok: false, reason: 'not_interactable' };
  if (requireFocus) {
    let active = document.activeElement;
    while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
    if (active !== frame) return { ok: false, reason: 'not_interactable' };
  }
  return { ok: true, point: { x, y }, viewport: { width: innerWidth, height: innerHeight } };
}

module.exports = { inspectFrameOwner };
