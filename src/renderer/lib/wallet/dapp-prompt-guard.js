/**
 * The dApp Connect, Sign and Send prompts share the sidebar. While one of
 * them shows an undecided request, main's next prompt waits
 * (page-prompts.js): the user's click would otherwise land on a request
 * they never saw.
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

export function isDappPromptShowing() {
  for (const isShowing of prompts) {
    if (isShowing()) return true;
  }
  return false;
}
