const fs = require('fs');
const path = require('path');

const SOURCE = fs.readFileSync(
  path.join(__dirname, 'webview-preload-ethereum-inject.js'),
  'utf-8'
);

// Compile the IIFE source once and re-invoke it per test with a fresh window.
const installProvider = new Function('window', SOURCE);

const DEFAULT_PROVIDER_CONFIG = Object.freeze({
  uuid: '11111111-1111-4111-8111-111111111111',
  name: 'Freedom',
  icon: 'data:image/png;base64,AAAA',
  rdns: 'baby.freedom.browser',
});

/**
 * The injection source runs in a page realm and expects a `window` global.
 * Evaluate it against a stub window so we can assert on side effects
 * (window.ethereum shape, postMessage payloads, dispatched events).
 */
function createInstance({ providerConfig = DEFAULT_PROVIDER_CONFIG } = {}) {
  const listeners = new Map();
  const postedMessages = [];
  const dispatchedEvents = [];

  const fakeWindow = {
    addEventListener: (type, handler) => {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(handler);
    },
    removeEventListener: (type, handler) => {
      const arr = listeners.get(type);
      if (!arr) return;
      const i = arr.indexOf(handler);
      if (i >= 0) arr.splice(i, 1);
    },
    dispatchEvent: (event) => {
      dispatchedEvents.push(event);
      const arr = listeners.get(event.type);
      if (arr) arr.forEach((h) => h(event));
      return true;
    },
    postMessage: (data, origin) => {
      postedMessages.push({ data, origin });
    },
    __FREEDOM_PROVIDER_CONFIG__: providerConfig,
  };

  installProvider(fakeWindow);

  // Helpers that simulate the preload realm posting messages back to the page.
  const deliverMessage = (data) => {
    const messageListeners = listeners.get('message') || [];
    const event = { source: fakeWindow, data };
    messageListeners.forEach((h) => h(event));
  };
  const deliverMessageFromOtherSource = (data) => {
    const messageListeners = listeners.get('message') || [];
    const event = { source: { different: true }, data };
    messageListeners.forEach((h) => h(event));
  };
  const emitProviderEvent = (event, data) => {
    deliverMessage({ type: 'FREEDOM_ETHEREUM_EVENT', event, data });
  };

  return {
    window: fakeWindow,
    postedMessages,
    dispatchedEvents,
    deliverMessage,
    deliverMessageFromOtherSource,
    emitProviderEvent,
  };
}

// Flush the microtask queue — a .then() + .catch() chain on a rejection
// propagates across 3 microtask turns (reject → .then passthrough → .catch).
// Fake timers don't touch microtasks, so await Promise.resolve() is unaffected.
const flushMicrotasks = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

describe('webview-preload-ethereum-inject', () => {
  let consoleLogSpy;

  beforeEach(() => {
    // Fake timers so orphan request promises (tests that don't await them)
    // never have their 60s/5min timeouts actually fire after the suite exits.
    jest.useFakeTimers();
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    jest.useRealTimers();
  });

  describe('provider shape', () => {
    test('exposes window.ethereum with EIP-1193 surface', () => {
      const { window } = createInstance();
      const p = window.ethereum;

      expect(p).toBeDefined();
      expect(p.isMetaMask).toBe(true);
      expect(p.isFreedomBrowser).toBe(true);
      expect(typeof p.request).toBe('function');
      expect(typeof p.on).toBe('function');
      expect(typeof p.removeListener).toBe('function');
      expect(typeof p.addListener).toBe('function');
      expect(typeof p.removeAllListeners).toBe('function');
      expect(typeof p.enable).toBe('function');
      expect(typeof p.send).toBe('function');
      expect(typeof p.sendAsync).toBe('function');
      expect(typeof p.isConnected).toBe('function');
    });

    test('initial getters reflect disconnected state', () => {
      const { window } = createInstance();
      const p = window.ethereum;

      expect(p.chainId).toBeNull();
      expect(p.selectedAddress).toBeNull();
      expect(p.networkVersion).toBeNull();
      expect(p.isConnected()).toBe(false);
    });

    test('dispatches ethereum#initialized after install', () => {
      const { dispatchedEvents } = createInstance();
      expect(dispatchedEvents.some((e) => e.type === 'ethereum#initialized')).toBe(true);
    });
  });

  describe('request flow', () => {
    test('posts FREEDOM_ETHEREUM_REQUEST with unique ids per call', () => {
      const { window, postedMessages } = createInstance();

      window.ethereum.request({ method: 'eth_chainId' });
      window.ethereum.request({ method: 'eth_accounts', params: [1, 2] });

      expect(postedMessages).toHaveLength(2);
      expect(postedMessages[0].data).toMatchObject({
        type: 'FREEDOM_ETHEREUM_REQUEST',
        method: 'eth_chainId',
        params: [],
      });
      expect(postedMessages[1].data).toMatchObject({
        type: 'FREEDOM_ETHEREUM_REQUEST',
        method: 'eth_accounts',
        params: [1, 2],
      });
      expect(postedMessages[0].data.id).not.toBe(postedMessages[1].data.id);
    });

    test('resolves with result when a matching response arrives', async () => {
      const { window, postedMessages, deliverMessage } = createInstance();

      const pending = window.ethereum.request({ method: 'eth_chainId' });
      const { id } = postedMessages[0].data;

      deliverMessage({ type: 'FREEDOM_ETHEREUM_RESPONSE', id, result: '0x1' });
      await expect(pending).resolves.toBe('0x1');
    });

    test('rejects with a coded error when the response carries an error', async () => {
      const { window, postedMessages, deliverMessage } = createInstance();

      const pending = window.ethereum.request({ method: 'eth_chainId' });
      const { id } = postedMessages[0].data;

      deliverMessage({
        type: 'FREEDOM_ETHEREUM_RESPONSE',
        id,
        error: { message: 'User rejected', code: 4001 },
      });

      await expect(pending).rejects.toMatchObject({ message: 'User rejected', code: 4001 });
    });

    test('ignores messages from a different source', async () => {
      const { window, postedMessages, deliverMessageFromOtherSource, deliverMessage } =
        createInstance();

      const pending = window.ethereum.request({ method: 'eth_chainId' });
      const { id } = postedMessages[0].data;

      deliverMessageFromOtherSource({ type: 'FREEDOM_ETHEREUM_RESPONSE', id, result: 'spoofed' });

      // The promise is still pending — resolve it via the legitimate path.
      deliverMessage({ type: 'FREEDOM_ETHEREUM_RESPONSE', id, result: '0x1' });
      await expect(pending).resolves.toBe('0x1');
    });

    test('rejects with timeout error after 60s for most methods', async () => {
      const { window } = createInstance();
      const pending = window.ethereum.request({ method: 'eth_chainId' });

      jest.advanceTimersByTime(60000);
      await expect(pending).rejects.toThrow('Request timed out');
    });

    test('rejects with timeout error after 5min for eth_sendTransaction', async () => {
      const { window } = createInstance();
      const pending = window.ethereum.request({
        method: 'eth_sendTransaction',
        params: [{}],
      });
      const settled = jest.fn();
      pending.then(settled, settled);

      jest.advanceTimersByTime(60000);
      await flushMicrotasks();
      expect(settled).not.toHaveBeenCalled();

      jest.advanceTimersByTime(240000);
      await expect(pending).rejects.toThrow('Request timed out');
    });
  });

  describe('event emission via FREEDOM_ETHEREUM_EVENT', () => {
    test('chainChanged updates state and notifies listeners', () => {
      const { window, emitProviderEvent } = createInstance();
      const handler = jest.fn();
      window.ethereum.on('chainChanged', handler);

      emitProviderEvent('chainChanged', '0x89');

      expect(handler).toHaveBeenCalledWith('0x89');
      expect(window.ethereum.chainId).toBe('0x89');
      expect(window.ethereum.networkVersion).toBe('137');
    });

    test('accountsChanged updates selectedAddress', () => {
      const { window, emitProviderEvent } = createInstance();
      const handler = jest.fn();
      window.ethereum.on('accountsChanged', handler);

      emitProviderEvent('accountsChanged', ['0xabc']);

      expect(handler).toHaveBeenCalledWith(['0xabc']);
      expect(window.ethereum.selectedAddress).toBe('0xabc');
    });

    test('connect flips isConnected and sets chainId', () => {
      const { window, emitProviderEvent } = createInstance();
      const handler = jest.fn();
      window.ethereum.on('connect', handler);

      emitProviderEvent('connect', { chainId: '0x1' });

      expect(handler).toHaveBeenCalledWith({ chainId: '0x1' });
      expect(window.ethereum.isConnected()).toBe(true);
      expect(window.ethereum.chainId).toBe('0x1');
    });

    test('disconnect clears accounts and isConnected', () => {
      const { window, emitProviderEvent } = createInstance();
      emitProviderEvent('connect', { chainId: '0x1' });
      emitProviderEvent('accountsChanged', ['0xabc']);

      const handler = jest.fn();
      window.ethereum.on('disconnect', handler);

      emitProviderEvent('disconnect', { code: 4900 });

      expect(handler).toHaveBeenCalledWith({ code: 4900 });
      expect(window.ethereum.isConnected()).toBe(false);
      expect(window.ethereum.selectedAddress).toBeNull();
    });

    test('swallows errors thrown by listeners so siblings still fire', () => {
      const { window, emitProviderEvent } = createInstance();
      const thrower = jest.fn(() => {
        throw new Error('boom');
      });
      const survivor = jest.fn();
      window.ethereum.on('chainChanged', thrower);
      window.ethereum.on('chainChanged', survivor);

      emitProviderEvent('chainChanged', '0x1');

      expect(thrower).toHaveBeenCalled();
      expect(survivor).toHaveBeenCalled();
    });

    test('removeListener detaches a specific handler', () => {
      const { window, emitProviderEvent } = createInstance();
      const handler = jest.fn();
      window.ethereum.on('chainChanged', handler);
      window.ethereum.removeListener('chainChanged', handler);

      emitProviderEvent('chainChanged', '0x1');

      expect(handler).not.toHaveBeenCalled();
    });

    test('removeAllListeners clears all handlers for an event', () => {
      const { window, emitProviderEvent } = createInstance();
      const a = jest.fn();
      const b = jest.fn();
      window.ethereum.on('chainChanged', a);
      window.ethereum.on('chainChanged', b);
      window.ethereum.removeAllListeners('chainChanged');

      emitProviderEvent('chainChanged', '0x1');

      expect(a).not.toHaveBeenCalled();
      expect(b).not.toHaveBeenCalled();
    });
  });

  describe('EIP-6963 provider announcement', () => {
    test('dispatches eip6963:announceProvider on install with the seeded info', () => {
      const { dispatchedEvents } = createInstance();
      const announcements = dispatchedEvents.filter((e) => e.type === 'eip6963:announceProvider');

      expect(announcements).toHaveLength(1);
      expect(announcements[0].detail.info).toMatchObject({
        uuid: DEFAULT_PROVIDER_CONFIG.uuid,
        name: 'Freedom',
        rdns: 'baby.freedom.browser',
      });
      expect(announcements[0].detail.info.icon).toMatch(/^data:image\/png;base64,/);
    });

    test('re-announces in response to eip6963:requestProvider', () => {
      const { window, dispatchedEvents } = createInstance();
      const countAnnouncements = () =>
        dispatchedEvents.filter((e) => e.type === 'eip6963:announceProvider').length;
      const before = countAnnouncements();

      window.dispatchEvent({ type: 'eip6963:requestProvider' });

      expect(countAnnouncements()).toBe(before + 1);
    });

    test('detail references the live window.ethereum', () => {
      const { window, dispatchedEvents } = createInstance();
      const announcement = dispatchedEvents.find((e) => e.type === 'eip6963:announceProvider');

      expect(announcement.detail.provider).toBe(window.ethereum);
    });

    test('freezes the detail object and its info per spec', () => {
      const { dispatchedEvents } = createInstance();
      const detail = dispatchedEvents.find((e) => e.type === 'eip6963:announceProvider').detail;

      expect(Object.isFrozen(detail)).toBe(true);
      expect(Object.isFrozen(detail.info)).toBe(true);
    });

    test('clears the config global after consuming it', () => {
      const { window } = createInstance();
      expect(window.__FREEDOM_PROVIDER_CONFIG__).toBeUndefined();
    });

    test('degrades gracefully if the provider config is missing', () => {
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      const { window, dispatchedEvents } = createInstance({ providerConfig: null });

      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('provider config missing'));

      // 6963 announce is skipped…
      expect(dispatchedEvents.filter((e) => e.type === 'eip6963:announceProvider')).toHaveLength(0);
      // …but window.ethereum is still installed and the legacy init still fires.
      expect(window.ethereum).toBeDefined();
      expect(dispatchedEvents.some((e) => e.type === 'ethereum#initialized')).toBe(true);

      errorSpy.mockRestore();
    });
  });

  describe('state sync via FREEDOM_ETHEREUM_STATE', () => {
    test('merges the delivered state into providerState', () => {
      const { window, deliverMessage } = createInstance();

      deliverMessage({
        type: 'FREEDOM_ETHEREUM_STATE',
        state: { chainId: '0x1', accounts: ['0xabc'], isConnected: true },
      });

      expect(window.ethereum.chainId).toBe('0x1');
      expect(window.ethereum.selectedAddress).toBe('0xabc');
      expect(window.ethereum.isConnected()).toBe(true);
    });
  });

  describe('legacy methods', () => {
    test('enable delegates to eth_requestAccounts', () => {
      const { window, postedMessages } = createInstance();
      window.ethereum.enable();

      expect(postedMessages[0].data).toMatchObject({
        type: 'FREEDOM_ETHEREUM_REQUEST',
        method: 'eth_requestAccounts',
      });
    });

    test('send(method, params) delegates to request', () => {
      const { window, postedMessages } = createInstance();
      window.ethereum.send('eth_chainId', []);

      expect(postedMessages[0].data).toMatchObject({
        type: 'FREEDOM_ETHEREUM_REQUEST',
        method: 'eth_chainId',
      });
    });

    test('send({method, params}) delegates to request', () => {
      const { window, postedMessages } = createInstance();
      window.ethereum.send({ method: 'eth_blockNumber' });

      expect(postedMessages[0].data).toMatchObject({
        type: 'FREEDOM_ETHEREUM_REQUEST',
        method: 'eth_blockNumber',
      });
    });

    test('sendAsync delivers JSON-RPC response via callback', async () => {
      const { window, postedMessages, deliverMessage } = createInstance();
      const callback = jest.fn();

      window.ethereum.sendAsync({ id: 42, method: 'eth_chainId' }, callback);

      const { id } = postedMessages[0].data;
      deliverMessage({ type: 'FREEDOM_ETHEREUM_RESPONSE', id, result: '0x1' });

      await flushMicrotasks();
      expect(callback).toHaveBeenCalledWith(null, { id: 42, jsonrpc: '2.0', result: '0x1' });
    });

    test('sendAsync forwards errors via callback', async () => {
      const { window, postedMessages, deliverMessage } = createInstance();
      const callback = jest.fn();

      window.ethereum.sendAsync({ id: 42, method: 'eth_chainId' }, callback);

      const { id } = postedMessages[0].data;
      deliverMessage({
        type: 'FREEDOM_ETHEREUM_RESPONSE',
        id,
        error: { message: 'oops', code: 4001 },
      });

      await flushMicrotasks();
      expect(callback).toHaveBeenCalledWith(expect.objectContaining({ message: 'oops' }), null);
    });
  });
});
