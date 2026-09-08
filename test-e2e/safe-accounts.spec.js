// End-to-end Safe (multi-owner account) lifecycle through the real UI,
// against an anvil fork of Gnosis:
//
//   create (1-of-2 wizard) → needs-funds blocking state → fund executor
//   → activate (real canonical-factory deployment) → Send enables →
//   send xDAI out of the Safe (signature collection + execTransaction)
//   → recipient balance checked on-chain.
//
// This is the layer the jest suites can't see: renderer wiring, IPC arg
// shapes, button/card states, the wizard, and the send flow's Safe
// branch — all un-mocked.

const { Wallet, parseEther } = require('ethers');
const { test, expect, safeE2eAvailable, VAULT_PASSWORD } = require('./safe-fixtures');

test.skip(
  !safeE2eAvailable(),
  'anvil (foundry) or the Gnosis fork RPC not available — Safe E2E needs both'
);

test('create, activate, and send from a Safe account', async ({ window: win, anvil }) => {
  test.setTimeout(300_000);

  // --- Create a 1-of-2 Safe through the wizard ---------------------------

  await win.click('#wallet-toggle-btn');
  await win.click('#wallet-selector-btn');
  await win.click('#wallet-create-safe-btn');

  await expect(win.locator('#create-safe-configure-step')).toBeVisible();
  // Backup (1 of 2) is preselected; pick both owner accounts.
  const ownerRows = win.locator('#create-safe-owner-list .connect-ledger-account');
  await expect(ownerRows).toHaveCount(2);
  await ownerRows.nth(0).click();
  await ownerRows.nth(1).click();
  await win.fill('#create-safe-name-input', 'E2E Safe');
  await expect(win.locator('#create-safe-submit')).toBeEnabled();
  await win.click('#create-safe-submit');

  await expect(win.locator('#create-safe-success')).toBeVisible({ timeout: 30_000 });
  const safeAddress = (await win.locator('#create-safe-result-address').textContent()).trim();
  expect(safeAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
  await win.click('#create-safe-done');

  // The new account is active, badged, and receive-only.
  await expect(win.locator('#wallet-selector-name')).toHaveText('E2E Safe');
  await expect(win.locator('#wallet-send-btn')).toBeDisabled();

  // --- Blocking state: the executor has no funds --------------------------

  const card = win.locator('#safe-status-card');
  await expect(card).toContainText(/fund/i, { timeout: 60_000 });

  // Fund the executor (Main Wallet) on the fork and re-check.
  const mainAddress = (await win.evaluate(() => window.wallet.getDerivedWallets()))
    .wallets.find((w) => w.index === 0).address;
  await anvil.rpc('anvil_setBalance', [mainAddress, '0x' + parseEther('1').toString(16)]);
  await win.click('#safe-status-refresh');

  // --- Activate: real deployment through the canonical factory -----------

  await expect(win.locator('#safe-status-activate')).toBeVisible({ timeout: 60_000 });
  // Deployment is signed by the executor's vault key; the vault is
  // locked, so activating walks through the standard unlock screen.
  await win.click('#safe-status-activate');
  await expect(win.locator('#sidebar-vault-unlock')).toBeVisible({ timeout: 15_000 });
  await win.fill('#vault-unlock-password-input', VAULT_PASSWORD);
  await win.click('#vault-unlock-password-submit');

  // The Send button enabling is the unambiguous "deployed" barrier (the
  // card is inside the identity view, which the unlock screen hides —
  // toBeHidden would pass prematurely).
  await expect(win.locator('#wallet-send-btn')).toBeEnabled({ timeout: 90_000 });
  await expect(card).toBeHidden();

  // Deployment really is on the fork.
  const code = await anvil.rpc('eth_getCode', [safeAddress, 'latest']);
  expect(code.length).toBeGreaterThan(2);

  // --- Send xDAI out of the Safe ------------------------------------------

  // Give the Safe a balance and let the asset list see it (switch away
  // and back — the account change refreshes balances, like a user would).
  await anvil.rpc('anvil_setBalance', [safeAddress, '0x' + parseEther('1').toString(16)]);
  await win.evaluate(() => window.wallet.clearBalanceCache());
  await win.click('#wallet-selector-btn');
  await win.locator('.wallet-selector-item', { hasText: 'Main Wallet' }).click();
  await win.click('#wallet-selector-btn');
  await win.locator('.wallet-selector-item', { hasText: 'E2E Safe' }).click();
  await expect(win.locator('#asset-list')).toContainText('1', { timeout: 60_000 });

  const recipient = Wallet.createRandom().address;
  await win.click('#wallet-send-btn');
  await win.fill('#send-recipient', recipient);
  await win.fill('#send-amount', '0.5');
  await win.click('#send-continue-btn');

  // Review names who pays instead of quoting exec gas.
  await expect(win.locator('#send-review-view')).toBeVisible({ timeout: 30_000 });
  await expect(win.locator('#send-review-fee-value')).toContainText('Main Wallet');

  // Vault was unlocked for activation, so no unlock gate here.
  await expect(win.locator('#send-confirm-btn')).toBeEnabled({ timeout: 15_000 });
  await win.click('#send-confirm-btn');

  // Confirm hands over to the signing board; with a 1-of-2 vault owner
  // the free signature meets the threshold and execution runs on its own.
  await expect(win.locator('#sidebar-safe-signing')).toBeVisible({ timeout: 30_000 });
  await expect(win.locator('#safe-signing-title')).toHaveText('Transaction sent', {
    timeout: 90_000,
  });
  await win.click('#safe-signing-done');

  // The money actually moved on the fork (allow a block for inclusion).
  await expect
    .poll(async () => BigInt(await anvil.rpc('eth_getBalance', [recipient, 'latest'])), {
      timeout: 30_000,
    })
    .toBe(parseEther('0.5'));
});
