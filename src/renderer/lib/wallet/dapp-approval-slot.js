/**
 * One dApp approval at a time, across Connect, Sign and Send.
 *
 * The three prompts share the sidebar. A request that took over a prompt
 * while the user was reading it would let the user's click confirm
 * something they never saw: the details repaint only after an await, and
 * the replaced request was never answered. So a newcomer is refused with
 * EIP-1193's "request already pending" (-32002) until the user has
 * decided; the dApp can retry then.
 *
 * Every prompt must release its claim on every way out, including being
 * hidden by another screen (see the screen hiders), or one abandoned
 * prompt would refuse every dApp after it.
 */

let holder = null;

export function requestPendingError() {
  return Object.assign(new Error('Another wallet request is already pending'), { code: -32002 });
}

export function isDappApprovalPending() {
  return holder !== null;
}

export function assertNoDappApprovalPending() {
  if (holder !== null) throw requestPendingError();
}

/** Takes the slot for `request`; throws if another request holds it. */
export function claimDappApproval(request) {
  assertNoDappApprovalPending();
  holder = request;
}

/** Frees the slot if `request` holds it. */
export function releaseDappApproval(request) {
  if (request && holder === request) holder = null;
}
