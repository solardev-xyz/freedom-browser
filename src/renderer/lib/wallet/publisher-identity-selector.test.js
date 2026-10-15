// The publisher identity selector's address slot (#606 item 5).
//
// The slot shows the active identity's owner address, which is code and is
// set in monospace. Before the owner is known it shows "Unlock to reveal
// owner", which is a sentence — it used to be rendered inside the same
// <code> element and so came out in the monospace font.

jest.mock('./wallet-state.js', () => ({ walletState: {} }));

const originalDocument = global.document;

const render = async (state) => {
  global.document = {
    addEventListener: jest.fn(),
    querySelectorAll: () => [],
    // `escapeHtml` round-trips through a detached element's textContent.
    createElement: () => {
      let text = '';
      return {
        set textContent(value) {
          text = String(value);
        },
        get innerHTML() {
          return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        },
      };
    },
  };
  const { renderPublisherIdentitySelector } = await import('./publisher-identity-selector.js');
  // `querySelector` returning null makes the renderer stop after writing the
  // button markup, which is all these tests read.
  const container = { innerHTML: '', querySelector: () => null };
  renderPublisherIdentitySelector(container, state);
  return container.innerHTML;
};

afterEach(() => {
  global.document = originalDocument;
});

test('a known owner is shown as code', async () => {
  const html = await render({
    activeIdentityId: 'bee-wallet',
    identities: [
      { id: 'bee-wallet', mode: 'bee-wallet', owner: '0x209693Bc6afc0C5328bA36FaF03C514EF312287C' },
    ],
  });
  expect(html).toMatch(/<code class="wallet-selector-address">0x209693…12287C<\/code>/);
});

test('the locked-state hint is prose, not code', async () => {
  const html = await render({
    activeIdentityId: 'bee-wallet',
    identities: [{ id: 'bee-wallet', mode: 'bee-wallet', owner: null }],
  });
  expect(html).toMatch(
    /<span class="wallet-selector-address wallet-selector-address-hint">Unlock to reveal owner<\/span>/
  );
  expect(html).not.toMatch(/<code[^>]*>[^<]*Unlock/);
});
