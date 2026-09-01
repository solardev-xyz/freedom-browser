#!/usr/bin/env node

'use strict';

const fs = require('fs');
const path = require('path');
const {
  createWorkspaceExecutionPolicy,
} = require('../src/main/agent/workspace-execution/execution-policy');
const { SeatbeltExecutor } = require('../src/main/agent/workspace-execution/seatbelt-backend');

const workspaceRoot = path.resolve(__dirname, '..');

async function main() {
  if (process.platform !== 'darwin' || process.env.FREEDOM_REQUIRE_SEATBELT !== '1') {
    throw new Error('macOS qualification requires darwin and FREEDOM_REQUIRE_SEATBELT=1');
  }
  const nodeExecutable = fs.realpathSync(process.execPath);
  if (path.basename(nodeExecutable) !== 'node') {
    throw new Error('macOS qualification must run from a standalone trusted Node runtime');
  }
  const nodeRuntimeRoot = path.dirname(path.dirname(nodeExecutable));
  const executor = new SeatbeltExecutor();
  const capabilities = await executor.detectCapabilities({ force: true });
  process.stdout.write(`${JSON.stringify({ type: 'capabilities', ...capabilities })}\n`);
  if (!capabilities.available) {
    throw new Error(capabilities.denial?.code || 'Seatbelt is unavailable');
  }
  const policy = await createWorkspaceExecutionPolicy({
    workspaceRoot,
    nodeRuntimeRoot,
    protectedWorkspacePaths: ['.git', 'node_modules'],
    limits: {
      timeoutMs: 5 * 60 * 1_000,
      stdoutBytes: 1024 * 1024,
      stderrBytes: 1024 * 1024,
    },
  });
  process.stdout.write(
    `${JSON.stringify({
      type: 'qualification-context',
      hostProcess: 'standalone_node',
      nodeRuntimeRoot,
      packagedElectronQualified: false,
    })}\n`
  );
  const workloads = [
    {
      name: 'focused-jest',
      command: 'npm',
      args: [
        'run',
        'test:unit',
        '--',
        '--runInBand',
        'src/main/agent/workspace-execution/seatbelt-backend.test.js',
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
          "const result = babel.transformFileSync('src/main/agent/workspace-execution/seatbelt-backend.js', { ast: false, babelrc: false, configFile: false });",
          "fs.writeFileSync(process.env.TMPDIR + '/freedom-seatbelt-build.js', result.code);",
        ].join(' '),
      ],
    },
    {
      name: 'shell-python-git',
      command: '/bin/sh',
      args: [
        '-c',
        [
          'python3 -c "print(\'python-ok\')" >/dev/null',
          'git status --short >/dev/null',
          'git diff -- src/main/agent/workspace-execution/seatbelt-backend.js >/dev/null',
          'git log -1 --oneline >/dev/null',
          "printf 'positive-ok'",
        ].join(' && '),
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
        terminationGuarantee: receipt.terminationGuarantee,
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
  process.stderr.write(`macOS sandbox qualification failed: ${error.message}\n`);
  process.exitCode = 1;
});
