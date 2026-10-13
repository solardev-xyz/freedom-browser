const http = require('http');
const { handleTonRequest, registerTonProtocol } = require('./ton-protocol');

let server;
let proxyUrl;
let seen;
beforeAll(async () => {
  server = http.createServer((req, res) => {
    const body = [];
    req.on('data', (chunk) => body.push(chunk));
    req.on('end', () => {
      seen = {
        url: req.url,
        host: req.headers.host,
        method: req.method,
        range: req.headers.range,
        body: Buffer.concat(body).toString(),
      };
      if (req.url.includes('/redirect')) {
        res.writeHead(302, { Location: '/next?q=1' });
        res.end();
      } else {
        res.writeHead(206, { 'Content-Type': 'text/plain', 'Content-Range': 'bytes 0-3/4' });
        res.end(req.method === 'HEAD' ? undefined : 'test');
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  proxyUrl = `http://127.0.0.1:${server.address().port}`;
});
afterAll(() => new Promise((resolve) => server.close(resolve)));
const options = () => ({ getProxyUrl: () => proxyUrl });

test('forwards absolute-form HTTP only through loopback, preserving method, path, range and body', async () => {
  const response = await handleTonRequest(
    new Request('tonsite://foundation.ton/docs?q=1', {
      method: 'POST',
      body: 'payload',
      headers: { Range: 'bytes=0-3' },
    }),
    options()
  );
  expect(response.status).toBe(206);
  expect(await response.text()).toBe('test');
  expect(response.headers.get('content-range')).toBe('bytes 0-3/4');
  expect(seen).toEqual({
    url: 'http://foundation.ton/docs?q=1',
    host: 'foundation.ton',
    method: 'POST',
    range: 'bytes=0-3',
    body: 'payload',
  });
});
test('keeps redirects in the tonsite URL space and permits explicit Telegram sites', async () => {
  const response = await handleTonRequest(new Request('tonsite://name.t.me/redirect'), options());
  expect(response.status).toBe(302);
  expect(response.headers.get('location')).toBe('tonsite://name.t.me/next?q=1');
  await response.body.cancel();
});
test('HEAD has no response body', async () => {
  const response = await handleTonRequest(
    new Request('tonsite://site.adnl/', { method: 'HEAD' }),
    options()
  );
  expect(response.body).toBeNull();
});
test('invalid hosts, ports and unavailable proxy never invoke transport', async () => {
  const requestImpl = jest.fn();
  for (const url of [
    'tonsite://example.com/',
    'tonsite://site.ton:8080/',
    'tonsite://user@site.ton/',
  ]) {
    expect(
      (
        await handleTonRequest(
          { url, method: 'GET', headers: new Headers() },
          { ...options(), requestImpl }
        )
      ).status
    ).toBe(400);
  }
  expect(
    (
      await handleTonRequest(new Request('tonsite://site.ton/'), {
        getProxyUrl: () => null,
        requestImpl,
      })
    ).status
  ).toBe(503);
  expect(requestImpl).not.toHaveBeenCalled();
});
test('registers a handler on each session only once', () => {
  const protocol = { isProtocolHandled: jest.fn(() => false), handle: jest.fn() };
  registerTonProtocol({ protocol }, options());
  expect(protocol.handle).toHaveBeenCalledWith('tonsite', expect.any(Function));
  protocol.isProtocolHandled.mockReturnValue(true);
  registerTonProtocol({ protocol }, options());
  expect(protocol.handle).toHaveBeenCalledTimes(1);
});
