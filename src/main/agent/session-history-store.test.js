'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const FakeDatabase = require('../../../test/helpers/fake-better-sqlite3-agent-history');

jest.mock('better-sqlite3', () =>
  require('../../../test/helpers/fake-better-sqlite3-agent-history')
);

const { AgentSessionHistoryStore, DB_FILE } = require('./session-history-store');

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
    expect(store.getSession('conversation_one')).toMatchObject({
      providerId: 'openai-codex',
      modelId: 'gpt-test',
      transcript: [
        {
          runId: 'run_one',
          userText: 'Research Freedom',
          assistantText: 'Done.',
          status: 'completed',
          durationMs: 350,
          activity: [
            {
              toolCallId: 'call_1',
              operation: 'browser_snapshot',
              status: 'succeeded',
              label: 'Read https://example.test',
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
    expect(store.getDb().filePath).toBe(path.join(userDataDir, DB_FILE));
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
    });
    now = 5_000;

    expect(store.markStaleRunningAsInterrupted()).toEqual({ sessions: 1, turns: 1 });
    expect(store.getSession('conversation_one')).toMatchObject({
      status: 'interrupted',
      updatedAt: 5_000,
      transcript: [{ status: 'interrupted' }],
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
