/**
 * The screens that render main's page prompts, by kind (freedom-core design
 * 0011, "The prompt protocol", before APS). Each screen registers itself when
 * it initializes, so `page-prompts.js` shows main's prompt in it without
 * importing it:
 *
 *   - `show(prompt)`: render `{ handle, guest, kind, site, view }` and take
 *     the sidebar; the screen answers the handle itself (`page:decide`);
 *   - `close(handle)`: take it down (main hid or closed it);
 *   - `isShowing()`: the handle the screen shows now, or null.
 *
 * A screen another one hides before its prompt is decided reports it
 * (`pagePromptDisplaced`), and the prompt shows again once the sidebar is
 * free.
 */

const renderers = new Map();
const displacedListeners = new Set();

/** A screen renders prompts of `kind`. */
export function registerPagePromptRenderer(kind, renderer) {
  if (typeof kind !== 'string' || !renderer) return;
  renderers.set(kind, renderer);
}

/** The screen for `kind`, or undefined. */
export function pagePromptRenderer(kind) {
  return renderers.get(kind);
}

/** Hear of a page prompt another screen hid before it was decided. */
export function onPagePromptDisplaced(listener) {
  if (typeof listener !== 'function') return () => {};
  displacedListeners.add(listener);
  return () => displacedListeners.delete(listener);
}

/** A screen's prompt `handle` was hidden by another screen, undecided. */
export function pagePromptDisplaced(handle) {
  for (const listener of displacedListeners) {
    try {
      listener(handle);
    } catch (err) {
      console.error('[PagePrompts] A displaced listener failed:', err);
    }
  }
}

/** For tests: forget every screen. */
export function _resetPagePromptRenderers() {
  renderers.clear();
  displacedListeners.clear();
}
