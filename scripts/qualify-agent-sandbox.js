#!/usr/bin/env node

'use strict';

const path = require('path');
const {
  createWorkspaceExecutionPolicy,
} = require('../src/main/agent/workspace-execution/execution-policy');
const { BubblewrapExecutor } = require('../src/main/agent/workspace-execution/bubblewrap-backend');
const {
  resolveProcessRuntimeAccess,
} = require('../src/main/agent/workspace-execution/qualification-runtime-access');

const workspaceRoot = path.resolve(__dirname, '..');

// Workloads flagged `runtime` need the qualification process's own Node/npm, mounted as
// approved read-only runtime roots. Every other workload runs on the baseline system
// toolchain, which is never assumed to provide node or npm.
const WORKLOADS = Object.freeze([
  {
    name: 'inherited-descriptor-closure',
    command: '/usr/bin/python3',
    args: [
      '-c',
      [
        'import json, os',
        'descriptors = []',
        "for name in os.listdir('/proc/self/fd'):",
        '    descriptor = int(name)',
        '    if descriptor <= 2:',
        '        continue',
        '    try:',
        "        target = os.readlink(f'/proc/self/fd/{descriptor}')",
        '    except FileNotFoundError:',
        '        continue',
        "    descriptors.append({'descriptor': descriptor, 'target': target})",
        'print(json.dumps(descriptors), end="")',
      ].join('\n'),
    ],
    expectEmptyDescriptorArray: true,
  },
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
    runtime: true,
  },
  { name: 'lint', command: 'npm', args: ['run', 'lint'], runtime: true },
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
    runtime: true,
  },
]);

function policyForWorkload(workload, policies) {
  return workload.runtime ? policies.runtime : policies.baseline;
}

async function main() {
  const executor = new BubblewrapExecutor();
  const capabilities = await executor.detectCapabilities({ force: true });
  process.stdout.write(`${JSON.stringify({ type: 'capabilities', ...capabilities })}\n`);
  if (!capabilities.available) {
    process.stderr.write(
      `Required Bubblewrap qualification is unavailable: ${capabilities.denial.code}\n`
    );
    process.exitCode = 1;
    return;
  }

  const runtimeAccess = await resolveProcessRuntimeAccess();
  process.stdout.write(
    `${JSON.stringify({
      type: 'runtime',
      commands: runtimeAccess.commands.map(({ name, status }) => ({ name, status })),
      runtimeRoots: runtimeAccess.runtimeRoots.map((root) => ({
        id: root.id,
        mountPath: root.mountPath,
        access: root.access,
        pathEntries: root.pathEntries,
        commands: root.commands,
      })),
    })}\n`
  );

  const policyOptions = {
    workspaceRoot,
    limits: {
      timeoutMs: 5 * 60 * 1_000,
      stdoutBytes: 1024 * 1024,
      stderrBytes: 1024 * 1024,
    },
  };
  const policies = {
    baseline: await createWorkspaceExecutionPolicy(policyOptions),
    runtime: await createWorkspaceExecutionPolicy({
      ...policyOptions,
      runtimeRoots: runtimeAccess.runtimeRoots,
    }),
  };
  for (const workload of WORKLOADS) {
    const receipt = await executor.execute(policyForWorkload(workload, policies), workload);
    let descriptors;
    if (workload.expectEmptyDescriptorArray && receipt.state === 'completed') {
      descriptors = JSON.parse(receipt.stdout);
      if (!Array.isArray(descriptors) || descriptors.length !== 0) {
        throw new Error(`Sandbox inherited descriptors: ${JSON.stringify(descriptors)}`);
      }
    }
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
        sideEffects: receipt.sideEffects,
        survivorsPossible: receipt.survivorsPossible,
        completeDescendantTermination: receipt.completeDescendantTermination,
        terminationScope: receipt.terminationScope,
        ...(descriptors ? { descriptors } : {}),
      })}\n`
    );
    if (receipt.state !== 'completed') {
      process.stderr.write(receipt.stderr || receipt.error?.message || 'Sandbox workload failed\n');
      process.exitCode = 1;
      return;
    }
  }
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`Sandbox qualification failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { WORKLOADS, policyForWorkload };
