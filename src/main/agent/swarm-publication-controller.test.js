'use strict';

const { ERROR_CODES } = require('../automation/contract/errors');
const {
  PUBLICATION_STATES,
  SwarmPublicationController,
} = require('./swarm-publication-controller');

const REFERENCE = 'a'.repeat(64);
const PUBLICATION_ID = `swarm_pub_${'b'.repeat(24)}`;

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createController(overrides = {}) {
  const dependencies = {
    attachmentStore: {
      resolvePublicationSource: jest.fn(async () => ({
        kind: 'folder',
        name: 'website',
        path: '/private/live/website',
      })),
    },
    readAttachmentSource: jest.fn(async descriptor => ({ ...descriptor, bytes: 5, files: [{ path: 'index.html', bytes: Buffer.from('hello') }] })),
    workspaceSourceReader: {
      describe: jest.fn(async () => ({
        sourceType: 'workspace',
        kind: 'folder',
        name: 'dist',
        workspacePath: 'dist',
      })),
      read: jest.fn(async () => ({
        sourceType: 'workspace',
        kind: 'folder',
        name: 'dist',
        workspacePath: 'dist',
        bytes: 12,
        files: [
          { path: 'index.html', bytes: Buffer.from('hello') },
          { path: 'app.js', bytes: Buffer.from('world!!') },
        ],
      })),
    },
    publishData: jest.fn(async () => ({
      reference: REFERENCE,
      bzzUrl: `bzz://${REFERENCE}`,
      tagUid: null,
      bytesSize: 5,
    })),
    publishFile: jest.fn(),
    publishDirectory: jest.fn(async () => ({
      reference: REFERENCE,
      bzzUrl: `bzz://${REFERENCE}`,
      tagUid: null,
      bytesSize: 42,
    })),
    publishCollection: jest.fn(async () => ({
      reference: REFERENCE,
      bzzUrl: `bzz://${REFERENCE}`,
      tagUid: null,
      bytesSize: 12,
    })),
    getUploadStatus: jest.fn(),
    addHistoryEntry: jest.fn(() => ({ id: 7 })),
    updateHistoryEntry: jest.fn(),
    verifyPublication: jest.fn(async () => true),
    publicationIdFactory: jest.fn(() => PUBLICATION_ID),
    ...overrides,
  };
  return { controller: new SwarmPublicationController(dependencies), dependencies };
}

describe('SwarmPublicationController', () => {
  test('publishes an attached folder snapshot and discloses its exact manifest', async () => {
    const { controller, dependencies } = createController();
    const requestApproval = jest.fn(async () => 'approved');
    const onProgress = jest.fn();

    const result = await controller.publish(
      { resourceId: 'folder_aaaaaaaaaaaaaaaaaaaa', indexDocument: 'index.html' },
      { conversationId: 'conversation_test', requestApproval, onProgress }
    );

    expect(dependencies.attachmentStore.resolvePublicationSource).toHaveBeenCalledWith(
      'conversation_test',
      'folder_aaaaaaaaaaaaaaaaaaaa'
    );
    expect(requestApproval).toHaveBeenCalledWith({
      action: 'swarm_publish',
      operation: 'swarm_publish',
      label: 'website',
      publication: {
        kind: 'folder',
        name: 'website',
        public: true,
        bytes: 5,
        files: [{ path: 'index.html', bytes: 5 }],
        indexDocument: 'index.html',
      },
    });
    expect(JSON.stringify(requestApproval.mock.calls)).not.toContain('/private/live/website');
    expect(dependencies.publishCollection).toHaveBeenCalledWith([{ path: 'index.html', bytes: Buffer.from('hello') }], {
      indexDocument: 'index.html',
    });
    expect(result.publication).toMatchObject({
      publicationId: PUBLICATION_ID,
      state: PUBLICATION_STATES.COMPLETED,
      applicationState: 'applied',
      reference: REFERENCE,
      bzzUrl: `bzz://${REFERENCE}`,
      verified: true,
    });
    expect(dependencies.updateHistoryEntry).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ status: 'completed', reference: REFERENCE })
    );
    expect(onProgress).toHaveBeenLastCalledWith(
      expect.objectContaining({ state: PUBLICATION_STATES.COMPLETED, progress: 100 })
    );
  });

  test('publishes the reviewed bytes even if files change during approval', async () => {
    const { controller, dependencies } = createController();
    await controller.publish({ workspacePath: 'dist' }, { requestApproval: async () => {
      dependencies.workspaceSourceReader.read.mockResolvedValue({ kind: 'folder', name: 'dist', files: [{ path: 'evil.txt', bytes: Buffer.from('changed') }] });
      return 'approved';
    } });
    expect(dependencies.workspaceSourceReader.read).toHaveBeenCalledTimes(1);
    expect(dependencies.publishCollection).toHaveBeenCalledWith([
      { path: 'index.html', bytes: Buffer.from('hello') }, { path: 'app.js', bytes: Buffer.from('world!!') },
    ], { indexDocument: undefined });
  });

  test('declines before dispatching or writing history', async () => {
    const { controller, dependencies } = createController();
    await expect(
      controller.publish(
        { resourceId: 'folder_aaaaaaaaaaaaaaaaaaaa' },
        {
          conversationId: 'conversation_test',
          requestApproval: jest.fn(async () => 'declined'),
        }
      )
    ).rejects.toMatchObject({ code: ERROR_CODES.SWARM_PUBLICATION_CANCELLED_BY_USER });
    expect(dependencies.publishDirectory).not.toHaveBeenCalled();
    expect(dependencies.addHistoryEntry).not.toHaveBeenCalled();
  });

  test('publishes a managed workspace subtree as a direct collection after approval', async () => {
    const { controller, dependencies } = createController();
    const requestApproval = jest.fn(async () => 'approved');

    const result = await controller.publish(
      { workspacePath: 'dist', indexDocument: 'index.html' },
      { conversationId: 'conversation_test', requestApproval }
    );

    expect(dependencies.workspaceSourceReader.read).toHaveBeenCalledWith(
      'conversation_test',
      'dist'
    );
    expect(requestApproval).toHaveBeenCalledWith({
      action: 'swarm_publish',
      operation: 'swarm_publish',
      label: 'dist',
      publication: {
        kind: 'folder',
        name: 'dist',
        public: true,
        bytes: 12,
        files: [{ path: 'index.html', bytes: 5 }, { path: 'app.js', bytes: 7 }],
        workspacePath: 'dist',
        indexDocument: 'index.html',
      },
    });
    expect(dependencies.workspaceSourceReader.read).toHaveBeenCalledWith(
      'conversation_test',
      'dist'
    );
    expect(dependencies.publishCollection).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ path: 'index.html', bytes: Buffer.from('hello') }),
      ]),
      { indexDocument: 'index.html' }
    );
    expect(dependencies.publishDirectory).not.toHaveBeenCalled();
    expect(dependencies.publishData).not.toHaveBeenCalled();
    expect(dependencies.addHistoryEntry).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'directory', name: 'dist', bytesSize: 12 })
    );
    expect(result.publication).toMatchObject({
      state: PUBLICATION_STATES.COMPLETED,
      kind: 'folder',
      name: 'dist',
      bytes: 12,
      verified: true,
    });
    expect(JSON.stringify(requestApproval.mock.calls)).not.toContain('/private/');
  });

  test('snapshots a managed workspace but never publishes it when approval is declined', async () => {
    const { controller, dependencies } = createController();

    await expect(
      controller.publish(
        { workspacePath: '.' },
        {
          conversationId: 'conversation_test',
          requestApproval: jest.fn(async () => 'declined'),
        }
      )
    ).rejects.toMatchObject({ code: ERROR_CODES.SWARM_PUBLICATION_CANCELLED_BY_USER });
    expect(dependencies.workspaceSourceReader.read).toHaveBeenCalledTimes(1);
    expect(dependencies.publishCollection).not.toHaveBeenCalled();
  });

  test('publishes one managed workspace file as exact bytes with its real name and media type', async () => {
    const data = Buffer.from('<main>site</main>');
    const { controller, dependencies } = createController({
      workspaceSourceReader: {
        describe: jest.fn(async () => ({
          sourceType: 'workspace',
          kind: 'file',
          name: 'index.html',
          workspacePath: 'index.html',
          bytes: data.byteLength,
        })),
        read: jest.fn(async () => ({
          sourceType: 'workspace',
          kind: 'file',
          name: 'index.html',
          workspacePath: 'index.html',
          bytes: data.byteLength,
          data,
          contentType: 'text/html; charset=utf-8',
        })),
      },
    });

    await controller.publish(
      { workspacePath: 'index.html' },
      {
        conversationId: 'conversation_test',
        requestApproval: jest.fn(async () => 'approved'),
      }
    );

    expect(dependencies.publishData).toHaveBeenCalledWith(data, {
      name: 'index.html',
      contentType: 'text/html; charset=utf-8',
    });
    expect(dependencies.addHistoryEntry).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'file', name: 'index.html' })
    );
  });

  test('rejects a missing workspace index document before creating publication history', async () => {
    const { controller, dependencies } = createController();

    await expect(
      controller.publish(
        { workspacePath: 'dist', indexDocument: 'missing.html' },
        {
          conversationId: 'conversation_test',
          requestApproval: jest.fn(async () => 'approved'),
        }
      )
    ).rejects.toMatchObject({ code: ERROR_CODES.INVALID_ARGUMENT });
    expect(dependencies.publishCollection).not.toHaveBeenCalled();
    expect(dependencies.addHistoryEntry).not.toHaveBeenCalled();
  });

  test('returns an operation ID for long work and recovers it without publishing twice', async () => {
    const upload = deferred();
    const { controller, dependencies } = createController({
      publishCollection: jest.fn(() => upload.promise),
      interactiveTimeoutMs: 5,
      statusWaitTimeoutMs: 100,
    });
    const initial = await controller.publish(
      { resourceId: 'folder_aaaaaaaaaaaaaaaaaaaa' },
      {
        conversationId: 'conversation_test',
        requestApproval: jest.fn(async () => 'approved'),
      }
    );
    expect(initial.publication).toMatchObject({
      publicationId: PUBLICATION_ID,
      state: PUBLICATION_STATES.UPLOADING,
      applicationState: 'possibly_applied',
    });

    upload.resolve({
      reference: REFERENCE,
      bzzUrl: `bzz://${REFERENCE}`,
      tagUid: null,
      bytesSize: 42,
    });
    const recovered = await controller.status(
      { publicationId: PUBLICATION_ID },
      { conversationId: 'conversation_test' }
    );
    expect(recovered.publication).toMatchObject({
      state: PUBLICATION_STATES.COMPLETED,
      reference: REFERENCE,
    });
    expect(dependencies.publishCollection).toHaveBeenCalledTimes(1);
  });

  test('reports a completed publication honestly when retrieval verification lags', async () => {
    const { controller, dependencies } = createController({
      verifyPublication: jest.fn(async () => {
        throw new Error('reference not retrievable yet');
      }),
    });
    const requestApproval = jest.fn(async () => 'approved');
    const result = await controller.publish(
      { text: 'hello', contentType: 'text/plain' },
      {
        conversationId: 'conversation_test',
        requestApproval,
      }
    );
    expect(requestApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        label: 'Text',
        publication: expect.objectContaining({ kind: 'text', name: 'Text' }),
      })
    );
    expect(result.publication).toMatchObject({
      state: PUBLICATION_STATES.COMPLETED,
      applicationState: 'applied',
      verified: false,
      error: 'reference not retrievable yet',
      kind: 'text',
      name: 'Text',
    });
    expect(dependencies.addHistoryEntry).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'data', name: 'Text' })
    );
    expect(dependencies.publishData).toHaveBeenCalledWith('hello', {
      contentType: 'text/plain',
    });
  });
});

test('verifies publication through the default Bee v13 data adapter', async () => {
  const download = jest.fn(async () => Buffer.from('published'));
  jest.doMock('../swarm/swarm-service', () => ({ getBee: () => ({ data: { download } }) }));
  const { controller } = createController({ verifyPublication: undefined });
  try {
    const result = await controller.publish(
      { resourceId: 'folder_aaaaaaaaaaaaaaaaaaaa', indexDocument: 'index.html' },
      { conversationId: 'conversation_test', requestApproval: async () => 'approved' }
    );
    expect(download).toHaveBeenCalledWith(REFERENCE);
    expect(result).toMatchObject({ publication: { verified: true } });
  } finally {
    jest.dontMock('../swarm/swarm-service');
  }
});

test('preserves postage capacity errors and actionable recovery instead of blaming browser capability', async () => {
  const { controller } = createController({ publishCollection: jest.fn(async () => { throw Object.assign(new Error('Upload needs 1500000 bytes; batch has 40890 bytes effective capacity.'), { code: 'POSTAGE_CAPACITY_INSUFFICIENT' }); }) });
  await expect(controller.publish({ workspacePath: 'out' }, { conversationId: 'conversation_test', requestApproval: async () => 'approved' })).rejects.toMatchObject({ code: 'POSTAGE_CAPACITY_INSUFFICIENT', suggestedAction: expect.stringContaining('effective remaining capacity') });
});

describe('publication lifecycle', () => {
  const batchId = 'c'.repeat(64);
  function lifecycle(overrides = {}) {
    let clock = 0;
    const readiness = { backendKey: () => 'backend', select: jest.fn(async () => batchId), inspect: jest.fn(async () => ({ ready: true, firstConfirmedBlock: 10 })) };
    const store = { list: () => [], save: jest.fn(), deleteConversation: jest.fn() };
    const fixture = createController({ postageReadiness: readiness, store, now: () => clock,
      sleep: async ms => { clock += ms; }, jobTimeoutMs: 1000, readinessPollMs: 10,
      retryDelayMs: 10, progressTimeoutMs: 30, progressPollMs: 10, ...overrides });
    return { ...fixture, readiness, store };
  }
  const context = () => ({ conversationId: 'owner', requestApproval: async () => 'approved' });

  test('waits for readiness then retries only the exact propagation error with identical approved content and batch', async () => {
    const { controller, dependencies, readiness } = lifecycle();
    readiness.inspect.mockResolvedValueOnce({ ready: false, firstConfirmedBlock: 10, blocksRemaining: 10 });
    dependencies.publishCollection.mockRejectedValueOnce(new Error(`postage batch 0x${batchId} rejected by 2 peer(s) as not found on-chain`));
    const result = await controller.publish({ workspacePath: 'dist' }, context());
    expect(result.publication.state).toBe('completed');
    expect(readiness.select).toHaveBeenCalledTimes(1);
    expect(readiness.inspect).toHaveBeenCalledTimes(3);
    expect(dependencies.publishCollection).toHaveBeenCalledTimes(2);
    expect(dependencies.publishCollection.mock.calls[0]).toEqual(dependencies.publishCollection.mock.calls[1]);
    expect(dependencies.publishCollection.mock.calls[0][1].batchId).toBe(batchId);
  });

  test('does not retry unrelated errors, and blocks another upload while its outcome is unknown', async () => {
    const { controller, dependencies } = lifecycle({ publishCollection: jest.fn(async () => { throw new Error('socket disconnected'); }) });
    await expect(controller.publish({ workspacePath: 'dist' }, context())).rejects.toThrow();
    const result = await controller.publish({ workspacePath: 'dist' }, context());
    expect(result.publication.state).toBe('outcome_unknown');
    expect(dependencies.publishCollection).toHaveBeenCalledTimes(1);
  });

  test('bounded propagation retries end as an upload failure, never buy another batch', async () => {
    const { controller, dependencies, readiness } = lifecycle({ publishCollection: jest.fn(async () => {
      throw new Error(`postage batch 0x${batchId} rejected by 2 peer(s) as not found on-chain`);
    }) });
    await expect(controller.publish({ workspacePath: 'dist' }, context())).rejects.toThrow();
    expect((await controller.status({ publicationId: PUBLICATION_ID }, { conversationId: 'owner' })).publication.state).toBe('failed');
    expect(dependencies.publishCollection).toHaveBeenCalledTimes(3);
    expect(readiness.select).toHaveBeenCalledTimes(1);
  });

  test('a stalled or unavailable tag cannot become completed through local retrieval', async () => {
    const { controller, dependencies } = lifecycle({ publishCollection: async () => ({ reference: REFERENCE, bzzUrl: `bzz://${REFERENCE}`, tagUid: 2 }), getUploadStatus: async () => { throw new Error('node unavailable'); } });
    await expect(controller.publish({ workspacePath: 'dist' }, context())).rejects.toThrow('confirmation');
    expect(dependencies.verifyPublication).not.toHaveBeenCalled();
    expect(dependencies.updateHistoryEntry).not.toHaveBeenCalledWith(7, expect.objectContaining({ status: 'completed' }));
  });

  test('restart resumes observation of a known tag without publishing again, scoped to owner and backend', async () => {
    const record = { publicationId: PUBLICATION_ID, ownerId: 'owner', state: 'confirming', kind: 'folder', name: 'dist', public: true, historyId: 7, reference: REFERENCE, bzzUrl: `bzz://${REFERENCE}`, tagUid: 2, dispatched: true, backendKey: 'backend' };
    const { controller, dependencies } = lifecycle({ store: { list: () => [record], save: jest.fn() }, getUploadStatus: async () => ({ done: true, progress: 100, reference: REFERENCE }) });
    await expect(controller.status({ publicationId: PUBLICATION_ID }, { conversationId: 'other' })).rejects.toThrow('not available');
    record.error = 'Earlier observation was interrupted';
    const receipt = (await controller.status({ publicationId: PUBLICATION_ID }, { conversationId: 'owner' })).publication;
    expect(receipt).toMatchObject({ state: 'completed', verified: true });
    expect(receipt.error).toBeUndefined();
    expect(dependencies.publishCollection).not.toHaveBeenCalled();
  });

  test('Stop during readiness prevents upload; Stop while uploading never claims rollback', async () => {
    const abort = new AbortController();
    const { controller, dependencies, readiness } = lifecycle({ sleep: async () => { abort.abort(); } });
    readiness.inspect.mockResolvedValue({ ready: false });
    await controller.publish({ workspacePath: 'dist' }, { ...context(), signal: abort.signal });
    await Promise.allSettled([...controller.active.values()]);
    expect(dependencies.publishCollection).not.toHaveBeenCalled();
    expect(controller.operations.get(PUBLICATION_ID)).toMatchObject({ state: 'failed', dispatched: false });

    const pending = deferred();
    const uploadAbort = new AbortController();
    const next = lifecycle({ publishCollection: () => pending.promise, interactiveTimeoutMs: 1 });
    await next.controller.publish({ workspacePath: 'dist' }, { ...context(), signal: uploadAbort.signal });
    uploadAbort.abort();
    pending.resolve({ reference: REFERENCE, bzzUrl: `bzz://${REFERENCE}` });
    await Promise.allSettled([...next.controller.active.values()]);
    expect(next.controller.operations.get(PUBLICATION_ID)).toMatchObject({ state: 'outcome_unknown', dispatched: true, reference: REFERENCE });
  });
});

test('concurrent preparation cannot approve or dispatch two publications for one conversation', async () => {
  const approval = deferred();
  const { controller, dependencies } = createController();
  const first = controller.publish({ workspacePath: 'dist' }, { conversationId: 'owner', requestApproval: () => approval.promise });
  await expect(controller.publish({ workspacePath: 'dist' }, { conversationId: 'owner', requestApproval: async () => 'approved' })).rejects.toThrow('already being prepared');
  approval.resolve('approved');
  await first;
  expect(dependencies.publishCollection).toHaveBeenCalledTimes(1);
});

test('a recycled tag for a different reference cannot complete a recovered publication', async () => {
  let clock = 0;
  const { controller, dependencies } = createController({
    store: { list: () => [{ publicationId: PUBLICATION_ID, ownerId: 'owner', name: 'dist', kind: 'folder', state: 'confirming', dispatched: true, reference: REFERENCE, tagUid: 5 }], save: jest.fn() },
    now: () => clock, sleep: async ms => { clock += ms; }, progressTimeoutMs: 20, progressPollMs: 10,
    getUploadStatus: async () => ({ done: true, reference: 'f'.repeat(64) }),
  });
  expect((await controller.status({ publicationId: PUBLICATION_ID }, { conversationId: 'owner' })).publication.state).toBe('outcome_unknown');
  expect(dependencies.verifyPublication).not.toHaveBeenCalled();
  expect(dependencies.publishCollection).not.toHaveBeenCalled();
});

test('retains a late transport receipt after a deadline without sending another upload', async () => {
  const upload = deferred();
  const { controller, dependencies } = createController({ publishCollection: () => upload.promise, jobTimeoutMs: 5, interactiveTimeoutMs: 1 });
  await controller.publish({ workspacePath: 'dist' }, { conversationId: 'owner', requestApproval: async () => 'approved' });
  await Promise.allSettled([...controller.active.values()]);
  expect(controller.operations.get(PUBLICATION_ID).state).toBe('outcome_unknown');
  upload.resolve({ reference: REFERENCE, bzzUrl: `bzz://${REFERENCE}` });
  await new Promise(resolve => setImmediate(resolve));
  expect(controller.operations.get(PUBLICATION_ID)).toMatchObject({ state: 'outcome_unknown', reference: REFERENCE });
  expect(dependencies.verifyPublication).not.toHaveBeenCalled();
  expect((await controller.status({ publicationId: PUBLICATION_ID }, { conversationId: 'owner' })).publication.state).toBe('completed');
});
