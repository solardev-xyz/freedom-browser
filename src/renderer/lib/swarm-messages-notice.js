// Question 4's notice (freedom-core design 0015, Messaging; SWM-7's PR 7.5):
// a site's live Swarm messages were refused, or ended, because they would go
// around Tor or the proxy to the external Swarm node. Main decides when (once
// per site per browser session) and words it
// (src/main/swarm/subscription-route-notices.js); this shows each in a corner
// toast in the style of the Myotis recovery notice, one sentence per site,
// until it is dismissed.

// The other corner toasts, which this one sits above while they show.
const OTHER_TOASTS = ['update-toast', 'myotis-recovery-notice'];
const EDGE_PX = 16;
const GAP_PX = 8;

let notice = null;
let noticeText = null;
let listenersAttached = false;
const sentences = [];

// Above whichever other corner toast shows, so none covers another.
const place = () => {
  if (!notice || notice.hidden) return;
  let bottom = EDGE_PX;
  for (const id of OTHER_TOASTS) {
    const other = document.getElementById(id);
    if (!other || other.hidden) continue;
    const rect = other.getBoundingClientRect?.();
    if (rect && rect.height > 0) bottom = Math.max(bottom, window.innerHeight - rect.top + GAP_PX);
  }
  notice.style.bottom = `${Math.round(bottom)}px`;
};

// One line per site, each its own block.
const render = () => {
  if (!notice || !noticeText) return;
  noticeText.replaceChildren(
    ...sentences.map((sentence) => {
      const line = document.createElement('span');
      line.className = 'swarm-messages-notice-line';
      line.textContent = sentence;
      return line;
    })
  );
  notice.hidden = sentences.length === 0;
  place();
};

/** Shows main's notice `{ text }` (a sentence already shown isn't repeated). */
export const showSwarmMessagesNotice = (payload) => {
  const text = typeof payload?.text === 'string' ? payload.text.trim() : '';
  if (text === '' || sentences.includes(text)) return;
  sentences.push(text);
  render();
};

const dismiss = () => {
  sentences.length = 0;
  render();
};

export const initSwarmMessagesNotice = () => {
  notice = document.getElementById('swarm-messages-notice');
  noticeText = document.getElementById('swarm-messages-notice-text');
  if (listenersAttached) return;
  listenersAttached = true;
  document.getElementById('swarm-messages-notice-close')?.addEventListener('click', dismiss);
  if (typeof MutationObserver === 'function') {
    const observer = new MutationObserver(place);
    for (const id of OTHER_TOASTS) {
      const other = document.getElementById(id);
      if (other) {
        observer.observe(other, {
          attributes: true,
          attributeFilter: ['hidden'],
          childList: true,
          characterData: true,
          subtree: true,
        });
      }
    }
  }
  window.addEventListener?.('resize', place);
  window.swarmMessages?.onNotice?.(showSwarmMessagesNotice);
};
