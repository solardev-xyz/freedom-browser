'use strict';
// TEMPORARY diagnostic for PR #830 R1-F1; removed in the fix commit.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const root = path.resolve(__dirname, '../..');
const { detectElectronJavaScriptRuntime } = require(path.join(root, 'src/main/agent/workspace-execution/electron-runtime'));
const { createWorkspaceFileReadPolicy, createWorkspaceExecutionPolicy } = require(path.join(root, 'src/main/agent/workspace-execution/execution-policy'));
const sb = require(path.join(root, 'src/main/agent/workspace-execution/seatbelt-backend'));

(async () => {
  console.log('versions', process.versions.electron, process.versions.node, process.execPath);
  const runtime = await detectElectronJavaScriptRuntime({ packaged: false });
  console.log('runtime available', runtime.available, runtime.denial || '');
  const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'diag-ws-')));
  fs.writeFileSync(path.join(ws, 'a.txt'), 'hello');
  for (const [label, factory] of [['read', createWorkspaceFileReadPolicy], ['exec', createWorkspaceExecutionPolicy]]) {
    let policy;
    try {
      policy = await factory({ workspaceRoot: ws, electronRuntime: runtime, allowMissingGitMetadata: true,
        environment: { set: { ELECTRON_RUN_AS_NODE: '1' } },
        limits: { timeoutMs: 30000, stdoutBytes: 65536, stderrBytes: 65536 } });
    } catch (e) { console.log(label, 'policy error', e.code, e.message); continue; }
    const executor = new sb.SeatbeltExecutor();
    const receipt = await executor.execute(policy, { command: runtime.sandboxExecutablePath,
      args: ['-e', 'process.stdout.write("ok:" + require("fs").readFileSync("a.txt","utf8"))'] });
    console.log(label, 'RECEIPT', JSON.stringify({ state: receipt.state, exitCode: receipt.exitCode, signal: receipt.signal,
      stdout: receipt.stdout, stderr: receipt.stderr, denial: receipt.denial, diagnostics: receipt.diagnostics }, null, 1));
    const priv = await sb.createPrivateDirectory();
    const profile = sb.buildSeatbeltProfile(policy, priv);
    const variants = ['', '(allow sysctl-read)'];
    for (const extra of variants) {
      const file = path.join(priv, 'v.sb');
      fs.writeFileSync(file, profile + extra + '\n');
      const r = spawnSync('/usr/bin/sandbox-exec', ['-f', file, runtime.executablePath, '-e', 'process.stdout.write("ok")'],
        { cwd: ws, env: { ELECTRON_RUN_AS_NODE: '1', HOME: path.join(priv, 'home'), TMPDIR: path.join(priv, 'tmp'), PATH: '/usr/bin:/bin' },
          encoding: 'utf8', timeout: 30000 });
      console.log(label, 'VARIANT', JSON.stringify(extra), 'status', r.status, 'signal', r.signal, 'stdout', JSON.stringify(r.stdout),
        'stderr', JSON.stringify((r.stderr || '').slice(0, 1500)));
    }
  }
  try {
    const out = execFileSync('/usr/bin/log', ['show', '--last', '3m', '--style', 'compact', '--predicate',
      'sender == "Sandbox" OR eventMessage CONTAINS "deny("'], { encoding: 'utf8', maxBuffer: 64 << 20 });
    const lines = out.split('\n').filter((l) => /Electron\(/.test(l) && /deny/.test(l));
    const uniq = [...new Set(lines.map((l) => l.replace(/^.*?Sandbox: /, '').replace(/\(\d+\)/g, '')))];
    console.log('DENIALS', uniq.length); for (const l of uniq.slice(0, 300)) console.log('  ', l);
  } catch (e) { console.log('log show failed', e.message); }
})().catch((e) => { console.log('FATAL', e); process.exitCode = 1; });
