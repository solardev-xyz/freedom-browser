'use strict';
// #779 native run, as the standard user: run the administrator setup through
// Freedom's own executor (setup-interactive -> UAC), and while it is pending
// keep trying to tamper with the verified runtime. Every attempt must fail
// until setup returns (L10); afterwards the same rename must succeed.
const fs = require('node:fs');
const path = require('node:path');
const repo = 'C:/e2e/repo';
const { execFileSync } = require('node:child_process');
const { WindowsWorkspaceExecutor } = require(`${repo}/src/main/agent/workspace-execution/windows-backend`);
const runtime = process.argv[2];
const log = (event, details = {}) => console.log(JSON.stringify({ t: new Date().toISOString(), event, ...details }));
const setupExe = path.join(runtime, 'freedom-windows-sandbox-setup.exe');
const attempts = {
  'write-setup-exe': () => fs.appendFileSync(setupExe, ''),
  'rename-setup-exe': () => { fs.renameSync(setupExe, `${setupExe}.moved`); fs.renameSync(`${setupExe}.moved`, setupExe); },
  'delete-setup-exe': () => { fs.copyFileSync(setupExe, `${setupExe}.bak`); fs.unlinkSync(setupExe); fs.renameSync(`${setupExe}.bak`, setupExe); },
  'rename-runtime-dir': () => { fs.renameSync(runtime, `${runtime}-moved`); fs.renameSync(`${runtime}-moved`, runtime); },
};
function tamper() {
  const result = {};
  for (const [name, attempt] of Object.entries(attempts)) {
    try { attempt(); result[name] = 'SUCCEEDED'; } catch (error) { result[name] = error.code || error.message; }
  }
  try { fs.rmSync(`${setupExe}.bak`, { force: true }); } catch { /* already gone */ }
  return result;
}
(async () => {
  const executor = new WindowsWorkspaceExecutor({ directory: runtime });
  log('probe-before', await executor.detectCapabilities());
  log('tamper-before-setup', { note: 'none of these run during setup; proves the user can normally write here' });
  let settled = false;
  const setup = executor.setup().then(() => ({ ok: true }), error => ({ ok: false, error: error.message }))
    .finally(() => { settled = true; });
  const rounds = [];
  await new Promise(resolve => setTimeout(resolve, 1500));
  while (!settled) {
    const elevatedSetupRunning = execFileSync('tasklist.exe', ['/FI', 'IMAGENAME eq freedom-windows-sandbox-setup.exe', '/NH'], { encoding: 'utf8' })
      .includes('freedom-windows-sandbox-setup.exe');
    const result = { elevatedSetupRunning, ...tamper() };
    rounds.push(result);
    log('tamper-during-setup', result);
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  const outcome = await setup;
  log('setup-returned', outcome);
  const after = tamper();
  log('tamper-after-setup', after);
  log('probe-after', await executor.detectCapabilities());
  const anyDuring = rounds.some(round => Object.values(round).includes('SUCCEEDED'));
  const sawElevated = rounds.some(round => round.elevatedSetupRunning);
  log('summary', { rounds: rounds.length, roundsWhileElevatedSetupRan: rounds.filter(round => round.elevatedSetupRunning).length, tamperSucceededDuringSetup: anyDuring,
    allAfterSucceeded: Object.values(after).every(value => value === 'SUCCEEDED'), setup: outcome });
  process.exitCode = outcome.ok && !anyDuring && sawElevated ? 0 : 1;
})().catch(error => { console.error(error); process.exitCode = 1; });
