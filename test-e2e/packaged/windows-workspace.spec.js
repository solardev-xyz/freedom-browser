// Read-only artifact check: the installed executable must load and validate its
// own sandbox helpers. Provisioning/UAC and execution have separate qualification
// gates; opening a release smoke test must not provision machine accounts.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { test, expect } = require('../fixtures');

test('Windows artifact carries a matching sandbox runtime and dependency notices', async ({ electronApp }) => {
  test.skip(process.platform !== 'win32', 'Windows artifact only');
  const { resourcesPath, execPath } = await electronApp.appFacts();
  const directory = path.join(resourcesPath, 'windows-workspace');
  const inventory = JSON.parse(fs.readFileSync(path.join(directory, 'CODEX-DEPENDENCIES.json'), 'utf8'));
  expect(inventory.length).toBeGreaterThan(10);
  expect(inventory.every(item => item.name && item.license && item.sourceDownload && item.notices.length)).toBe(true);
  expect(fs.readFileSync(path.join(directory, 'CODEX-DEPENDENCIES.txt'), 'utf8')).toContain('Apache License');
  const runtimePath = path.join(resourcesPath, 'app.asar', 'src/main/agent/workspace-execution/windows-sandbox-runtime');
  const script = `require(${JSON.stringify(runtimePath)}).resolveWindowsSandbox({packaged:true,resourcesPath:${JSON.stringify(resourcesPath)}}).then(r=>console.log(JSON.stringify({backend:r.backend}))).catch(e=>{console.error(e.message);process.exitCode=1})`;
  const result = spawnSync(execPath, ['-e', script], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', timeout: 30000, windowsHide: true });
  expect({ status: result.status, stderr: result.stderr, error: result.error?.message }).toEqual({ status: 0, stderr: '', error: undefined });
  expect(JSON.parse(result.stdout.trim())).toEqual({ backend: 'elevated' });
});
