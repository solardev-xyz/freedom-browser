jest.mock('electron', () => ({ app: { isPackaged: false } }));
jest.mock('../settings-store', () => ({ isWalletTorExperimentAvailable: () => mockAvailable }));
jest.mock('../profile-resolver', () => ({ getActiveProfile: () => mockProfile }));
const fs = require('fs'),
  os = require('os'),
  path = require('path'),
  https = require('https');
const { createHash } = require('crypto');
const { listen } = require('../../../test/helpers/tor-socks-fixture');
const fixture = require('../../../test/helpers/tor-tls-fixture');
const { createPrivacyScope } = require('./privacy-context');
const {
  MARKER,
  directTestExposure,
  createDirectTestnetTransport,
} = require('./direct-testnet-transport');
let mockAvailable, mockProfile, scope, handle, server, transport, port, seen, trusted, spy;
const realRequest = https.request;
beforeEach(async () => {
  mockAvailable = true;
  require('electron').app.isPackaged = false;
  mockProfile = { id: 'test', userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'direct-test-')) };
  fs.writeFileSync(
    path.join(mockProfile.userDataDir, MARKER),
    JSON.stringify({
      version: 1,
      chainId: 11155111,
      profileId: 'test',
      disposable: true,
      relayerExposure: 'direct-ip',
    })
  );
  scope = createPrivacyScope({
    profileId: createHash('sha256')
      .update(JSON.stringify(['test', mockProfile.userDataDir]))
      .digest('hex'),
    signal: new AbortController().signal,
  });
  handle = scope.getContext({
    kind: 'private-account',
    principal: 'ppv2:0',
    protocol: 'privacy-pools-v2',
    deployment: 'sepolia',
    chainId: 11155111,
    role: 'relayer',
  });
  seen = [];
  trusted = true;
  server = https.createServer(fixture, (req, res) => {
    seen.push(req.url);
    if (req.url === '/stall') return;
    if (req.url === '/redirect') {
      res.writeHead(302, { location: '/ok' });
      res.end();
      return;
    }
    if (req.url === '/compressed') res.setHeader('content-encoding', 'gzip');
    res.end(req.url === '/large' ? Buffer.alloc(4 * 1024 * 1024 + 1) : '{}');
  });
  port = await listen(server);
  spy = jest.spyOn(https, 'request').mockImplementation((url, options, cb) =>
    realRequest(
      url,
      {
        ...options,
        ...(trusted ? { ca: fixture.cert } : {}),
        lookup: (_host, opts, done) =>
          opts.all ? done(null, [{ address: '127.0.0.1', family: 4 }]) : done(null, '127.0.0.1', 4),
      },
      cb
    )
  );
  transport = createDirectTestnetTransport();
});
afterEach(async () => {
  transport.close();
  scope.close();
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  jest.restoreAllMocks();
});
const url = (p = '/ok') => `https://rpc.example.test:${port}${p}`;

test('requires a sticky disposable marker and exact development Sepolia relayer scope before I/O', async () => {
  expect(directTestExposure()).toBe(true);
  for (const patch of [
    { role: 'asp' },
    { deployment: 'mainnet' },
    { chainId: 1 },
    { protocol: 'other' },
  ]) {
    const h = scope.getContext({
      kind: 'private-account',
      principal: 'ppv2:0',
      protocol: 'privacy-pools-v2',
      deployment: 'sepolia',
      chainId: 11155111,
      role: 'relayer',
      ...patch,
    });
    await expect(transport.request(h, url())).rejects.toThrow();
  }
  mockAvailable = false;
  await expect(transport.request(handle, url())).rejects.toThrow();
  mockAvailable = true;
  require('electron').app.isPackaged = true;
  await expect(transport.request(handle, url())).rejects.toThrow();
  require('electron').app.isPackaged = false;
  mockProfile = {
    ...mockProfile,
    userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'unmarked-test-')),
  };
  expect(directTestExposure()).toBe(false);
  await expect(transport.request(handle, url())).rejects.toThrow();
  expect(spy).not.toHaveBeenCalled();
});

test('uses explicit validated TLS and its own non-pooling agent even with proxy/TLS environment overrides', async () => {
  const previous = {
    HTTPS_PROXY: process.env.HTTPS_PROXY,
    NODE_USE_ENV_PROXY: process.env.NODE_USE_ENV_PROXY,
    NODE_TLS_REJECT_UNAUTHORIZED: process.env.NODE_TLS_REJECT_UNAUTHORIZED,
  };
  Object.assign(process.env, {
    HTTPS_PROXY: 'http://127.0.0.1:1',
    NODE_USE_ENV_PROXY: '1',
    NODE_TLS_REJECT_UNAUTHORIZED: '0',
  });
  try {
    expect((await transport.request(handle, url())).status).toBe(200);
    const options = spy.mock.calls[0][1];
    expect(options.rejectUnauthorized).toBe(true);
    expect(options.agent.options.keepAlive).toBe(false);
    trusted = false;
    await expect(transport.request(handle, url())).rejects.toMatchObject({
      code: 'PRIVATE_DIRECT_TEST_REFUSED',
    });
    expect(seen).toEqual(['/ok']);
  } finally {
    for (const [key, value] of Object.entries(previous))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
  }
});

test('refuses credentials, TLS overrides, request size, redirects, compression and response size without retry', async () => {
  for (const options of [
    { headers: { cookie: 'x' } },
    { headers: { authorization: 'x' } },
    { ca: fixture.cert },
    { rejectUnauthorized: false },
    { method: 'PUT' },
  ]) {
    await expect(transport.request(handle, url(), options)).rejects.toThrow();
  }
  await expect(transport.request(handle, url().replace('https:', 'http:'))).rejects.toThrow();
  await expect(
    transport.request(handle, url(), { method: 'POST', body: 'x'.repeat(1024 * 1024 + 1) })
  ).rejects.toMatchObject({ code: 'PRIVATE_REQUEST_TOO_LARGE' });
  expect(spy).not.toHaveBeenCalled();
  for (const [p, code] of [
    ['/redirect', 'PRIVATE_REDIRECT_REFUSED'],
    ['/compressed', 'PRIVATE_ENCODING_REFUSED'],
    ['/large', 'PRIVATE_RESPONSE_TOO_LARGE'],
  ]) {
    await expect(transport.request(handle, url(p))).rejects.toMatchObject({ code });
  }
  expect(seen).toEqual(['/redirect', '/compressed', '/large']);
});

test('timeout, release and scope revocation cancel requests and never deliver a late result', async () => {
  await expect(transport.request(handle, url('/stall'), { timeoutMs: 25 })).rejects.toMatchObject({
    code: 'PRIVACY_REQUEST_ABORTED',
  });
  const pending = transport.request(handle, url('/stall'));
  const rejection = expect(pending).rejects.toMatchObject({ code: 'PRIVACY_REQUEST_ABORTED' });
  transport.release(handle);
  await rejection;
  const locked = transport.request(handle, url('/stall'));
  const lockedRejection = expect(locked).rejects.toMatchObject({ code: 'PRIVACY_REQUEST_ABORTED' });
  scope.close();
  await lockedRejection;
  await expect(transport.request(handle, url())).rejects.toThrow();
});

test('bounds concurrent requests and sanitizes unexpected HTTPS exceptions', async () => {
  spy.mockImplementationOnce(() => {
    throw new Error('remote sensitive fixture');
  });
  await expect(transport.request(handle, url())).rejects.toMatchObject({
    code: 'PRIVATE_DIRECT_TEST_REFUSED',
    message: 'Direct Sepolia test route is unavailable',
  });
  const requests = Array.from({ length: 32 }, () =>
    transport.request(handle, url('/stall')).catch((e) => e.code)
  );
  await expect(transport.request(handle, url('/stall'))).rejects.toMatchObject({
    code: 'PRIVATE_DIRECT_TEST_REFUSED',
  });
  transport.close();
  expect(await Promise.all(requests)).toEqual(Array(32).fill('PRIVACY_REQUEST_ABORTED'));
});
