'use strict';
// #779 S8, as the standard user, against the installed runtime: a command
// without a network grant is refused before it starts (no DNS reaches the
// owned listener); the same command with the grant resolves through the
// shared Windows resolver, for the owned name and for a public one.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const repo = 'C:/e2e/repo';
const { WindowsWorkspaceExecutor } = require(`${repo}/src/main/agent/workspace-execution/windows-backend`);
const { createWorkspaceExecutionPolicy } = require(`${repo}/src/main/agent/workspace-execution/execution-policy`);
const packets = 'C:/e2e/dns/packets.log';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const log = (event, details = {}) => console.log(JSON.stringify({ event, ...details }));
(async () => {
  const executor = new WindowsWorkspaceExecutor({ directory: process.argv[2] });
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-s8-'));
  execFileSync('git', ['init', '--quiet', workspace]);
  const results = [];
  const lookup = name => `require('dns').lookup(${JSON.stringify(name)},{all:true},(e,a)=>{console.log(JSON.stringify({code:e&&e.code,addresses:a}));process.exit(0)});setTimeout(()=>process.exit(0),5000);`;
  const run = async (network, name) => executor.execute(await createWorkspaceExecutionPolicy({ workspaceRoot: workspace, network, limits: { timeoutMs: 15000 } }),
    { command: process.execPath, args: ['-e', lookup(name)] });
  const seen = name => fs.readFileSync(packets, 'utf8').includes(` ${name} `);
  // Host control: the listener is reachable for this user outside the sandbox.
  const control = `${randomBytes(8).toString('hex')}.freedom-audit.test`;
  execFileSync(process.execPath, ['-e', lookup(control)]);
  await sleep(1000);
  results.push({ name: 'host-control-reaches-owned-dns', passed: seen(control) });
  const offline = `${randomBytes(8).toString('hex')}.freedom-audit.test`;
  const refused = await run('none', offline);
  await sleep(2500);
  results.push({ name: 'offline-refused-before-start', passed: refused.state === 'sandbox_denied' && refused.sideEffects === 'none' &&
    refused.error?.code === 'WINDOWS_FULL_NETWORK_PERMISSION_REQUIRED' && !seen(offline), receipt: refused, dnsSeen: seen(offline) });
  const refusedPublic = await run('none', 'example.com');
  results.push({ name: 'offline-public-refused', passed: refusedPublic.state === 'sandbox_denied' && refusedPublic.stdout === '', receipt: refusedPublic });
  const granted = `${randomBytes(8).toString('hex')}.freedom-audit.test`;
  const full = await run('full', granted);
  await sleep(1000);
  results.push({ name: 'granted-owned-dns-reaches-listener', passed: full.state === 'completed' && seen(granted) && /ENOTFOUND/.test(full.stdout), receipt: full });
  const publicFull = await run('full', 'example.com');
  let addresses = [];
  try { addresses = JSON.parse(publicFull.stdout.trim()).addresses || []; } catch { /* no JSON output: addresses stays empty */ }
  results.push({ name: 'granted-public-dns-resolves', passed: publicFull.state === 'completed' && addresses.length > 0, receipt: publicFull });
  // The native boundary itself refuses an offline 'execute' (no JS gate).
  const native = await executor.run(executor.runtime, { version: 1, operation: 'execute', backend: 'elevated', home: executor.home, network: false });
  results.push({ name: 'native-offline-execute-refused', passed: native.terminal?.type === 'error' && /WINDOWS_OFFLINE_COMMAND_UNAVAILABLE/.test(native.terminal.message), terminal: native.terminal });
  for (const result of results) log(result.name, result);
  fs.rmSync(workspace, { recursive: true, force: true });
  process.exitCode = results.every(result => result.passed) ? 0 : 1;
})().catch(error => { console.error(error); process.exitCode = 1; });
