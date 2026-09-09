// Chrome's "user input in progress" state for the address bar, per tab.
//
// Chrome's omnibox tracks whether the user has an uncommitted edit. While
// that flag is set:
//   - a navigation committing in the tab updates the tab strip, the security
//     chip and the page, but never rewrites the text the user is typing
//     (issue #305), and
//   - because the flag and the draft it carries live on the *tab*, switching
//     away and back restores the edit and its selection (issue #314).
// The edit ends when the user commits it (form submit / a picked suggestion,
// both of which funnel through `loadTarget`) or reverts it (Escape).
//
// The draft is stored on the tab's `navigationState` (`addressBarPendingInput`
// / `addressBarPendingSelection`) so it is per-tab by construction and dies
// with the tab. It is deliberately *not* the same field as
// `addressBarSnapshot`, which keeps holding the page's own display URL (the
// omnibox "permanent text") so Escape and the trust/protocol surfaces still
// have something truthful to fall back to while an edit is in flight.
import { getActiveTabState } from './tabs.js';

const activeNavState = () => {
  try {
    return typeof getActiveTabState === 'function' ? getActiveTabState() || null : null;
  } catch {
    return null;
  }
};

/**
 * Record an uncommitted user edit of the address bar.
 *
 * @param {string} value - the text currently in the address input
 * @param {{start: number, end: number, direction: string}|null} selection
 * @param {object|null} navState - tab navigation state (defaults to active tab)
 */
export const setAddressBarEdit = (value, selection = null, navState = activeNavState()) => {
  if (!navState) return;
  navState.addressBarPendingInput = typeof value === 'string' ? value : '';
  navState.addressBarPendingSelection = selection;
};

/** Forget any uncommitted edit (the user committed or reverted it). */
export const clearAddressBarEdit = (navState = activeNavState()) => {
  if (!navState) return;
  navState.addressBarPendingInput = null;
  navState.addressBarPendingSelection = null;
};

/** True while the user has an uncommitted edit in this tab's address bar. */
export const isAddressBarEditInProgress = (navState = activeNavState()) =>
  typeof navState?.addressBarPendingInput === 'string';

/** The uncommitted draft for this tab, or null when there is none. */
export const getAddressBarEdit = (navState = activeNavState()) =>
  isAddressBarEditInProgress(navState) ? navState.addressBarPendingInput : null;

/** Selection range of an input, or null when it can't be read. */
export const captureInputSelection = (input) => {
  if (!input) return null;
  const { selectionStart, selectionEnd, selectionDirection } = input;
  if (typeof selectionStart !== 'number' || typeof selectionEnd !== 'number') return null;
  return {
    start: selectionStart,
    end: selectionEnd,
    direction: selectionDirection || 'none',
  };
};

/** Re-apply a selection captured by `captureInputSelection`. */
export const applyInputSelection = (input, selection) => {
  if (!input || !selection || typeof input.setSelectionRange !== 'function') return;
  try {
    input.setSelectionRange(selection.start, selection.end, selection.direction || 'none');
  } catch {
    // Inputs that don't support selection ranges (type=email/number) throw.
  }
};
