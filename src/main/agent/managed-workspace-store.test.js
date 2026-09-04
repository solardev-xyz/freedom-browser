'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const FakeDatabase = require('../../../test/helpers/fake-better-sqlite3-workspaces');
const {
  AgentManagedWorkspaceStore,
  DB_FILE,
  WORKSPACE_DIRECTORY,
} = require('./managed-workspace-store');

describe('AgentManagedWorkspaceStore', () => {
  let userDataDir;
  let store;
  let now;
  let commandIndex;

  beforeEach(() => {
    FakeDatabase.reset();
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-managed-workspace-'));
    now = 1_000;
    commandIndex = 0;
    store = new AgentManagedWorkspaceStore({
      userDataDir,
      now: () => now,
      workspaceIdFactory: () => 'workspace_aaaaaaaaaaaaaaaaaaaa',
      commandIdFactory: () => {
        commandIndex += 1;
        return `workspace_cmd_${'b'.repeat(23)}${commandIndex}`;
      },
      Database: FakeDatabase,
    });
  });

  afterEach(() => {
    store.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  });

  test('creates one private persistent workspace per conversation', async () => {
    const created = await store.ensureForConversation('conversation_one');
    const workspacePath = path.join(
      userDataDir,
      WORKSPACE_DIRECTORY,
      'workspace_aaaaaaaaaaaaaaaaaaaa'
    );

    expect(created).toEqual({
      workspaceId: 'workspace_aaaaaaaaaaaaaaaaaaaa',
      conversationId: 'conversation_one',
      enabled: false,
      backend: '',
      createdAt: 1_000,
      updatedAt: 1_000,
    });
    expect(await store.ensureForConversation('conversation_one')).toEqual(created);
    expect(await store.resolvePath(created.workspaceId)).toBe(fs.realpathSync(workspacePath));
    expect(fs.statSync(workspacePath).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(workspacePath, '.git')).isDirectory()).toBe(true);
    expect(store.getDb().name).toBe(path.join(userDataDir, DB_FILE));
  });

  test('persists bounded command receipts and marks abandoned work as interrupted', async () => {
    const workspace = await store.ensureForConversation('conversation_one');
    now = 1_100;
    expect(
      store.enable(workspace.workspaceId, 'conversation_one', 'linux-bubblewrap')
    ).toMatchObject({
      enabled: true,
      backend: 'linux-bubblewrap',
    });
    const completedCommandId = store.startCommand({
      workspaceId: workspace.workspaceId,
      conversationId: 'conversation_one',
      command: 'printf hello',
      workingDirectory: '.',
      backend: 'linux-bubblewrap',
      networkPosture: 'full',
      startedAt: 1_200,
    });
    expect(
      store.finishCommand(completedCommandId, workspace.workspaceId, {
        state: 'completed',
        finishedAt: 1_300,
        durationMs: 100,
        exitCode: 0,
        stdout: 'x'.repeat(70_000),
        stderr: '',
        stdoutTruncated: true,
        stderrTruncated: false,
        terminationGuarantee: 'namespace_scoped',
        sideEffects: 'unknown',
        networkPosture: 'full',
      })
    ).toBe(true);
    const interruptedCommandId = store.startCommand({
      workspaceId: workspace.workspaceId,
      conversationId: 'conversation_one',
      command: 'sleep 100',
      workingDirectory: '.',
      backend: 'linux-bubblewrap',
      networkPosture: 'none',
      startedAt: 1_400,
    });
    now = 1_500;
    expect(store.markStaleRunningAsInterrupted()).toBe(1);
    expect(store.listCommands('conversation_one')).toEqual([
      expect.objectContaining({
        commandId: interruptedCommandId,
        state: 'interrupted',
        durationMs: 100,
        sideEffects: 'unknown',
        error: expect.objectContaining({ code: 'WORKSPACE_EXECUTION_INTERRUPTED' }),
      }),
      expect.objectContaining({
        commandId: completedCommandId,
        state: 'completed',
        durationMs: 100,
        stdout: 'x'.repeat(65_536),
        stdoutTruncated: true,
        networkPosture: 'full',
      }),
    ]);

    store.close();
    store = new AgentManagedWorkspaceStore({
      userDataDir,
      now: () => now,
      Database: FakeDatabase,
    });
    expect(store.getForConversation('conversation_one')).toMatchObject({
      workspaceId: workspace.workspaceId,
      enabled: true,
    });
  });

  test('removes only the exact managed workspace when its conversation is deleted', async () => {
    const workspace = await store.ensureForConversation('conversation_one');
    const workspacePath = await store.resolvePath(workspace.workspaceId);
    const sibling = path.join(userDataDir, WORKSPACE_DIRECTORY, 'keep-me');
    fs.mkdirSync(sibling);

    await expect(store.deleteConversation('conversation_one')).resolves.toBe(true);

    expect(fs.existsSync(workspacePath)).toBe(false);
    expect(fs.existsSync(sibling)).toBe(true);
    expect(store.getForConversation('conversation_one')).toBeNull();
  });
});
