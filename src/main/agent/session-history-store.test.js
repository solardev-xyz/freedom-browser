'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const FakeDatabase = require('../../../test/helpers/fake-better-sqlite3-agent-history');

jest.mock('better-sqlite3', () =>
  require('../../../test/helpers/fake-better-sqlite3-agent-history')
);

const { AgentSessionHistoryStore, DB_FILE, normalizeActivity } = require('./session-history-store');

test('retains complete helper text without runtime objects or extra fields', () => {
  const [item] = normalizeActivity([{ operation: 'delegate_task', status: 'succeeded', subagent: {
    taskId: `delegate_${'a'.repeat(24)}`, title: 'Review', state: 'completed', toolCalls: 3, toolScripts: 2,
    report: 'x'.repeat(13000), credential: 'not persisted', session: { live: true },
  } }]);
  expect(item.subagent.report.length).toBe(13000);
  expect(item.subagent.toolCalls).toBe(3);
  expect(item.subagent.toolScripts).toBe(2);
  expect(item.subagent.credential).toBeUndefined();
  expect(item.subagent.session).toBeUndefined();
});

test('retains individual parallel reports and rejects oversized or duplicate receipt collections', () => {
  const a = { taskId: `delegate_${'a'.repeat(24)}`, title: 'First', state: 'completed', report: 'First report' };
  const b = { ...a, taskId: `delegate_${'b'.repeat(24)}`, title: 'Second', state: 'cancelled', report: '' };
  const item = subagents => normalizeActivity([{ operation: 'delegate_task', subagents }])[0];
  expect(item([a, b]).subagents.map(receipt => receipt.state)).toEqual(['completed', 'cancelled']);
  expect(item([a, a]).subagents).toBeUndefined();
  expect(item([a, b, a]).subagents).toBeUndefined();
  const batch = Array.from({ length: 6 }, (_, i) => ({ ...a, taskId: `delegate_${String(i).repeat(24)}`, title: `Topic ${i}` }));
  expect(item(batch).subagents).toHaveLength(6);
  expect(item([...batch, { ...a, taskId: `delegate_${'f'.repeat(24)}` }]).subagents).toBeUndefined();
});

test('reviewer approval provenance survives history normalization without its private decision data', () => {
  const [item] = normalizeActivity([{ operation: 'request_permissions', approval: 'reviewer_approved',
    status: 'succeeded', reviewer: { reason: 'private review', root: '/private/path' }, isCurrent: () => true }]);
  expect(item.approval).toBe('reviewer_approved');
  expect(JSON.stringify(item)).not.toMatch(/private|isCurrent/);
});

describe('AgentSessionHistoryStore', () => {
  let userDataDir;
  let store;
  let now;

  beforeEach(() => {
    FakeDatabase.reset();
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-agent-history-'));
    now = 1_000;
    store = new AgentSessionHistoryStore({ userDataDir, now: () => now });
  });

  afterEach(() => {
    store.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  });

  test('persists profile-local sessions and visible turn history across store instances', () => {
    store.createSession({
      conversationId: 'conversation_one',
      title: 'Research Freedom',
      approvalMode: 'every_interaction',
      providerId: 'openai-codex',
      modelId: 'gpt-test',
      thinkingLevel: 'high',
      createdAt: 900,
    });
    store.startTurn({
      conversationId: 'conversation_one',
      runId: 'run_one',
      position: 0,
      userText: 'Research Freedom',
      approvalMode: 'every_interaction',
      attachments: [
        {
          resourceId: 'attachment_aaaaaaaaaaaaaaaaaaaa',
          kind: 'file',
          name: 'notes.txt',
          bytes: 24,
          mimeType: 'text/plain',
          category: 'text',
          available: true,
          path: '/Users/private/notes.txt',
        },
      ],
      startedAt: 900,
    });
    store.updateTurnGuidance({
      conversationId: 'conversation_one',
      runId: 'run_one',
      guidance: [
        {
          guidanceId: 'guidance_one',
          text: 'Prefer primary sources',
          status: 'applied',
          createdAt: 1_000,
          ignored: 'not persisted',
        },
      ],
    });
    now = 1_250;
    store.finishTurn({
      conversationId: 'conversation_one',
      runId: 'run_one',
      assistantText: 'Done.',
      status: 'completed',
      durationMs: 350,
      activity: [
        {
          toolCallId: 'call_1',
          operation: 'browser_snapshot',
          status: 'succeeded',
          label: 'Read https://example.test',
          pageTitle: 'Example article',
          intent: 'Reading https://example.test',
          effect: 'observed',
          approval: 'approved',
          origin: 'https://example.test',
          destinationOrigin: 'https://submit.example/private?token=secret',
          pageId: 'tab_1',
          pageCount: 1,
          artifact: {
            artifactId: 'artifact_1234567890abcdef1234',
            filename: 'report.pdf',
            bytes: 2048,
            state: 'completed',
            sourceOrigin: 'https://files.example/private?token=secret',
            location: 'downloads',
            available: true,
            savePath: '/Users/private/report.pdf',
          },
          pageText: 'not persisted',
        },
        {
          toolCallId: 'call_upload',
          operation: 'browser_upload',
          status: 'succeeded',
          label: 'Attached résumé.pdf',
          effect: 'changed',
          origin: 'https://submit.example',
          upload: {
            filename: 'résumé.pdf',
            bytes: 4096,
            mimeType: 'application/pdf',
            state: 'attached',
            path: '/Users/private/Documents/résumé.pdf',
          },
        },
        {
          toolCallId: 'call_lifecycle',
          operation: 'node_lifecycle',
          status: 'succeeded',
          label: 'Restarted ipfs — running',
          effect: 'changed',
          nodeLifecycle: {
            service: 'ipfs',
            action: 'restart',
            beforeState: 'running',
            afterState: 'running',
            verified: true,
            rawStatus: { endpoint: 'http://127.0.0.1:secret' },
          },
        },
        {
          toolCallId: 'call_node_request',
          operation: 'node_request',
          status: 'succeeded',
          label: 'Requested POST /stamps/100/20 — still running',
          effect: 'changed',
          nodeRequest: {
            operationId: 'node_op_aaaaaaaaaaaaaaaaaaaaaaaa',
            state: 'in_flight',
            retrySafety: 'unsafe',
            service: 'ant',
            method: 'POST',
            path: '/stamps/100/20',
            effect: 'financial',
            body: '{"secret":"not persisted"}',
          },
        },
        {
          toolCallId: 'call_attachment',
          operation: 'attachment_read',
          status: 'succeeded',
          label: 'Read report.json',
          effect: 'observed',
          attachment: {
            action: 'read',
            resourceId: 'folder_bbbbbbbbbbbbbbbbbbbb',
            resourceKind: 'folder',
            name: 'report.json',
            folderName: 'Bug reports',
            relativePath: 'report.json',
            bytesRead: 2048,
            offset: 0,
            truncated: false,
            sourcePath: '/Users/private/Bug reports/report.json',
          },
        },
      ],
      guidance: [
        {
          guidanceId: 'guidance_one',
          text: 'Prefer primary sources',
          status: 'applied',
          createdAt: 1_000,
        },
      ],
    });
    store.close();

    store = new AgentSessionHistoryStore({ userDataDir, now: () => now });
    expect(store.listSessions()).toEqual([
      expect.objectContaining({
        conversationId: 'conversation_one',
        title: 'Research Freedom',
        status: 'ready',
        turnCount: 1,
      }),
    ]);
    const restored = store.getSession('conversation_one');
    expect(restored).toMatchObject({
      providerId: 'openai-codex',
      modelId: 'gpt-test',
      transcript: [
        {
          runId: 'run_one',
          userText: 'Research Freedom',
          assistantText: 'Done.',
          status: 'completed',
          approvalMode: 'every_interaction',
          durationMs: 350,
          attachments: [
            {
              resourceId: 'attachment_aaaaaaaaaaaaaaaaaaaa',
              kind: 'file',
              name: 'notes.txt',
              bytes: 24,
              mimeType: 'text/plain',
              category: 'text',
              available: true,
            },
          ],
          activity: [
            {
              toolCallId: 'call_1',
              operation: 'browser_snapshot',
              status: 'succeeded',
              label: 'Read https://example.test',
              pageTitle: 'Example article',
              intent: 'Reading https://example.test',
              effect: 'observed',
              approval: 'approved',
              origin: 'https://example.test',
              destinationOrigin: 'https://submit.example',
              pageId: 'tab_1',
              pageCount: 1,
              artifact: {
                artifactId: 'artifact_1234567890abcdef1234',
                filename: 'report.pdf',
                bytes: 2048,
                state: 'completed',
                sourceOrigin: 'https://files.example',
                location: 'downloads',
                available: true,
              },
            },
            {
              toolCallId: 'call_upload',
              operation: 'browser_upload',
              status: 'succeeded',
              label: 'Attached résumé.pdf',
              effect: 'changed',
              origin: 'https://submit.example',
              upload: {
                filename: 'résumé.pdf',
                bytes: 4096,
                mimeType: 'application/pdf',
                state: 'attached',
              },
            },
            {
              toolCallId: 'call_lifecycle',
              operation: 'node_lifecycle',
              status: 'succeeded',
              label: 'Restarted ipfs — running',
              effect: 'changed',
              nodeLifecycle: {
                service: 'ipfs',
                action: 'restart',
                beforeState: 'running',
                afterState: 'running',
                verified: true,
              },
            },
            {
              toolCallId: 'call_node_request',
              operation: 'node_request',
              status: 'succeeded',
              label: 'Requested POST /stamps/100/20 — still running',
              effect: 'changed',
              nodeRequest: {
                operationId: 'node_op_aaaaaaaaaaaaaaaaaaaaaaaa',
                state: 'in_flight',
                retrySafety: 'unsafe',
                service: 'ant',
                method: 'POST',
                path: '/stamps/100/20',
                effect: 'financial',
              },
            },
            {
              toolCallId: 'call_attachment',
              operation: 'attachment_read',
              status: 'succeeded',
              label: 'Read report.json',
              effect: 'observed',
              attachment: {
                action: 'read',
                resourceId: 'folder_bbbbbbbbbbbbbbbbbbbb',
                resourceKind: 'folder',
                name: 'report.json',
                folderName: 'Bug reports',
                relativePath: 'report.json',
                bytesRead: 2048,
                offset: 0,
                truncated: false,
              },
            },
          ],
          guidance: [
            {
              guidanceId: 'guidance_one',
              text: 'Prefer primary sources',
              status: 'applied',
              createdAt: 1_000,
            },
          ],
        },
      ],
    });
    expect(JSON.stringify(restored)).not.toContain('/Users/private');
    expect(store.getDb().filePath).toBe(path.join(userDataDir, DB_FILE));
  });

  test('updates terminal turn activity without changing its status', () => {
    store.createSession({
      conversationId: 'conversation_one',
      title: 'Run server',
      approvalMode: 'every_interaction',
    });
    store.startTurn({
      conversationId: 'conversation_one',
      runId: 'run_one',
      userText: 'Run the server',
      approvalMode: 'every_interaction',
    });
    expect(
      store.updateTurnActivity({
        conversationId: 'conversation_one',
        runId: 'run_one',
        activity: [],
      })
    ).toBe(false);
    store.finishTurn({
      conversationId: 'conversation_one',
      runId: 'run_one',
      assistantText: 'Server started.',
      status: 'completed',
      activity: [],
    });
    now = 2_000;

    expect(
      store.updateTurnActivity({
        conversationId: 'conversation_one',
        runId: 'run_one',
        activity: [
          {
            toolCallId: 'call_server',
            operation: 'bash',
            status: 'succeeded',
            label: 'Ran node server.js',
            intent: 'Running node server.js',
            effect: 'changed',
            workspace: {
              workspaceId: 'workspace_aaaaaaaaaaaaaaaaaaaa',
              commandId: 'workspace_cmd_bbbbbbbbbbbbbbbbbbbbbbbb',
              processId: 'workspace_process_cccccccccccccccccccccccc',
              kind: 'command',
              command: 'node server.js',
              workingDirectory: '.',
              backend: 'linux-bubblewrap',
              networkPosture: 'none',
              state: 'completed',
              terminationGuarantee: 'namespace_scoped',
              terminationScope: 'pid_namespace',
              sideEffects: 'unknown',
              completeDescendantTermination: true,
            },
          },
        ],
      })
    ).toBe(true);
    expect(store.getSession('conversation_one')).toMatchObject({
      status: 'ready',
      updatedAt: 2_000,
      transcript: [
        {
          status: 'completed',
          activity: [
            {
              toolCallId: 'call_server',
              status: 'succeeded',
              workspace: {
                processId: 'workspace_process_cccccccccccccccccccccccc',
                state: 'completed',
                terminationScope: 'pid_namespace',
              },
            },
          ],
        },
      ],
    });
  });

  test('renames and permanently deletes a session with all turns', () => {
    store.createSession({
      conversationId: 'conversation_one',
      title: 'Original',
      approvalMode: 'allow_website_interactions',
    });
    store.startTurn({
      conversationId: 'conversation_one',
      runId: 'run_one',
      userText: 'Task',
      approvalMode: 'allow_website_interactions',
    });
    now = 2_000;

    expect(store.renameSession('conversation_one', 'Renamed')).toMatchObject({
      title: 'Renamed',
      updatedAt: 2_000,
    });
    expect(store.deleteSession('conversation_one')).toBe(true);
    expect(store.getSession('conversation_one')).toBeNull();
    expect(store.listSessions()).toEqual([]);
  });

  test('updates the conversation policy without rewriting earlier turn policy', () => {
    store.createSession({
      conversationId: 'conversation_one',
      title: 'Policy transition',
      approvalMode: 'every_interaction',
    });
    store.startTurn({
      conversationId: 'conversation_one',
      runId: 'run_one',
      userText: 'First task',
      approvalMode: 'every_interaction',
    });
    now = 2_000;

    expect(
      store.updateApprovalMode('conversation_one', 'allow_website_interactions')
    ).toMatchObject({
      approvalMode: 'allow_website_interactions',
      updatedAt: 2_000,
    });
    store.startTurn({
      conversationId: 'conversation_one',
      runId: 'run_two',
      userText: 'Second task',
      approvalMode: 'allow_website_interactions',
    });

    expect(store.getSession('conversation_one')).toMatchObject({
      approvalMode: 'allow_website_interactions',
      transcript: [
        { runId: 'run_one', approvalMode: 'every_interaction' },
        { runId: 'run_two', approvalMode: 'allow_website_interactions' },
      ],
    });
  });

  test('marks crash-left running records interrupted on startup', () => {
    store.createSession({
      conversationId: 'conversation_one',
      title: 'Interrupted task',
      approvalMode: 'every_interaction',
    });
    store.startTurn({
      conversationId: 'conversation_one',
      runId: 'run_one',
      userText: 'Task',
      approvalMode: 'every_interaction',
    });
    store.updateTurnActivity({ conversationId: 'conversation_one', runId: 'run_one', running: true, activity: [
      { toolCallId: 'helper', operation: 'delegate_task', status: 'running', label: 'Delegating: Review' },
    ] });
    now = 5_000;

    expect(store.markStaleRunningAsInterrupted()).toEqual({ sessions: 1, turns: 1 });
    expect(store.getSession('conversation_one')).toMatchObject({
      status: 'interrupted',
      updatedAt: 5_000,
      transcript: [{ status: 'interrupted', activity: [{ operation: 'delegate_task', status: 'failed', label: 'Helper interrupted' }] }],
    });
  });

  test('bounds titles and rejects unsupported approval modes', () => {
    expect(() =>
      store.createSession({
        conversationId: 'conversation_one',
        title: 'x'.repeat(121),
        approvalMode: 'every_interaction',
      })
    ).toThrow('cannot exceed');
    expect(() =>
      store.createSession({
        conversationId: 'conversation_two',
        title: 'Task',
        approvalMode: 'unsafe',
      })
    ).toThrow('supported approval mode');
  });
});

test('real SQLite stores complete reports once, migrates legacy text, and reads bounded conversation-scoped pages', () => {
  const { DatabaseSync } = require('node:sqlite');
  class SqliteAdapter {
    constructor(filename) { this.db = new DatabaseSync(filename); }
    exec(sql) { return this.db.exec(sql); }
    prepare(sql) { return this.db.prepare(sql); }
    close() { this.db.close(); }
    pragma(sql, options = {}) {
      const rows = this.db.prepare(`PRAGMA ${sql}`).all();
      return options.simple ? Object.values(rows[0])[0] : rows;
    }
    transaction(fn) { return (...args) => {
      this.db.exec('BEGIN');
      try { const result = fn(...args); this.db.exec('COMMIT'); return result; }
      catch (error) { this.db.exec('ROLLBACK'); throw error; }
    }; }
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-helper-reports-'));
  let store = new AgentSessionHistoryStore({ userDataDir: dir, Database: SqliteAdapter, now: () => 1234 });
  try {
    for (const id of ['one', 'two']) {
      store.createSession({ conversationId: id, title: id, approvalMode: 'every_interaction' });
      store.startTurn({ conversationId: id, runId: `run_${id}`, userText: 'Review', approvalMode: 'every_interaction', startedAt: 100 });
    }
    const text = '😀important finding\n'.repeat(3000) + 'Final recommendation';
    const value = { taskId: 'delegate_' + 'a'.repeat(24), title: 'Review', state: 'completed', report: text, toolScripts: 2 };
    const receipt = store.saveHelperReport('one', 'run_one', value);
    expect(receipt.report.length).toBeLessThan(1000);
    expect(receipt.reportTruncated).toBe(false);
    expect(store.saveHelperReport('one', 'run_one', value).reportId).toBe(receipt.reportId);
    store.finishTurn({ conversationId: 'one', runId: 'run_one', status: 'completed', activity: [{ operation: 'delegate_task', subagent: receipt }] });
    expect(JSON.stringify(store.getSession('one')).length).toBeLessThan(3000);
    expect(store.getSession('one').transcript[0].activity[0].subagent.toolScripts).toBe(2);
    expect(store.getDb().prepare('SELECT count(*) AS n FROM agent_helper_reports').get().n).toBe(1);
    expect(store.helperReports('two', { action: 'read', reportId: receipt.reportId }).error).toMatch(/not found/);
    expect(store.helperReports('two').reports).toEqual([]);
    expect(store.helperReports('one', { query: 'Final recommendation' }).reports[0].reportId).toBe(receipt.reportId);
    let restored = ''; let offset = 0;
    do {
      const page = store.helperReports('one', { action: 'read', reportId: receipt.reportId, offset, limit: 997 });
      expect(Array.from(page.text).length).toBeLessThanOrEqual(997);
      restored += page.text; offset = page.nextOffset;
    } while (offset !== null);
    expect(restored).toBe(text);
    expect(() => store.helperReports('one', { action: 'read', reportId: receipt.reportId, limit: 20000 })).toThrow();
    expect(() => store.helperReports('one', { offset: -1 })).toThrow();
    const next = store.saveHelperReport('one', 'run_one', { ...value, report: 'Follow-up report' });
    expect(next.reportId).not.toBe(receipt.reportId);
    const listing = store.helperReports('one', { limit: 1 });
    expect(listing.nextOffset).toBe(1);
    expect(store.helperReports('one', { limit: 1, offset: 1 }).reports[0].reportId).not.toBe(listing.reports[0].reportId);
    // Simulate legacy history before the schema upgrade.
    const legacy = { ...value, report: 'legacy text', reportTruncated: true };
    store.getDb().prepare('UPDATE agent_turns SET activity_json = ? WHERE id = ?').run(JSON.stringify([{ operation: 'delegate_task', subagent: legacy }]), 'run_two');
    store.getDb().pragma('user_version = 4'); store.close();
    store = new AgentSessionHistoryStore({ userDataDir: dir, Database: SqliteAdapter });
    expect(store.getSession('one').transcript[0].activity[0].subagent.toolScripts).toBe(2);
    const old = store.getSession('two').transcript[0].activity[0].subagent;
    expect(old.reportId).toMatch(/^report_/);
    expect(store.helperReports('two', { action: 'read', reportId: old.reportId })).toMatchObject({ text: 'legacy text', reportTruncated: true });
    expect(store.helperReports('two').reports[0].createdAt).toBe(100);
    expect(store.helperReports('one', { action: 'read', reportId: receipt.reportId, offset: Array.from(text).length - 20 }).text).toBe('Final recommendation');
    expect(store.getDb().prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    store.deleteSession('one');
    expect(store.helperReports('one').reports).toEqual([]);
    expect(store.helperReports('two').reports).toHaveLength(1);
  } finally { store.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
