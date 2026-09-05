#!/usr/bin/env node

'use strict';

// Unified runner for the Freedom managed Agent workspace qualification. It composes the production
// FreedomAgentService, the real SQLite stores, the ManagedWorkspaceController and its process
// manager, the real Pi tool factories, the production WorkspacePreviewController, and the real
// Bubblewrap executor once (see ./agent-qualification/harness.js), then drives one reusable
// scenario group against that composition and guarantees finally-based cleanup.
//
// Launch through the checkout's Electron binary in Node mode so the native SQLite stores load and
// the production runtime detector attests the helper runtime:
//
//   ELECTRON_RUN_AS_NODE=1 electron scripts/qualify-agent-workspace.js <group> [flags]
//
// Groups:
//   network         Network permissions, product build (default: available, offline until approval)
//   network --network-disabled
//                   Network permissions, capability-disabled regression
//   processes       Managed processes (yield, stdin, bounds, termination, Stop, disposal)
//   processes --include-slow
//                   Also run the five-minute terminal-handle expiry case
//   reconciliation  Automatic terminal reconciliation without model polling
//   previews        Managed server previews, gate enabled
//   previews --network-disabled
//                   Managed server previews, gate-absent regression
//   process-controls  Trusted-chrome running-process controls (list, stop, preview)
//   self-test-fault Controlled-failure self-test that proves cleanup runs after a scenario error
//   all             Every group above (both network modes and both preview modes), each in its own
//                   isolated process, with an aggregate matrix; excludes the slow expiry case and
//                   the self-test-fault group
//
// Each run emits one JSON line per assertion and exits non-zero if any assertion, the scenario, or
// cleanup failed. On non-Linux platforms every group prints an explicit skip and exits 0.

const { spawn } = require('child_process');

const { runScenario } = require('./agent-qualification/harness');

const SCENARIOS = {
  network: {
    module: './agent-qualification/scenarios/network',
    modes: (flags) => ({ networkEnabled: !flags.networkDisabled }),
  },
  processes: {
    module: './agent-qualification/scenarios/processes',
    modes: (flags) => ({ networkEnabled: true, includeSlow: flags.includeSlow }),
  },
  reconciliation: {
    module: './agent-qualification/scenarios/reconciliation',
    modes: () => ({ networkEnabled: true }),
  },
  previews: {
    module: './agent-qualification/scenarios/previews',
    modes: (flags) => ({ networkEnabled: !flags.networkDisabled }),
  },
  'process-controls': {
    module: './agent-qualification/scenarios/process-controls',
    modes: () => ({ networkEnabled: true }),
  },
  'self-test-fault': {
    module: './agent-qualification/scenarios/self-test-fault',
    modes: () => ({ networkEnabled: true }),
  },
};

// The aggregate order: both network modes, the three process/preview/reconciliation groups, and
// both preview modes. Kept deterministic so the matrix always reads the same way.
const AGGREGATE = [
  { group: 'network', flags: [] },
  { group: 'network', flags: ['--network-disabled'] },
  { group: 'processes', flags: [] },
  { group: 'reconciliation', flags: [] },
  { group: 'previews', flags: [] },
  { group: 'previews', flags: ['--network-disabled'] },
  { group: 'process-controls', flags: [] },
];

function parseFlags(argv) {
  return {
    networkDisabled: argv.includes('--network-disabled'),
    includeSlow: argv.includes('--include-slow'),
  };
}

async function runGroup(group, argv) {
  const entry = SCENARIOS[group];
  if (!entry) {
    process.stdout.write(
      `${JSON.stringify({ type: 'runner_error', message: `Unknown group: ${group}`, groups: Object.keys(SCENARIOS).concat('all') })}\n`
    );
    return 2;
  }
  const scenario = require(entry.module);
  const options = entry.modes(parseFlags(argv));
  const outcome = await runScenario(scenario, options);
  if (outcome.skipped) return 0;
  return outcome.failed ? 1 : 0;
}

// Run one group in its own child process so each aggregate group gets a clean composition, a fresh
// temporary fixture root, and independent survivor/cleanup accounting. Child stdout is forwarded
// live; the final summary line is parsed for the aggregate matrix.
function runChild(group, flags) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [__filename, group, ...flags], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    let buffer = '';
    let summary = null;
    let skipped = false;
    child.stdout.on('data', (chunk) => {
      process.stdout.write(chunk);
      buffer += chunk.toString('utf8');
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        try {
          const parsed = JSON.parse(line);
          if (parsed.type === 'summary') summary = parsed;
          if (parsed.type === 'skip' && parsed.platform) skipped = true;
        } catch {
          // Non-JSON progress lines are forwarded but not parsed.
        }
      }
    });
    child.on('close', (code) => {
      resolve({
        group,
        flags,
        code: code ?? 1,
        summary,
        skipped: skipped || Boolean(summary?.skipped),
      });
    });
  });
}

async function runAggregate() {
  const results = [];
  for (const { group, flags } of AGGREGATE) {
    const label = `${group}${flags.length ? ` ${flags.join(' ')}` : ''}`;
    process.stdout.write(`${JSON.stringify({ type: 'aggregate_group_start', label })}\n`);
    const outcome = await runChild(group, flags);
    results.push({ label, ...outcome });
  }

  const skippedAll = results.every((entry) => entry.skipped);
  const matrix = results.map((entry) => ({
    group: entry.label,
    passed: entry.summary?.passed ?? null,
    failed: entry.summary?.failed ?? null,
    skipped: entry.skipped,
    exitCode: entry.code,
    status: entry.skipped ? 'skipped' : entry.code === 0 ? 'passed' : 'failed',
  }));
  process.stdout.write(`${JSON.stringify({ type: 'aggregate', matrix, skippedAll })}\n`);

  process.stdout.write('\nAggregate qualification matrix\n');
  for (const row of matrix) {
    const counts = row.skipped
      ? 'skipped (platform)'
      : `${row.passed ?? '?'} passed / ${row.failed ?? '?'} failed`;
    process.stdout.write(
      `  ${row.status.toUpperCase().padEnd(8)} ${row.group.padEnd(28)} ${counts}\n`
    );
  }

  if (skippedAll) return 0;
  return results.every((entry) => entry.skipped || entry.code === 0) ? 0 : 1;
}

async function run(argv) {
  const positional = argv.filter((arg) => !arg.startsWith('-'));
  const group = positional[0] || 'all';
  if (group === 'all') return runAggregate();
  return runGroup(group, argv);
}

module.exports = { run, SCENARIOS: Object.keys(SCENARIOS) };

if (require.main === module) {
  run(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      process.stdout.write(
        `${JSON.stringify({ type: 'runner_error', message: error.message, stack: error.stack?.split('\n').slice(0, 6) })}\n`
      );
      process.exit(2);
    });
}
