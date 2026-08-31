'use strict';

const crypto = require('crypto');
const { OPERATIONS } = require('../automation/contract/operations');
const { AutomationError, ERROR_CODES } = require('../automation/contract/errors');

const AGENT_PUBLISH_ORIGIN = 'freedom://agent';
const DEFAULT_INTERACTIVE_TIMEOUT_MS = 10_000;
const DEFAULT_STATUS_WAIT_TIMEOUT_MS = 10_000;
const DEFAULT_PROGRESS_POLL_MS = 500;
const DEFAULT_PROGRESS_TIMEOUT_MS = 120_000;
const PUBLICATION_STATES = Object.freeze({
  UPLOADING: 'uploading',
  VERIFYING: 'verifying',
  COMPLETED: 'completed',
  FAILED: 'failed',
  OUTCOME_UNKNOWN: 'outcome_unknown',
});

function approved(decision) {
  return (
    decision === true ||
    decision === 'approved' ||
    (decision && typeof decision === 'object' && decision.status === 'approved')
  );
}

function opaquePublicationId() {
  return `swarm_pub_${crypto.randomUUID().replaceAll('-', '').slice(0, 24)}`;
}

function delay(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function observe(promise, timeoutMs, signal) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve(value);
    };
    const onAbort = () => finish({ kind: 'aborted' });
    const timer = setTimeout(() => finish({ kind: 'timeout' }), timeoutMs);
    timer.unref?.();
    if (signal?.aborted) return finish({ kind: 'aborted' });
    signal?.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => finish({ kind: 'result', value }),
      (error) => finish({ kind: 'error', error })
    );
  });
}

function safeMessage(error, fallback) {
  const message = typeof error?.message === 'string' ? error.message.trim() : '';
  return (message || fallback).slice(0, 500);
}

function publicReceipt(operation) {
  return Object.freeze({
    publicationId: operation.publicationId,
    state: operation.state,
    applicationState:
      operation.state === PUBLICATION_STATES.COMPLETED
        ? 'applied'
        : operation.state === PUBLICATION_STATES.FAILED
          ? 'not_applied'
          : 'possibly_applied',
    kind: operation.kind,
    name: operation.name,
    public: true,
    ...(Number.isSafeInteger(operation.bytes) && { bytes: operation.bytes }),
    ...(Number.isSafeInteger(operation.progress) && { progress: operation.progress }),
    ...(operation.indexDocument && { indexDocument: operation.indexDocument }),
    ...(operation.reference && { reference: operation.reference }),
    ...(operation.bzzUrl && { bzzUrl: operation.bzzUrl }),
    ...(typeof operation.verified === 'boolean' && { verified: operation.verified }),
    ...(operation.error && { error: operation.error }),
  });
}

function operationResult(operation) {
  const publication = publicReceipt(operation);
  return { publication, summary: { publication } };
}

class SwarmPublicationController {
  constructor(options = {}) {
    if (
      !options.attachmentStore ||
      typeof options.attachmentStore.resolvePublicationSource !== 'function'
    ) {
      throw new TypeError('Swarm publications require an attachment source resolver');
    }
    const publishService =
      options.publishService ||
      (options.publishData &&
      options.publishFile &&
      options.publishDirectory &&
      options.getUploadStatus
        ? {}
        : require('../swarm/publish-service'));
    const publishHistory =
      options.publishHistory ||
      (options.addHistoryEntry && options.updateHistoryEntry
        ? {}
        : require('../swarm/publish-history'));
    this.attachmentStore = options.attachmentStore;
    this.publishData = options.publishData || publishService.publishData;
    this.publishFile = options.publishFile || publishService.publishFile;
    this.publishDirectory = options.publishDirectory || publishService.publishDirectory;
    this.getUploadStatus = options.getUploadStatus || publishService.getUploadStatus;
    this.addHistoryEntry = options.addHistoryEntry || publishHistory.addEntry;
    this.updateHistoryEntry = options.updateHistoryEntry || publishHistory.updateEntry;
    this.verifyPublication = options.verifyPublication || (async (reference) => {
      const { getBee } = require('../swarm/swarm-service');
      await getBee().downloadData(reference);
      return true;
    });
    this.publicationIdFactory = options.publicationIdFactory || opaquePublicationId;
    this.sleep = options.sleep || delay;
    this.interactiveTimeoutMs = options.interactiveTimeoutMs || DEFAULT_INTERACTIVE_TIMEOUT_MS;
    this.statusWaitTimeoutMs = options.statusWaitTimeoutMs || DEFAULT_STATUS_WAIT_TIMEOUT_MS;
    this.progressPollMs = options.progressPollMs || DEFAULT_PROGRESS_POLL_MS;
    this.progressTimeoutMs = options.progressTimeoutMs || DEFAULT_PROGRESS_TIMEOUT_MS;
    this.operations = new Map();
    this.active = new Map();
    this.disposed = false;
  }

  async publish(input, context = {}) {
    if (this.disposed) {
      throw new AutomationError(
        ERROR_CODES.CAPABILITY_UNAVAILABLE,
        'Swarm publishing is shutting down'
      );
    }
    if (context.signal?.aborted) {
      throw new AutomationError(ERROR_CODES.USER_CANCELLED, 'The publication was cancelled');
    }
    const ownerId = context.conversationId || 'local';
    const source = input.resourceId
      ? await this.attachmentStore.resolvePublicationSource(ownerId, input.resourceId)
      : {
          kind: 'text',
          name: 'Text',
          text: input.text,
          bytes: Buffer.byteLength(input.text, 'utf8'),
          contentType: input.contentType,
        };
    if (input.indexDocument && source.kind !== 'folder') {
      throw new AutomationError(
        ERROR_CODES.INVALID_ARGUMENT,
        'indexDocument can only be used with an attached folder'
      );
    }
    if (typeof context.requestApproval !== 'function') {
      throw new AutomationError(
        ERROR_CODES.APPROVAL_REQUIRED,
        'Publishing to the public Swarm network requires user approval'
      );
    }
    const decision = await context.requestApproval({
      action: 'swarm_publish',
      operation: OPERATIONS.SWARM_PUBLISH,
      label: source.name,
      publication: {
        kind: source.kind,
        name: source.name,
        public: true,
        ...(Number.isSafeInteger(source.bytes) && { bytes: source.bytes }),
        ...(source.contentType && { contentType: source.contentType }),
        ...(input.indexDocument && { indexDocument: input.indexDocument }),
      },
    });
    if (!approved(decision)) {
      throw new AutomationError(
        ERROR_CODES.SWARM_PUBLICATION_CANCELLED_BY_USER,
        'The user declined the Swarm publication'
      );
    }
    if (context.signal?.aborted) {
      throw new AutomationError(ERROR_CODES.USER_CANCELLED, 'The publication was cancelled');
    }

    const publicationId = this.publicationIdFactory();
    const history = this.addHistoryEntry({
      type: source.kind === 'folder' ? 'directory' : source.kind === 'file' ? 'file' : 'data',
      name: source.name,
      status: 'uploading',
      origin: AGENT_PUBLISH_ORIGIN,
      ...(Number.isSafeInteger(source.bytes) && { bytesSize: source.bytes }),
    });
    const operation = {
      publicationId,
      ownerId,
      state: PUBLICATION_STATES.UPLOADING,
      kind: source.kind,
      name: source.name,
      public: true,
      progress: 0,
      historyId: history.id,
      ...(Number.isSafeInteger(source.bytes) && { bytes: source.bytes }),
      ...(input.indexDocument && { indexDocument: input.indexDocument }),
    };
    this.operations.set(publicationId, operation);
    this.#emitProgress(operation, context.onProgress);

    const active = this.#run(operation, source, input, context.onProgress);
    this.active.set(publicationId, active);
    active.then(
      () => this.active.delete(publicationId),
      () => this.active.delete(publicationId)
    );
    active.catch(() => {});

    const observed = await observe(active, this.interactiveTimeoutMs, context.signal);
    if (observed.kind === 'result') return observed.value;
    if (observed.kind === 'error') throw observed.error;
    return operationResult(operation);
  }

  async status(input, context = {}) {
    const ownerId = context.conversationId || 'local';
    if (!input.publicationId) {
      const publications = [...this.operations.values()]
        .filter((operation) => operation.ownerId === ownerId)
        .slice(-20)
        .reverse()
        .map(publicReceipt);
      return { publications, summary: { publications } };
    }
    const operation = this.operations.get(input.publicationId);
    if (!operation || operation.ownerId !== ownerId) {
      throw new AutomationError(
        ERROR_CODES.CAPABILITY_UNAVAILABLE,
        'That Swarm publication is not available in this conversation'
      );
    }
    const active = this.active.get(input.publicationId);
    if (active) await observe(active, this.statusWaitTimeoutMs);
    return operationResult(operation);
  }

  dispose() {
    this.disposed = true;
    for (const operation of this.operations.values()) {
      if (this.active.has(operation.publicationId)) {
        operation.state = PUBLICATION_STATES.OUTCOME_UNKNOWN;
        operation.error = 'Freedom stopped observing the publication before it completed';
      }
    }
  }

  async #run(operation, source, input, onProgress) {
    try {
      const result =
        source.kind === 'folder'
          ? await this.publishDirectory(source.path, { indexDocument: input.indexDocument })
          : source.kind === 'file'
            ? await this.publishFile(source.path, {
                name: source.name,
              })
            : await this.publishData(source.text, {
                contentType: source.contentType,
              });
      operation.reference = result.reference;
      operation.bzzUrl = result.bzzUrl;
      if (Number.isSafeInteger(result.bytesSize)) operation.bytes = result.bytesSize;
      this.updateHistoryEntry(operation.historyId, { status: 'completed', ...result });

      if (Number.isSafeInteger(result.tagUid)) {
        await this.#pollProgress(operation, result.tagUid, onProgress);
      }
      operation.state = PUBLICATION_STATES.VERIFYING;
      this.#emitProgress(operation, onProgress);
      try {
        await this.verifyPublication(result.reference);
        operation.verified = true;
      } catch (error) {
        operation.verified = false;
        operation.error = safeMessage(error, 'The publication could not be verified yet');
      }
      operation.progress = 100;
      operation.state = PUBLICATION_STATES.COMPLETED;
      this.#emitProgress(operation, onProgress);
      return operationResult(operation);
    } catch (error) {
      operation.state = PUBLICATION_STATES.FAILED;
      operation.error = safeMessage(error, 'The Swarm publication failed');
      this.updateHistoryEntry(operation.historyId, {
        status: 'failed',
        errorMessage: operation.error,
      });
      this.#emitProgress(operation, onProgress);
      throw error instanceof AutomationError
        ? error
        : new AutomationError(ERROR_CODES.CAPABILITY_UNAVAILABLE, operation.error, {
            suggestedAction: 'Check Swarm node readiness and postage, then try again.',
          });
    }
  }

  async #pollProgress(operation, tagUid, onProgress) {
    const deadline = Date.now() + this.progressTimeoutMs;
    while (!this.disposed && Date.now() < deadline) {
      try {
        const status = await this.getUploadStatus(tagUid);
        if (Number.isSafeInteger(status.progress)) {
          operation.progress = Math.max(operation.progress || 0, status.progress);
          this.#emitProgress(operation, onProgress);
        }
        if (status.done) return;
      } catch {
        return;
      }
      await this.sleep(this.progressPollMs);
    }
  }

  #emitProgress(operation, onProgress) {
    if (typeof onProgress !== 'function') return;
    onProgress({
      state: operation.state,
      progress: operation.progress,
      publication: publicReceipt(operation),
    });
  }
}

module.exports = {
  AGENT_PUBLISH_ORIGIN,
  PUBLICATION_STATES,
  SwarmPublicationController,
  opaquePublicationId,
  publicReceipt,
};
