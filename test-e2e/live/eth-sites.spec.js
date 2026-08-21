// Real-network E2E: Swarm + native IPFS cold-start → ENS resolution → page render.
//
// Steps:
//   1. Open the Nodes menu, which starts Bee peer-info polling.
//   2. Wait for Swarm connected-peer count to climb past PEER_TARGET and for
//      the native IPFS manager to report running.
//   3. Close the menu so it doesn't sit over the address bar.
//   4. Navigate to `meinhard.eth` (Swarm-hosted), assert a play-button-
//      shaped element exists in the active <webview>.
//   5. Navigate to `vitalik.eth` (IPFS-hosted blog), assert an <h1>
//      mentioning "Vitalik" exists in the active <webview>.
//   6. Navigate to `meinhard.wei` (WNS name, Swarm-hosted), assert the WNS
//      contract path dispatches to bzz:// and the same site as meinhard.eth
//      renders.
//   7. Navigate to `apoorv.gwei` (GNS-hosted site), assert it resolves through
//      a supported name transport and renders the live portfolio content.

const {
  test,
  expect,
  HAS_ANT_BINARY,
  ANT_BINARY_PATH,
  HAS_IPFS_NATIVE_ADDON,
  IPFS_NATIVE_ADDON_PATH,
} = require('../live-fixtures');

const PEER_TARGET = 20;
// Each live run starts with a *fresh* Ant/IPFS data dir
// (FREEDOM_ANT_DATA / FREEDOM_IPFS_DATA point at a per-run temp dir,
// see live-fixtures.js), so peerstores are empty and gossip starts
// from the hardcoded bootstrap nodes every time. Bee in DHT client
// mode typically crosses 20 peers in 30–180 s on a warm bootstrap
// network. 7 min keeps headroom for slow home connections without making the
// test feel infinite.
const PEER_TIMEOUT_MS = 7 * 60_000;
const NAVIGATION_TIMEOUT_MS = 90_000;
const PAGE_RENDER_TIMEOUT_MS = 60_000;
const IPFS_START_TIMEOUT_MS = 60_000;

const PLAY_BUTTON_SNIFFER = `
  (() => {
    const sel = [
      'button[aria-label*="play" i]',
      '[role="button"][aria-label*="play" i]',
      'a[aria-label*="play" i]',
      '.play-button',
      '.play',
      'button.play',
      'video',
      'audio',
    ].join(', ');
    if (document.querySelector(sel)) return true;
    const els = document.querySelectorAll('button, a, [role="button"]');
    for (const el of els) {
      if (/\\bplay\\b/i.test(el.textContent || '')) return true;
    }
    return false;
  })()
`;

const VITALIK_H1_SNIFFER = `
  (() => {
    const headings = document.querySelectorAll('h1');
    for (const h of headings) {
      if (/vitalik/i.test(h.textContent || '')) return true;
    }
    return false;
  })()
`;

const GNS_GWEI_PAGE_SNIFFER = `
  (() => {
    const hostOk = window.location.hostname === 'apoorv.gwei' || window.location.hostname === 'apoorv.xyz';
    if (!hostOk) return false;
    const protocolOk = ['bzz:', 'ipfs:', 'ipns:', 'https:'].includes(window.location.protocol);
    if (!protocolOk) return false;
    const text = (document.body?.innerText || document.body?.textContent || '').trim();
    if (!text) return false;
    if (/invalid|not found|has no contenthash|resolver error|resolution failed/i.test(text)) {
      return false;
    }
    return /Apoorv Lathey|Smart Contracts|Full-Stack Developer/i.test(
      (document.title || '') + '\\n' + text
    );
  })()
`;

// Read the textContent of a peer-count <span> and parse it as an int.
// Returns -1 for "--" / non-numeric placeholders so the polling
// comparator never accidentally satisfies `> PEER_TARGET`.
const readPeerCount = async (locator) => {
  const raw = (await locator.textContent()) || '';
  const n = parseInt(raw.trim(), 10);
  return Number.isFinite(n) ? n : -1;
};

// Wait for a peer-count <span> to exceed PEER_TARGET. Polling cadence is tuned
// to the renderer's Bee fetch loop (500 ms, see bee-ui.js) — coarser polls
// would add dead air between the count crossing the threshold and Playwright
// noticing.
const waitForPeers = (locator, label) =>
  expect
    .poll(() => readPeerCount(locator), {
      message: `Waiting for ${label} connected peers > ${PEER_TARGET}`,
      timeout: PEER_TIMEOUT_MS,
      intervals: [500],
    })
    .toBeGreaterThan(PEER_TARGET);

// Drive the address bar the way a user would: focus, fill, Enter.
// Returns once the address bar has normalised to `<scheme>://<ensName>`,
// optionally with a trailing slash or path. The scheme assertion is
// strict: it pins the expected transport (bzz vs ipfs vs ipns) so a
// regression in ENS contenthash dispatch can't silently land us on the
// wrong gateway.
const navigateTo = async (window, ensName, expectedScheme) => {
  const input = window.locator('[data-test="address-input"]');
  await input.click();
  await input.fill(ensName);
  await input.press('Enter');

  const escapedHost = ensName.replace(/\./g, '\\.');
  await expect(input).toHaveValue(
    new RegExp(`^${expectedScheme}://${escapedHost}(/.*)?$`),
    { timeout: NAVIGATION_TIMEOUT_MS }
  );
};

const navigateToAnyNameTransport = async (window, name) => {
  const input = window.locator('[data-test="address-input"]');
  await input.click();
  await input.fill(name);
  await input.press('Enter');

  const escapedHost = name.replace(/\./g, '\\.');
  await expect(input).toHaveValue(
    new RegExp(`^(?:bzz|ipfs|ipns)://${escapedHost}(/.*)?$`),
    { timeout: NAVIGATION_TIMEOUT_MS }
  );
};

// Playwright's Electron API doesn't expose <webview> guests as Pages,
// so we route through the host renderer and use webview.executeJavaScript()
// — the same DevTools-Protocol primitive Electron exposes for guests.
const evalInActiveWebview = (window, snippet) =>
  window.evaluate(async (s) => {
    const wv = document.querySelector('webview:not(.hidden)');
    if (!wv || typeof wv.executeJavaScript !== 'function') return false;
    try {
      return await wv.executeJavaScript(s);
    } catch {
      return false;
    }
  }, snippet);

const waitForWebviewCondition = (window, snippet, message) =>
  expect
    .poll(() => evalInActiveWebview(window, snippet), {
      message,
      timeout: PAGE_RENDER_TIMEOUT_MS,
      intervals: [1_000, 2_000, 5_000],
    })
    .toBeTruthy();

// Binary preconditions are evaluated at describe-load (before any
// fixture runs). The previous in-test `test.skip` / `expect` form let
// Playwright launch Electron *first* and only then notice the missing
// binary — meaning a CI box without Bee/IPFS would still spawn the
// app, attempt to start the production node managers against a missing
// binary, and only fail/skip after that side-effect. Now the binary
// check happens before `electronApp` is ever requested.
test.describe('live cold-start sites', () => {
  test.skip(
    !HAS_ANT_BINARY,
    `Live E2E needs the Ant binary at ${ANT_BINARY_PATH}. Run \`npm run ant:download\` to fetch it.`
  );
  test.skip(
    !HAS_IPFS_NATIVE_ADDON,
    `Live E2E needs the freedom-ipfs native addon at ${IPFS_NATIVE_ADDON_PATH}. Run \`npm run ipfs:download\` to fetch it.`
  );

  test('cold-start: Bee reaches peers, native IPFS starts, ENS, WNS, and GNS sites render', async ({
    window,
  }) => {
    const beeMenuButton = window.locator('#bee-menu-button');
    const beeDropdown = window.locator('#bee-menu-dropdown');
    const beePeersCount = window.locator('#bee-peers-count');

    // (1) Open the Nodes menu — kicks off Bee status polling in the renderer.
    await beeMenuButton.click();
    await expect(beeDropdown).toHaveClass(/open/);

    // (2) Wait for Swarm peers and the native IPFS manager.
    await waitForPeers(beePeersCount, 'Swarm');
    await expect
      .poll(async () => (await window.evaluate(() => window.ipfs.getStatus())).status, {
        message: 'Waiting for native IPFS manager to start',
        timeout: IPFS_START_TIMEOUT_MS,
        intervals: [500, 1000],
      })
      .toBe('running');

    // (3) Close the menu before driving the address bar. Polling stops
    // and the visible counters reset to 0 — that's expected.
    await beeMenuButton.click();
    await expect(beeDropdown).not.toHaveClass(/open/);

    // (4) meinhard.eth — Swarm-hosted; address bar must end up on bzz://.
    await navigateTo(window, 'meinhard.eth', 'bzz');
    await waitForWebviewCondition(
      window,
      PLAY_BUTTON_SNIFFER,
      'Waiting for a play-button-shaped element on meinhard.eth'
    );

    // (5) vitalik.eth — IPFS-hosted blog; address bar must end up on
    // ipfs://. The page is content-heavy so the H1 is a stable
    // structural marker that the page actually rendered (vs an error
    // page).
    await navigateTo(window, 'vitalik.eth', 'ipfs');
    await waitForWebviewCondition(
      window,
      VITALIK_H1_SNIFFER,
      'Waiting for an <h1> mentioning "Vitalik" on vitalik.eth'
    );

    // (6) meinhard.wei — WNS name whose contenthash is the same Swarm
    // reference as meinhard.eth, so it must dispatch to bzz:// and render
    // the site step (4) already proved retrievable. This pins the WNS
    // contract path (suffix detection → mainnet contenthash() call →
    // decode → transport dispatch) without depending on third-party IPFS
    // pinning: the previous target, wns.wei, is pinned only at Pinata and
    // advertised via IPNI alone, which a DHT-only node can never retrieve
    // (see freedom-browser#174 / freedom-ipfs#18). Revert to an
    // IPFS-hosted .wei site once delegated routing ships.
    await navigateTo(window, 'meinhard.wei', 'bzz');
    await waitForWebviewCondition(
      window,
      PLAY_BUTTON_SNIFFER,
      'Waiting for a play-button-shaped element on meinhard.wei'
    );

    // (7) apoorv.gwei — GNS-backed page. The live GNS contenthash currently
    // points at an IPFS-hosted portfolio, so assert any supported transport
    // first and then verify page content that should only appear after the
    // name has resolved and the site has rendered.
    await navigateToAnyNameTransport(window, 'apoorv.gwei');
    await waitForWebviewCondition(
      window,
      GNS_GWEI_PAGE_SNIFFER,
      'Waiting for Apoorv portfolio content on apoorv.gwei'
    );
  });
});
