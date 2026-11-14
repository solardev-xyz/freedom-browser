#!/usr/bin/env node
/**
 * `npm run dapp:reset`: refuses, and touches nothing.
 *
 * It used to delete `dapp-permissions.json`. Since APB-2 (freedom-core design
 * 0012) the identity core is that file's only writer: it holds the grants in
 * memory, so a file deleted behind it resets nothing, and its next write puts
 * the grants back. A site's grant and rules are revoked through the core, from
 * the browser's own controls, and this command says so and exits non-zero.
 */

const MESSAGE = [
  'npm run dapp:reset no longer deletes dapp-permissions.json, and nothing was changed.',
  "Since APB-2 the dApp permissions are the identity core's (freedom-core design 0012): it is the file's",
  'only writer, so a file deleted behind it resets nothing.',
  'Revoke a site from the browser: open it, then in the wallet panel use its connection banner',
  '(Disconnect, or Manage permissions to turn its auto-approve rules off).',
].join('\n');

function main() {
  console.error(MESSAGE);
  return 1;
}

if (require.main === module) process.exitCode = main();

module.exports = { MESSAGE, main };
