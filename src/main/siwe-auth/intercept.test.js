const os = require('os');
const path = require('path');
const fs = require('fs');
const { EventEmitter } = require('events');
const { Wallet } = require('ethers');

jest.mock('../logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const mockUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'siwe-intercept-'));
const mockTabs = new Map();
jest.mock('electron', () => ({
  app: { getPath: () => mockUserData },
  ipcMain: { handle: jest.fn() },
  webContents: { fromId: (id) => mockTabs.get(id) || null },
}));

const mockRegister = jest.fn();
jest.mock('../webrequest-dispatcher', () => ({
  registerWebRequestHandler: (...args) => mockRegister(...args),
}));
jest.mock('../ipfs/gateway-transport', () => ({ isGatewayTransportRequest: () => false }));

const mockAgentPages = new Set();
jest.mock('../wallet/agent-tab-custody', () => ({
  isAgentPageId: (id) => mockAgentPages.has(id),
}));

// Hardhat accounts #0 and #2: public test keys.
const signer = new Wallet('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcaec478ef4ca2b0ef');
const otherSigner = new Wallet(
  '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a'
);
const mockWallets = [
  { index: 0, name: 'Main Wallet', address: signer.address, type: 'mnemonic' },
  { index: 1, name: 'Team', address: '0x1111111111111111111111111111111111111111', type: 'safe' },
];
jest.mock('../identity-manager', () => ({
  getDerivedWallets: async () => mockWallets,
}));

const IPC = require('../../shared/ipc-channels');
const siwe = require('./intercept');

const TAB = 7;
const URL_ = 'https://club.example/members';
const CHALLENGE =
  'SIWE realm="club.example", nonce=abc12345xyz, chain-id=1, statement="Sign in to Example Club"';

function makeTab(id, url = URL_) {
  const tab = new EventEmitter();
  tab.isDestroyed = () => false;
  tab.getURL = () => url;
  // Like the real one, settles only when the page has loaded: after the
  // request (and its headers) went out.
  tab.loadURL = jest.fn(() => new Promise(() => {}));
  tab.hostWebContents = { send: jest.fn(), isDestroyed: () => false };
  mockTabs.set(id, tab);
  return tab;
}

function response(overrides = {}) {
  return {
    id: 101,
    url: URL_,
    method: 'GET',
    resourceType: 'mainFrame',
    statusCode: 401,
    webContentsId: TAB,
    responseHeaders: { 'WWW-Authenticate': [CHALLENGE] },
    ...overrides,
  };
}

function sentChallenge(tab) {
  const call = tab.hostWebContents.send.mock.calls.find(
    ([channel]) => channel === IPC.SIWE_CHALLENGE
  );
  return call?.[1];
}

let tab;

beforeEach(() => {
  siwe._resetForTests();
  mockTabs.clear();
  mockAgentPages.clear();
  fs.rmSync(path.join(mockUserData, 'siwe-accounts.json'), { force: true });
  tab = makeTab(TAB);
});

afterAll(() => {
  fs.rmSync(mockUserData, { recursive: true, force: true });
});

describe('installSiweInterception', () => {
  test('registers the detector and the injector under siwe- names', () => {
    siwe.installSiweInterception();
    expect(mockRegister).toHaveBeenCalledWith(
      'onHeadersReceived',
      'siwe-detect',
      expect.any(Function)
    );
    expect(mockRegister).toHaveBeenCalledWith(
      'onBeforeSendHeaders',
      'siwe-inject',
      expect.any(Function)
    );
  });
});

describe('detectHandler', () => {
  test("passes the 401 through and tells the tab's window", () => {
    expect(siwe.detectHandler(response())).toBeNull();
    expect(sentChallenge(tab)).toMatchObject({
      webContentsId: TAB,
      url: URL_,
      origin: 'https://club.example',
      domain: 'club.example',
      statement: 'Sign in to Example Club',
      chainId: 1,
      rememberedAddress: null,
    });
  });

  test.each([
    ['another status', { statusCode: 403 }],
    ['a subresource', { resourceType: 'xhr' }],
    ['a POST', { method: 'POST' }],
    ['no SIWE challenge', { responseHeaders: { 'WWW-Authenticate': ['Basic realm="x"'] } }],
    [
      'a challenge for another host',
      {
        responseHeaders: {
          'WWW-Authenticate': ['SIWE realm="evil.example", nonce=abc12345, chain-id=1'],
        },
      },
    ],
    ['plain http to a remote host', { url: 'http://club.example/members' }],
  ])('ignores %s', (_label, overrides) => {
    siwe.detectHandler(response(overrides));
    expect(tab.hostWebContents.send).not.toHaveBeenCalled();
  });

  test('ignores a tab the Agent is driving', () => {
    mockAgentPages.add(TAB);
    siwe.detectHandler(response());
    expect(tab.hostWebContents.send).not.toHaveBeenCalled();
  });

  test('a newer challenge in the tab replaces the older one', () => {
    siwe.detectHandler(response());
    const first = sentChallenge(tab);
    tab.hostWebContents.send.mockClear();
    siwe.detectHandler(response({ id: 102 }));
    const second = sentChallenge(tab);
    expect(second.id).not.toBe(first.id);
    expect(siwe.getChallenge({ id: first.id })).toBeNull();
    expect(siwe.getChallenge({ id: second.id })).toMatchObject({ id: second.id });
  });

  test('leaving the page drops the challenge and tells the window', () => {
    siwe.detectHandler(response());
    const { id } = sentChallenge(tab);
    tab.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
    expect(siwe.getChallenge({ id })).toBeNull();
    expect(tab.hostWebContents.send).toHaveBeenCalledWith(IPC.SIWE_CHALLENGE_CLOSED, { id });
  });

  test('a same-document or subframe navigation keeps it', () => {
    siwe.detectHandler(response());
    const { id } = sentChallenge(tab);
    tab.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true });
    tab.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false });
    expect(siwe.getChallenge({ id })).not.toBeNull();
  });
});

describe('prepare and complete', () => {
  async function prepared(walletIndex = 0) {
    siwe.detectHandler(response());
    const { id } = sentChallenge(tab);
    const result = await siwe.prepare({ id, walletIndex });
    return { id, ...result };
  }

  test('builds the message for the chosen account, bound to the page', async () => {
    const { success, address, message } = await prepared();
    expect(success).toBe(true);
    expect(address).toBe(signer.address);
    expect(message).toMatch(/^club\.example wants you to sign in with your Ethereum account:\n/);
    expect(message).toContain(`\n${signer.address}\n\nSign in to Example Club\n\nURI: ${URL_}\n`);
    expect(message).toContain('\nChain ID: 1\nNonce: abc12345xyz\nIssued At: ');
  });

  test('refuses a Safe account and an unknown one', async () => {
    siwe.detectHandler(response());
    const { id } = sentChallenge(tab);
    expect(await siwe.prepare({ id, walletIndex: 1 })).toMatchObject({
      success: false,
      code: 'unsupported_account',
    });
    expect(await siwe.prepare({ id, walletIndex: 9 })).toMatchObject({
      success: false,
      code: 'no_account',
    });
  });

  test('a good signature reloads the page and the header goes on that request once', async () => {
    const { id, message } = await prepared();
    const signature = await signer.signMessage(message);

    expect(await siwe.complete({ id, walletIndex: 0, signature })).toEqual({ success: true });
    expect(tab.loadURL).toHaveBeenCalledWith(URL_);
    expect(siwe.getChallenge({ id })).toBeNull();

    // The reload's own navigation must not be mistaken for leaving.
    tab.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
    expect(tab.hostWebContents.send).not.toHaveBeenCalledWith(IPC.SIWE_CHALLENGE_CLOSED, { id });

    const request = {
      id: 201,
      url: URL_,
      resourceType: 'mainFrame',
      webContentsId: TAB,
      requestHeaders: { authorization: 'Basic x' },
    };
    const injected = siwe.injectHandler(request);
    expect(Object.keys(injected.requestHeaders)).toEqual(['Authorization']);
    const token = injected.requestHeaders.Authorization.match(/^SIWE result="([^"]+)"$/)[1];
    expect(JSON.parse(Buffer.from(token, 'base64url').toString('utf8'))).toEqual({
      message,
      signature,
    });

    expect(siwe.injectHandler({ ...request, id: 202 })).toBeNull();
  });

  test('the header never goes to another URL, tab or a subresource', async () => {
    const { id, message } = await prepared();
    await siwe.complete({ id, walletIndex: 0, signature: await signer.signMessage(message) });
    const base = {
      id: 201,
      url: URL_,
      resourceType: 'mainFrame',
      webContentsId: TAB,
      requestHeaders: {},
    };
    expect(siwe.injectHandler({ ...base, url: 'https://club.example/other' })).toBeNull();
    expect(siwe.injectHandler({ ...base, webContentsId: 8 })).toBeNull();
    expect(siwe.injectHandler({ ...base, resourceType: 'xhr' })).toBeNull();
    expect(siwe.injectHandler(base)).not.toBeNull();
  });

  test('the header goes on the GET reload only, never a form POST to the same URL', async () => {
    const { id, message } = await prepared();
    await siwe.complete({ id, walletIndex: 0, signature: await signer.signMessage(message) });
    const base = {
      id: 201,
      url: URL_,
      resourceType: 'mainFrame',
      webContentsId: TAB,
      requestHeaders: {},
    };
    expect(siwe.injectHandler({ ...base, method: 'POST' })).toBeNull();
    expect(siwe.injectHandler({ ...base, method: 'GET' })).not.toBeNull();
  });

  test('a reload that fails leaves no header waiting for a later load', async () => {
    tab.loadURL.mockImplementation(() => Promise.reject(new Error('ERR_CONNECTION_REFUSED')));
    const { id, message } = await prepared();
    await siwe.complete({ id, walletIndex: 0, signature: await signer.signMessage(message) });
    await new Promise((resolve) => setImmediate(resolve));
    expect(
      siwe.injectHandler({
        id: 201,
        url: URL_,
        resourceType: 'mainFrame',
        webContentsId: TAB,
        requestHeaders: {},
      })
    ).toBeNull();
  });

  test('a reload that finished leaves no header behind either', async () => {
    tab.loadURL.mockImplementation(() => Promise.resolve());
    const { id, message } = await prepared();
    await siwe.complete({ id, walletIndex: 0, signature: await signer.signMessage(message) });
    await new Promise((resolve) => setImmediate(resolve));
    expect(
      siwe.injectHandler({
        id: 201,
        url: URL_,
        resourceType: 'mainFrame',
        webContentsId: TAB,
        requestHeaders: {},
      })
    ).toBeNull();
  });

  test('a tab the Agent took while the card was open is not signed in', async () => {
    const { id, message } = await prepared();
    mockAgentPages.add(TAB);
    const signature = await signer.signMessage(message);
    expect(await siwe.complete({ id, walletIndex: 0, signature })).toMatchObject({
      success: false,
      code: 'stale',
    });
    expect(tab.loadURL).not.toHaveBeenCalled();
  });

  test('a tab the Agent took before the reload left does not get the header', async () => {
    const { id, message } = await prepared();
    await siwe.complete({ id, walletIndex: 0, signature: await signer.signMessage(message) });
    mockAgentPages.add(TAB);
    expect(
      siwe.injectHandler({
        id: 201,
        url: URL_,
        resourceType: 'mainFrame',
        webContentsId: TAB,
        requestHeaders: {},
      })
    ).toBeNull();
  });

  test('a challenge whose tab the Agent took is no longer open', () => {
    siwe.detectHandler(response());
    const { id } = sentChallenge(tab);
    mockAgentPages.add(TAB);
    expect(siwe.getChallenge({ id })).toBeNull();
    mockAgentPages.clear();
    expect(siwe.getChallenge({ id })).toBeNull();
  });

  test('preparing for a tab the Agent took drops the challenge', async () => {
    siwe.detectHandler(response());
    const { id } = sentChallenge(tab);
    mockAgentPages.add(TAB);
    expect(await siwe.prepare({ id, walletIndex: 0 })).toMatchObject({
      success: false,
      code: 'stale',
    });
    expect(tab.hostWebContents.send).toHaveBeenCalledWith(IPC.SIWE_CHALLENGE_CLOSED, { id });
  });

  test('a site that still answers 401 is not asked again for that response', async () => {
    const { id, message } = await prepared();
    await siwe.complete({ id, walletIndex: 0, signature: await signer.signMessage(message) });
    siwe.injectHandler({
      id: 301,
      url: URL_,
      resourceType: 'mainFrame',
      webContentsId: TAB,
      requestHeaders: {},
    });
    tab.hostWebContents.send.mockClear();

    siwe.detectHandler(response({ id: 301 }));
    expect(tab.hostWebContents.send).not.toHaveBeenCalled();

    // A later, fresh load asks again.
    siwe.detectHandler(response({ id: 302 }));
    expect(sentChallenge(tab)).toBeDefined();
  });

  test('remembers the account for the site', async () => {
    const { id, message } = await prepared();
    await siwe.complete({ id, walletIndex: 0, signature: await signer.signMessage(message) });
    tab.hostWebContents.send.mockClear();
    siwe.detectHandler(response({ id: 400 }));
    expect(sentChallenge(tab).rememberedAddress).toBe(signer.address);
    expect(siwe.forgetOrigin('https://club.example')).toBe(true);
  });

  test('refuses a signature from another account', async () => {
    const { id, message } = await prepared();
    const signature = await otherSigner.signMessage(message);
    expect(await siwe.complete({ id, walletIndex: 0, signature })).toMatchObject({
      success: false,
      code: 'bad_signature',
    });
    expect(tab.loadURL).not.toHaveBeenCalled();
  });

  test('refuses a signature over another message', async () => {
    const { id, message } = await prepared();
    const signature = await signer.signMessage(message.replace('club.example', 'evil.example'));
    expect(await siwe.complete({ id, walletIndex: 0, signature })).toMatchObject({
      success: false,
      code: 'bad_signature',
    });
  });

  test('refuses when nothing was prepared for the account', async () => {
    const { id, message } = await prepared(0);
    const signature = await signer.signMessage(message);
    expect(await siwe.complete({ id, walletIndex: 3, signature })).toMatchObject({
      success: false,
      code: 'not_prepared',
    });
  });

  test('refuses when the tab moved to another site', async () => {
    const { id, message } = await prepared();
    tab.getURL = () => 'https://evil.example/';
    const signature = await signer.signMessage(message);
    expect(await siwe.complete({ id, walletIndex: 0, signature })).toMatchObject({
      success: false,
      code: 'stale',
    });
    expect(tab.loadURL).not.toHaveBeenCalled();
  });

  test('refuses a cancelled or unknown challenge', async () => {
    const { id, message } = await prepared();
    siwe.cancel({ id });
    const signature = await signer.signMessage(message);
    expect(await siwe.complete({ id, walletIndex: 0, signature })).toMatchObject({
      success: false,
      code: 'stale',
    });
    expect(await siwe.prepare({ id: 'nope', walletIndex: 0 })).toMatchObject({
      success: false,
      code: 'stale',
    });
  });

  test('refuses an expired challenge', async () => {
    jest.useFakeTimers({ now: Date.now() });
    try {
      const { id, message } = await prepared();
      jest.setSystemTime(Date.now() + 11 * 60 * 1000);
      const signature = await signer.signMessage(message);
      expect(await siwe.complete({ id, walletIndex: 0, signature })).toMatchObject({
        success: false,
        code: 'expired',
      });
    } finally {
      jest.useRealTimers();
    }
  });
});
