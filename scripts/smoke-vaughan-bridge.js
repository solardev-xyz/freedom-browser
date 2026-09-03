#!/usr/bin/env node
/**
 * Manual smoke: Freedom's real Vaughan transport against a running Vaughan provider.
 *
 * Prerequisites:
 *   1. Vaughan running with the wallet unlocked (the TUI trusts the Freedom
 *      origin by default and writes provider.session, which the transport
 *      picks up automatically).
 *   2. Provider listening on ws://127.0.0.1:8745
 *   3. Approve any connect / sign prompts that appear in the TUI
 *
 * Usage:
 *   node scripts/smoke-vaughan-bridge.js
 *   FREEDOM_VAUGHAN_WS_URL=ws://127.0.0.1:8745 node scripts/smoke-vaughan-bridge.js
 */

const path = require('path');
const { rpcRequest, DEFAULT_URL, DEFAULT_ORIGIN } = require(
  path.join(__dirname, '..', 'src', 'main', 'wallet', 'vaughan', 'transport')
);
const { createVaughanBackend, SIGN_TIMEOUT_MS } = require(
  path.join(__dirname, '..', 'src', 'main', 'wallet', 'vaughan', 'signer')
);

async function main() {
  const url = process.env.FREEDOM_VAUGHAN_WS_URL || DEFAULT_URL;
  console.log(`Connecting as Origin=${DEFAULT_ORIGIN} → ${url}`);

  // Connect gesture waits on interactive TUI approval — signing-grade timeout.
  const accounts = await rpcRequest('eth_requestAccounts', [], { url, timeoutMs: SIGN_TIMEOUT_MS });
  if (!Array.isArray(accounts) || !accounts[0]) {
    throw new Error(`eth_requestAccounts returned no accounts: ${JSON.stringify(accounts)}`);
  }
  const address = accounts[0];
  console.log(`accounts: ${address}`);

  const backend = createVaughanBackend({ address, type: 'vaughan' });
  const got = await backend.getAddress();
  console.log(`getAddress: ${got}`);

  const sig = await backend.signMessage(Buffer.from('freedom-manual-smoke', 'utf8'));
  console.log(`signMessage: ${sig.slice(0, 18)}… (${sig.length} chars)`);

  console.log('OK — Freedom transport ↔ Vaughan provider smoke passed');
}

main().catch((err) => {
  console.error('FAIL:', err && err.message ? err.message : err);
  if (err && err.code) console.error('code:', err.code);
  process.exit(1);
});
