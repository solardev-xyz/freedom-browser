'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openedFilePath, checkedWorkspaceRoot } = require('./opened-file-path');
const { removeSandboxTree } = require('./seatbelt-backend');
const { buildSeatbeltProfile, createPrivateDirectory } = require('./seatbelt-backend');
const { createWorkspaceExecutionPolicy } = require('./execution-policy');
const { spawnSync } = require('node:child_process');
const { raceCleanup, racerNames } = require('./__tests__/cleanup-racer');

let fixture;
beforeEach(async () => { fixture = await fs.promises.realpath(await fs.promises.mkdtemp(path.join(os.tmpdir(), 'freedom-secure-files-'))); });
afterEach(async () => { await fs.promises.rm(fixture, { recursive: true, force: true }); });

test.each([
  ['publication', require('../managed-workspace-source-reader').readRegularFile, 'WORKSPACE_PUBLICATION_UNSAFE'],
  ['preview', (root, file) => require('../workspace-preview-controller').readRegularFile(root, file), 'WORKSPACE_PREVIEW_UNSAFE'],
])('%s refuses root replacement during canonicalization', async (_name, read, code) => {
  const root = path.join(fixture, 'root'), moved = path.join(fixture, 'moved'), outside = path.join(fixture, 'outside');
  await fs.promises.mkdir(root); await fs.promises.mkdir(outside);
  await fs.promises.writeFile(path.join(root, 'note.txt'), 'inside');
  await fs.promises.writeFile(path.join(outside, 'note.txt'), 'outside sentinel');
  const realpath = fs.promises.realpath.bind(fs.promises);
  let swapped = false;
  const spy = jest.spyOn(fs.promises, 'realpath').mockImplementation(async candidate => {
    if (candidate === root && !swapped) {
      swapped = true;
      await fs.promises.rename(root, moved);
      await fs.promises.symlink(outside, root, process.platform === 'win32' ? 'junction' : 'dir');
    }
    return realpath(candidate);
  });
  try { await expect(read(root, 'note.txt', 1024)).rejects.toMatchObject({ code }); }
  finally { spy.mockRestore(); }
  expect(await fs.promises.readFile(path.join(outside, 'note.txt'), 'utf8')).toBe('outside sentinel');
});

test('an authorized root identity rejects a replacement ordinary directory', async () => {
  const root = path.join(fixture, 'root');
  await fs.promises.mkdir(root);
  const identity = await checkedWorkspaceRoot(root);
  await fs.promises.rename(root, path.join(fixture, 'moved'));
  await fs.promises.mkdir(root);
  await expect(checkedWorkspaceRoot(root, identity)).rejects.toMatchObject({ code: 'WORKSPACE_ROOT_CHANGED' });
});

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

// S1 under an active race: a surviving process keeps swapping `work/sub`
// between a real directory and a link to `outside` for as long as the cleanup
// runs. The write-confined `rm` may fail while the tree keeps refilling, but it
// must never delete through the link. `gate` keeps an attempt from removing the
// whole tree inside one of the racer's idle holds, before any swap: that ended
// the race with `overlapped: false` now and then (#843), the outside files
// untouched.
(process.platform === 'darwin' ? test : test.skip)('restricted cleanup keeps the outside target while a surviving process swaps a subdirectory for a link', async () => {
  const report = await raceCleanup({
    target: path.join(fixture, 'work'),
    outside: path.join(fixture, 'outside'),
    names: racerNames(),
    cleanup: removeSandboxTree,
    gate: true,
  });
  expect(report).toMatchObject({ overlapped: true, preserved: true, removed: true, missing: [] });
}, 60_000);

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
