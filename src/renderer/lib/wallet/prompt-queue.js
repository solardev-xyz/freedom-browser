/**
 * Prompt Queue
 *
 * Shared queueing for the sidebar's dApp approval prompts (Swarm connect,
 * publish, messaging, feed, permission manifest). Each prompt owns a single
 * sidebar screen, so the queue is what keeps concurrent requests from
 * clobbering each other.
 */

/**
 * Input protection: a queued prompt is presented by the very click that
 * settles the one before it, so without a dead window the second click of a
 * double-click would land on a prompt the user has not had a chance to read
 * — approving (or cancelling) a stamp-spending, network-visible request
 * sight unseen. Browsers apply the same guard to permission dialogs.
 */
export const PROMPT_ARM_DELAY_MS = 500;

/**
 * Each approval prompt owns a single sidebar screen, so only one request can
 * be on screen at a time. Concurrent dApp requests (two swarm.subscribe()
 * calls at page load, two sends back to back) queue up and are shown in turn.
 * Without a queue the newer request would overwrite the pending one, which
 * both orphans the first request and auto-rejects the new one when
 * hideAllSubscreens() fires this screen's hider during the transition.
 *
 * Settling goes through claim(): it hands the on-screen request to exactly
 * one caller, so a double-click cannot settle the same request twice (which
 * silently consumed the request queued behind it) and cannot act on a prompt
 * that only just appeared.
 *
 * @param {(entry: Object) => void} present - renders and shows the screen
 * @param {(armed: boolean) => void} [onArmedChange] - reflect the input-protection
 *   window in the screen's buttons
 */
export function createPromptQueue(present, onArmedChange) {
  const waiting = [];
  let current = null;
  let armed = false;
  let armTimer = null;
  let settling = false;
  let presenting = false;

  function setArmed(next) {
    armed = next;
    onArmedChange?.(next);
  }

  return {
    /** The request currently on screen, or null. */
    get current() {
      return current;
    },

    /** True while this queue is mid-transition to a queued request. */
    get presenting() {
      return presenting;
    },

    /** False during a freshly-presented prompt's input-protection window. */
    get armed() {
      return armed;
    },

    /** Show `entry` now, or queue it behind the request already on screen. */
    show(entry) {
      waiting.push(entry);
      // `settling` covers the gap between claim() and settle(): the settling
      // request is still on screen, so the newcomer waits for its turn.
      if (!current && !settling) this.showNext();
    },

    /** Show the next queued request, if there is one. */
    showNext() {
      const next = waiting.shift();
      if (!next) return;
      // present() calls hideAllSubscreens(), which runs every screen hider —
      // including this screen's. `current` stays null until that has run so
      // the hider cannot mistake the incoming request for a dismissed one,
      // and `presenting` tells the hider the still-queued requests are not
      // being dismissed either.
      presenting = true;
      if (armTimer) clearTimeout(armTimer);
      setArmed(false);
      try {
        present(next);
      } finally {
        presenting = false;
      }
      current = next;
      armTimer = setTimeout(() => {
        armTimer = null;
        setArmed(true);
      }, PROMPT_ARM_DELAY_MS);
    },

    /**
     * Take the on-screen request for settling. Returns null when there is
     * nothing on screen, when the request was already claimed (the second
     * click of a double-click), or while the prompt is still inside its
     * input-protection window — callers must then do nothing at all.
     */
    claim() {
      if (!current || !armed) return null;
      const claimed = current;
      current = null;
      settling = true;
      return claimed;
    },

    /** The claimed request finished settling: show the next one. */
    settle() {
      settling = false;
      this.showNext();
    },

    /** The screen was dismissed: hand back every request so all get rejected. */
    drain() {
      const dropped = current ? [current, ...waiting] : waiting.slice();
      current = null;
      waiting.length = 0;
      if (armTimer) {
        clearTimeout(armTimer);
        armTimer = null;
      }
      setArmed(false);
      return dropped;
    },
  };
}

// Buttons are disabled for the input-protection window so the dead click is
// visible rather than mysterious.
export function setButtonsDisabled(buttons, disabled) {
  for (const button of buttons) {
    if (button) button.disabled = disabled;
  }
}
