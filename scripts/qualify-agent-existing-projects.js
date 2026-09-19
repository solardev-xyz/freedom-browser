#!/usr/bin/env node
'use strict';

// Run only on the designated disposable testing machine, using the matching
// Electron binary with ELECTRON_RUN_AS_NODE=1. All project roots are synthetic.
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { execFileSync } = require('child_process');
const { AgentManagedWorkspaceStore } = require('../src/main/agent/managed-workspace-store');
const { ManagedWorkspaceController } = require('../src/main/agent/managed-workspace-controller');
const { WorkspacePreviewController } = require('../src/main/agent/workspace-preview-controller');

async function main() {
  assert.equal(process.platform, 'darwin');
  assert.ok(process.versions.electron, 'Use the checkout Electron runtime');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-existing-project-qualification-'));
  const profile = path.join(temporary, 'profile');
  const project = path.join(temporary, 'Project ü with spaces');
  const outside = path.join(temporary, 'outside');
  for (const folder of [profile, project, outside]) fs.mkdirSync(folder);
  fs.writeFileSync(path.join(project, 'source.txt'), 'before\n');
  fs.writeFileSync(path.join(outside, 'canary.txt'), 'untouched\n');
  execFileSync('/usr/bin/git', ['init', '--quiet', project]);
  const configBefore = fs.readFileSync(path.join(project, '.git', 'config'));
  let store = new AgentManagedWorkspaceStore({ userDataDir: profile });
  let controller = new ManagedWorkspaceController({ store });
  let assertions = 0;
  const pass = (name) => { assertions++; process.stdout.write(JSON.stringify({ ok: true, name }) + '\n'); };
  try {
    const attached = await store.attachProject('project_one', project);
    assert.equal(attached.project.mode, 'read');
    assert.equal((await controller.readFile('project_one', 'source.txt')).toString(), 'before\n');
    await assert.rejects(controller.writeFile('project_one', 'source.txt', 'denied'), { code: 'PROJECT_READ_ONLY' });
    await assert.rejects(controller.execute('project_one', { command: 'printf denied > source.txt', timeoutMs: 3000 }), { code: 'PROJECT_READ_ONLY' });
    pass('read-only project reads successfully and refuses edits/commands');

    await controller.setProjectAccess('project_one', 'write');
    await controller.readFile('project_one', 'source.txt');
    fs.writeFileSync(path.join(project, 'source.txt'), 'changed outside Freedom\n');
    await assert.rejects(controller.writeFile('project_one', 'source.txt', 'stale'), { code: 'WORKSPACE_HISTORY_CHANGED' });
    assert.equal(fs.readFileSync(path.join(project, 'source.txt'), 'utf8'), 'changed outside Freedom\n');
    pass('external edits survive stale agent writes');
    await controller.readFile('project_one', 'source.txt');
    await controller.writeFile('project_one', 'source.txt', 'accepted\n');
    await controller.writeFile('project_one', 'created.txt', 'new file\n');
    await assert.rejects(controller.writeFile('project_one', 'created.txt', 'unread overwrite'), { code: 'WORKSPACE_HISTORY_CHANGED' });
    pass('reviewed writes and exclusive new-file creation');
    const changes = await controller.inspectWorkspace('project_one', { kind: 'changes' });
    assert.equal(changes.project, true);
    assert.equal(changes.changes.find((entry) => entry.path === 'source.txt').agentEdited, true);
    pass('project changes distinguish recorded direct Agent edits');

    fs.symlinkSync(path.join(outside, 'canary.txt'), path.join(project, 'escape.txt'));
    await assert.rejects(controller.readFile('project_one', 'escape.txt'));
    await assert.rejects(controller.writeFile('project_one', 'escape.txt', 'denied'));
    fs.linkSync(path.join(outside, 'canary.txt'), path.join(project, 'hardlink.txt'));
    await assert.rejects(controller.readFile('project_one', 'hardlink.txt'));
    fs.unlinkSync(path.join(project, 'hardlink.txt'));
    pass('external link escapes refused');

    const command = await controller.execute('project_one', { command: 'printf command > command.txt', timeoutMs: 3000 });
    assert.equal(command.state, 'completed'); assert.equal(command.exitCode, 0);
    const denied = await controller.execute('project_one', { command: 'printf bad > .git/config', timeoutMs: 3000 });
    assert.notEqual(denied.exitCode, 0);
    assert.deepEqual(fs.readFileSync(path.join(project, '.git', 'config')), configBefore);
    assert.equal(fs.readFileSync(path.join(outside, 'canary.txt'), 'utf8'), 'untouched\n');
    pass('commands write selected project while Git and outside canary stay intact');

    const review = await controller.reviewWorkspaceHistory('project_one', { action: 'review', path: 'source.txt' });
    await controller.reviewWorkspaceHistory('project_one', { action: 'checkpoint', reviewIds: [review.reviewId], label: 'Qualified edit' });
    const history = await controller.workspaceHistory('project_one', { action: 'list' });
    assert.equal(history.versions.length, 1);
    assert.equal(fs.existsSync(path.join(project, '.git', 'freedom-history')), false);
    assert.deepEqual(fs.readFileSync(path.join(project, '.git', 'config')), configBefore);
    pass('checkpoints live in private metadata, outside project Git');

    await controller.writeFile('project_one', 'index.html', '<h1>Existing project preview</h1>');
    const previews = new WorkspacePreviewController({ workspaceController: controller });
    const preview = await previews.createPreview('project_one', 'index.html');
    assert.match(await (await previews.handleRequest(new Request(preview.url))).text(), /Existing project preview/);
    pass('static previews read attached project files');

    const reservation = net.createServer();
    await new Promise((resolve, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', resolve); });
    const port = reservation.address().port;
    await new Promise((resolve) => reservation.close(resolve));
    await controller.writeFile('project_one', 'server.cjs',
      "const http = require('http'); const server = http.createServer((_req, res) => res.end('<h1>Attached dev server</h1>')); server.listen(Number(process.argv[2]), '127.0.0.1'); setTimeout(() => process.exit(0), 12000).unref();");
    const launch = `node server.cjs ${port}`;
    const permission = await controller.prepareCommandPermissions('project_one', { executables: ['node'], network: 'full' }, { command: launch, workingDirectory: '.' });
    assert.deepEqual(permission.unavailable, []);
    controller.grantCommandPermissions('project_one', permission.prepared, 'conversation');
    const running = await controller.startProcess('project_one', { command: launch, previewPort: port, yieldMs: 1000, timeoutMs: 10000 });
    assert.equal(running.state, 'running');
    const serverPreview = previews.createProcessPreview('project_one', running.processId);
    let serverText = '';
    for (let attempt = 0; attempt < 20; attempt++) {
      serverText = await (await previews.handleRequest(new Request(serverPreview.url))).text();
      if (serverText.includes('Attached dev server')) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.match(serverText, /Attached dev server/);
    pass('approved executable/network grants launch an attached-project dev server and isolated preview');

    await controller.setProjectAccess('project_one', 'remove');
    assert.notEqual((await previews.handleRequest(new Request(preview.url))).status, 200);
    assert.notEqual((await previews.handleRequest(new Request(serverPreview.url))).status, 200);
    await previews.dispose();
    await assert.rejects(controller.readFile('project_one', 'source.txt'), { code: 'PROJECT_RECONNECT_REQUIRED' });
    await controller.dispose(); store.close();
    store = new AgentManagedWorkspaceStore({ userDataDir: profile });
    controller = new ManagedWorkspaceController({ store });
    await assert.rejects(controller.readFile('project_one', 'source.txt'), { code: 'PROJECT_RECONNECT_REQUIRED' });
    await controller.setProjectAccess('project_one', 'reconnect', project);
    assert.equal((await controller.readFile('project_one', 'source.txt')).toString(), 'accepted\n');
    assert.equal(controller.getWorkspace('project_one').project.mode, 'read');
    await controller.deleteConversation('project_one');
    assert.equal(fs.readFileSync(path.join(project, 'source.txt'), 'utf8'), 'accepted\n');
    pass('revocation, restart, reconnection and conversation deletion preserve user files');

    const plain = path.join(temporary, 'no-git'); fs.mkdirSync(plain);
    fs.writeFileSync(path.join(plain, 'readme.txt'), 'plain');
    await store.attachProject('plain', plain);
    assert.equal((await controller.readFile('plain', 'readme.txt')).toString(), 'plain');
    await controller.setProjectAccess('plain', 'write');
    await controller.writeFile('plain', 'new.txt', 'new');
    const recorded = await controller.inspectWorkspace('plain', { kind: 'changes' });
    assert.equal(recorded.recordedEditsOnly, true);
    assert.deepEqual(recorded.changes.map((entry) => entry.path), ['new.txt']);
    const createGit = await controller.execute('plain', { command: 'mkdir .git', timeoutMs: 3000 });
    assert.notEqual(createGit.exitCode, 0);
    assert.equal(fs.existsSync(path.join(plain, '.git')), false);
    pass('non-Git project works without creating Git metadata');
    process.stdout.write(JSON.stringify({ ok: true, assertions, versions: process.versions }) + '\n');
  } finally {
    await controller.dispose(); store.close();
    assert.equal(fs.readFileSync(path.join(outside, 'canary.txt'), 'utf8'), 'untouched\n');
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
