/**
 * Onboarding Navigation
 *
 * An iPhone-style navigation stack for the onboarding sheet: screens are pushed
 * in from the right under a bar that stays put, the bar's title appears once a
 * screen's large title has scrolled away, and whatever is underneath is hidden
 * once it has slid out of the way.
 */

// A little longer than --onboarding-push in onboarding.css.
const TRANSITION_MS = 400;

/**
 * @param {Object} options
 * @param {HTMLElement} options.dialog - Takes focus on each change of screen
 * @param {Object<string, HTMLElement>} options.steps - Screen elements by name
 * @param {Object<string, Object|(() => Object)>} options.stepConfig - For each
 *   screen: `title`, `large`, `back` (the back button's label), `startOver`,
 *   `close`, `done`
 */
export function createOnboardingNav({ dialog, steps, stepConfig }) {
  const bar = document.getElementById('onboarding-nav');
  const content = document.getElementById('onboarding-nav-content');
  const backBtn = document.getElementById('onboarding-back');
  const backLabel = document.getElementById('onboarding-back-label');
  const startOverBtn = document.getElementById('onboarding-start-over');
  const titleEl = document.getElementById('onboarding-nav-title');
  const closeBtn = document.getElementById('onboarding-close');
  const doneBtn = document.getElementById('onboarding-done');

  const stack = [];
  const hideTimers = new Map();

  const current = () => stack[stack.length - 1] ?? null;
  const configOf = (name) => {
    const config = stepConfig[name];
    return (typeof config === 'function' ? config() : config) ?? {};
  };
  const scrollerOf = (name) => steps[name].querySelector('.onboarding-scroll');

  function cancelHide(name) {
    clearTimeout(hideTimers.get(name));
    hideTimers.delete(name);
  }

  function hideAfterTransition(name) {
    cancelHide(name);
    hideTimers.set(
      name,
      setTimeout(() => {
        hideTimers.delete(name);
        steps[name].classList.add('hidden');
        steps[name].classList.remove('onboarding-step-from-right');
      }, TRANSITION_MS)
    );
  }

  function syncToScroll(name) {
    const y = scrollerOf(name)?.scrollTop ?? 0;
    bar.classList.toggle('scrolled', y > 2);
    if (configOf(name).large) {
      const heading = steps[name].querySelector('.onboarding-large-title');
      const past = y > heading.offsetTop + heading.offsetHeight - 6;
      titleEl.classList.toggle('quiet', !past);
    }
  }

  /** Leave a copy of the outgoing bar to animate away over the new one. */
  function animateBarOut(direction) {
    const outgoing = content.cloneNode(true);
    outgoing.removeAttribute('id');
    outgoing.querySelectorAll('[id]').forEach((el) => el.removeAttribute('id'));
    outgoing.setAttribute('aria-hidden', 'true');
    outgoing.inert = true;
    outgoing.classList.remove('onboarding-nav-enter-push', 'onboarding-nav-enter-pop');
    outgoing.classList.add(`onboarding-nav-leave-${direction}`);
    bar.append(outgoing);
    setTimeout(() => outgoing.remove(), TRANSITION_MS);
  }

  /**
   * The button that was clicked may just have gone inert or hidden. From the
   * dialog itself, Tab carries on from the top of the new screen.
   */
  function keepFocusInDialog() {
    dialog.focus({ preventScroll: true });
  }

  function renderBar(name, direction) {
    if (direction) animateBarOut(direction);

    const { title = '', large = false, back = null, startOver, close, done } = configOf(name);
    titleEl.textContent = title;
    titleEl.classList.toggle('quiet', large);
    backBtn.classList.toggle('hidden', !back);
    backLabel.textContent = back ?? '';
    backBtn.setAttribute('aria-label', back ? `Back to ${back}` : 'Back');
    startOverBtn.classList.toggle('hidden', !startOver);
    closeBtn.classList.toggle('hidden', !close);
    doneBtn.classList.toggle('hidden', !done);

    content.classList.remove('onboarding-nav-enter-push', 'onboarding-nav-enter-pop');
    if (direction) {
      void content.offsetWidth;
      content.classList.add(`onboarding-nav-enter-${direction}`);
    }
    syncToScroll(name);
  }

  function push(name) {
    const previous = current();
    if (previous === name) return;
    const el = steps[name];
    stack.push(name);
    cancelHide(name);

    el.classList.remove('hidden', 'onboarding-step-behind');
    el.classList.add('onboarding-step-from-right');
    el.inert = false;
    const scroller = scrollerOf(name);
    if (scroller) scroller.scrollTop = 0;
    void el.offsetWidth;
    el.classList.remove('onboarding-step-from-right');

    if (previous) {
      steps[previous].classList.add('onboarding-step-behind');
      steps[previous].inert = true;
      hideAfterTransition(previous);
    }
    renderBar(name, 'push');
    keepFocusInDialog();
  }

  function pop() {
    if (stack.length < 2) return;
    const leaving = stack.pop();
    const name = current();
    const el = steps[name];
    cancelHide(name);

    el.classList.remove('hidden');
    void el.offsetWidth;
    el.classList.remove('onboarding-step-behind');
    el.inert = false;

    steps[leaving].classList.add('onboarding-step-from-right');
    steps[leaving].inert = true;
    hideAfterTransition(leaving);
    renderBar(name, 'pop');
    keepFocusInDialog();
  }

  /** Go straight to a screen with nothing behind it. */
  function reset(name) {
    for (const key of Object.keys(steps)) {
      cancelHide(key);
      steps[key].classList.add('hidden');
      steps[key].classList.remove('onboarding-step-behind', 'onboarding-step-from-right');
      steps[key].inert = false;
    }
    stack.length = 0;
    stack.push(name);
    steps[name].classList.remove('hidden');
    const scroller = scrollerOf(name);
    if (scroller) scroller.scrollTop = 0;
    renderBar(name, null);
    if (dialog.open) keepFocusInDialog();
  }

  for (const name of Object.keys(steps)) {
    scrollerOf(name)?.addEventListener('scroll', () => {
      if (current() === name) syncToScroll(name);
    });
  }

  return {
    push,
    pop,
    reset,
    current,
    depth: () => stack.length,
    canGoBack: () => {
      const { back, done } = configOf(current());
      return Boolean(back || done);
    },
  };
}
