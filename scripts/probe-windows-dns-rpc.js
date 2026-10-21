'use strict';

// The controller owns all DNS endpoints on this disposable runner. No NRPT
// rule or upstream forwarding can turn a disabled policy into a false pass.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const dgram = require('node:dgram');
const net = require('node:net');
const { randomBytes } = require('node:crypto');
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');
const { WindowsWorkspaceExecutor } = require('../src/main/agent/workspace-execution/windows-backend');
const { createWorkspaceExecutionPolicy } = require('../src/main/agent/workspace-execution/execution-policy');
const execute = promisify(execFile);

async function main() {
  assert(process.platform === 'win32' && process.env.GITHUB_ACTIONS === 'true', 'Use only disposable Windows CI');
  const helper = path.resolve(process.argv[2]);
  const container = path.resolve(process.argv[3]);
  const fixture = fs.mkdtempSync('C:/freedom-agent-tests/freedom-dns-rpc-');
  const workspace = path.join(fixture, 'project');
  const runtime = path.join(fixture, 'runtime');
  fs.mkdirSync(workspace); fs.mkdirSync(runtime);
  const ownedNode = path.join(runtime, 'node.exe');
  fs.copyFileSync(process.execPath, ownedNode);
  await execute('git', ['init', '--quiet', workspace]);
  const snapshot = path.join(workspace, 'adapter-dns.json');
  const powershell = path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const adapters = async operation => {
    try {
      const result = await execute(powershell, ['-NoProfile', '-NonInteractive', '-File',
        path.join(__dirname, 'probe-windows-dns-adapters.ps1'), '-Operation', operation, '-Snapshot', snapshot], { timeout: 60000 });
      console.log(result.stdout.trim());
    } catch (error) {
      console.error('Adapter operation failed:', operation, error.stdout, error.stderr);
      throw error;
    }
  };
  const listeners = [];
  const queries = new Map();
  function response(query) {
    if (query.length < 12) return null;
    const labels = [];
    for (let offset = 12; offset < query.length;) {
      const length = query[offset++];
      if (!length) break;
      if (length > 63 || offset + length > query.length) return null;
      labels.push(query.toString('ascii', offset, offset + length));
      offset += length;
    }
    const name = labels.join('.').toLowerCase();
    // Do not return/cache NXDOMAIN for unrelated runner infrastructure names.
    if (!queries.has(name)) return null;
    queries.set(name, queries.get(name) + 1);
    const bytes = Buffer.from(query);
    bytes.writeUInt16BE(0x8183, 2); // NXDOMAIN; never send upstream.
    return bytes;
  }
  let filter;
  try {
    for (const [family, address] of [['udp4', '127.0.0.1'], ['udp6', '::1']]) {
      const udp = dgram.createSocket(family);
      listeners.push(udp);
      udp.on('message', (query, remote) => {
        const bytes = response(query);
        if (bytes) udp.send(bytes, remote.port, remote.address);
      });
      await new Promise((resolve, reject) => { udp.once('error', reject); udp.bind(53, address, resolve); });
      const tcp = net.createServer(socket => {
        socket.setTimeout(3000, () => socket.destroy());
        socket.on('error', () => {});
        let pending = Buffer.alloc(0);
        socket.on('data', bytes => {
          pending = Buffer.concat([pending, bytes]);
          if (pending.length > 65537) { socket.destroy(); return; }
          if (pending.length < 2 || pending.length < pending.readUInt16BE(0) + 2) return;
          const answer = response(pending.subarray(2, pending.readUInt16BE(0) + 2));
          if (answer) {
            const frame = Buffer.alloc(answer.length + 2);
            frame.writeUInt16BE(answer.length); answer.copy(frame, 2); socket.end(frame);
          } else socket.destroy();
        });
      });
      listeners.push(tcp);
      await new Promise((resolve, reject) => { tcp.once('error', reject); tcp.listen(53, address, resolve); });
    }
    await adapters('Begin');
    const executor = new WindowsWorkspaceExecutor();
    const policy = async network => createWorkspaceExecutionPolicy({ workspaceRoot: workspace, network, limits: { timeoutMs: 15000 } });
    const run = async (network, source) => executor.execute(await policy(network), { command: process.execPath, args: ['-e', source] });
    const lookup = name => `require('dns').lookup('${name}.',e=>{console.log('lookup-complete',e?.code||'resolved');process.exit(0)});setTimeout(()=>{console.log('lookup-timeout');process.exit(2)},6000);`;
    const count = async action => {
      const name = `${randomBytes(12).toString('hex')}.freedom-audit.test`;
      queries.set(name, 0);
      await action(lookup(name));
      await new Promise(resolve => setTimeout(resolve, 2000));
      return queries.get(name);
    };
    const host = source => execute(process.execPath, ['-e', source], { timeout: 20000 });
    const sandbox = async (network, source) => {
      const result = await run(network, source);
      assert.equal(result.state, 'completed');
      assert.equal(result.exitCode, 0, 'DNS lookup must finish before its process exits');
      assert.match(result.stdout, /lookup-complete/);
    };
    const baseline = { host: await count(host), full: await count(source => sandbox('full', source)), offline: await count(source => sandbox('none', source)) };
    console.log(JSON.stringify({ baseline }));
    assert(baseline.host > 0 && baseline.full > 0 && baseline.offline > 0, 'All baseline DNS paths must reach the owned listeners');
    const results = [];
    const appcontainerOnly = process.argv.includes('--appcontainer-only');
    for (const mode of appcontainerOnly ? [] : ['query', 'policy', 'both']) {
      const child = spawn(helper, [mode], { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true });
      child.stdin.on('error', () => {});
      const closed = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
      closed.catch(() => {});
      const timer = setTimeout(() => child.kill(), 30000);
      filter = { child, closed, timer };
      await new Promise((resolve, reject) => {
        let output = '';
        child.stdout.on('data', bytes => {
          process.stdout.write(bytes);
          output += bytes;
          if (output.length > 65536) reject(new Error('Oversized filter output'));
          if (output.includes('FREEDOM_DNS_FILTERS_READY')) resolve();
        });
        child.once('error', reject);
        child.once('close', () => reject(new Error('Filter helper exited before readiness')));
      });
      const result = { mode, host: await count(host), full: await count(source => sandbox('full', source)), offline: await count(source => sandbox('none', source)) };
      console.log(JSON.stringify(result));
      results.push(result);
      child.stdin.end('release\n');
      assert.equal(await closed, 0, 'Dynamic filter session must close normally');
      clearTimeout(timer);
      filter = null;
      assert(result.host > 0 && result.full > 0, 'Host and approved-network DNS must remain usable');
    }
    if (!appcontainerOnly) assert.equal(results.find(result => result.mode === 'both')?.offline, 0, 'RPC-only experiment did not block DNS');
    // RPC results remain recorded even when they fail. This separate prototype
    // tests actual no-network AppContainer tokens, not production integration.
    const containerPackets = await count(async source => {
      const probe = `try{require('fs').writeFileSync(${JSON.stringify(path.join(workspace, 'appcontainer-probe.txt'))},'owned fixture');console.log('appcontainer-write:ok')}catch(e){console.log('appcontainer-write:'+e.code)};${source}`;
      const result = await execute(container, [ownedNode, workspace, probe], { timeout: 45000 });
      console.log(result.stdout.trim());
      assert.match(result.stdout, /Verified AppContainer process, zero network capabilities/);
      assert.match(result.stdout, /lookup-complete/);
      assert.match(result.stdout, /appcontainer-write:ok/, 'Node must still write the selected project');
    });
    const candidate = { mode: 'appcontainer', offline: containerPackets,
      host: await count(host), full: await count(source => sandbox('full', source)) };
    console.log(JSON.stringify({ rpcResults: results, candidate }));
    assert(candidate.host > 0 && candidate.full > 0, 'Normal and approved-network DNS must remain available');
    assert.equal(candidate.offline, 0, 'An actual no-network container must not emit DNS');
  } catch (error) {
    console.error('Owned DNS fixture failed before cleanup:', error);
    throw error;
  } finally {
    try {
      if (filter) {
        filter.child.stdin.end('release\n');
        try { await filter.closed; } finally { clearTimeout(filter.timer); }
      }
    } finally {
      // Close filters before touching service configuration. Keep the owned DNS
      // listeners alive until the original resolver addresses are restored.
      try { if (fs.existsSync(snapshot)) await adapters('Restore'); }
      finally { await Promise.all(listeners.map(listener => new Promise(resolve => listener.close(resolve)))); }
    }
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
