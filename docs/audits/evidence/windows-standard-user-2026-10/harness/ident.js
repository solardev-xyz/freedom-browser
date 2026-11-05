'use strict';
// Which identity does a granted command run as? (standard user's view)
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const { execFileSync } = require('node:child_process');
const repo = 'C:/e2e/repo';
const { WindowsWorkspaceExecutor } = require(`${repo}/src/main/agent/workspace-execution/windows-backend`);
const { createWorkspaceExecutionPolicy } = require(`${repo}/src/main/agent/workspace-execution/execution-policy`);
(async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-ident-'));
  execFileSync('git', ['init', '--quiet', workspace]);
  const executor = new WindowsWorkspaceExecutor({ directory: process.argv[2] });
  const policy = await createWorkspaceExecutionPolicy({ workspaceRoot: workspace, network: 'full', limits: { timeoutMs: 15000 } });
  const r = await executor.execute(policy, { command: 'C:\\Windows\\System32\\whoami.exe', args: ['/user', '/groups', '/fo', 'csv', '/nh'] });
  console.log(JSON.stringify({ host: os.userInfo().username, state: r.state, exitCode: r.exitCode }));
  console.log(r.stdout.split(/\r?\n/).filter(line => /freedom|sbx|Mandatory|Administrators/i.test(line)).join('\n'));
  fs.rmSync(workspace, { recursive: true, force: true });
})().catch(error => { console.error(error); process.exitCode = 1; });
