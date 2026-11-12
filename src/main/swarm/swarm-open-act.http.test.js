/**
 * @jest-environment node
 */
'use strict';

/**
 * `swarm_openAct` (#648), through the result the page gets: the real
 * provider, permission store, publisher normaliser and ACT service against a
 * fake Ant over loopback HTTP. The fake answers ACT downloads the way Ant's
 * `act_maybe_resolve` does (crates/ant-gateway/src/act.rs): with both
 * `swarm-act-publisher` and `swarm-act-history-address` it resolves the share,
 * and a node that holds no grantee entry under that publisher answers 404
 * `act or history entry not found`.
 *
 * What is pinned here is the consent boundary in main: an open needs the
 * user's approval of this call or a stored grant for exactly this (site,
 * publisher) pair; a private (or unclassifiable) sender is refused; and the
 * request the node sees carries main's normalised publisher, never the
 * page's spelling.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

const ipcHandlers = {};
const mockFromId = jest.fn();
jest.mock('electron', () => ({
  app: { getPath: jest.fn() },
  ipcMain: {
    handle: (channel, handler) => {
      ipcHandlers[channel] = handler;
    },
    removeHandler: jest.fn(),
  },
  webContents: { fromId: (id) => mockFromId(id) },
}));
jest.mock('electron-log', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  verbose: jest.fn(),
}));
// The window registry itself needs Electron; the private-sender rule over
// it (anything but 'public' is private) runs for real.
jest.mock('../private/private-windows', () => ({
  classifyWebContents: (webContents) => webContents?.kind ?? 'unknown',
}));
jest.mock('./gsoc-miner', () => ({ mineSigner: jest.fn(), joinJob: jest.fn() }));
jest.mock('./subscription-registry', () => ({ configure: jest.fn(), cancelByOrigin: jest.fn() }));
jest.mock('./publish-setup-service', () => ({ getPublishReadiness: async () => ({ ok: true }) }));
jest.mock('./publish-service', () => ({}));
jest.mock('./feed-service', () => ({}));
jest.mock('./feed-store', () => ({}));
jest.mock('./publish-history', () => ({}));
jest.mock('../identity-manager', () => ({}));
let mockAntUrl = null;
jest.mock('../service-registry', () => ({ getAntApiUrl: () => mockAntUrl }));

const { app } = require('electron');
const { SigningKey } = require('ethers');
const { PrivateKey } = require('@ethersphere/bee-js');
const permissions = require('./swarm-permissions');
const { registerSwarmProviderIpc, clearPermissionFreeReadBudgets } = require('./swarm-provider-ipc');
const { startFakeHttpNode } = require('../../../test/helpers/fake-http-node');

registerSwarmProviderIpc();
permissions.registerSwarmPermissionsIpc();

const ORIGIN = 'https://inbox.example';
const OTHER_ORIGIN = 'https://other.example';
const PUBLISHER = new PrivateKey('11'.repeat(32)).publicKey().toCompressedHex().replace(/^0x/, '');
const PUBLISHER_UNCOMPRESSED = SigningKey.computePublicKey(`0x${PUBLISHER}`, false).slice(2);
const OTHER_PUBLISHER = new PrivateKey('22'.repeat(32)).publicKey().toCompressedHex().replace(/^0x/, '');
const REFERENCE = 'aa'.repeat(32);
const HISTORY = 'bb'.repeat(32);
const CONTENT = Buffer.from('a letter shared through ACT');

// The chrome window that sends provider requests, and the tab guest it
// names; agent-tab-custody ties an automatic request to the guest this way.
const CHROME = { id: 1, kind: 'public' };
const GUEST = { id: 9, hostWebContents: CHROME, isDestroyed: () => false };
const AUTO = { webContentsId: 9, approval: 'auto' };
const USER = { webContentsId: 9, approval: 'user' };

let node;
let tmpDir;
// What the fake node answers for an ACT download it can resolve.
let actAnswer;

function fakeAnt(req, res) {
  const url = new URL(req.url, 'http://x');
  const publisher = req.headers['swarm-act-publisher'];
  const history = req.headers['swarm-act-history-address'];
  if (!publisher || !history) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ code: 404, message: 'Not Found' }));
    return;
  }
  // The fake holds a grantee entry for this node under PUBLISHER only.
  if (publisher !== PUBLISHER || history !== HISTORY) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ code: 404, message: 'act or history entry not found' }));
    return;
  }
  actAnswer(req, res, url);
}

function serveContent(_req, res) {
  res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Length': CONTENT.length });
  res.end(CONTENT);
}

// `meta` and `sender` may be passed as undefined on purpose, so only a key
// left out takes the default.
async function call(params, options = {}) {
  const meta = 'meta' in options ? options.meta : USER;
  const sender = 'sender' in options ? options.sender : CHROME;
  return ipcHandlers['swarm:provider-execute'](
    { sender },
    { method: 'swarm_openAct', params, origin: options.origin ?? ORIGIN, meta }
  );
}

const share = (extra = {}) => ({
  reference: REFERENCE,
  publisher: PUBLISHER,
  historyAddress: HISTORY,
  ...extra,
});

function actRequests() {
  return node.requests.filter((r) => r.url !== '/node');
}

beforeAll(async () => {
  node = await startFakeHttpNode({
    handler: fakeAnt,
    prelude: (req, res) => {
      if (req.url !== '/node' && req.url !== '/bee/node') return false;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
      return true;
    },
  });
});

afterAll(async () => {
  await node.close();
});

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-open-act-'));
  app.getPath.mockReturnValue(tmpDir);
  permissions._resetCache();
  clearPermissionFreeReadBudgets();
  mockAntUrl = node.origin;
  mockFromId.mockImplementation((id) => (id === 9 ? GUEST : undefined));
  node.requests.length = 0;
  actAnswer = serveContent;
  permissions.grantPermission(ORIGIN);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('swarm_openAct', () => {
  test('a call the user approved opens the share through the node with the ACT headers', async () => {
    const result = await call(share({ timestamp: 1700000000 }));

    expect(result).toEqual({
      result: { data: CONTENT.toString('base64'), encoding: 'base64', contentType: 'text/plain' },
    });
    const [request] = actRequests();
    expect(request.method).toBe('GET');
    expect(request.url).toBe(`/bytes/${REFERENCE}`);
    expect(request.headers['swarm-act-publisher']).toBe(PUBLISHER);
    expect(request.headers['swarm-act-history-address']).toBe(HISTORY);
    expect(request.headers['swarm-act-timestamp']).toBe('1700000000');
    expect(request.headers['accept-encoding']).toBe('identity');
  });

  test('the node is sent main\'s compressed lower-case key, whatever spelling the page used', async () => {
    for (const spelling of [
      PUBLISHER.toUpperCase().replace(/^0([23])/, '0$1'),
      `0x${PUBLISHER}`,
      PUBLISHER_UNCOMPRESSED,
      `0x${PUBLISHER_UNCOMPRESSED.toUpperCase()}`,
    ]) {
      node.requests.length = 0;
      const result = await call(share({ publisher: spelling }));
      expect(result.result?.data).toBe(CONTENT.toString('base64'));
      expect(actRequests()[0].headers['swarm-act-publisher']).toBe(PUBLISHER);
      expect(actRequests()[0].headers).not.toHaveProperty('swarm-act-timestamp');
    }
  });

  test('without the user\'s approval of the call, only a stored grant for this site and publisher opens it', async () => {
    // No grant: refused before the node is asked, with or without meta.
    for (const meta of [AUTO, undefined, {}]) {
      const refused = await call(share(), { meta });
      expect(refused.error).toMatchObject({ code: 4100, data: { reason: 'act_not_granted' } });
    }
    expect(actRequests()).toHaveLength(0);

    // A grant stored under another spelling of the same key covers it.
    expect(permissions.grantActPublisher(ORIGIN, `0x${PUBLISHER_UNCOMPRESSED}`)).toBe(true);
    const opened = await call(share({ publisher: PUBLISHER.toUpperCase() }), { meta: AUTO });
    expect(opened.result?.data).toBe(CONTENT.toString('base64'));

    // It names one publisher: another one's shares still need the user.
    const otherPublisher = await call(share({ publisher: OTHER_PUBLISHER }), { meta: AUTO });
    expect(otherPublisher.error).toMatchObject({ code: 4100, data: { reason: 'act_not_granted' } });

    // And one site: another connected site holds nothing from it.
    permissions.grantPermission(OTHER_ORIGIN);
    const otherSite = await call(share(), { meta: AUTO, origin: OTHER_ORIGIN });
    expect(otherSite.error).toMatchObject({ code: 4100, data: { reason: 'act_not_granted' } });

    // Removing the grant, or disconnecting the site, takes it away.
    expect(permissions.revokeActPublisher(ORIGIN, PUBLISHER)).toBe(true);
    expect((await call(share(), { meta: AUTO })).error?.data?.reason).toBe('act_not_granted');
    permissions.grantActPublisher(ORIGIN, PUBLISHER);
    permissions.revokePermission(ORIGIN);
    expect((await call(share(), { meta: AUTO })).error?.data?.reason).toBe('not_connected');
    permissions.grantPermission(ORIGIN);
    expect((await call(share(), { meta: AUTO })).error?.data?.reason).toBe('act_not_granted');
  });

  test('a private or unclassifiable sender is refused, grant or no grant', async () => {
    permissions.grantActPublisher(ORIGIN, PUBLISHER);
    for (const sender of [{ id: 1, kind: 'private' }, { id: 1, kind: 'unknown' }, undefined]) {
      for (const meta of [USER, AUTO]) {
        const refused = await call(share(), { meta, sender });
        // An automatic request from a sender the custody check cannot tie
        // to a guest is refused there first; either way nothing is opened.
        expect(refused.error.code).toBe(4100);
        expect(['private_window', 'agent_custody']).toContain(refused.error.data.reason);
      }
      expect((await call(share(), { meta: USER, sender })).error.data.reason).toBe('private_window');
    }
    expect(actRequests()).toHaveLength(0);
  });

  test('an Agent-held tab is not answered by the rule', async () => {
    const { setAgentPageCustody } = require('../wallet/agent-tab-custody');
    permissions.grantActPublisher(ORIGIN, PUBLISHER);
    setAgentPageCustody(GUEST, true);
    try {
      const refused = await call(share(), { meta: AUTO });
      expect(refused.error).toMatchObject({ code: 4100, data: { reason: 'agent_custody' } });
      expect(actRequests()).toHaveLength(0);
      const prompted = await call(share(), { meta: USER });
      expect(prompted.result?.data).toBe(CONTENT.toString('base64'));
    } finally {
      setAgentPageCustody(GUEST, false);
    }
  });

  test('a site that is not connected is refused', async () => {
    permissions.revokePermission(ORIGIN);
    const refused = await call(share());
    expect(refused.error).toMatchObject({ code: 4100, data: { reason: 'not_connected' } });
    expect(actRequests()).toHaveLength(0);
  });

  test('a file in a shared manifest is read through /bzz, each path segment encoded', async () => {
    const result = await call(share({ path: 'letters/a b%2F..txt' }));
    expect(result.result?.data).toBe(CONTENT.toString('base64'));
    expect(actRequests()[0].url).toBe(`/bzz/${REFERENCE}/letters/a%20b%252F..txt`);

    node.requests.length = 0;
    await call(share({ path: '' }));
    expect(actRequests()[0].url).toBe(`/bzz/${REFERENCE}/`);
  });

  test.each([
    [{ reference: 'zz'.repeat(32) }, 'invalid_reference'],
    [{ reference: `0x${REFERENCE}` }, 'invalid_reference'],
    [{ publisher: PUBLISHER.slice(2) }, 'invalid_publisher'],
    // 32 bytes is a private key's length, not a public key's.
    [{ publisher: '11'.repeat(32) }, 'invalid_publisher'],
    [{ publisher: `06${PUBLISHER_UNCOMPRESSED.slice(2)}` }, 'invalid_publisher'],
    [{ publisher: `02${'00'.repeat(32)}` }, 'invalid_publisher'],
    [{ historyAddress: 'bb' }, 'invalid_history_address'],
    [{ timestamp: -1 }, 'invalid_timestamp'],
    [{ timestamp: 1.5 }, 'invalid_timestamp'],
    [{ timestamp: '1700000000' }, 'invalid_timestamp'],
    [{ path: '../stamps' }, 'invalid_path'],
    [{ path: '/index.html' }, 'invalid_path'],
    [{ path: 'a//b' }, 'invalid_path'],
    [{ path: 'a\\b' }, 'invalid_path'],
    [{ path: 'a\nb' }, 'invalid_path'],
    [{ options: { act: true } }, 'unsupported_option'],
  ])('%j is refused with %s before the node is asked', async (extra, reason) => {
    const result = await call(share(extra));
    expect(result.error).toMatchObject({ code: -32602, data: { reason } });
    expect(actRequests()).toHaveLength(0);
  });

  test('a share the node holds no grant for is act_not_found; missing content is content_not_found', async () => {
    const notShared = await call(share({ publisher: OTHER_PUBLISHER }));
    expect(notShared.error).toMatchObject({ code: -32602, data: { reason: 'act_not_found' } });

    actAnswer = (_req, res) => {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ code: 404, message: 'Not Found' }));
    };
    const missing = await call(share());
    expect(missing.error).toMatchObject({ code: -32602, data: { reason: 'content_not_found' } });

    actAnswer = (_req, res) => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ code: 500, message: 'act download failed' }));
    };
    const failed = await call(share());
    expect(failed.error.code).toBe(-32603);
    expect(failed.error.message).toContain('act download failed');
  });

  test('a redirect is not followed with the ACT headers on it', async () => {
    actAnswer = (_req, res) => {
      res.writeHead(301, { Location: 'http://127.0.0.1:1/elsewhere' });
      res.end();
    };
    const result = await call(share());
    expect(result.error.code).toBe(-32603);
    expect(actRequests()).toHaveLength(1);
  });

  test('content larger than the read budget is refused from its declared length, unread', async () => {
    const big = 5 * 1024 * 1024 + 1;
    actAnswer = (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': big });
      res.write(Buffer.alloc(64 * 1024));
    };
    const result = await call(share());
    expect(result.error).toMatchObject({
      code: -32602,
      data: { reason: 'data_too_large', limit: 5 * 1024 * 1024, actual: big },
    });
    const [request] = actRequests();
    await request.done;
    expect(request.aborted).toBe(true);
  });

  test('content without a declared length is held to the budget as it streams', async () => {
    actAnswer = (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      const piece = Buffer.alloc(1024 * 1024);
      let sent = 0;
      const pump = () => {
        while (sent < 8 && res.write(piece)) sent += 1;
        if (sent < 8) res.once('drain', pump);
        else res.end();
      };
      pump();
    };
    const result = await call(share());
    expect(result.error).toMatchObject({ code: -32602, data: { reason: 'data_too_large' } });
  });

  test('an external node behind a path prefix keeps its prefix', async () => {
    mockAntUrl = `${node.origin}/bee`;
    const result = await call(share());
    expect(result.result?.data).toBe(CONTENT.toString('base64'));
    expect(actRequests()[0].url).toBe(`/bee/bytes/${REFERENCE}`);
  });

  test('a stopped node is node-stopped', async () => {
    mockAntUrl = null;
    const result = await call(share());
    expect(result.error).toMatchObject({ code: 4900, data: { reason: 'node-stopped' } });
  });
});

describe('ACT grant IPC', () => {
  const invoke = (channel, sender, ...args) => ipcHandlers[channel]({ sender }, ...args);

  test('a private or unclassifiable window cannot store a grant', async () => {
    for (const sender of [{ kind: 'private' }, { kind: 'unknown' }, undefined]) {
      expect(await invoke('swarm:grant-act', sender, ORIGIN, PUBLISHER)).toBe(false);
    }
    expect(permissions.getActGrants(ORIGIN)).toEqual([]);
    expect(await invoke('swarm:grant-act', CHROME, ORIGIN, PUBLISHER)).toBe(true);
    expect(permissions.hasActGrant(ORIGIN, PUBLISHER)).toBe(true);
  });

  test('a grant needs a connected site and a valid key, and lists in its normalised form', async () => {
    expect(await invoke('swarm:grant-act', CHROME, OTHER_ORIGIN, PUBLISHER)).toBe(false);
    expect(await invoke('swarm:grant-act', CHROME, ORIGIN, 'not-a-key')).toBe(false);
    expect(await invoke('swarm:grant-act', CHROME, ORIGIN, `0x${PUBLISHER_UNCOMPRESSED}`)).toBe(true);

    const grants = await invoke('swarm:get-act-grants', CHROME, ORIGIN);
    expect(grants).toEqual([
      expect.objectContaining({
        publicKey: PUBLISHER,
        address: new PrivateKey('11'.repeat(32)).publicKey().address().toChecksum(),
      }),
    ]);
    const described = await invoke('swarm:describe-act-request', CHROME, ORIGIN, share({
      reference: REFERENCE.toUpperCase(),
      publisher: `0x${PUBLISHER.toUpperCase()}`,
      path: 'a/b.txt',
    }));
    expect(described).toMatchObject({
      valid: true,
      publicKey: PUBLISHER,
      granted: true,
      request: { reference: REFERENCE, publisher: PUBLISHER, historyAddress: HISTORY, path: 'a/b.txt' },
    });
    expect(await invoke('swarm:describe-act-request', CHROME, ORIGIN, share({ publisher: OTHER_PUBLISHER })))
      .toMatchObject({ valid: true, publicKey: OTHER_PUBLISHER, granted: false });
    // What main would refuse is refused here too, with the same reason.
    expect(await invoke('swarm:describe-act-request', CHROME, ORIGIN, share({ publisher: '02' })))
      .toMatchObject({ valid: false, reason: 'invalid_publisher' });
    expect(await invoke('swarm:describe-act-request', CHROME, ORIGIN, share({ path: `${'x'.repeat(1025)}` })))
      .toMatchObject({ valid: false, reason: 'invalid_path' });

    expect(await invoke('swarm:revoke-act', CHROME, ORIGIN, PUBLISHER)).toBe(true);
    expect(await invoke('swarm:get-act-grants', CHROME, ORIGIN)).toEqual([]);
    expect(permissions.getPermission(ORIGIN)).not.toHaveProperty('act');
  });
});
