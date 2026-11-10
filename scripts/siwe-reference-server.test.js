const { Wallet } = require('ethers');
const { createSiweReferenceServer } = require('./siwe-reference-server');
const { findSiweChallenge, bindChallenge } = require('../src/main/siwe-auth/challenge');
const { buildSiweMessage, authorizationValue } = require('../src/main/siwe-auth/message');

// Hardhat account #0: a public test key.
const signer = new Wallet('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');

let server;
let base;

beforeAll(async () => {
  server = createSiweReferenceServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://localhost:${server.address().port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

/** Do what Freedom does: read the challenge, build and sign the message. */
async function signIn(wallet = signer, tamper = (m) => m) {
  const first = await fetch(`${base}/members`);
  expect(first.status).toBe(401);
  const found = findSiweChallenge({ 'WWW-Authenticate': [first.headers.get('www-authenticate')] });
  const bound = bindChallenge(found.params, `${base}/members`);
  expect(bound.ok).toBe(true);
  const message = tamper(
    buildSiweMessage({
      ...bound.challenge,
      address: wallet.address,
      issuedAt: new Date().toISOString(),
    })
  );
  const signature = await wallet.signMessage(message);
  return { message, signature };
}

test("Freedom's message signs in, and the session cookie keeps the visitor in", async () => {
  const { message, signature } = await signIn();
  const res = await fetch(`${base}/members`, {
    headers: { Authorization: authorizationValue(message, signature) },
  });
  expect(res.status).toBe(200);
  expect(await res.text()).toContain(signer.address);
  const cookie = res.headers.get('set-cookie').split(';')[0];

  const again = await fetch(`${base}/members`, { headers: { Cookie: cookie } });
  expect(again.status).toBe(200);
});

test('a nonce works once', async () => {
  const { message, signature } = await signIn();
  const headers = { Authorization: authorizationValue(message, signature) };
  expect((await fetch(`${base}/members`, { headers })).status).toBe(200);
  const replay = await fetch(`${base}/members`, { headers });
  expect(replay.status).toBe(401);
  expect(await replay.text()).toContain('unknown or used nonce');
});

test('a message for another domain is refused', async () => {
  const { message, signature } = await signIn(signer, (m) =>
    m.replace(/^http:\/\/localhost/, 'http://evil.localhost')
  );
  const res = await fetch(`${base}/members`, {
    headers: { Authorization: authorizationValue(message, signature) },
  });
  expect(res.status).toBe(401);
  expect(await res.text()).toContain('wrong domain');
});

test('a signature by another account is refused', async () => {
  const { message } = await signIn();
  const other = Wallet.createRandom();
  const res = await fetch(`${base}/members`, {
    headers: { Authorization: authorizationValue(message, await other.signMessage(message)) },
  });
  expect(res.status).toBe(401);
  expect(await res.text()).toContain('bad signature');
});
