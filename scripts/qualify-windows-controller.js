#!/usr/bin/env node
'use strict';

// Run with ELECTRON_RUN_AS_NODE=1 in a standard Windows desktop session.
// The profile and fixtures are synthetic and retained for inspection.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { parseArgs } = require('node:util');
const { values } = parseArgs({ options: { root: { type: 'string' }, 'app-root': { type: 'string' } } });
async function main() {
  assert.equal(process.platform, 'win32');
  assert.ok(process.versions.electron, 'Use Electron with ELECTRON_RUN_AS_NODE=1');
  assert.ok(values.root && path.isAbsolute(values.root));
  const application = values['app-root'] ? path.resolve(values['app-root']) : path.resolve(__dirname, '..');
  const { AgentManagedWorkspaceStore } = require(path.join(application, 'src/main/agent/managed-workspace-store'));
  const { ManagedWorkspaceController } = require(path.join(application, 'src/main/agent/managed-workspace-controller'));
  fs.mkdirSync(values.root, { recursive: true });
  const profile = fs.mkdtempSync(path.join(values.root, 'controller-'));
  const store = new AgentManagedWorkspaceStore({ userDataDir: profile });
  const controller = new ManagedWorkspaceController({ store, runtimeOptions: { resourcesPath: path.join(path.dirname(process.execPath), 'resources') } });
  const record = (name, details) => {
    const line = JSON.stringify({ name, ...details });
    console.log(line);
    fs.appendFileSync(path.join(profile, 'results.jsonl'), `${line}\n`);
  };
  try {
    record('fixture', { profile });
    const capabilities = await controller.getCapabilities();
    record('capabilities', capabilities);
    assert.ok(capabilities.available && !capabilities.setupRequired);
    await controller.enable('windows-qualification');
    record('enabled', { passed: true });
    await controller.writeFile('windows-qualification', 'index.html', '<h1>Freedom Windows</h1>');
    assert.equal((await controller.readFile('windows-qualification', 'index.html')).toString(), '<h1>Freedom Windows</h1>');
    record('file-round-trip', { passed: true });
    await controller.writeFile('windows-qualification', 'large.txt', 'x'.repeat(65536));
    assert.equal((await controller.readFile('windows-qualification', 'large.txt')).length, 65536);
    record('maximum-file-round-trip', { passed: true });
    const longCommand = "Write-Output 'Grüße'\n#" + 'x'.repeat(30000);
    const longResult = await controller.execute('windows-qualification', { command: longCommand });
    assert.equal(longResult.state, 'completed');
    assert.match(longResult.stdout, /Grüße/);
    record('long-unicode-command', { passed: true });
    await controller.writeFile('windows-qualification', 'package.json', JSON.stringify({ name: 'freedom-windows-test', private: true, scripts: { build: 'node build.cjs' } }));
    await controller.writeFile('windows-qualification', 'build.cjs', "require('fs').writeFileSync('built.txt', 'built'); console.log('build-ok')");
    const command = 'npm.cmd run build';
    const permission = await controller.prepareCommandPermissions('windows-qualification', { executables: ['node', 'npm'] }, { command });
    controller.grantCommandPermissions('windows-qualification', permission.prepared);
    const build = await controller.execute('windows-qualification', { command });
    record('powershell-build', build);
    assert.equal(build.state, 'completed');
    assert.equal((await controller.readFile('windows-qualification', 'built.txt')).toString(), 'built');

    const review = await controller.reviewWorkspaceHistory('windows-qualification', { action: 'review', path: 'index.html' });
    const commit = await controller.reviewWorkspaceHistory('windows-qualification', { action: 'checkpoint', label: 'Windows qualification', reviewIds: [review.reviewId] });
    record('checkpoint', commit);
    const history = await controller.workspaceHistory('windows-qualification', { action: 'list' });
    record('history', history);
    await controller.writeFile('windows-qualification', 'server.cjs', "const h=require('http').createServer((q,r)=>r.end('windows-preview'));h.listen(0,'127.0.0.1',()=>console.log('PORT='+h.address().port));process.stdin.on('data',b=>console.log('INPUT='+b.toString().trim()));");
    const launch = 'node server.cjs';
    const serverPermission = await controller.prepareCommandPermissions('windows-qualification', { executables: ['node'], network: 'full' }, { command: launch });
    controller.grantCommandPermissions('windows-qualification', serverPermission.prepared);
    let server = await controller.startProcess('windows-qualification', { command: launch, yieldMs: 1000, timeoutMs: 30000 });
    let output = server.output || '';
    for (let i = 0; i < 10 && !/PORT=\d+/.test(output); i++) {
      server = await controller.interactProcess('windows-qualification', server.processId, { waitMs: 1000 });
      output += server.output || '';
    }
    const port = Number(output.match(/PORT=(\d+)/)?.[1]);
    assert.ok(port, 'Preview server must report its port');
    assert.equal(await (await fetch(`http://127.0.0.1:${port}`)).text(), 'windows-preview');
    const input = await controller.interactProcess('windows-qualification', server.processId, { input: 'hello\n', waitMs: 1000 });
    assert.match(input.output, /INPUT=hello/);
    await controller.terminateProcess('windows-qualification', server.processId);
    await assert.rejects(fetch(`http://127.0.0.1:${port}`, { signal: AbortSignal.timeout(2000) }));
    record('preview-stdin-and-stop', { passed: true });
    // External projects must be outside the browser profile, just as a folder
    // selected by the user would be. AppData itself is intentionally rejected.
    const external = fs.mkdtempSync(path.join(values.root, 'external-project-'));
    require('node:child_process').execFileSync('git', ['init', '--quiet', external]);
    fs.writeFileSync(path.join(external, 'README.md'), 'External project fixture');
    await store.attachProject('external-qualification', external);
    await controller.enable('external-qualification');
    assert.equal((await controller.readFile('external-qualification', 'README.md')).toString(), 'External project fixture');
    await assert.rejects(controller.writeFile('external-qualification', 'README.md', 'denied'), { code: 'PROJECT_READ_ONLY' });
    record('external-read-only', { passed: true });
    await controller.setProjectAccess('external-qualification', 'write', external);
    await controller.readFile('external-qualification', 'README.md');
    await controller.writeFile('external-qualification', 'README.md', 'Reviewed external edit');
    assert.equal(fs.readFileSync(path.join(external, 'README.md'), 'utf8'), 'Reviewed external edit');
    record('external-approved-write', { passed: true });

  } catch (error) {
    record('failure', { message: error.message, code: error.code, stack: error.stack });
    process.exitCode = 1;
  } finally {
    await controller.dispose();
    store.close();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
