'use strict';
// Characterise the S1 cleanup race on this machine: run raceCleanup N times
// against the installed remove-tree and time each piece.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const repo = 'C:/e2e/repo';
const { WindowsWorkspaceExecutor } = require(`${repo}/src/main/agent/workspace-execution/windows-backend`);
const { raceCleanup, racerNames } = require(`${repo}/src/main/agent/workspace-execution/__tests__/cleanup-racer`);
(async () => {
  const executor = new WindowsWorkspaceExecutor({ directory: process.argv[2] });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'race-probe-'));
  const runs = Number(process.argv[3] || 5);
  for (let i = 0; i < runs; i++) {
    let calls = 0; const times = [];
    const started = Date.now();
    const result = await raceCleanup({
      target: fs.mkdtempSync(path.join(root, 'freedom-win-workspace-')), outside: path.join(root, `outside-${i}`),
      names: racerNames(), linkType: 'junction',
      cleanup: async target => { calls++; const t = Date.now(); try { await executor.removeTree(target); } finally { times.push(Date.now() - t); } },
    });
    console.log(JSON.stringify({ i, ms: Date.now() - started, calls, cleanupMs: times, overlapped: result.overlapped, preserved: result.preserved, removed: result.removed,
      before: result.before, during: result.during, final: result.final, firstError: result.firstError }));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
