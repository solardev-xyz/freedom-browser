// One header for every wallet-sidebar sub-screen (#238).
//
// The unit tests cover the renderer and the declarations in index.html.
// What they cannot cover is that `renderSubscreenHeaders()` is actually
// *called*, early enough, in the shipping bootstrap — an import that never
// runs leaves 30 empty header bars and a sidebar with no way back, and every
// unit test still passes. So this asserts against the live DOM the renderer
// built, and re-checks the ids the wallet modules cached off the back of it.

const { test, expect } = require('./fixtures');

// The screens the issue lists, in the order it lists them, plus the two the
// same chevron-only layout had spread to.
const SUBSCREENS = [
  { id: 'sidebar-send', title: 'Send' },
  { id: 'sidebar-dapp-tx', title: 'Confirm Transaction' },
  { id: 'sidebar-dapp-sign', title: 'Sign Message' },
  { id: 'sidebar-dapp-connect', title: 'Connect' },
  { id: 'sidebar-swarm-connect', title: 'Swarm Access' },
  { id: 'sidebar-swarm-publish-approve', title: 'Confirm Publish' },
  { id: 'sidebar-swarm-messaging-approve', title: 'Messaging Access' },
  { id: 'sidebar-swarm-feed-approve', title: 'Feed Access' },
  { id: 'sidebar-connect-ledger', title: 'Connect Ledger' },
  { id: 'sidebar-connect-phone', title: 'Connect Phone' },
  { id: 'sidebar-x402-approval', title: 'Payment Required' },
];

const headerShapes = (window) =>
  window.evaluate(() =>
    [...document.querySelectorAll('.subscreen-header')].map((header) => {
      const screen = header.closest('.sidebar-subscreen');
      const button = header.querySelector('button');
      const heading = header.querySelector('h3');
      return {
        screen: screen?.id ?? null,
        // The tag names in order — the shape a user sees left to right.
        children: [...header.children].map((child) => child.tagName.toLowerCase()),
        backId: button?.id ?? null,
        backClass: button?.className ?? null,
        backLabel: button?.textContent.trim() ?? null,
        hasChevron: Boolean(button?.querySelector('svg polyline')),
        titleClass: heading?.className ?? null,
        title: heading?.textContent.trim() ?? null,
        // Anything that could read as a close control.
        closeControls: header.querySelectorAll('[class*="close"], [aria-label*="lose"]').length,
      };
    })
  );

test('every sub-screen header is chevron + Back + title, with no close control', async ({
  window,
}) => {
  const headers = await headerShapes(window);
  expect(headers.length).toBeGreaterThanOrEqual(SUBSCREENS.length);

  const byScreen = new Map(headers.map((header) => [header.screen, header]));
  for (const { id, title } of SUBSCREENS) {
    const header = byScreen.get(id);
    expect(header, `${id} has no header`).toBeDefined();
    expect(header, id).toMatchObject({
      children: ['button', 'h3'],
      backClass: 'subscreen-back-btn',
      backLabel: 'Back',
      hasChevron: true,
      titleClass: 'subscreen-title',
      title,
      closeControls: 0,
    });
  }

  // Nothing anywhere in the sidebar still uses one of the old shapes: a
  // chevron with no "Back" word, or a header carrying its own "×".
  const strays = headers.filter(
    (header) =>
      header.closeControls > 0 ||
      (header.backId && (header.backLabel !== 'Back' || !header.hasChevron))
  );
  expect(strays).toEqual([]);
});

test('the sidebar keeps exactly one close control, and it is the sidebar’s own', async ({
  window,
}) => {
  const closers = await window.evaluate(() =>
    [...document.querySelectorAll('#sidebar [aria-label*="lose"], #sidebar .sidebar-close')].map(
      (el) => el.id
    )
  );
  expect([...new Set(closers)]).toEqual(['sidebar-close']);
});

test('the ids the wallet modules cache still resolve after the header renders', async ({
  window,
}) => {
  // The migration's one real hazard: these buttons no longer exist in the
  // HTML the renderer parses, only in what renderSubscreenHeaders() stamps.
  // If it ran too late, every init*() would have cached null and the Back
  // buttons would be inert — which unit tests with their own fake DOM cannot
  // see. A click handler is proof the module found the element.
  const wired = await window.evaluate(() =>
    [
      'send-back',
      'dapp-tx-back',
      'dapp-sign-back',
      'dapp-connect-back',
      'swarm-connect-back',
      'swarm-publish-back',
      'swarm-messaging-back',
      'swarm-feed-back',
      'connect-ledger-back',
      'connect-phone-back',
      'x402-approval-back',
    ].map((id) => ({ id, present: Boolean(document.getElementById(id)) }))
  );
  expect(wired.filter((entry) => !entry.present)).toEqual([]);

  // …and Back really does go back: open Send, click it, and the screen closes.
  await window.evaluate(async () => {
    const { walletState } = await import('./lib/wallet/wallet-state.js');
    const sidebar = await import('./lib/sidebar.js');
    sidebar.open();
    document.getElementById('sidebar-setup-cta')?.classList.add('hidden');
    document.getElementById('sidebar-identity')?.classList.remove('hidden');
    walletState.viewMode = 'identity';
    walletState.identityView = document.getElementById('sidebar-identity');
    document.getElementById('sidebar-send').classList.remove('hidden');
    document.getElementById('sidebar-identity').classList.add('hidden');
  });
  await expect(window.locator('#sidebar-send')).toBeVisible();

  await window.click('#send-back');
  await expect(window.locator('#sidebar-send')).toBeHidden();
  await expect(window.locator('#sidebar-identity')).toBeVisible();
});
