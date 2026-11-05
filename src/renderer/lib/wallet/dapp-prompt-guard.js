/**
 * The dApp Connect, Sign and Send prompts share the sidebar. While one of
 * them shows an undecided request, a newcomer must not take the screen:
 * the user's click would land on a request they never saw (the details
 * repaint after an await). It is refused with EIP-1193's "request already
 * pending" (-32002) instead, and the dApp can retry once the user decides.
 *
 * Whether a prompt is showing is read from the prompts themselves (their
 * screen is visible and holds a request) every time, never kept here: a
 * prompt that another screen hides, or that failed before it was shown,
 * blocks nothing.
 */

const prompts = new Set();

/** @param {() => boolean} isShowing - true while the prompt shows a request */
export function registerDappPrompt(isShowing) {
  prompts.add(isShowing);
}

export function requestPendingError() {
  return Object.assign(new Error('Another wallet request is already pending'), { code: -32002 });
}

export function isDappPromptShowing() {
  for (const isShowing of prompts) {
    if (isShowing()) return true;
  }
  return false;
}

export function assertNoDappPromptShowing() {
  if (isDappPromptShowing()) throw requestPendingError();
}
