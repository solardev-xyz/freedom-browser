/**
 * The sidebar panel is the surface an approval screen owns.
 *
 * While a hardware signature is in flight the device prompt cannot be
 * recalled, so the chrome that would collapse the panel over it — the header
 * X, the toolbar toggle, Cmd/Ctrl+Shift+W — has to refuse, and has to look
 * refused. Collapsing also fires 'sidebar-closed', which runs the
 * coordinator's closeAllSubscreens() cascade over the live confirmation.
 */

const { createDocument, createElement } = require('../../../test/helpers/fake-dom.js');

const flush = () => new Promise((resolve) => setImmediate(resolve));

async function loadSidebar() {
  jest.resetModules();

  const elements = {
    sidebar: createElement('aside', { classes: ['sidebar', 'collapsed'] }),
    'wallet-toggle-btn': createElement('button'),
    'sidebar-close': createElement('button'),
  };
  const document = createDocument({ elementsById: elements });
  document.dispatchEvent = jest.fn();
  global.document = document;
  global.window = {
    electronAPI: { getSettings: jest.fn().mockResolvedValue({ enableIdentityWallet: true }) },
    addEventListener: jest.fn(),
  };
  global.CustomEvent = class { constructor(type, init) { this.type = type; Object.assign(this, init); } };

  // Imported after resetModules, so this is the same lock instance the
  // sidebar module subscribes to.
  const flight = await import('./wallet/signature-flight.js');
  const sidebar = await import('./sidebar.js');
  sidebar.initSidebar();
  await flush(); // the feature flag resolves asynchronously

  sidebar.open();
  return { sidebar, flight, elements, document };
}

const closedEvents = (document) =>
  document.dispatchEvent.mock.calls.filter(([event]) => event.type === 'sidebar-closed').length;

describe('sidebar ownership during a signature flight', () => {
  afterEach(() => {
    delete global.document;
    delete global.window;
    delete global.CustomEvent;
  });

  test('the close button and toolbar toggle go dead for the flight', async () => {
    const { flight, elements } = await loadSidebar();
    const request = { id: 'ledger-send' };

    expect(elements['sidebar-close'].disabled).toBe(false);
    expect(elements['wallet-toggle-btn'].disabled).toBe(false);

    flight.beginSignatureFlight(request);
    expect(elements['sidebar-close'].disabled).toBe(true);
    expect(elements['sidebar-close'].title).toMatch(/device/);
    expect(elements['wallet-toggle-btn'].disabled).toBe(true);

    flight.endSignatureFlight(request);
    expect(elements['sidebar-close'].disabled).toBe(false);
    expect(elements['wallet-toggle-btn'].disabled).toBe(false);
  });

  test('the X, the toggle and the keyboard shortcut cannot collapse a live confirmation', async () => {
    const { sidebar, flight, elements, document } = await loadSidebar();
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const before = closedEvents(document);

    flight.beginSignatureFlight({ id: 'ledger-send' });

    elements['sidebar-close'].dispatch('click');
    elements['wallet-toggle-btn'].dispatch('click');
    sidebar.close();
    sidebar.toggle();
    document.handlers.keydown({ ctrlKey: true, shiftKey: true, key: 'W', preventDefault: jest.fn() });

    expect(sidebar.isVisible()).toBe(true);
    expect(elements.sidebar.classList.contains('collapsed')).toBe(false);
    // 'sidebar-closed' is what runs closeAllSubscreens() over the pending
    // approval screen, so it must not have fired either.
    expect(closedEvents(document)).toBe(before);

    warn.mockRestore();
  });

  test('the panel closes normally again once the device has answered', async () => {
    const { sidebar, flight, elements, document } = await loadSidebar();
    const request = { id: 'ledger-send' };
    const before = closedEvents(document);

    flight.beginSignatureFlight(request);
    flight.endSignatureFlight(request);

    elements['sidebar-close'].dispatch('click');

    expect(sidebar.isVisible()).toBe(false);
    expect(elements.sidebar.classList.contains('collapsed')).toBe(true);
    expect(closedEvents(document)).toBe(before + 1);
  });

  test('a closed panel can still be reopened to reach the confirmation', async () => {
    const { sidebar, flight, elements } = await loadSidebar();
    sidebar.close();

    flight.beginSignatureFlight({ id: 'ledger-send' });

    // Nothing to protect while the panel is shut, and the toggle is the way
    // back to the screen holding the device prompt.
    expect(elements['wallet-toggle-btn'].disabled).toBe(false);
    sidebar.toggle();
    expect(sidebar.isVisible()).toBe(true);
    expect(elements['wallet-toggle-btn'].disabled).toBe(true);
  });
});
