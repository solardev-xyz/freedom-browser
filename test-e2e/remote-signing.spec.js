// End-to-end remote (phone) signing over the real openlv stack.
//
// Freedom (Electron) hosts the sessions and shows QR codes; the "phone"
// is the bridge page (sibling freedom-bridge checkout) in a plain Chromium
// context with a faked window.ethereum that signs with an ethers test
// key. Signaling runs over an in-test local MQTT broker; transport is
// real WebRTC between the two browser stacks. Covers, through the real
// UI: connecting a phone account (vault locked) and a personal_sign
// round-trip through the remote signer with on-return verification.

const { Wallet, getBytes, verifyMessage } = require('ethers');
const { bridgeAvailable } = require('../scripts/serve-bridge');
const { test, expect } = require('./remote-signing-fixtures');

// The "phone" side is the bridge page, which lives in its own repo —
// skip (don't fail) for contributors without the sibling checkout.
test.skip(
  !bridgeAvailable(),
  'freedom-bridge checkout not found — clone github.com/solardev-xyz/freedom-bridge next to this repo'
);

// Anvil/Hardhat-default test key — well-known, never funded on mainnet.
const PHONE_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const phoneWallet = new Wallet(PHONE_KEY);

/** A bridge-page tab whose window.ethereum signs with the test key in Node. */
async function openPhonePage(phoneBrowser) {
  const page = await phoneBrowser.newPage();

  await page.exposeFunction('__phoneRequest', async (method, paramsJson) => {
    const params = JSON.parse(paramsJson || '[]');
    switch (method) {
      case 'eth_requestAccounts':
      case 'eth_accounts':
        return [phoneWallet.address];
      case 'eth_chainId':
        return '0x64';
      case 'wallet_switchEthereumChain':
        return null;
      case 'personal_sign':
        return phoneWallet.signMessage(getBytes(params[0]));
      case 'eth_signTypedData_v4': {
        const typed = JSON.parse(params[1]);
        const types = { ...typed.types };
        delete types.EIP712Domain;
        return phoneWallet.signTypedData(typed.domain, types, typed.message);
      }
      default:
        throw new Error(`Fake phone wallet: unsupported method ${method}`);
    }
  });
  await page.addInitScript(() => {
    window.ethereum = {
      isFreedomE2EFake: true,
      request: ({ method, params }) => window.__phoneRequest(method, JSON.stringify(params ?? [])),
    };
  });
  return page;
}

/** Point the phone page at the local bridge server with the QR's session fragment. */
async function scanQr(phonePage, bridgeOrigin, bridgeUrl) {
  const fragment = bridgeUrl.split('#')[1];
  // Full reload each time — the bridge page reads the fragment at load,
  // and a hash-only navigation would not re-run it.
  await phonePage.goto('about:blank');
  await phonePage.goto(`${bridgeOrigin}/#${fragment}`);
}

test('connect a phone account and sign a message through the bridge page', async ({
  window: win,
  phoneBrowser,
  services,
}) => {
  test.setTimeout(120_000);

  // --- Connect the phone account (vault stays locked throughout) ---------

  await win.click('#wallet-toggle-btn');
  await win.click('#wallet-selector-btn');
  await win.click('#wallet-connect-phone-btn');

  // The connect screen publishes the QR contents for machines.
  await expect(win.locator('#sidebar-connect-phone')).toHaveAttribute(
    'data-bridge-url',
    /#openlv:\/\//,
    { timeout: 30_000 }
  );
  const connectUrl = await win.locator('#sidebar-connect-phone').getAttribute('data-bridge-url');

  const phonePage = await openPhonePage(phoneBrowser);
  await scanQr(phonePage, services.bridgeOrigin, connectUrl);
  await expect(phonePage.locator('#flow')).toBeVisible();

  // Handshake → WebRTC → eth_requestAccounts → account list in freedom.
  await expect(win.locator('#connect-phone-accounts-step')).toBeVisible({ timeout: 45_000 });
  await expect(win.locator('#connect-phone-account-list .connect-ledger-account')).toHaveCount(1);

  await win.fill('#connect-phone-name-input', 'E2E Phone');
  await win.click('#connect-phone-submit');
  await expect(win.locator('#connect-phone-success')).toBeVisible({ timeout: 15_000 });
  await expect(win.locator('#connect-phone-result-address')).toHaveText(phoneWallet.address);
  await win.click('#connect-phone-done');

  const active = await win.evaluate(() => window.wallet.getActiveIndex());
  expect(active.success).toBe(true);

  // --- Sign a message with the phone account ------------------------------

  const message = 'freedom remote-signing e2e';
  const messageHex = '0x' + Buffer.from(message, 'utf8').toString('hex');

  // Kick off the signature; it stays pending until the phone answers.
  const signaturePromise = win.evaluate(
    ({ hex, index }) => window.wallet.signMessage(hex, index),
    { hex: messageHex, index: active.index }
  );

  // The signing QR panel appears with a fresh session.
  await expect(win.locator('#sidebar-remote-signing')).toBeVisible({ timeout: 30_000 });
  await expect(win.locator('#sidebar-remote-signing')).toHaveAttribute(
    'data-bridge-url',
    /#openlv:\/\//
  );
  const signUrl = await win.locator('#sidebar-remote-signing').getAttribute('data-bridge-url');
  expect(signUrl).not.toBe(connectUrl); // per-request session, fresh secret

  await scanQr(phonePage, services.bridgeOrigin, signUrl);

  const result = await signaturePromise;
  expect(result.success).toBe(true);

  // The signature is real and recovers to the phone account — the same
  // check main's remote signer already enforced before resolving.
  expect(verifyMessage(message, result.signature)).toBe(phoneWallet.address);

  // The panel cleans up after itself.
  await expect(win.locator('#sidebar-remote-signing')).toBeHidden({ timeout: 10_000 });
});
