#!/usr/bin/env node

'use strict';

const {
  detectSeatbeltCapabilities,
} = require('../src/main/agent/workspace-execution/seatbelt-backend');

async function main() {
  if (process.platform !== 'darwin' || process.env.FREEDOM_REQUIRE_SEATBELT !== '1') {
    throw new Error('macOS qualification requires darwin and FREEDOM_REQUIRE_SEATBELT=1');
  }
  const capabilities = await detectSeatbeltCapabilities();
  process.stdout.write(`${JSON.stringify({ type: 'capabilities', ...capabilities })}\n`);
  if (
    capabilities.available ||
    capabilities.denial?.code !== 'DESCENDANT_CANCELLATION_UNAVAILABLE' ||
    capabilities.diagnostics?.setsidEscape !== 'confirmed'
  ) {
    throw new Error('The qualified macOS blocker did not reproduce exactly; refusing to proceed');
  }
  for (const name of ['focused-jest', 'lint', 'babel-transform', 'shell-node-python-git']) {
    process.stdout.write(
      `${JSON.stringify({
        type: 'workload',
        name,
        state: 'sandbox_denied',
        reason: capabilities.denial.code,
        commandStarted: false,
      })}\n`
    );
  }
}

main().catch((error) => {
  process.stderr.write(`macOS sandbox qualification failed: ${error.message}\n`);
  process.exitCode = 1;
});
