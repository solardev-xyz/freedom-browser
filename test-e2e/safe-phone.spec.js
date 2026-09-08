// A phone owner co-signs a Safe transaction through the real stack:
// 2-of-3 Safe (vault + phone + unreachable phone) on an anvil Gnosis
// fork; the vault signature is free, the second comes from the "phone"
// (the bridge page in a plain Chromium context, signing with a real
// test key over openlv via a local relay). Covers the signing board's
// QR row end to end.

const { Wallet, getBytes, parseEther } = require('ethers');
const { bridgeAvailable } = require('../scripts/serve-bridge');
const {
  test,
  expect,
  safePhoneE2eAvailable,
  VAULT_PASSWORD,
  PHONE_KEY,
} = require('./safe-phone-fixtures');

test.skip(
  !bridgeAvailable() || !safePhoneE2eAvailable(),
  'needs the freedom-bridge sibling checkout, anvil (foundry), and Gnosis fork RPC access'
);

/** A bridge-page tab whose window.ethereum signs with the test key in Node. */
async function openPhonePage(phoneBrowser) {
  const page = await phoneBrowser.newPage();
  await page.exposeFunction('__phoneRequest', async (method, paramsJson) => {
    const params = JSON.parse(paramsJson || '[]');
    const wallet = new Wallet(PHONE_KEY);
    switch (method) {
      case 'eth_requestAccounts':
      case 'eth_accounts':
        return [wallet.address];
      case 'eth_chainId':
        return '0x64';
      case 'wallet_switchEthereumChain':
        return null;
      case 'personal_sign':
        return wallet.signMessage(getBytes(params[0]));
      case 'eth_signTypedData_v4': {
        const typed = JSON.parse(params[1]);
        const types = { ...typed.types };
        delete types.EIP712Domain;
        return wallet.signTypedData(typed.domain, types, typed.message);
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

test('a phone owner co-signs a Safe send through the bridge page', async ({
  window: win,
  anvil,
  services,
  phoneBrowser,
}) => {
  test.setTimeout(300_000);

  // --- Create + activate a 2/3 Safe (vault, phone, dead phone) ------------

  await win.click('#wallet-toggle-btn');
  await win.click('#wallet-selector-btn');
  await win.click('#wallet-create-safe-btn');

  await win.click('#safe-preset-resilient'); // 2 of 3
  const ownerRows = win.locator('#create-safe-owner-list .connect-ledger-account');
  await expect(ownerRows).toHaveCount(3);
  await ownerRows.nth(0).click();
  await ownerRows.nth(1).click();
  await ownerRows.nth(2).click();
  await win.fill('#create-safe-name-input', 'Phone Safe');
  await win.click('#create-safe-submit');
  await expect(win.locator('#create-safe-success')).toBeVisible({ timeout: 30_000 });
  const safeAddress = (await win.locator('#create-safe-result-address').textContent()).trim();
  await win.click('#create-safe-done');

  // Fund the executor; the card may have quoted before or after the
  // balance landed, so accept either state and nudge if needed
  // (needs-funds semantics are covered by the safe-accounts spec).
  const mainAddress = (await win.evaluate(() => window.wallet.getDerivedWallets()))
    .wallets.find((w) => w.index === 0).address;
  await anvil.rpc('anvil_setBalance', [mainAddress, '0x' + parseEther('1').toString(16)]);
  const activateBtn = win.locator('#safe-status-activate');
  const refreshBtn = win.locator('#safe-status-refresh');
  await expect(activateBtn.or(refreshBtn)).toBeVisible({ timeout: 60_000 });
  if (await refreshBtn.isVisible()) {
    await refreshBtn.click();
  }
  await expect(activateBtn).toBeVisible({ timeout: 60_000 });
  const unlock = await win.evaluate((pw) => window.identity.unlock(pw), VAULT_PASSWORD);
  expect(unlock.success).toBe(true);
  await win.click('#safe-status-activate');
  await expect(win.locator('#safe-status-card')).toBeHidden({ timeout: 90_000 });

  // --- Start a send: vault signs free, phone signature required -----------

  await anvil.rpc('anvil_setBalance', [safeAddress, '0x' + parseEther('1').toString(16)]);
  await win.evaluate(() => window.wallet.clearBalanceCache());
  await win.click('#wallet-selector-btn');
  await win.locator('.wallet-selector-item', { hasText: 'Main Wallet' }).click();
  await win.click('#wallet-selector-btn');
  await win.locator('.wallet-selector-item', { hasText: 'Phone Safe' }).click();
  await expect(win.locator('#asset-list')).toContainText('1', { timeout: 60_000 });

  const recipient = Wallet.createRandom().address;
  await win.click('#wallet-send-btn');
  await win.fill('#send-recipient', recipient);
  await win.fill('#send-amount', '0.5');
  await win.click('#send-continue-btn');
  await expect(win.locator('#send-confirm-btn')).toBeEnabled({ timeout: 30_000 });
  await win.click('#send-confirm-btn');

  // The board: 1 of 2 collected (vault free signature), phone row waiting.
  await expect(win.locator('#sidebar-safe-signing')).toBeVisible({ timeout: 30_000 });
  await expect(win.locator('#safe-signing-content')).toContainText('1 of 2 signatures', {
    timeout: 30_000,
  });

  // --- The phone signs through the bridge page ----------------------------

  const phoneRow = win
    .locator('.safe-signing-row', { hasText: 'E2E Phone' })
    .locator('button[data-sign-owner]');
  await phoneRow.click();

  // The QR panel publishes its bridge URL for machines.
  await expect(win.locator('#sidebar-remote-signing')).toBeVisible({ timeout: 30_000 });
  await expect(win.locator('#sidebar-remote-signing')).toHaveAttribute(
    'data-bridge-url',
    /#openlv:\/\//,
    { timeout: 30_000 }
  );
  const bridgeUrl = await win
    .locator('#sidebar-remote-signing')
    .getAttribute('data-bridge-url');

  const phonePage = await openPhonePage(phoneBrowser);
  const fragment = bridgeUrl.split('#')[1];
  await phonePage.goto(`${services.bridgeOrigin}/#${fragment}`);

  // Phone connects over openlv, auto-signs the SafeTx typed data, the
  // threshold is met, and the board executes through the vault executor.
  await expect(win.locator('#safe-signing-title')).toHaveText('Transaction sent', {
    timeout: 120_000,
  });
  await win.click('#safe-signing-done');

  await expect
    .poll(async () => BigInt(await anvil.rpc('eth_getBalance', [recipient, 'latest'])), {
      timeout: 30_000,
    })
    .toBe(parseEther('0.5'));

  // The phone's signature really was the second one (2/3 threshold, the
  // dead phone untouched) — sanity: the safe spent exactly 0.5.
  expect(BigInt(await anvil.rpc('eth_getBalance', [safeAddress, 'latest']))).toBe(
    parseEther('0.5')
  );
});
