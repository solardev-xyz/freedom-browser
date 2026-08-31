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
  test('publishes an attached folder directly from its live main-process path', async () => {
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
        indexDocument: 'index.html',
      },
    });
    expect(JSON.stringify(requestApproval.mock.calls)).not.toContain('/private/live/website');
    expect(dependencies.publishDirectory).toHaveBeenCalledWith('/private/live/website', {
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

  test('returns an operation ID for long work and recovers it without publishing twice', async () => {
    const upload = deferred();
    const { controller, dependencies } = createController({
      publishDirectory: jest.fn(() => upload.promise),
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
    expect(dependencies.publishDirectory).toHaveBeenCalledTimes(1);
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
