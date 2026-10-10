#!/usr/bin/env node
'use strict';

// Run with ELECTRON_RUN_AS_NODE=1 in a standard Windows desktop session.
// The profile and fixtures are synthetic and retained for inspection.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { parseArgs } = require('node:util');
const { AgentManagedWorkspaceStore } = require('../src/main/agent/managed-workspace-store');
const { ManagedWorkspaceController } = require('../src/main/agent/managed-workspace-controller');
const { values } = parseArgs({ options: { root: { type: 'string' } } });
async function main() {
  assert.equal(process.platform, 'win32');
  assert.ok(process.versions.electron, 'Use Electron with ELECTRON_RUN_AS_NODE=1');
  assert.ok(values.root && path.isAbsolute(values.root));
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
    const review = await controller.reviewWorkspaceHistory('windows-qualification', { action: 'review', path: 'index.html' });
    const commit = await controller.reviewWorkspaceHistory('windows-qualification', { action: 'checkpoint', label: 'Windows qualification', reviewIds: [review.reviewId] });
    record('checkpoint', commit);
    const history = await controller.workspaceHistory('windows-qualification', { action: 'list' });
    record('history', history);
  } catch (error) {
    record('failure', { message: error.message, code: error.code, stack: error.stack });
    process.exitCode = 1;
  } finally {
    await controller.dispose();
    store.close();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
