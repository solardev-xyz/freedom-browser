#!/usr/bin/env node

'use strict';

// Backwards-compatible entry point for the network-permission qualification. The scenario and the
// shared production composition now live in scripts/agent-qualification/; this file preserves the
// existing `test:agent-sandbox:network:product` and `test:agent-sandbox:network:disabled` commands.
//
//   ELECTRON_RUN_AS_NODE=1 electron scripts/qualify-agent-network-product.js [--network-disabled]
//
// Equivalent to `scripts/qualify-agent-workspace.js network [--network-disabled]`.

const { run } = require('./qualify-agent-workspace');

run(['network', ...process.argv.slice(2)])
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    process.stdout.write(
      `${JSON.stringify({ type: 'runner_error', message: error.message, stack: error.stack?.split('\n').slice(0, 6) })}\n`
    );
    process.exit(2);
  });
