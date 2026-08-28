'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const FakeDatabase = require('../../../test/helpers/fake-better-sqlite3-node-operations');
const {
  AgentNodeOperationStore,
  DB_FILE,
  OPERATION_STATES,
} = require('./node-operation-store');

describe('AgentNodeOperationStore', () => {
  let userDataDir;
  let store;
  let now;

  beforeEach(() => {
    FakeDatabase.reset();
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-node-operations-'));
    now = 1_000;
    store = new AgentNodeOperationStore({ userDataDir, now: () => now, Database: FakeDatabase });
  });

  afterEach(() => {
    store.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  });

  test('persists bounded operation receipts without raw request bodies or header values', () => {
    store.create({
      operationId: 'node_op_aaaaaaaaaaaaaaaaaaaaaaaa',
      ownerId: 'conversation_one',
      service: 'ant',
      transport: 'http',
      effect: 'financial',
      request: {
        method: 'POST',
        path: '/stamps/100/20',
        headerNames: ['content-type'],
        bodySha256: 'b'.repeat(64),
      },
    });
    now = 1_100;
    store.markInFlight('node_op_aaaaaaaaaaaaaaaaaaaaaaaa');
    now = 1_200;
    store.markResponded('node_op_aaaaaaaaaaaaaaaaaaaaaaaa', {
      status: 201,
      statusText: 'Created',
      headers: { 'content-type': 'application/json' },
      body: '{"batchID":"batch-1"}',
      bytes: 21,
    });
    store.close();

    store = new AgentNodeOperationStore({ userDataDir, now: () => now, Database: FakeDatabase });
    expect(store.get('node_op_aaaaaaaaaaaaaaaaaaaaaaaa', 'conversation_one')).toEqual({
      operationId: 'node_op_aaaaaaaaaaaaaaaaaaaaaaaa',
      ownerId: 'conversation_one',
      state: OPERATION_STATES.RESPONDED,
      service: 'ant',
      transport: 'http',
      effect: 'financial',
      request: {
        method: 'POST',
        path: '/stamps/100/20',
        headerNames: ['content-type'],
        bodySha256: 'b'.repeat(64),
      },
      response: {
        status: 201,
        statusText: 'Created',
        headers: { 'content-type': 'application/json' },
        body: '{"batchID":"batch-1"}',
        bytes: 21,
      },
      createdAt: 1_000,
      updatedAt: 1_200,
    });
    expect(store.getDb().filePath).toBe(path.join(userDataDir, DB_FILE));
    expect(JSON.stringify(store.getAny('node_op_aaaaaaaaaaaaaaaaaaaaaaaa'))).not.toContain(
      'immutable'
    );
  });

  test('marks operations left in flight by a prior app process as delivery uncertain', () => {
    store.create({
      operationId: 'node_op_bbbbbbbbbbbbbbbbbbbbbbbb',
      ownerId: 'conversation_one',
      service: 'radicle',
      transport: 'http',
      effect: 'persistent_change',
      request: { method: 'PATCH', path: '/api/v1/config', headerNames: [] },
    });
    store.markInFlight('node_op_bbbbbbbbbbbbbbbbbbbbbbbb');
    now = 2_000;

    expect(store.markStaleInFlightAsUncertain()).toBe(1);
    expect(store.get('node_op_bbbbbbbbbbbbbbbbbbbbbbbb', 'conversation_one')).toMatchObject({
      state: OPERATION_STATES.DELIVERY_UNCERTAIN,
      error: {
        code: 'NODE_DELIVERY_UNCERTAIN',
        message: 'Freedom restarted before the node response was received',
      },
      updatedAt: 2_000,
    });
  });

  test('does not reveal an operation receipt to another conversation', () => {
    store.create({
      operationId: 'node_op_cccccccccccccccccccccccc',
      ownerId: 'conversation_one',
      service: 'ant',
      transport: 'http',
      effect: 'read',
      request: { method: 'GET', path: '/health', headerNames: [] },
    });

    expect(store.get('node_op_cccccccccccccccccccccccc', 'conversation_two')).toBeNull();
    expect(store.listRecent('conversation_two')).toEqual([]);
    expect(store.listRecent('conversation_one')).toEqual([
      expect.objectContaining({ operationId: 'node_op_cccccccccccccccccccccccc' }),
    ]);
  });
});
