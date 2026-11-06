// The trust panel's content row for `bzz:`, `ipfs:` and `ipns:` pages
// (freedom-core design 0009, Labels), driven through the real chrome.
//
// Main labels each dweb response with `X-Freedom-Content-Trust`; the session's
// `onHeadersReceived` takes the label off every response, keeps a main
// frame's for its tab, and the chrome asks for it once the navigation commits
// (`src/main/dweb/content-trust.js`). In test mode the harness owns the dweb
// schemes, so a content fixture's header plays main's label here: what is
// pinned is everything after the handler, which is the same code in
// production. `content-trust.test.js` pins the handler's side (no node names
// its own label), and `navigation-utils.test.js` the rows.

const { test, expect, clickOverGuest } = require('./fixtures');

const HASH = 'c0ffee'.repeat(10) + 'beef';
const CID = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi';
const LABEL = 'X-Freedom-Content-Trust';

const SENTENCE = {
  verified: 'Content verified by Freedom',
  latest_asserted: 'Content verified; latest version as reported by your node',
  node_asserted: "Content retrieved by Freedom's node",
  unverified: 'Content not verified: served by your external node as is',
};

const navigateTo = async (window, value) => {
  const input = window.locator('[data-test="address-input"]');
  await input.click();
  await input.fill(value);
  await input.press('Enter');
};

const webviewUrl = (window) =>
  window.evaluate(() => {
    const wv = document.querySelector('webview.active, webview:not(.hidden)');
    return wv?.getURL?.() || '';
  });

const inGuest = (window, source) =>
  window.evaluate(async (js) => {
    const wv = document.querySelector('webview.active, webview:not(.hidden)');
    if (!wv?.executeJavaScript) return null;
    try {
      return await wv.executeJavaScript(js, true);
    } catch (err) {
      return `error: ${err?.message || err}`;
    }
  }, source);

// Every row of a popover section: its label (null for a sentence row, which
// has none), its value, and whether it wraps.
const readRows = (window, containerId) =>
  window.evaluate(
    (id) =>
      [...document.querySelectorAll(`#${id} .trust-popover-field`)].map((row) => ({
        label:
          row.querySelector('.trust-popover-field-label')?.textContent.replace(/:\s*$/, '') ??
          null,
        value: row.dataset.autoFit || row.querySelector('.trust-popover-field-value')?.textContent,
        wraps: row.classList.contains('trust-popover-field-wrap'),
      })),
    containerId
  );

test("a hash page's shield is its content label, which its subresources don't change", async ({
  window,
  harness,
}) => {
  const page = `bzz://${HASH}/`;
  // The page loads a subframe and fetches a resource, each labelled
  // otherwise, and records what its own fetch could read of the label.
  await harness.setContentFixture(page, {
    headers: { [LABEL]: 'unverified' },
    body:
      '<!doctype html><title>content label</title><h1>page</h1>' +
      `<iframe src="${page}frame.html"></iframe>` +
      '<script>' +
      `window.__read = fetch('${page}data.json').then((r) => r.headers.get('${LABEL}'));` +
      '</script>',
  });
  await harness.setContentFixture(`${page}frame.html`, {
    headers: { [LABEL]: 'verified' },
    body: '<!doctype html><p>frame</p>',
  });
  await harness.setContentFixture(`${page}data.json`, {
    contentType: 'application/json',
    headers: { [LABEL]: 'verified', 'Access-Control-Expose-Headers': LABEL },
    body: '{}',
  });

  await navigateTo(window, page);
  await expect.poll(() => webviewUrl(window), { timeout: 15_000 }).toBe(page);

  const shield = window.locator('#trust-shield');
  await expect(shield).toBeVisible({ timeout: 15_000 });
  await expect(shield).toHaveAttribute('data-trust', 'unverified');
  await expect(shield).toHaveAttribute('aria-label', SENTENCE.unverified);

  // No page reads the label: the session took it off the response.
  await expect.poll(() => inGuest(window, 'window.__read'), { timeout: 15_000 }).toBeNull();
  await expect
    .poll(() => inGuest(window, `fetch('${page}data.json').then((r) => r.headers.get('${LABEL}'))`))
    .toBeNull();
  // The subframe and the fetch kept their labels to themselves.
  await expect(shield).toHaveAttribute('data-trust', 'unverified');

  await clickOverGuest(shield);
  await expect(window.locator('#trust-popover')).toBeVisible();
  await expect(window.locator('#trust-popover-status')).toHaveText(SENTENCE.unverified);
  await expect(window.locator('#trust-popover-content-title')).toHaveText('Loads from');
  expect(await readRows(window, 'trust-popover-trust-fields')).toEqual([]);
  await expect(window.locator('#trust-popover-trust-fields')).toBeHidden();
  expect(await readRows(window, 'trust-popover-content-fields')).toEqual([
    { label: 'Network', value: 'Swarm', wraps: false },
    { label: 'Hash', value: HASH, wraps: false },
  ]);
});

test("a name's popover keeps its resolution and gains the content row", async ({
  window,
  harness,
}) => {
  const name = 'content-label.eth';
  await harness.setEnsFixture(name, {
    type: 'ok',
    protocol: 'ipfs',
    decoded: CID,
    uri: `ipfs://${CID}`,
    trust: {
      level: 'verified',
      system: 'ens',
      method: 'quorum',
      block: { number: 21000000 },
      queried: ['a.rpc.test', 'b.rpc.test'],
      agreed: ['a.rpc.test', 'b.rpc.test'],
      dissented: [],
    },
  });
  await harness.setContentFixture(`ipfs://${name}/`, {
    headers: { [LABEL]: 'latest_asserted' },
    body: `<!doctype html><title>${name}</title><h1>${name}</h1>`,
  });

  await navigateTo(window, name);
  await expect
    .poll(() => webviewUrl(window), { timeout: 15_000 })
    .toMatch(new RegExp(`^ipfs://${name.replace('.', '\\.')}`));

  const shield = window.locator('#trust-shield');
  await expect(shield).toBeVisible({ timeout: 15_000 });
  // The shield is still the name's.
  await expect(shield).toHaveAttribute('data-trust', 'verified');
  await expect(shield).toHaveAttribute('aria-label', 'Ethereum name resolution trust: verified');

  // The label arrives once the navigation commits. A popover opened before
  // it closes when it lands (the stale guard), so reopen until it shows.
  const popover = window.locator('#trust-popover');
  await expect
    .poll(
      async () => {
        if (await popover.isHidden()) await clickOverGuest(shield);
        return readRows(window, 'trust-popover-content-fields');
      },
      { timeout: 15_000 }
    )
    .toEqual([
      { label: 'Network', value: 'IPFS', wraps: false },
      { label: 'CID', value: CID, wraps: false },
      { label: null, value: SENTENCE.latest_asserted, wraps: true },
    ]);
  await expect(window.locator('#trust-popover-status')).toHaveText('ENS resolution verified');
  await expect(window.locator('#trust-popover-trust-fields')).toBeVisible();
  await expect(window.locator('#trust-popover-content-title')).toHaveText('Resolves to');
});

test('a page without a label shows no shield, and leaves no label behind', async ({
  window,
  harness,
}) => {
  const labelled = `bzz://${HASH}/`;
  const plain = `ipfs://${CID}/`;
  await harness.setContentFixture(labelled, {
    headers: { [LABEL]: 'node_asserted' },
    body: '<!doctype html><h1>labelled</h1>',
  });
  // Main's own answer (an error page, say) carries no label.
  await harness.setContentFixture(plain, { status: 502, body: '<!doctype html><h1>error</h1>' });

  await navigateTo(window, labelled);
  const shield = window.locator('#trust-shield');
  await expect(shield).toBeVisible({ timeout: 15_000 });
  await expect(shield).toHaveAttribute('data-trust', 'user-configured');
  await expect(shield).toHaveAttribute('aria-label', SENTENCE.node_asserted);

  await navigateTo(window, plain);
  await expect.poll(() => webviewUrl(window), { timeout: 15_000 }).toBe(plain);
  await expect(shield).toBeHidden();
  await expect(window.locator('#protocol-icon')).toHaveAttribute('data-protocol', 'ipfs');
});
