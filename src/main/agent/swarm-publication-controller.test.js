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
        target: 'public',
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
        target: 'public',
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

describe('SwarmPublicationController pre-publish scan', () => {
  const STRIPE = `sk_live_${'4eC39HqLyjWDarjtT1zdp7dc'}`;
  const folderWith = (files, excluded) => ({
    sourceType: 'workspace', kind: 'folder', name: 'dist', workspacePath: 'dist',
    bytes: files.reduce((total, file) => total + file.bytes.length, 0), files, ...(excluded && { excluded }),
  });

  test('scans attachment, text and workspace sources before approval without blocking clean content', async () => {
    for (const input of [{ resourceId: 'folder_aaaaaaaaaaaaaaaaaaaa' }, { text: `key ${STRIPE}` }, { workspacePath: 'dist' }]) {
      const { controller } = createController({
        readAttachmentSource: jest.fn(async descriptor => ({ ...descriptor, files: [{ path: 'pay.js', bytes: Buffer.from(`const k = "${STRIPE}";`) }] })),
        workspaceSourceReader: { read: jest.fn(async () => folderWith([{ path: 'app.js', bytes: Buffer.from(`fetch("x", { key: "${STRIPE}" })`) }])) },
      });
      const requestApproval = jest.fn(async () => 'declined');
      await expect(controller.publish(input, { requestApproval })).rejects.toMatchObject({ code: ERROR_CODES.SWARM_PUBLICATION_CANCELLED_BY_USER });
      const { findings } = requestApproval.mock.calls[0][0].publication;
      expect(findings).toEqual([expect.objectContaining({ kind: 'secret', rule: 'stripe-secret-key', blocking: true, line: 1 })]);
      expect(JSON.stringify(findings)).not.toContain(STRIPE);
    }
  });

  test('a secret finding blocks a plain approval; nothing is uploaded', async () => {
    const { controller, dependencies } = createController({
      workspaceSourceReader: { read: jest.fn(async () => folderWith([{ path: 'app.js', bytes: Buffer.from(`const s = "${STRIPE}";`) }])) },
    });
    const failure = controller.publish({ workspacePath: 'dist' }, { requestApproval: async () => 'approved' });
    await expect(failure).rejects.toMatchObject({ code: ERROR_CODES.SWARM_PUBLICATION_CANCELLED_BY_USER, message: expect.stringContaining('stripe-secret-key') });
    await failure.catch(error => expect(error.message).not.toContain(STRIPE));
    expect(dependencies.publishCollection).not.toHaveBeenCalled();
    expect(dependencies.addHistoryEntry).not.toHaveBeenCalled();
  });

  test('Publish anyway for each blocking finding uploads exactly the scanned bytes', async () => {
    const files = [
      { path: 'index.html', bytes: Buffer.from('<p>alice.smith@proton.me</p>') },
      { path: 'app.js', bytes: Buffer.from(`const s = "${STRIPE}";\n//# sourceMappingURL=app.js.map\n`) },
      { path: 'app.js.map', bytes: Buffer.from('{"sources":["secret.ts"]}') },
    ];
    const { controller, dependencies } = createController({ workspaceSourceReader: { read: jest.fn(async () => folderWith(files)) } });
    let request;
    const result = await controller.publish({ workspacePath: 'dist' }, { requestApproval: async value => {
      request = value;
      const ids = value.publication.findings.filter(finding => finding.blocking).map(finding => finding.id);
      return { status: 'approved', publicationAcknowledged: ids };
    } });
    expect(request.publication.findings.map(finding => [finding.path, finding.rule, finding.blocking])).toEqual([
      ['index.html', 'email-address', false], ['app.js', 'stripe-secret-key', true],
    ]);
    expect(request.publication.excluded).toEqual([{ path: 'app.js.map', reason: expect.stringContaining('Source map') }]);
    expect(request.publication.stripped).toEqual([{ path: 'app.js', reason: 'sourceMappingURL comment removed' }]);
    const uploaded = dependencies.publishCollection.mock.calls[0][0];
    expect(uploaded.map(file => file.path)).toEqual(['index.html', 'app.js']);
    expect(uploaded[1].bytes.toString()).toBe(`const s = "${STRIPE}";\n\n`);
    expect(request.publication.files).toEqual(uploaded.map(file => ({ path: file.path, bytes: file.bytes.length })));
    // The model-facing receipt carries counts and rule names, never an excerpt.
    expect(result.publication.prepublishScan).toEqual({ findings: 2, rules: ['email-address', 'stripe-secret-key'], excludedFiles: 1, metadataStripped: 1, excludedByUser: 0 });
  });

  test('Exclude file removes it from the upload and resolves its findings', async () => {
    const files = [{ path: 'index.html', bytes: Buffer.from('hi') }, { path: 'keys.js', bytes: Buffer.from(`k="${STRIPE}"`) }];
    const { controller, dependencies } = createController({ workspaceSourceReader: { read: jest.fn(async () => folderWith(files)) } });
    await controller.publish({ workspacePath: 'dist' }, { requestApproval: async () => ({ status: 'approved', publicationExclusions: ['keys.js'] }) });
    expect(dependencies.publishCollection).toHaveBeenCalledWith([files[0]], expect.anything());
    await expect(createController({ workspaceSourceReader: { read: jest.fn(async () => folderWith(files)) } }).controller
      .publish({ workspacePath: 'dist' }, { requestApproval: async () => ({ status: 'approved', publicationExclusions: ['missing.js'] }) }))
      .rejects.toMatchObject({ code: ERROR_CODES.INVALID_ARGUMENT });
    // More than 100 flagged files can all be excluded (up to the 200-finding cap).
    const many = [{ path: 'index.html', bytes: Buffer.from('hi') },
      ...Array.from({ length: 150 }, (_, index) => ({ path: `k${index}.js`, bytes: Buffer.from(`k="${STRIPE}"`) }))];
    const wide = createController({ workspaceSourceReader: { read: jest.fn(async () => folderWith(many)) } });
    await wide.controller.publish({ workspacePath: 'dist' }, { requestApproval: async () =>
      ({ status: 'approved', publicationExclusions: many.slice(1).map(file => file.path) }) });
    expect(wide.dependencies.publishCollection).toHaveBeenCalledWith([many[0]], expect.anything());
  });

  test('Ask Agent to fix returns rule names and paths only, and the next attempt scans the new snapshot', async () => {
    const read = jest.fn()
      .mockResolvedValueOnce(folderWith([{ path: 'app.js', bytes: Buffer.from(`\nconst s = "${STRIPE}";`) }]))
      .mockResolvedValueOnce(folderWith([{ path: 'app.js', bytes: Buffer.from('const s = window.config.key;') }]));
    const { controller, dependencies } = createController({ workspaceSourceReader: { read } });
    const first = controller.publish({ workspacePath: 'dist' }, { requestApproval: async () => ({ status: 'declined', publicationFix: { paths: ['app.js'] } }) });
    await expect(first).rejects.toMatchObject({
      code: ERROR_CODES.SWARM_PUBLICATION_CANCELLED_BY_USER,
      message: expect.stringContaining('app.js: stripe-secret-key (line 2)'),
      suggestedAction: expect.stringContaining('swarm_publish again'),
    });
    await first.catch(error => expect(`${error.message}${error.suggestedAction}`).not.toContain('sk_live'));
    const requestApproval = jest.fn(async () => 'approved');
    await controller.publish({ workspacePath: 'dist' }, { requestApproval });
    expect(requestApproval.mock.calls[0][0].publication.findings).toBeUndefined();
    expect(dependencies.publishCollection.mock.calls[0][0][0].bytes.toString()).toBe('const s = window.config.key;');
  });

  test('lists excluded paths by name and reason, and strips image metadata from a single attached file', async () => {
    const jpeg = Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x0e]), Buffer.from('Exif\0\0GPS\0\0\0', 'latin1'),
      Buffer.from([0xff, 0xda, 0x00, 0x02, 0x11, 0x22, 0xff, 0xd9]),
    ]);
    const { controller, dependencies } = createController({
      attachmentStore: { resolvePublicationSource: jest.fn(async () => ({ kind: 'file', name: 'photo.jpg', path: '/x/photo.jpg' })) },
      readAttachmentSource: jest.fn(async () => ({ kind: 'file', name: 'photo.jpg', data: jpeg, bytes: jpeg.length, contentType: 'image/jpeg' })),
    });
    const requestApproval = jest.fn(async () => 'approved');
    await controller.publish({ resourceId: 'file_aaaaaaaaaaaaaaaaaaaa' }, { requestApproval });
    expect(requestApproval.mock.calls[0][0].publication.stripped).toEqual([{ path: 'photo.jpg', reason: 'Image metadata (EXIF, GPS, XMP) removed' }]);
    const sent = dependencies.publishData.mock.calls[0][0];
    expect(sent.includes(Buffer.from('Exif'))).toBe(false);
    expect(sent).toEqual(Buffer.from([0xff, 0xd8, 0xff, 0xda, 0x00, 0x02, 0x11, 0x22, 0xff, 0xd9]));
    expect(requestApproval.mock.calls[0][0].publication.bytes).toBe(sent.length);
  });

  test('the scan is awaited with the caller signal; Stop while it runs cancels before approval', async () => {
    const scanning = deferred();
    const preparePublication = jest.fn(() => scanning.promise);
    const { controller, dependencies } = createController({ preparePublication });
    const stop = new AbortController();
    const requestApproval = jest.fn();
    const publication = controller.publish({ workspacePath: 'dist' }, { requestApproval, signal: stop.signal });
    await new Promise(resolve => setImmediate(resolve));
    expect(preparePublication).toHaveBeenCalledWith(expect.objectContaining({ kind: 'folder' }), { signal: stop.signal });
    stop.abort();
    const abortError = new Error('PublicationScan prepare aborted');
    abortError.name = 'AbortError';
    scanning.reject(abortError);
    await expect(publication).rejects.toMatchObject({ code: ERROR_CODES.USER_CANCELLED });
    expect(requestApproval).not.toHaveBeenCalled();
    expect(dependencies.publishCollection).not.toHaveBeenCalled();
  });
});

describe('private draft links, stable addresses and postage on the card (#741 E, F, G)', () => {
  const ENCRYPTED = 'e'.repeat(128);
  const FEED = 'f'.repeat(64);
  const OWNER = `0x${'1'.repeat(40)}`;
  const BATCH = 'c'.repeat(64);
  const STRIPE = `sk_live_${'4eC39HqLyjWDarjtT1zdp7dc'}`;
  const encryptedUpload = jest.fn(async () => ({ reference: ENCRYPTED, bzzUrl: `bzz://${ENCRYPTED}`, tagUid: null, bytesSize: 12 }));
  const signer = () => jest.fn(async () => ({ address: OWNER, privateKey: `0x${'9'.repeat(64)}` }));
  const feeds = () => ({
    updateFeed: jest.fn(async () => ({ index: 3 })),
    createFeed: jest.fn(async () => ({ manifestReference: FEED, bzzUrl: `bzz://${FEED}` })),
  });

  test('E: a draft is its own target, uploads with Swarm-Encrypt and records that it was a draft', async () => {
    const { controller, dependencies } = createController({ publishCollection: encryptedUpload });
    const requestApproval = jest.fn(async () => 'approved');
    const result = await controller.publish({ workspacePath: 'dist', target: 'draft' }, { conversationId: 'c', requestApproval });
    expect(requestApproval.mock.calls[0][0].publication).toMatchObject({ target: 'draft', public: false, encrypted: true });
    expect(requestApproval.mock.calls[0][0].publication).not.toHaveProperty('stableAddress');
    expect(encryptedUpload.mock.calls[0][1]).toMatchObject({ encrypt: true });
    expect(result.publication).toMatchObject({ target: 'draft', public: false, encrypted: true, reference: ENCRYPTED,
      bzzUrl: `bzz://${ENCRYPTED}`, state: 'completed', message: expect.stringContaining('Private draft link ready') });
    expect(dependencies.addHistoryEntry).toHaveBeenCalledWith(expect.objectContaining({ name: 'dist (private draft link)' }));
  });

  test('E: an unencrypted reference from the node is never reported as a private link', async () => {
    const { controller } = createController();
    const failure = controller.publish({ workspacePath: 'dist', target: 'draft' }, { conversationId: 'c', requestApproval: async () => 'approved' });
    await expect(failure).rejects.toThrow('did not encrypt this upload');
    const receipt = (await controller.status({ publicationId: PUBLICATION_ID }, { conversationId: 'c' })).publication;
    expect(receipt).toMatchObject({ target: 'draft', state: 'outcome_unknown' });
    expect(receipt).not.toHaveProperty('bzzUrl');
  });

  test('E: the same scan and blocking rules apply to a draft', async () => {
    const { controller } = createController({
      publishCollection: encryptedUpload,
      workspaceSourceReader: { read: jest.fn(async () => ({ sourceType: 'workspace', kind: 'folder', name: 'dist', workspacePath: 'dist', bytes: 20,
        files: [{ path: 'app.js', bytes: Buffer.from(`const s = "${STRIPE}";`) }] })) },
    });
    encryptedUpload.mockClear();
    await expect(controller.publish({ workspacePath: 'dist', target: 'draft' }, { conversationId: 'c', requestApproval: async () => 'approved' }))
      .rejects.toMatchObject({ code: ERROR_CODES.SWARM_PUBLICATION_CANCELLED_BY_USER, message: expect.stringContaining('stripe-secret-key') });
    expect(encryptedUpload).not.toHaveBeenCalled();
  });

  test('E: publishing a draft publicly later is a separate approval and an unencrypted upload', async () => {
    let call = 0;
    const publishCollection = jest.fn(async () => (call++ === 0
      ? { reference: ENCRYPTED, bzzUrl: `bzz://${ENCRYPTED}`, tagUid: null }
      : { reference: REFERENCE, bzzUrl: `bzz://${REFERENCE}`, tagUid: null }));
    let id = 0;
    const { controller } = createController({ publishCollection, publicationIdFactory: () => `swarm_pub_${String(++id).padStart(24, '0')}` });
    const requestApproval = jest.fn(async () => 'approved');
    await controller.publish({ workspacePath: 'dist', target: 'draft' }, { conversationId: 'c', requestApproval });
    const declined = jest.fn(async () => 'declined');
    await expect(controller.publish({ workspacePath: 'dist' }, { conversationId: 'c', requestApproval: declined }))
      .rejects.toMatchObject({ code: ERROR_CODES.SWARM_PUBLICATION_CANCELLED_BY_USER });
    expect(declined).toHaveBeenCalledWith(expect.objectContaining({ publication: expect.objectContaining({ target: 'public', public: true }) }));
    expect(publishCollection).toHaveBeenCalledTimes(1);
    const published = await controller.publish({ workspacePath: 'dist' }, { conversationId: 'c', requestApproval });
    expect(requestApproval).toHaveBeenCalledTimes(2);
    expect(publishCollection.mock.calls[1][1]).not.toHaveProperty('encrypt');
    expect(published.publication).toMatchObject({ target: 'public', public: true, reference: REFERENCE });
    expect(published.publication).not.toHaveProperty('encrypted');
  });

  test('E: a draft never gets a stable address', async () => {
    const { controller, dependencies } = createController({ feedSigner: signer(), ...feeds() });
    const requestApproval = jest.fn();
    await expect(controller.publish({ workspacePath: 'dist', target: 'draft', stableAddress: 'site' }, { requestApproval }))
      .rejects.toMatchObject({ code: ERROR_CODES.INVALID_ARGUMENT });
    expect(requestApproval).not.toHaveBeenCalled();
    expect(dependencies.publishCollection).not.toHaveBeenCalled();
  });

  test('F: publishes under a feed owned by the Swarm identity, and a later fix updates the same address', async () => {
    const feed = feeds();
    let id = 0;
    const feedSigner = signer();
    const { controller } = createController({ feedSigner, ...feed, publicationIdFactory: () => `swarm_pub_${String(++id).padStart(24, '0')}` });
    const requestApproval = jest.fn(async () => 'approved');
    const first = await controller.publish({ workspacePath: 'dist', stableAddress: 'my-site' }, { conversationId: 'c', requestApproval });
    expect(requestApproval.mock.calls[0][0].publication.stableAddress).toEqual({ name: 'my-site', owner: OWNER });
    expect(feed.updateFeed).toHaveBeenCalledWith(`0x${'9'.repeat(64)}`, 'freedom-agent/stable-address/my-site', REFERENCE, undefined);
    expect(feed.createFeed).toHaveBeenCalledWith(`0x${'9'.repeat(64)}`, 'freedom-agent/stable-address/my-site', undefined);
    expect(first.publication.stableAddress).toEqual({ name: 'my-site', owner: OWNER, reference: FEED, bzzUrl: `bzz://${FEED}`, index: 3, updated: true });
    expect(JSON.stringify(first)).not.toContain('9'.repeat(64));
    // A later publication in another conversation names the address it updates.
    await controller.publish({ workspacePath: 'dist', stableAddress: 'my-site' }, { conversationId: 'other', requestApproval });
    expect(requestApproval.mock.calls[1][0].publication.stableAddress).toEqual({ name: 'my-site', owner: OWNER, currentBzzUrl: `bzz://${FEED}` });
    expect(feed.updateFeed).toHaveBeenCalledTimes(2);
  });

  test('F: a locked vault refuses before approval; a failed feed update leaves the content published and says so', async () => {
    const locked = createController({ feedSigner: jest.fn(async () => { throw new Error('locked'); }), ...feeds() });
    const requestApproval = jest.fn(async () => 'approved');
    await expect(locked.controller.publish({ workspacePath: 'dist', stableAddress: 'site' }, { requestApproval }))
      .rejects.toMatchObject({ code: ERROR_CODES.CAPABILITY_UNAVAILABLE, message: expect.stringContaining('vault') });
    expect(requestApproval).not.toHaveBeenCalled();

    const feed = feeds();
    feed.updateFeed.mockRejectedValueOnce(new Error('feed write refused'));
    const { controller } = createController({ feedSigner: signer(), ...feed });
    const result = await controller.publish({ workspacePath: 'dist', stableAddress: 'site' }, { conversationId: 'c', requestApproval });
    expect(result.publication).toMatchObject({ state: 'completed', reference: REFERENCE,
      message: expect.stringContaining('the stable address was not updated'),
      stableAddress: { name: 'site', owner: OWNER, updated: false, error: 'feed write refused' } });
    expect(result.publication.stableAddress).not.toHaveProperty('bzzUrl');
    expect(feed.createFeed).not.toHaveBeenCalled();
  });

  test('F: an identity switched after approval does not update the address', async () => {
    const feed = feeds();
    const feedSigner = jest.fn()
      .mockResolvedValueOnce({ address: OWNER, privateKey: '0x1' })
      .mockResolvedValueOnce({ address: `0x${'2'.repeat(40)}`, privateKey: '0x2' });
    const { controller } = createController({ feedSigner, ...feed });
    const result = await controller.publish({ workspacePath: 'dist', stableAddress: 'site' }, { conversationId: 'c', requestApproval: async () => 'approved' });
    expect(result.publication.stableAddress).toMatchObject({ updated: false, error: expect.stringContaining('identity changed') });
    expect(feed.updateFeed).not.toHaveBeenCalled();
  });

  test('G: the card shows the selected batch, its cost and time left, and that batch is the one used', async () => {
    const preview = { status: 'ready', batchId: BATCH, usable: true, ttlSeconds: 3 * 86_400, expiry: 'soon', estimatedChunks: 4, estimatedCostPlur: '4000' };
    const readiness = { backendKey: () => 'backend', preview: jest.fn(async () => preview),
      select: jest.fn(async () => 'd'.repeat(64)), inspect: jest.fn(async () => ({ ready: true, firstConfirmedBlock: 1 })) };
    const { controller, dependencies } = createController({ postageReadiness: readiness, publishCollection: encryptedUpload });
    encryptedUpload.mockClear();
    const requestApproval = jest.fn(async () => 'approved');
    await controller.publish({ workspacePath: 'dist', target: 'draft' }, { conversationId: 'c', requestApproval });
    expect(readiness.preview).toHaveBeenCalledWith('c', 12, { encrypted: true, files: 2 });
    expect(requestApproval.mock.calls[0][0].publication.postage).toEqual(preview);
    expect(readiness.select).not.toHaveBeenCalled();
    expect(encryptedUpload.mock.calls[0][1]).toMatchObject({ batchId: BATCH, encrypt: true });
    expect(dependencies.publishData).not.toHaveBeenCalled();
  });

  test('G: postage details that cannot be read never decide the publication', async () => {
    const readiness = { backendKey: () => 'backend', preview: jest.fn(async () => { throw new Error('node down'); }),
      select: jest.fn(async () => BATCH), inspect: jest.fn(async () => ({ ready: true, firstConfirmedBlock: 1 })) };
    const { controller, dependencies } = createController({ postageReadiness: readiness });
    const requestApproval = jest.fn(async () => 'approved');
    const result = await controller.publish({ workspacePath: 'dist' }, { conversationId: 'c', requestApproval });
    expect(requestApproval.mock.calls[0][0].publication.postage).toEqual({ status: 'unknown' });
    expect(readiness.select).toHaveBeenCalledTimes(1);
    expect(dependencies.publishCollection.mock.calls[0][1]).toMatchObject({ batchId: BATCH });
    expect(result.publication.state).toBe('completed');
  });
});
