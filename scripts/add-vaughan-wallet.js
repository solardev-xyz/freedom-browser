#!/usr/bin/env node
/**
 * Add the unlocked Vaughan account to Freedom's wallet list (no DevTools needed).
 *
 * Prerequisites:
 *   1. Freedom has a vault (sidebar → Create New Wallet / unlock once)
 *   2. Vaughan unlocked with:
 *        VAUGHAN_PROVIDER_TRUSTED_ORIGINS=https://freedom.browser
 *      and listening on ws://127.0.0.1:8745
 *   3. Quit Freedom before running this script, then reopen after
 *
 * Usage:
 *   node scripts/add-vaughan-wallet.js
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { rpcRequest } = require('../src/main/wallet/vaughan/transport');

const HARDWARE_INDEX_BASE = 1_000_000;

function findVaultMeta() {
  const root = path.join(os.homedir(), '.config', 'Freedom Dev');
  if (!fs.existsSync(root)) {
    return null;
  }
  const hits = [];
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (ent.name === 'vault-meta.json') hits.push(p);
    }
  };
  walk(root);
  return hits.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0] || null;
}

function nextHardwareIndex(wallets, meta) {
  const fromMeta = Number(meta.nextHardwareWalletIndex);
  const maxExisting = wallets.reduce((m, w) => Math.max(m, Number(w.index) || 0), 0);
  const floor = Math.max(HARDWARE_INDEX_BASE, maxExisting + 1, fromMeta || HARDWARE_INDEX_BASE);
  return floor;
}

async function main() {
  console.log('Asking Vaughan for accounts…');
  let accounts;
  try {
    accounts = await rpcRequest('eth_requestAccounts', []);
  } catch (err) {
    console.error('FAIL: cannot reach Vaughan at ws://127.0.0.1:8745');
    console.error('  → Start/unlock Vaughan with VAUGHAN_PROVIDER_TRUSTED_ORIGINS=https://freedom.browser');
    console.error('  → Detail:', err.message || err);
    process.exit(1);
  }
  if (!Array.isArray(accounts) || !accounts[0]) {
    console.error('FAIL: Vaughan returned no accounts (is the wallet unlocked?)');
    process.exit(1);
  }
  const address = accounts[0];
  console.log('Vaughan address:', address);

  const metaPath = findVaultMeta();
  if (!metaPath) {
    console.error('FAIL: no Freedom vault-meta.json found');
    console.error('  → In Freedom: Create New Wallet (or unlock) once, quit Freedom, then re-run this script');
    process.exit(1);
  }
  console.log('Freedom vault:', metaPath);

  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  const wallets = Array.isArray(meta.derivedWallets) ? meta.derivedWallets.slice() : [];
  const dup = wallets.find((w) => (w.address || '').toLowerCase() === address.toLowerCase());
  if (dup) {
    meta.activeWalletIndex = dup.index;
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2) + '\n');
    console.log(`Already present as "${dup.name}" (index ${dup.index}). Set active. Reopen Freedom.`);
    return;
  }

  const index = nextHardwareIndex(wallets, meta);
  const entry = {
    index,
    name: 'Vaughan',
    address,
    type: 'vaughan',
  };
  wallets.push(entry);
  meta.derivedWallets = wallets;
  meta.nextHardwareWalletIndex = index + 1;
  meta.activeWalletIndex = index;
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2) + '\n');
  console.log('Added Vaughan wallet and set it active.');
  console.log('Reopen Freedom, then click Connect on the dApp.');
}

main().catch((err) => {
  console.error('FAIL:', err);
  process.exit(1);
});
