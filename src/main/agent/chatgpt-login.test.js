'use strict';

const { EventEmitter } = require('node:events');
jest.mock('node:http', () => ({ createServer: jest.fn() }));
const { createServer } = require('node:http');
const { loginChatGPT, loginPage } = require('./chatgpt-login');

const options = { getDeviceId: () => 'bcb1cbdb-7eae-4566-bc6c-d843484b676b' };
let server;
let request;
let originalFetch;
beforeEach(() => {
  originalFetch = global.fetch;
  global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({
    access_token: 'test-access', refresh_token: 'test-refresh', id_token: 'test-identity',
    expires_in: 3600, scope: 'openid chatgpt.tokens.use.direct',
  }) });
  server = new EventEmitter();
  server.listen = jest.fn((_port, _host, ready) => ready());
  server.close = jest.fn(done => done());
  server.closeAllConnections = jest.fn();
  createServer.mockImplementation(handler => { request = handler; return server; });
});
afterEach(() => { global.fetch = originalFetch; });

function callback(authorization, params = {}, headers = { host: '127.0.0.1:1455' }) {
  const response = new EventEmitter();
  response.writeHead = jest.fn();
  response.end = jest.fn(() => { response.writableEnded = true; response.writableFinished = true; });
  request({ method: 'GET', headers, url: '/auth/callback?' + new URLSearchParams({
    state: authorization.searchParams.get('state'), code: 'test-code', client_id: 'issued-client', ...params,
  }) }, response);
  return response;
}

function start(onAuthorize, controller = new AbortController()) {
  let authorization;
  return loginChatGPT({ signal: controller.signal,
    notify(event) {
      if (event.type === 'auth_url') {
        authorization = new URL(event.url);
        onAuthorize(authorization);
      }
    },
    prompt: ({ signal }) => new Promise((_resolve, reject) => {
      if (signal.aborted) reject(new Error('Cancelled'));
      else signal.addEventListener('abort', () => reject(new Error('Cancelled')), { once: true });
    }),
  }, options);
}

test('uses Freedom branding, PKCE and issued client ID, and only reports success after exchange', async () => {
  let response;
  let authorization;
  const credential = await start(url => {
    authorization = url;
    response = callback(url);
    expect(response.end).not.toHaveBeenCalled();
  });
  expect(authorization.searchParams.get('agent_name_hint')).toBe('Freedom Browser');
  expect(authorization.searchParams.get('ext_agent_host_id')).toBe('urn:uuid:' + options.getDeviceId());
  const body = global.fetch.mock.calls[0][1].body;
  expect(body.get('client_id')).toBe('issued-client');
  expect(body.get('redirect_uri')).toBe('http://127.0.0.1:1455/auth/callback');
  expect(require('node:crypto').createHash('sha256').update(body.get('code_verifier')).digest('base64url'))
    .toBe(authorization.searchParams.get('code_challenge'));
  expect(credential).toMatchObject({ type: 'oauth', access: 'test-access', clientId: 'issued-client' });
  expect(response.end.mock.calls[0][0]).toContain('ChatGPT connected');
  expect(response.writeHead).toHaveBeenCalledWith(200, expect.objectContaining({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' }));
  expect(server.closeAllConnections).toHaveBeenCalled();
});

test('a declined connection shows cancellation and a new attempt works', async () => {
  let response;
  await expect(start(url => { response = callback(url, { error: 'access_denied' }); }))
    .rejects.toMatchObject({ code: 'AGENT_PROVIDER_AUTH_CANCELLED' });
  expect(response.end.mock.calls[0][0]).toContain('Connection cancelled');
  expect(global.fetch).not.toHaveBeenCalled();
  await expect(start(url => callback(url))).resolves.toHaveProperty('access', 'test-access');
});

test('stale success and denial callbacks and unexpected hosts cannot settle the pending login', async () => {
  await expect(start(url => {
    for (const params of [{ state: 'stale' }, { state: 'stale', error: 'access_denied' }]) {
      expect(callback(url, params).writeHead.mock.calls[0][0]).toBe(400);
    }
    expect(callback(url, {}, { host: 'unexpected.test' }).writeHead.mock.calls[0][0]).toBe(400);
    callback(url);
    expect(callback(url).writeHead.mock.calls[0][0]).toBe(409);
  })).resolves.toHaveProperty('access', 'test-access');
  expect(global.fetch).toHaveBeenCalledTimes(1);
});

test('token exchange errors are branded and never reflect token response bodies', async () => {
  global.fetch.mockResolvedValue({ ok: false, status: 401, text: async () => 'sensitive-token-body' });
  let response;
  await expect(start(url => { response = callback(url); })).rejects.toThrow('ChatGPT token exchange failed (401)');
  expect(response.end.mock.calls[0][0]).toContain('Connection unsuccessful');
  expect(response.end.mock.calls[0][0]).not.toContain('sensitive-token-body');
});

test('sidebar cancellation releases the server and manual callback prompt', async () => {
  const controller = new AbortController();
  await expect(start(() => controller.abort(), controller)).rejects.toThrow('cancelled');
  expect(server.closeAllConnections).toHaveBeenCalled();
});

test.each([
  { access_token: 'test', refresh_token: 'test', id_token: 'test', expires_in: 3600, scope: 'openid' },
  { access_token: 'test', refresh_token: 'test', id_token: 'test', expires_in: -1, scope: 'chatgpt.tokens.use.direct' },
  { access_token: 'test', expires_in: 3600, scope: 'chatgpt.tokens.use.direct' },
])('rejects incomplete grants instead of reporting success', async token => {
  global.fetch.mockResolvedValue({ ok: true, json: async () => token });
  let response;
  await expect(start(url => { response = callback(url); })).rejects.toThrow('incomplete authorization grant');
  expect(response.end.mock.calls[0][0]).toContain('Connection unsuccessful');
});

test('a busy callback port fails before opening the browser', async () => {
  server.listen.mockImplementation(() => server.emit('error', Object.assign(new Error('busy'), { code: 'EADDRINUSE' })));
  const notify = jest.fn();
  await expect(loginChatGPT({ signal: new AbortController().signal, notify, prompt: jest.fn() }, options)).rejects.toThrow('port 1455 is busy');
  expect(notify).not.toHaveBeenCalled();
});

test('manual fallback validates the callback before exchanging it', async () => {
  let authorization;
  const run = input => loginChatGPT({ signal: new AbortController().signal,
    notify: event => { if (event.type === 'auth_url') authorization = new URL(event.url); },
    prompt: async () => input(authorization),
  }, options);
  await expect(run(() => 'http://127.0.0.1:1455/auth/callback?state=stale&code=x&client_id=y')).rejects.toThrow('does not match');
  expect(global.fetch).not.toHaveBeenCalled();
  await expect(run(url => 'http://127.0.0.1:1455/auth/callback?' + new URLSearchParams({ state: url.searchParams.get('state'), code: 'x', client_id: 'y' })))
    .resolves.toHaveProperty('clientId', 'y');
});

test('all callback pages use the local Freedom logo without scripts or remote assets', () => {
  for (const outcome of ['success', 'cancelled', 'failed', 'invalid']) {
    const html = loginPage(outcome);
    expect(html).toContain('alt="Freedom Browser"');
    expect(html).toContain('data:image/png;base64,');
    expect(html).not.toMatch(/<script|https?:\/\//);
  }
});
