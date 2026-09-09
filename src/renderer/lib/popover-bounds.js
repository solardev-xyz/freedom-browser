// One bound for every popover in the browser chrome (#324).
//
// Chrome's model: a menu that does not fit the window scrolls *inside itself*,
// and the browser chrome never scrolls. Freedom had neither half — the chrome
// document had no `overflow` rule and no dropdown had a height bound, so with
// all nodes enabled the ~650 px Nodes menu pushed the whole toolbar up and its
// last section (Tor) off the bottom of a 1200x600 window.
//
// This module is the single mechanism for the first half; `styles/popovers.css`
// (`.chrome-popover`) is the CSS half, and `styles/base.css` pins the document.
// Every chrome popover — Nodes menu, hamburger menu, the Profiles flyout, the
// tab / page / chrome-input / bookmark context menus, the bookmarks overflow
// menu, autocomplete, the trust and permission popovers — goes through one of
// the two entry points below at open time:
//
//   boundPopoverToViewport(el)     anchored popovers (already positioned by CSS
//                                  or by their own anchor logic)
//   placePopoverAtPoint(el, x, y)  pointer-anchored context menus: clamp to the
//                                  viewport, flip up when the space below is
//                                  too small, bound what is left
//
// Both leave the element with an inline `max-height`; `.chrome-popover` turns
// the overflow into an internal scroll with a theme-matched scrollbar.

// Gap kept between a popover and the window edge — the same 8 px the context
// menus already used when clamping horizontally.
export const POPOVER_VIEWPORT_MARGIN = 8;

// A popover is not squeezed below this: at that point a scroll of two or three
// rows is more useful than a sliver, and the viewport clamp in
// `placePopoverAtPoint` has already picked the roomier side.
//
// It is a floor, not a guarantee. It may never push a popover's *bottom* edge
// past the window: scrolling moves the content inside the box, so an off-screen
// tail of the box itself is unreachable — worse than the sliver it avoids
// (#328). Where the position is ours to pick (`placePopoverAtPoint`) the menu
// is moved up to make room for the floor; where it is not
// (`boundPopoverToViewport`, anchored under a toolbar button) the room that is
// actually there wins.
export const POPOVER_MIN_HEIGHT = 96;

const viewportHeight = () => window.innerHeight || document.documentElement?.clientHeight || 0;
const viewportWidth = () => window.innerWidth || document.documentElement?.clientWidth || 0;

/**
 * The popover's own `max-height` from the stylesheet, in px, or Infinity when
 * it has none. Read with the inline bound already cleared, so it is the sheet's
 * value and not ours.
 *
 * The viewport bound may only ever make a popover *shorter*: a sheet that caps
 * a list on purpose (autocomplete's 360 px, the Profiles list's 60vh) keeps
 * that cap on a tall window instead of being stretched to fill it.
 */
const styleMaxHeight = (el) => {
  if (typeof window.getComputedStyle !== 'function') return Infinity;
  const px = parseFloat(window.getComputedStyle(el).maxHeight);
  return Number.isFinite(px) ? px : Infinity;
};

/**
 * Apply `available` px of room as a max-height, never loosening the sheet's.
 *
 * `ceiling` is the room the popover's own box has before its bottom edge leaves
 * the window; the min-height floor may not be applied past it. It defaults to
 * `available` — the case where the popover's top is fixed and the space below
 * it is all there is.
 */
const applyMaxHeight = (el, available, ceiling = available) => {
  const bounded = Math.min(
    Math.max(POPOVER_MIN_HEIGHT, Math.floor(available)),
    Math.max(0, Math.floor(ceiling)),
    styleMaxHeight(el)
  );
  el.style.maxHeight = `${bounded}px`;
  return bounded;
};

/**
 * Bound `el` to the space between its own top edge and the bottom of the
 * viewport. Call it *after* the popover has been made visible and positioned,
 * so its top offset is the real one.
 *
 * @param {HTMLElement|null} el
 * @returns {number} the applied max-height in px (0 when there was nothing to do)
 */
export const boundPopoverToViewport = (el) => {
  if (!el?.getBoundingClientRect) return 0;
  // Measure against the natural position, not against a bound left over from a
  // previous open at a different offset or window size.
  el.style.maxHeight = '';
  const { top } = el.getBoundingClientRect();
  return applyMaxHeight(el, viewportHeight() - top - POPOVER_VIEWPORT_MARGIN);
};

/**
 * Position a pointer-anchored context menu at (x, y) and bound it.
 *
 * Chrome's rules, in order: open down-right from the pointer; if the menu is
 * taller than the space below, open *upwards* from the pointer instead; if it
 * fits neither way, take the roomier side, clamp to the viewport edge and let
 * the menu scroll. Horizontally it is clamped, as it already was.
 *
 * @param {HTMLElement|null} el  a visible `position: fixed` menu
 * @param {number} x  client X of the pointer
 * @param {number} y  client Y of the pointer
 */
export const placePopoverAtPoint = (el, x, y) => {
  if (!el?.getBoundingClientRect) return;
  const margin = POPOVER_VIEWPORT_MARGIN;
  // Natural size first: an inline max-height from a previous open would make
  // the menu look shorter than it is and defeat the flip decision below.
  el.style.maxHeight = '';
  el.style.left = `${x}px`;
  el.style.top = `${y}px`;

  const rect = el.getBoundingClientRect();
  const vw = viewportWidth();
  const vh = viewportHeight();

  let left = x;
  if (x + rect.width > vw - margin) left = vw - rect.width - margin;
  if (left < margin) left = margin;

  const spaceBelow = vh - y - margin;
  const spaceAbove = y - margin;
  let top = y;
  if (rect.height <= spaceBelow) {
    // Fits below the pointer: the common case, nothing to bound.
    el.style.maxHeight = '';
  } else if (rect.height <= spaceAbove) {
    // Flip up: the menu's bottom edge lands on the pointer.
    top = y - rect.height;
  } else if (spaceAbove > spaceBelow) {
    // Neither side fits — take the roomier one and scroll inside it.
    top = margin;
    applyMaxHeight(el, spaceAbove, vh - 2 * margin);
  } else {
    const applied = applyMaxHeight(el, spaceBelow, vh - 2 * margin);
    // In a window too short for the minimum height, honouring it means opening
    // the menu above the pointer so its bottom edge stays on screen (#328).
    if (y + applied > vh - margin) top = vh - margin - applied;
  }
  if (top < margin) top = margin;

  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
  el.scrollTop = 0;
};

/**
 * Re-bound every popover that is currently on screen.
 *
 * A menu opened in a tall window and left up while the window is resized (or
 * the display scale changes) would otherwise keep a stale bound and overflow
 * again. Anchored popovers are re-measured from their live top offset; a
 * context menu keeps the position it was opened at and is re-bounded from it,
 * so the visible part stays inside the shrunken window.
 */
export const rebindOpenPopovers = () => {
  for (const el of document.querySelectorAll('.chrome-popover')) {
    // `getClientRects()` is the visibility test that also works for the
    // `position: fixed` menus, whose `offsetParent` is always null.
    if (el.getClientRects().length === 0) continue;
    boundPopoverToViewport(el);
  }
};

/**
 * Install the window-level half of the mechanism. Called once from the
 * renderer's bootstrap.
 */
export const initPopoverBounds = () => {
  window.addEventListener('resize', rebindOpenPopovers);
};
