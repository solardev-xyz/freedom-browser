#!/usr/bin/env node
'use strict';

// Run from a normal Windows desktop session after the separate administrator
// setup. Exercises Freedom's actual policy/executor, without a model or secrets.
// Retain the synthetic fixture and JSONL report for inspection.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { execFileSync } = require('node:child_process');
const { parseArgs } = require('node:util');
const { WindowsWorkspaceExecutor } = require('../src/main/agent/workspace-execution/windows-backend');
const { createWorkspaceExecutionPolicy, createWorkspaceFileReadPolicy } = require('../src/main/agent/workspace-execution/execution-policy');
const { resolveExecutableAccess } = require('../src/main/agent/workspace-execution/executable-access');
const { values } = parseArgs({ options: { root: { type: 'string' }, home: { type: 'string' } } });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
  assert.equal(process.platform, 'win32');
  assert.ok(values.root && path.isAbsolute(values.root), '--root must name an absolute scratch directory');
  fs.mkdirSync(values.root, { recursive: true });
  const directory = fs.mkdtempSync(path.join(values.root, 'freedom-'));
  const workspace = path.join(directory, 'Project with spaces');
  fs.mkdirSync(workspace);
  execFileSync('git', ['init', '--quiet', workspace]);
  const outside = path.join(directory, 'outside.txt');
  const gitSentinel = path.join(workspace, '.git', 'sentinel');
  fs.writeFileSync(outside, 'untouched');
  fs.writeFileSync(gitSentinel, 'untouched');
  const results = [];
  const record = (name, passed, details = {}) => {
    const value = { name, passed, ...details };
    results.push(value);
    console.log(JSON.stringify(value));
    fs.appendFileSync(path.join(directory, 'results.jsonl'), `${JSON.stringify(value)}\n`);
  };
  const executor = new WindowsWorkspaceExecutor({ ...(values.home && { home: values.home }) });
  const capabilities = await executor.detectCapabilities();
  record('capabilities', capabilities.available && !capabilities.setupRequired, { capabilities, directory });
  assert.ok(capabilities.available && !capabilities.setupRequired, 'Complete administrator setup first');
  const access = await resolveExecutableAccess(['node', 'npm'], { hostEnvironment: { PATH: `${path.dirname(process.execPath)};${process.env.PATH}` } });
  const policy = (network = 'none') => createWorkspaceExecutionPolicy({ workspaceRoot: workspace, runtimeRoots: access.runtimeRoots, network, limits: { timeoutMs: 30000 } });
  const execute = async (source, options = {}) => executor.execute(await policy(options.network), { command: process.execPath, args: ['-e', source], ...options });
  const check = async (name, source, verify, options) => {
    const result = await execute(source, options);
    record(name, verify(result), { state: result.state, exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr, error: result.error });
    return result;
  };
  await check('node-write', "require('fs').writeFileSync('hello.txt', 'hello'); console.log('written')", r => r.state === 'completed' && fs.readFileSync(path.join(workspace, 'hello.txt'), 'utf8') === 'hello');
  await check('broad-read', `console.log(require('fs').readFileSync(${JSON.stringify(outside)}, 'utf8'))`, r => r.stdout.trim() === 'untouched');
  for (const [name, target] of [['outside-write', outside], ['git-write', gitSentinel]]) {
    await check(name, `try { require('fs').writeFileSync(${JSON.stringify(target)}, 'tampered'); process.exitCode=2; } catch(e) { console.log(e.code); }`, r => r.state === 'completed' && /EPERM|EACCES/.test(r.stdout) && fs.readFileSync(target, 'utf8') === 'untouched');
  }
  const readPolicy = await createWorkspaceFileReadPolicy({ workspaceRoot: workspace });
  const readOnly = await executor.execute(readPolicy, { command: process.execPath, args: ['-e', "try { require('fs').writeFileSync('hello.txt','tampered'); process.exitCode=2; } catch(e) { console.log(e.code); }"] });
  record('read-only-after-writer', readOnly.state === 'completed' && /EPERM|EACCES/.test(readOnly.stdout) && fs.readFileSync(path.join(workspace, 'hello.txt'), 'utf8') === 'hello', readOnly);
  fs.writeFileSync(path.join(workspace, 'package.json'), JSON.stringify({ name: 'freedom-probe', private: true, scripts: { build: 'node build.cjs' } }));
  fs.writeFileSync(path.join(workspace, 'build.cjs'), "require('fs').writeFileSync('index.html', '<h1>built</h1>'); console.log('built');");
  const npm = path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
  const build = await executor.execute(await policy(), { command: process.execPath, args: [npm, 'run', 'build'] });
  record('npm-build', build.state === 'completed' && fs.existsSync(path.join(workspace, 'index.html')), build);
  const socketSource = "const s=require('net').connect(443,'1.1.1.1'); s.setTimeout(3000); s.on('connect',()=>{console.log('connected');s.destroy()});s.on('error',e=>console.log(e.code));s.on('timeout',()=>{console.log('timeout');s.destroy()});";
  for (const network of ['full', 'none']) {
    await check(`network-${network}`, socketSource, r => r.state === 'completed' && (network === 'full' ? r.stdout.trim() === 'connected' : /EACCES|EPERM/.test(r.stdout)), { network });
  }
  const controller = new AbortController();
  let output = '';
  const server = execute("const fs=require('fs');fs.writeFileSync('heartbeat','started');const h=require('http').createServer((q,r)=>r.end('preview-ok'));h.listen(0,'127.0.0.1',()=>console.log('PORT='+h.address().port));setInterval(()=>fs.writeFileSync('heartbeat',String(Date.now())),100);setTimeout(()=>process.exit(),20000);", {
    network: 'full', signal: controller.signal, onOutput: (_stream, bytes) => { output += bytes; },
  });
  let port;
  for (let i = 0; i < 100 && !port; i++) { await sleep(100); port = Number(output.match(/PORT=(\d+)/)?.[1]); }
  const reachable = port && await new Promise(resolve => {
    const req = http.get({ host: '127.0.0.1', port, timeout: 2000 }, res => {
      let body = ''; res.on('data', bytes => { body += bytes; }); res.on('end', () => resolve(body === 'preview-ok'));
    });
    req.on('error', () => resolve(false)); req.on('timeout', () => req.destroy());
  });
  record('host-preview', Boolean(reachable), { port });
  const cancelledAt = Date.now();
  controller.abort();
  const cancelled = await server;
  const heartbeat = path.join(workspace, 'heartbeat');
  await sleep(300);
  const first = fs.existsSync(heartbeat) ? fs.readFileSync(heartbeat, 'utf8') : null;
  await sleep(500);
  record('cancel-server', cancelled.state === 'cancelled' && first !== null && fs.readFileSync(heartbeat, 'utf8') === first && Date.now() - cancelledAt < 10000, cancelled);
  record('sentinels', fs.readFileSync(outside, 'utf8') === 'untouched' && fs.readFileSync(gitSentinel, 'utf8') === 'untouched');
  if (results.some(result => !result.passed)) process.exitCode = 1;
}
main().catch(error => { console.error(error); process.exitCode = 1; });
