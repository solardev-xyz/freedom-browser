'use strict';
// Pure recovery protocol tests; native Git fault fixtures stay on the Mac mini.
const fs = require('fs');
const crypto = require('crypto');
const { ExternalProjectGit } = require('./external-project-git');
const digest = value => crypto.createHash('sha256').update(value).digest('hex');

describe('external commit recovery protocol', () => {
  let service, record, current, lock, inode, rename, controller;
  beforeEach(() => {
    controller = new AbortController(); lock = Buffer.from('prepared index'); inode = 42;
    record = { root: '/fixture', candidate: 'a'.repeat(40), baseline: { id: 'b'.repeat(40), head: 'ref: refs/heads/main\n', index: digest('original index') }, preparedIndex: digest(lock), indexLock: { dev: 1, ino: 42, birthtimeMs: 1, ctimeMs: 2 } };
    current = { ...record.baseline, id: record.candidate };
    service = new ExternalProjectGit('/fixture', { temporaryRoot: '/private-fixture', authorize: jest.fn(async () => {}), signal: controller.signal, globalConfigFiles: [] });
    service.validate = jest.fn(async () => true); service.checkMetadataIdentity = jest.fn(async () => {});
    service.baseline = jest.fn(async () => ({ ...current }));
    service.read = jest.fn(async name => name.endsWith('git-commit-pending.json') ? Buffer.from(JSON.stringify(record)) : name.endsWith('index.lock') ? lock : null);
    jest.spyOn(fs.promises, 'lstat').mockResolvedValue({ dev: 1, birthtimeMs: 1, ctimeMs: 2, get ino() { return inode; } });
    jest.spyOn(fs, 'existsSync').mockImplementation(name => name.endsWith('index.lock') && Boolean(lock));
    rename = jest.spyOn(fs.promises, 'rename').mockResolvedValue();
  });
  afterEach(() => jest.restoreAllMocks());
  test('inspection is read-only; confirmed repair finalizes only the index and archives evidence', async () => {
    const state = await service.recovery(); expect(state).toMatchObject({ pending: true, state: 'committed', repairable: true });
    expect(rename).not.toHaveBeenCalled();
    await expect(service.repairCommit(state.token)).resolves.toMatchObject({ repaired: true, id: record.candidate });
    expect(rename).toHaveBeenCalledWith('/fixture/.git/index.lock', '/fixture/.git/index');
    expect(rename).toHaveBeenCalledWith('/private-fixture/git-commit-pending.json', expect.stringMatching(/git-commit-recovered-/));
    expect(rename).toHaveBeenCalledTimes(2); expect(service.authorize).toHaveBeenCalledWith(true);
  });
  test.each(['branch', 'index', 'lock', 'token', 'permission', 'cancel'])('refuses changed %s without mutating anything', async change => {
    const state = await service.recovery();
    if (change === 'branch') current.head = 'ref: refs/heads/other\n';
    if (change === 'index') current.index = digest('new user staging');
    if (change === 'lock') inode = 43;
    if (change === 'permission') service.authorize.mockRejectedValue(Object.assign(new Error('Read only'), { code: 'PROJECT_READ_ONLY' }));
    if (change === 'cancel') controller.abort();
    await expect(service.repairCommit(change === 'token' ? '0'.repeat(64) : state.token)).rejects.toThrow();
    expect(rename).not.toHaveBeenCalled();
  });
  test('rechecks immediately before finalization and declines changed state', async () => {
    const state = await service.recovery();
    service.authorize.mockImplementation(async write => { if (write) { current.index = digest('concurrent staging'); } });
    await expect(service.repairCommit(state.token)).rejects.toThrow(); expect(rename).not.toHaveBeenCalled();
  });
  test('recognizes an already finalized index without rewriting it', async () => {
    lock = null; current.index = record.preparedIndex;
    const state = await service.recovery(); expect(state.repairable).toBe(true);
    await service.repairCommit(state.token); expect(rename).toHaveBeenCalledTimes(1);
    expect(rename.mock.calls[0][0]).toBe('/private-fixture/git-commit-pending.json');
  });
  test('refuses leftover branch locks without deleting them or reporting repair complete', async () => {
    current.id = record.baseline.id;
    fs.existsSync.mockImplementation(name => name.endsWith('index.lock') || name.endsWith('refs/heads/main.lock'));
    expect(await service.recovery()).toMatchObject({ state: 'not_applied', repairable: false });
    expect(rename).not.toHaveBeenCalled();
  });

  test('refuses a reused inode with different creation or modification time', async () => {
    const state = await service.recovery();
    fs.promises.lstat.mockResolvedValue({ dev: 1, ino: 42, birthtimeMs: 9, ctimeMs: 10 });
    await expect(service.repairCommit(state.token)).rejects.toThrow('changed');
    expect(rename).not.toHaveBeenCalled();
  });

  test('retries private-journal cleanup after an unapplied owned lock was already released', async () => {
    current.id = record.baseline.id;
    const unlink = jest.spyOn(fs.promises, 'unlink').mockImplementation(async () => { lock = null; });
    const state = await service.recovery();
    rename.mockRejectedValueOnce(new Error('interrupted archive'));
    await expect(service.repairCommit(state.token)).rejects.toThrow('interrupted archive');
    expect(unlink).toHaveBeenCalledWith('/fixture/.git/index.lock');
    const retry = await service.recovery();
    expect(retry).toMatchObject({ state: 'not_applied', repairable: true });
    await service.repairCommit(retry.token);
    expect(unlink).toHaveBeenCalledTimes(1);
    expect(rename.mock.calls.every(([from]) => from === '/private-fixture/git-commit-pending.json')).toBe(true);
  });

  test('allows exact baseline cleanup but leaves uncertain branch states for reconciliation', async () => {
    current.id = record.baseline.id; expect(await service.recovery()).toMatchObject({ state: 'not_applied', repairable: true });
    current.id = 'c'.repeat(40); expect(await service.recovery()).toMatchObject({ state: 'uncertain', repairable: false });
  });
});
