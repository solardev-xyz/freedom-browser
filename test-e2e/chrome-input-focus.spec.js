// One focus treatment for every chrome text field (#237).
//
// The unit guard (src/renderer/styles/chrome-input-focus.test.js) proves no
// component sheet declares its own indicator. It cannot prove the shared rule
// actually *reaches* these elements: specificity, import order and
// `:focus-visible`'s own matching rules all decide that, and only the real
// browser knows. So this focuses each field for real and reads back what
// Chromium computed — in both themes, because the address bar's old
// light-theme rule was what removed its indicator entirely.

const { test, expect } = require('./fixtures');

// The four surfaces the issue names — address bar, find bar, bookmark modal,
// sidebar inputs — sampled across the three sidebar field classes that used
// to be styled separately (`.send-input`, and `.password-input`, whose rule
// the send screen re-declared with a different background).
const FIELDS = [
  { id: 'address-input', label: 'address bar' },
  { id: 'find-bar-input', label: 'find bar' },
  { id: 'bookmark-label', label: 'bookmark modal' },
  { id: 'send-recipient', label: 'sidebar send recipient' },
  { id: 'send-amount', label: 'sidebar send amount' },
  { id: 'vault-unlock-password-input', label: 'sidebar vault unlock' },
];

// Reveal the surfaces that are hidden until something opens them. Only
// visibility is forced — no styles are touched, so what Chromium computes
// below is what a user gets. The bookmark <dialog> is deliberately left
// closed: `showModal()` makes the rest of the document inert, which would
// stop every other field here from taking focus at all.
async function revealFields(window) {
  await window.evaluate(() => {
    document.getElementById('sidebar')?.classList.remove('collapsed');
    document.getElementById('find-bar').hidden = false;
    for (const id of [
      'sidebar-send',
      'sidebar-vault-unlock',
      // The password field only appears once the user picks "or enter your
      // password"; un-hide the section it lives in rather than skipping the
      // only `type="password"` field in the sample.
      'vault-unlock-password-section',
    ]) {
      document.getElementById(id)?.classList.remove('hidden');
    }
  });
}

// Focus `id` and read back the indicator Chromium actually painted.
const focusRing = (window, id) =>
  window.evaluate((fieldId) => {
    const modal = document.getElementById('add-bookmark-modal');
    const inModal = modal.contains(document.getElementById(fieldId));
    if (inModal) modal.showModal();
    try {
      const el = document.getElementById(fieldId);
      if (!el) return { missing: true };
      el.focus();
      const style = getComputedStyle(el);
      return {
        focused: document.activeElement === el,
        focusVisible: el.matches(':focus-visible'),
        outlineStyle: style.outlineStyle,
        outlineWidth: style.outlineWidth,
        outlineColor: style.outlineColor,
        outlineOffset: style.outlineOffset,
      };
    } finally {
      if (inModal) modal.close();
    }
  }, id);

for (const theme of ['dark', 'light']) {
  test(`every chrome text field shows the same focus ring (${theme} theme)`, async ({ window }) => {
    await window.evaluate((t) => window.electronAPI.saveSettings({ theme: t }), theme);
    await expect
      .poll(() =>
        window.evaluate(() => document.documentElement.getAttribute('data-theme') || 'dark')
      )
      .toBe(theme);
    await revealFields(window);

    const rings = {};
    for (const field of FIELDS) {
      rings[field.label] = await focusRing(window, field.id);
    }

    for (const [label, ring] of Object.entries(rings)) {
      expect(ring.missing, `${label} is not in the chrome any more`).toBeUndefined();
      expect(ring, label).toMatchObject({
        focused: true,
        // A text field matches :focus-visible however it was focused, so the
        // ring is there for mouse users too — this is the assumption the
        // shared rule rests on, asserted rather than assumed.
        focusVisible: true,
        outlineStyle: 'solid',
        outlineWidth: '2px',
        outlineOffset: '-1px',
      });
      // Never the platform default (which is what the address bar used to
      // fall through to) and never transparent.
      expect(ring.outlineColor, label).not.toBe('rgba(0, 0, 0, 0)');
    }

    // The point of the issue: one treatment, not one per screen.
    const distinct = new Set(
      Object.values(rings).map((ring) =>
        [ring.outlineStyle, ring.outlineWidth, ring.outlineColor, ring.outlineOffset].join(' ')
      )
    );
    expect([...distinct]).toHaveLength(1);

    // …and it is the palette's accent, which is what makes it track the
    // theme instead of needing a per-theme override.
    const accent = await window.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()
    );
    expect(accent).not.toBe('');
    const asRgb = await window.evaluate((color) => {
      const probe = document.createElement('span');
      probe.style.color = color;
      document.body.appendChild(probe);
      const resolved = getComputedStyle(probe).color;
      probe.remove();
      return resolved;
    }, accent);
    expect([...distinct][0]).toContain(asRgb);
  });
}

test('an unfocused field paints no ring, so the indicator means something', async ({ window }) => {
  await revealFields(window);
  await focusRing(window, 'address-input');

  const idle = await window.evaluate(() => {
    const el = document.getElementById('find-bar-input');
    const style = getComputedStyle(el);
    return { outlineStyle: style.outlineStyle, outlineWidth: style.outlineWidth };
  });
  expect(idle.outlineStyle === 'none' || idle.outlineWidth === '0px').toBe(true);
});
