#!/usr/bin/env node

'use strict';

const path = require('path');
const {
  createWorkspaceExecutionPolicy,
} = require('../src/main/agent/workspace-execution/execution-policy');
const { BubblewrapExecutor } = require('../src/main/agent/workspace-execution/bubblewrap-backend');

const workspaceRoot = path.resolve(__dirname, '..');

async function main() {
  const executor = new BubblewrapExecutor();
  const capabilities = await executor.detectCapabilities({ force: true });
  process.stdout.write(`${JSON.stringify({ type: 'capabilities', ...capabilities })}\n`);
  if (!capabilities.available) process.exitCode = 1;
  if (!capabilities.available) return;

  const policy = await createWorkspaceExecutionPolicy({
    workspaceRoot,
    limits: {
      timeoutMs: 5 * 60 * 1_000,
      stdoutBytes: 1024 * 1024,
      stderrBytes: 1024 * 1024,
    },
  });
  const workloads = [
    {
      name: 'focused-jest',
      command: 'npm',
      args: [
        'run',
        'test:unit',
        '--',
        '--runInBand',
        'src/main/agent/workspace-execution/execution-policy.test.js',
      ],
    },
    { name: 'lint', command: 'npm', args: ['run', 'lint'] },
    {
      name: 'babel-transform',
      command: 'node',
      args: [
        '-e',
        [
          "const babel = require('@babel/core');",
          "const fs = require('fs');",
          "const result = babel.transformFileSync('src/main/agent/workspace-execution/bubblewrap-backend.js', { ast: false, babelrc: false, configFile: false });",
          "fs.writeFileSync('/tmp/freedom-sandbox-build.js', result.code);",
        ].join(' '),
      ],
    },
  ];
  for (const workload of workloads) {
    const receipt = await executor.execute(policy, workload);
    process.stdout.write(
      `${JSON.stringify({
        type: 'workload',
        name: workload.name,
        state: receipt.state,
        exitCode: receipt.exitCode,
        durationMs: receipt.durationMs,
        stdoutBytes: Buffer.byteLength(receipt.stdout),
        stderrBytes: Buffer.byteLength(receipt.stderr),
        stdoutTruncated: receipt.stdoutTruncated,
        stderrTruncated: receipt.stderrTruncated,
      })}\n`
    );
    if (receipt.state !== 'completed') {
      process.stderr.write(receipt.stderr || receipt.error?.message || 'Sandbox workload failed\n');
      process.exitCode = 1;
      return;
    }
  }
}

main().catch((error) => {
  process.stderr.write(`Sandbox qualification failed: ${error.message}\n`);
  process.exitCode = 1;
});
