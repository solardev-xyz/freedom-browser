/**
 * The Profiles page when the list cannot be read (#606 item 7).
 *
 * It used to say "Profile list unavailable" twice — once as the count line
 * under the title, once in the body — with no icon, where History and
 * Downloads give an empty or failed list the icon + one-line message shape.
 */

const { runPageScript } = require('../../../test/helpers/page-script-harness');

const run = (listProfiles) =>
  runPageScript('profiles', {
    ids: {
      'profile-manager-list': 'div',
      stats: 'p',
      'delete-modal': 'div',
      'profile-toast': 'div',
    },
    freedomAPI: { listProfiles, onProfileUpdated: () => {} },
    // scripts/hover-tooltip.js, loaded before profiles.js on the real page.
    windowExtras: { bindHoverTooltip: () => {}, hideHoverTooltip: () => {} },
  });

test.each([
  ['the catalog is unavailable', async () => ({ success: false, error: { message: 'nope' } })],
  ['the call throws', async () => Promise.reject(new Error('boom'))],
])('when %s, the message is said once, with the page icon', async (_label, listProfiles) => {
  const page = await run(listProfiles);
  const stats = page.elements.stats;
  const body = page.document.htmlWrites.at(-1);

  expect(stats.hidden).toBe(true);
  expect(stats.textContent).toBe('');
  expect(body).toMatch(/class="empty-state"/);
  expect(body).toMatch(/<svg\b[\s\S]*<path d="M20 21a8 8 0 0 0-16 0"\/>/);
  expect(body).toMatch(/<p>Could not load profiles<\/p>/);
});

test('a listed catalog shows its count line', async () => {
  const page = await run(async () => ({
    success: true,
    profiles: [{ id: 'default', displayName: 'Default', active: true, registered: true }],
  }));
  expect(page.elements.stats.hidden).toBe(false);
  expect(page.elements.stats.textContent).toBe('1 profile');
});
