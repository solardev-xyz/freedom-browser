#!/usr/bin/env node
'use strict';

// Reference-backend qualification only; this does not enable Freedom execution.
// Run as the normal test user, after separately provisioning the elevated backend.
// All workload files are synthetic and retained for inspection. No model is called.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { parseArgs } = require('node:util');

const { values } = parseArgs({ options: {
  codex: { type: 'string' }, home: { type: 'string' }, root: { type: 'string' },
  backend: { type: 'string', default: 'mxc' },
} });

function launch(executable, args, options = {}) {
  const child = spawn(executable, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], ...options });
  let stdout = '', stderr = '', timedOut = false;
  child.stdout.on('data', chunk => { stdout = (stdout + chunk).slice(-65536); });
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-65536); });
  child.stdin.end();
  const timer = setTimeout(() => { timedOut = true; child.kill(); }, 30000);
  const done = new Promise(resolve => {
    child.once('error', error => { clearTimeout(timer); resolve({ error: error.message, stdout, stderr }); });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, timedOut, stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
  return { child, done, output: () => stdout };
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function request(port) {
  return new Promise(resolve => {
    const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: 1000 }, res => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve(body === 'freedom-preview-probe'));
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(false));
  });
}

async function main() {
  assert.equal(process.platform, 'win32', 'Run on the designated Windows test machine');
  assert.ok(['mxc', 'elevated', 'unelevated'].includes(values.backend));
  for (const key of ['codex', 'home', 'root']) assert.ok(values[key] && path.isAbsolute(values[key]), `--${key} must be absolute`);
  assert.ok(fs.existsSync(values.codex));
  assert.ok(fs.existsSync(values.home), 'Use a separately prepared scratch Codex home');
  fs.mkdirSync(values.root, { recursive: true });
  const run = fs.mkdtempSync(path.join(values.root, `${values.backend}-`));
  const work = path.join(run, 'Project with spaces');
  const outside = path.join(run, 'outside');
  fs.mkdirSync(work);
  fs.mkdirSync(outside);
  fs.mkdirSync(path.join(work, '.git'));
  const outsideFile = path.join(outside, 'sentinel.txt');
  const gitFile = path.join(work, '.git', 'sentinel.txt');
  for (const file of [outsideFile, gitFile]) fs.writeFileSync(file, 'untouched');
  // A host-created junction tests whether write containment follows the target.
  fs.symlinkSync(outside, path.join(work, 'outside-junction'), 'junction');
  const results = [];
  const record = (name, result) => {
    const entry = { name, ...result };
    results.push(entry);
    fs.appendFileSync(path.join(run, 'results.jsonl'), JSON.stringify(entry) + '\n');
    console.log(JSON.stringify(entry));
  };
  const env = { ...process.env, CODEX_HOME: values.home,
    PATH: `${path.dirname(process.execPath)};${process.env.PATH}` };
  const sandbox = (args, network = false) => launch(values.codex, [
    '-c', `windows.sandbox=${JSON.stringify(values.backend)}`,
    '-c', 'features.prefer_mxc=false',
    ...(network ? ['-c', 'permissions.freedom_probe_net.extends=":workspace"',
      '-c', 'permissions.freedom_probe_net.network.enabled=true'] : []),
    '-C', work, 'sandbox', '-P', network ? 'freedom_probe_net' : ':workspace', '--', ...args,
  ], { cwd: work, env });
  const cmd = async (name, body, verify) => {
    const script = path.join(work, `${name}.cmd`);
    fs.writeFileSync(script, '@echo off\r\n' + body + '\r\n');
    const result = await sandbox(['cmd.exe', '/d', '/c', script]).done;
    record(name, { ...result, passed: verify(result) });
  };
  record('environment', { backend: values.backend, node: process.version, run,
    codex: await launch(values.codex, ['--version'], { env }).done });
  await cmd('workspace-write', 'echo workspace-ok> workspace-output.txt', r =>
    r.code === 0 && fs.existsSync(path.join(work, 'workspace-output.txt')) &&
      fs.readFileSync(path.join(work, 'workspace-output.txt'), 'utf8').includes('workspace-ok'));
  await cmd('outside-read', `type "${outsideFile}"`, r => r.code === 0 && r.stdout.includes('untouched'));
  for (const [name, target] of [['outside-write', outsideFile], ['git-write', gitFile],
    ['junction-write', path.join(work, 'outside-junction', 'sentinel.txt')]]) {
    await cmd(name, `echo tampered> "${target}"`, r =>
      r.code === 1 && /access is denied/i.test(r.stderr) && fs.readFileSync(target, 'utf8') === 'untouched');
  }
  const version = await sandbox([process.execPath, '--version']).done;
  record('node-start', { ...version, passed: version.code === 0 && version.stdout === process.version });
  if (version.code !== 0) {
    record('node-workloads', { skipped: true, reason: 'Node could not start; build/network/preview/cancellation remain unqualified' });
    process.exitCode = 1;
    return;
  }
  const buildSource = "const fs = require('node:fs'); fs.mkdirSync('dist', {recursive:true}); fs.writeFileSync('dist/index.html', '<h1>freedom-build-probe</h1>'); console.log('build-ok');";
  fs.writeFileSync(path.join(work, 'build.cjs'), buildSource);
  fs.writeFileSync(path.join(work, 'package.json'), JSON.stringify({ name: 'freedom-sandbox-probe', private: true,
    scripts: { build: 'node build.cjs' } }));
  const npm = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  const build = await sandbox([process.execPath, npm, '--cache', path.join(work, '.npm-cache'), 'run', 'build']).done;
  record('npm-build', { ...build, passed: build.code === 0 &&
    fs.existsSync(path.join(work, 'dist', 'index.html')) });

  // Raw sockets deliberately bypass HTTP proxy environment variables.
  const networkSource = `const net = require('node:net');
const socket = net.connect({host:'1.1.1.1', port:443});
socket.setTimeout(2500);
socket.once('connect', () => { console.log('connected'); socket.destroy(); });
socket.once('timeout', () => { console.log('timeout'); socket.destroy(); });
socket.once('error', e => console.log('blocked:' + e.code));`;
  const networkScript = path.join(work, 'network.cjs');
  fs.writeFileSync(networkScript, networkSource);
  const control = await launch(process.execPath, [networkScript], { cwd: work, env }).done;
  record('network-control', { ...control, passed: control.stdout === 'connected' });
  for (const enabled of [false, true]) {
    const result = await sandbox([process.execPath, networkScript], enabled).done;
    record(enabled ? 'network-allowed' : 'network-denied', { ...result,
      passed: control.stdout === 'connected' && result.code === 0 &&
        (enabled ? result.stdout === 'connected' : /^(blocked:|timeout)/.test(result.stdout)) });
  }
  const serverScript = path.join(work, 'server.cjs');
  fs.writeFileSync(serverScript, `const http = require('node:http');
const server = http.createServer((req,res) => res.end('freedom-preview-probe'));
server.listen(0, '127.0.0.1', () => console.log('PORT=' + server.address().port));
setTimeout(() => process.exit(0), 15000);`);
  const server = sandbox([process.execPath, serverScript], true);
  let port;
  for (let i = 0; i < 50; i++) {
    port = Number(server.output().match(/PORT=(\d+)/)?.[1]);
    if (port || server.child.exitCode !== null) break;
    await delay(100);
  }
  const reachable = Boolean(port) && await request(port);
  record('preview-http', { passed: reachable, port: port || null });
  // Terminating the owning launcher is an abrupt-shutdown probe, not Ctrl+C.
  server.child.kill();
  const ended = await server.done;
  await delay(500);
  record('launcher-termination', { ...ended, passed: reachable && !(await request(port)),
    scope: 'abrupt launcher exit; graceful cancellation is a separate integration gate' });
  // The bounded server watchdog prevents a surviving probe becoming a permanent service.
  record('sentinels', { passed: [outsideFile, gitFile].every(file => fs.readFileSync(file, 'utf8') === 'untouched') });
  if (results.some(result => result.passed === false)) process.exitCode = 1;
}

main().catch(error => { console.error(error); process.exitCode = 1; });
