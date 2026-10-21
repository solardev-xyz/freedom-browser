'use strict';

// Administrator-only qualification on a disposable GitHub Windows runner.
// A temporary NRPT rule routes only our synthetic namespace to our own DNS
// listener. Restore it in finally; never alter the machine's default resolver.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const dgram = require('node:dgram');
const { randomBytes } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { WindowsWorkspaceExecutor } = require('../src/main/agent/workspace-execution/windows-backend');
const { createWorkspaceExecutionPolicy } = require('../src/main/agent/workspace-execution/execution-policy');
const execute = promisify(execFile);

async function main() {
  assert(process.platform === 'win32' && process.env.GITHUB_ACTIONS === 'true', 'Use only a disposable Windows CI runner');
  const powershell = path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const ps = script => execute(powershell, ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 15000 });
  const workspace = fs.mkdtempSync('C:/freedom-agent-tests/freedom-dns-');
  await execute('git', ['init', '--quiet', workspace]);
  const dns = dgram.createSocket('udp4');
  let packets = 0, rule;
  dns.on('message', (query, remote) => {
    if (query.length < 12) return;
    packets++;
    const response = Buffer.from(query);
    response.writeUInt16BE(0x8183, 2); // NXDOMAIN; no upstream traffic.
    dns.send(response, remote.port, remote.address);
  });
  await new Promise((resolve, reject) => {
    dns.once('error', reject);
    dns.bind(53, '127.0.0.1', resolve);
  });
  try {
    rule = (await ps("Add-DnsClientNrptRule -Namespace '.freedom-audit.test' -NameServers '127.0.0.1' -DisplayName 'Freedom owned DNS fixture' -PassThru | Select-Object -ExpandProperty Name")).stdout.trim();
    assert.match(rule, /^\{?[0-9a-f-]+\}?$/i);
    const source = () => `require('dns').lookup('${randomBytes(12).toString('hex')}.freedom-audit.test',()=>process.exit(0));setTimeout(()=>process.exit(0),3500);`;
    await execute(process.execPath, ['-e', source()], { timeout: 5000 });
    const control = packets;
    assert(control > 0, 'The host control must reach the owned DNS listener');
    packets = 0;
    const policy = await createWorkspaceExecutionPolicy({ workspaceRoot: workspace, network: 'none', limits: { timeoutMs: 6000 } });
    const receipt = await new WindowsWorkspaceExecutor().execute(policy, { command: process.execPath, args: ['-e', source()] });
    await new Promise(resolve => setTimeout(resolve, 2000));
    console.log(JSON.stringify({ control, offlinePackets: packets, state: receipt.state }));
    assert.equal(receipt.state, 'completed');
    if (process.argv.includes('--expect-existing-leak')) {
      // Explicit diagnostic control only. Normal CI qualification still
      // requires zero packets; a setup/execution failure cannot be a baseline.
      assert(packets > 0, 'The diagnostic baseline must reproduce the existing DNS leak');
    } else {
      assert.equal(packets, 0, 'An offline workload must not send DNS through the shared service');
    }
  } finally {
    if (rule) await ps(`Remove-DnsClientNrptRule -Name '${rule}' -Force`);
    await new Promise(resolve => dns.close(resolve));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
