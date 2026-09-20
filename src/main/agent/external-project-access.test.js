'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { ExternalProjectAccess } = require('./external-project-access');
const { AgentManagedWorkspaceStore } = require('./managed-workspace-store');

class SqliteAdapter {
  constructor(filename) { this.db = new (require('node:sqlite').DatabaseSync)(filename); }
  exec(sql) { this.db.exec(sql); }
  prepare(sql) { return this.db.prepare(sql); }
  close() { this.db.close(); }
  pragma(sql, options = {}) {
    const rows = this.db.prepare(`PRAGMA ${sql}`).all();
    return options.simple ? Object.values(rows[0])[0] : rows;
  }
}

describe('external project authority', () => {
  let temporary;
  let userDataDir;
  let project;
  let access;
  let store;
  beforeEach(() => {
    temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-project-access-'));
    userDataDir = path.join(temporary, 'profile');
    project = path.join(temporary, 'Project with spaces ü');
    fs.mkdirSync(userDataDir); fs.mkdirSync(project);
    fs.writeFileSync(path.join(project, 'existing.txt'), 'pre-existing changes');
    access = new ExternalProjectAccess({ userDataDir });
  });
  afterEach(() => { store?.close(); fs.rmSync(temporary, { recursive: true, force: true }); });

  test('defaults to read-only and revocation invalidates an already resolved grant', async () => {
    const identity = await access.identify(project);
    access.grant('one', identity);
    await expect(access.resolve('one')).resolves.toMatchObject({ mode: 'read' });
    await expect(access.resolve('one', { write: true })).rejects.toMatchObject({ code: 'PROJECT_READ_ONLY' });
    access.grant('one', identity, 'write');
    await expect(access.resolve('one', { write: true })).resolves.toMatchObject({ mode: 'write' });
    access.revoke('one');
    await expect(access.resolve('one')).rejects.toMatchObject({ code: 'PROJECT_RECONNECT_REQUIRED' });
  });

  test('rejects overlapping writer grants and profile ancestors', async () => {
    fs.mkdirSync(path.join(project, 'child'));
    access.grant('one', await access.identify(project), 'write');
    const child = await access.identify(path.join(project, 'child'));
    expect(() => access.grant('two', child)).toThrow('overlaps');
    await expect(access.identify(temporary)).rejects.toMatchObject({ code: 'PROJECT_UNSAFE' });
    await expect(access.identify(userDataDir)).rejects.toMatchObject({ code: 'PROJECT_UNSAFE' });
  });

  test('rejects a replaced directory even at the original path', async () => {
    access.grant('one', await access.identify(project));
    fs.renameSync(project, `${project}-moved`); fs.mkdirSync(project);
    await expect(access.resolve('one')).rejects.toMatchObject({ code: 'PROJECT_CHANGED' });
    expect(access.grants.size).toBe(0);
  });

  test('persists association without persisting authority or touching project Git/files', async () => {
    store = new AgentManagedWorkspaceStore({ userDataDir, Database: SqliteAdapter });
    const before = fs.statSync(project).mode;
    const workspace = await store.attachProject('conversation_one', project);
    expect(fs.readdirSync(await store.resolveHistoryPath(workspace.workspaceId))).toEqual([]);
    expect(workspace.project).toEqual({ name: path.basename(project), mode: 'read', connected: true });
    expect(JSON.stringify(workspace)).not.toContain(temporary);
    expect(await store.resolvePath(workspace.workspaceId)).toBe(fs.realpathSync(project));
    await store.setProjectAccess('conversation_one', 'write');
    store.close();
    expect(store.getForConversation('conversation_one').project.connected).toBe(false);
    await expect(store.resolvePath(workspace.workspaceId)).rejects.toMatchObject({ code: 'PROJECT_RECONNECT_REQUIRED' });
    await store.setProjectAccess('conversation_one', 'reconnect', project);
    expect(store.getForConversation('conversation_one').project.mode).toBe('read');
    await store.deleteConversation('conversation_one');
    expect(fs.readFileSync(path.join(project, 'existing.txt'), 'utf8')).toBe('pre-existing changes');
    expect(fs.readdirSync(project)).toEqual(['existing.txt']);
    expect(fs.statSync(project).mode).toBe(before);
  });

  test('reconnecting requires the original identity, not an arbitrary saved path', async () => {
    store = new AgentManagedWorkspaceStore({ userDataDir, Database: SqliteAdapter });
    await store.attachProject('conversation_one', project);
    await store.setProjectAccess('conversation_one', 'remove');
    const other = path.join(temporary, 'other'); fs.mkdirSync(other);
    await expect(store.setProjectAccess('conversation_one', 'reconnect', other)).rejects.toMatchObject({ code: 'PROJECT_CHANGED' });
    fs.renameSync(project, `${project}-moved`);
    await store.setProjectAccess('conversation_one', 'reconnect', `${project}-moved`);
    expect(store.getForConversation('conversation_one').project.connected).toBe(true);
  });

  test('failed overlapping attachment rolls back only its private metadata', async () => {
    store = new AgentManagedWorkspaceStore({ userDataDir, Database: SqliteAdapter });
    await store.attachProject('first', project);
    await store.setProjectAccess('first', 'write');
    await expect(store.attachProject('second', project)).rejects.toMatchObject({ code: 'PROJECT_IN_USE' });
    expect(store.getForConversation('second')).toBeNull();
    expect(store.getForConversation('first').project.connected).toBe(true);
    expect(fs.readFileSync(path.join(project, 'existing.txt'), 'utf8')).toBe('pre-existing changes');
  });

  test('conversation deletion preserves pending external commit recovery evidence', async () => {
    store = new AgentManagedWorkspaceStore({ userDataDir, Database: SqliteAdapter });
    const workspace = await store.attachProject('recovery', project);
    const privatePath = await store.resolveHistoryPath(workspace.workspaceId);
    fs.writeFileSync(path.join(privatePath, 'git-commit-pending.json'), '{"candidate":"retained"}');
    await store.deleteConversation('recovery');
    expect(store.getForConversation('recovery')).toBeNull();
    expect(fs.readFileSync(path.join(privatePath, 'git-commit-pending.json'), 'utf8')).toContain('retained');
    expect(store.projectAccess.grants.has(workspace.workspaceId)).toBe(false);
  });
});
