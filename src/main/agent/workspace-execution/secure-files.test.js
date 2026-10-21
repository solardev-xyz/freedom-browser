'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openedFilePath } = require('./opened-file-path');
const { removeSandboxTree } = require('./seatbelt-backend');
const { buildSeatbeltProfile, createPrivateDirectory } = require('./seatbelt-backend');
const { createWorkspaceExecutionPolicy } = require('./execution-policy');
const { spawnSync } = require('node:child_process');

let fixture;
beforeEach(async () => { fixture = await fs.promises.realpath(await fs.promises.mkdtemp(path.join(os.tmpdir(), 'freedom-secure-files-'))); });
afterEach(async () => { await fs.promises.rm(fixture, { recursive: true, force: true }); });

(process.platform === 'win32' ? test.skip : test)('kernel identity still identifies an outside file when its path is swapped back', async () => {
  const workspace = path.join(fixture, 'workspace');
  const outside = path.join(fixture, 'outside');
  await fs.promises.mkdir(workspace);
  await fs.promises.mkdir(outside);
  await fs.promises.writeFile(path.join(outside, 'note.txt'), 'outside sentinel');
  await fs.promises.symlink(outside, path.join(workspace, 'sub'));
  const handle = await fs.promises.open(path.join(workspace, 'sub/note.txt'), 'r');
  try {
    await fs.promises.unlink(path.join(workspace, 'sub'));
    await fs.promises.mkdir(path.join(workspace, 'sub'));
    await fs.promises.writeFile(path.join(workspace, 'sub/note.txt'), 'inside decoy');
    expect(await openedFilePath(handle)).toBe(path.join(outside, 'note.txt'));
  } finally { await handle.close(); }
});

(process.platform === 'darwin' ? test : test.skip)('restricted cleanup removes links without deleting their outside target, including a replaced root', async () => {
  const target = path.join(fixture, 'work');
  const outside = path.join(fixture, 'outside');
  await fs.promises.mkdir(target);
  await fs.promises.mkdir(outside);
  await fs.promises.writeFile(path.join(outside, 'sentinel.txt'), 'preserved');
  await fs.promises.symlink(outside, path.join(target, 'link'));
  await removeSandboxTree(target);
  expect(await fs.promises.readFile(path.join(outside, 'sentinel.txt'), 'utf8')).toBe('preserved');
  await fs.promises.symlink(outside, target);
  await removeSandboxTree(target).catch(() => {});
  expect(await fs.promises.readFile(path.join(outside, 'sentinel.txt'), 'utf8')).toBe('preserved');
});

(process.platform === 'darwin' ? test : test.skip)('the production missing-Git deny protects alternate-case names', async () => {
  for (const [index, name] of ['.git', '.GIT', '.Git', '.gIT'].entries()) {
    const workspace = path.join(fixture, `workspace-${index}`);
    const temporary = await createPrivateDirectory();
    await fs.promises.mkdir(workspace);
    try {
      const policy = await createWorkspaceExecutionPolicy({ workspaceRoot: workspace, allowMissingGitMetadata: true });
      const result = spawnSync('/usr/bin/sandbox-exec', ['-p', buildSeatbeltProfile(policy, temporary),
        '/bin/sh', '-c', `printf control > ordinary.txt; mkdir '${name}'`],
      { cwd: workspace, env: { PATH: '/usr/bin:/bin' }, timeout: 5000 });
      expect(await fs.promises.readFile(path.join(workspace, 'ordinary.txt'), 'utf8')).toBe('control');
      expect(result.status).not.toBe(0);
      expect(fs.existsSync(path.join(workspace, name))).toBe(false);
    } finally { await removeSandboxTree(temporary); }
  }
});
