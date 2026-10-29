'use strict';

const crypto = require('crypto');
const path = require('path');
const { ManagedWorkspaceSourceReader } = require('./managed-workspace-source-reader');
const { MAX_FINDINGS, publicationScanSummary } = require('./publication-scan');
const { preparePublicationOffThread } = require('./publication-scan-host');
const { OPERATIONS } = require('../automation/contract/operations');
const { AutomationError, ERROR_CODES } = require('../automation/contract/errors');

const AGENT_PUBLISH_ORIGIN = 'freedom://agent';
const DEFAULT_INTERACTIVE_TIMEOUT_MS = 10_000;
const DEFAULT_STATUS_WAIT_TIMEOUT_MS = 10_000;
const DEFAULT_PROGRESS_POLL_MS = 500;
const DEFAULT_PROGRESS_TIMEOUT_MS = 120_000;
const FEED_TIMEOUT_MS = 60_000;
// A stable address is a Swarm feed owned by the user's Swarm identity (the
// Ant node's wallet key). Its topic is derived from this prefix and the name
// the publication asks for, so the same name always maps to the same address.
const STABLE_ADDRESS_TOPIC_PREFIX = 'freedom-agent/stable-address/';
const STABLE_ADDRESS_NAME = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const PUBLICATION_TARGETS = Object.freeze({ PUBLIC: 'public', DRAFT: 'draft' });
const PUBLICATION_STATES = Object.freeze({
  WAITING_POSTAGE: 'waiting_postage',
  CONFIRMING: 'confirming',
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

function stableAddressReceipt(stableAddress) {
  if (!stableAddress) return undefined;
  return Object.freeze({
    name: stableAddress.name,
    owner: stableAddress.owner,
    ...(stableAddress.reference && { reference: stableAddress.reference, bzzUrl: stableAddress.bzzUrl }),
    ...(Number.isSafeInteger(stableAddress.index) && { index: stableAddress.index }),
    ...(typeof stableAddress.updated === 'boolean' && { updated: stableAddress.updated }),
    ...(stableAddress.error && { error: stableAddress.error }),
  });
}

// Ant keys a tag on the upload's 32-byte root chunk address. For an
// encrypted (draft) upload that is the leading 64 hex of the 128-hex
// reference; the trailing 64 hex are the decryption key and never appear.
function tagMatchesReference(tagReference, reference) {
  if (!tagReference) return true;
  return tagReference === reference ||
    (/^[a-f0-9]{128}$/.test(reference || '') && tagReference === reference.slice(0, 64));
}

function publicReceipt(operation) {
  const draft = operation.target === PUBLICATION_TARGETS.DRAFT;
  return Object.freeze({
    publicationId: operation.publicationId,
    state: operation.state,
    applicationState:
      operation.state === PUBLICATION_STATES.COMPLETED
        ? 'applied'
        : operation.state === PUBLICATION_STATES.FAILED
          ? operation.dispatched ? 'possibly_applied' : 'not_applied'
          : 'possibly_applied',
    kind: operation.kind,
    name: operation.name,
    // Receipts record which kind of publication this was. Records saved
    // before drafts existed have no target and were all public.
    target: draft ? PUBLICATION_TARGETS.DRAFT : PUBLICATION_TARGETS.PUBLIC,
    public: !draft,
    ...(draft && { encrypted: true }),
    ...(operation.stableAddress && { stableAddress: stableAddressReceipt(operation.stableAddress) }),
    ...(Number.isSafeInteger(operation.bytes) && { bytes: operation.bytes }),
    ...(Number.isSafeInteger(operation.progress) && { progress: operation.progress }),
    ...(operation.indexDocument && { indexDocument: operation.indexDocument }),
    ...(operation.reference && { reference: operation.reference }),
    ...(operation.unencryptedReference && { unencryptedReference: operation.unencryptedReference }),
    ...(operation.bzzUrl && { bzzUrl: operation.bzzUrl }),
    ...(typeof operation.verified === 'boolean' && { verified: operation.verified }),
    ...(operation.error && { error: operation.error }),
    ...(operation.message && { message: operation.message }),
    ...(operation.batchId && { batchId: operation.batchId }),
    ...(operation.prepublishScan && { prepublishScan: operation.prepublishScan }),
  });
}

function publicationDeclined(message, suggestedAction) {
  return new AutomationError(ERROR_CODES.SWARM_PUBLICATION_CANCELLED_BY_USER, message,
    suggestedAction ? { suggestedAction } : undefined);
}

function stringList(value, max) {
  return Array.isArray(value) ? [...new Set(value.filter(item => typeof item === 'string' && item.length <= 1_024))].slice(0, max) : [];
}

// Applies the user's per-file and per-finding choices from the approval card.
// The renderer only proposes them; this is where secrets stay blocked.
function resolveScan(scan, decision) {
  const choice = decision && typeof decision === 'object' ? decision : {};
  if (choice.status !== 'approved' && choice.publicationFix) {
    const fixPaths = stringList(choice.publicationFix.paths, MAX_FINDINGS);
    const requested = scan.findings.filter(finding => fixPaths.includes(finding.path));
    if (!requested.length) throw publicationDeclined('The user declined the Swarm publication');
    const lines = requested.slice(0, 40).map(finding =>
      `${finding.path}: ${finding.rule}${Number.isSafeInteger(finding.line) ? ` (line ${finding.line})` : ''}`);
    throw publicationDeclined(
      `The user asked you to fix pre-publish scan findings before publishing. Nothing was uploaded. Findings: ${lines.join('; ')}.`,
      'Remove or replace the flagged values in those files without repeating them in chat (keep secrets out of published files entirely), then call swarm_publish again. Freedom scans the new snapshot and the user approves it again.');
  }
  if (!approved(decision)) return null;
  const sourceKind = scan.source.kind;
  const excludedPaths = stringList(choice.publicationExclusions, MAX_FINDINGS);
  const acknowledged = new Set(stringList(choice.publicationAcknowledged, MAX_FINDINGS));
  if (excludedPaths.length && sourceKind !== 'folder') {
    throw new AutomationError(ERROR_CODES.INVALID_ARGUMENT, 'Only files inside a folder publication can be excluded');
  }
  const filePaths = new Set((scan.source.files || []).map(file => file.path));
  if (excludedPaths.some(item => !filePaths.has(item))) {
    throw new AutomationError(ERROR_CODES.INVALID_ARGUMENT, 'An excluded file is not part of this publication');
  }
  const remaining = scan.findings.filter(finding => !excludedPaths.includes(finding.path));
  const unresolved = remaining.filter(finding => finding.blocking && !acknowledged.has(finding.id));
  if (unresolved.length) {
    throw publicationDeclined(
      `Publication blocked: ${unresolved.length} pre-publish finding${unresolved.length === 1 ? '' : 's'} (${[...new Set(unresolved.map(finding => finding.rule))].join(', ')}) were not resolved. Nothing was uploaded.`,
      'Ask the user how to proceed, or remove the flagged values and publish again.');
  }
  if (!excludedPaths.length) return { source: scan.source, findings: remaining, excludedByUser: 0 };
  const files = scan.source.files.filter(file => !excludedPaths.includes(file.path));
  if (!files.length) throw publicationDeclined('Every file was excluded. Nothing was uploaded.');
  return {
    source: Object.freeze({ ...scan.source, files: Object.freeze(files),
      bytes: files.reduce((total, file) => total + file.bytes.byteLength, 0) }),
    findings: remaining,
    excludedByUser: excludedPaths.length,
  };
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
      options.publishCollection &&
      options.getUploadStatus
        ? {}
        : require('../swarm/publish-service'));
    const publishHistory =
      options.publishHistory ||
      (options.addHistoryEntry && options.updateHistoryEntry
        ? {}
        : require('../swarm/publish-history'));
    this.attachmentStore = options.attachmentStore;
    this.readAttachmentSource = options.readAttachmentSource || (async (descriptor) => {
      const root = descriptor.kind === 'folder' ? descriptor.path : path.dirname(descriptor.path);
      const reader = new ManagedWorkspaceSourceReader({ workspaceController: {
        resolveWorkspacePath: async () => ({ path: root }),
      } });
      const source = await reader.read('attachment', descriptor.kind === 'folder' ? '.' : path.basename(descriptor.path));
      return { ...source, sourceType: 'attachment', workspacePath: undefined, name: descriptor.name };
    });
    this.workspaceSourceReader = options.workspaceSourceReader || null;
    this.publishData = options.publishData || publishService.publishData;
    this.publishFile = options.publishFile || publishService.publishFile;
    this.publishDirectory = options.publishDirectory || publishService.publishDirectory;
    this.publishCollection = options.publishCollection || publishService.publishCollection;
    this.getUploadStatus = options.getUploadStatus || publishService.getUploadStatus;
    this.addHistoryEntry = options.addHistoryEntry || publishHistory.addEntry;
    this.updateHistoryEntry = options.updateHistoryEntry || publishHistory.updateEntry;
    this.createFeed = options.createFeed || ((...args) => require('../swarm/feed-service').createFeed(...args));
    this.updateFeed = options.updateFeed || ((...args) => require('../swarm/feed-service').updateFeed(...args));
    this.readFeedState = options.readFeedState || ((...args) => require('../swarm/feed-service').readFeedState(...args));
    // The user's Swarm identity: the Ant node's wallet key from the unlocked
    // vault. Its private key is read only to sign a feed update, never stored.
    // The signer carries the vault epoch it was read in; a feed update made
    // with it stops if the vault was locked since (K-1).
    this.feedSigner = options.feedSigner || (async () => {
      const epoch = require('../identity/vault-epoch').currentVaultEpoch();
      const keys = require('../identity-manager').getDerivedKeys();
      if (!keys?.beeWallet?.privateKey) throw new Error('Freedom’s vault is locked');
      return { address: keys.beeWallet.address, privateKey: keys.beeWallet.privateKey, epoch };
    });
    this.verifyPublication =
      options.verifyPublication ||
      (async (reference) => {
        const { getBee } = require('../swarm/swarm-service');
        await getBee().data.download(reference);
        return true;
      });
    this.publicationIdFactory = options.publicationIdFactory || opaquePublicationId;
    this.sleep = options.sleep || delay;
    this.interactiveTimeoutMs = options.interactiveTimeoutMs || DEFAULT_INTERACTIVE_TIMEOUT_MS;
    this.statusWaitTimeoutMs = options.statusWaitTimeoutMs || DEFAULT_STATUS_WAIT_TIMEOUT_MS;
    this.progressPollMs = options.progressPollMs || DEFAULT_PROGRESS_POLL_MS;
    this.progressTimeoutMs = options.progressTimeoutMs || DEFAULT_PROGRESS_TIMEOUT_MS;
    this.postageReadiness = options.postageReadiness || null;
    this.store = options.store || null;
    // Off the main thread: the scan reads every byte of up to 50 MiB.
    this.preparePublication = options.preparePublication || preparePublicationOffThread;
    this.now = options.now || Date.now;
    this.jobTimeoutMs = options.jobTimeoutMs || 10 * 60_000;
    this.readinessPollMs = options.readinessPollMs || 5_000;
    this.retryDelayMs = options.retryDelayMs || 30_000;
    this.operations = new Map((this.store?.list() || []).map(record => [record.publicationId, record]));
    for (const operation of this.operations.values()) {
      if (!['completed', 'failed'].includes(operation.state)) {
        operation.recovered = true;
        operation.state = operation.dispatched ? PUBLICATION_STATES.OUTCOME_UNKNOWN : PUBLICATION_STATES.FAILED;
        operation.message = operation.dispatched ? 'Observation was interrupted. Check this publication before starting another upload.' : 'Freedom stopped before uploading. Start publication again to review the content.';
      }
    }
    this.active = new Map();
    this.preparingOwners = new Set();
    this.disposed = false;
  }

  async publish(input, context = {}) {
    const ownerId = context.conversationId || 'local';
    if (this.preparingOwners.has(ownerId)) throw new AutomationError(ERROR_CODES.CAPABILITY_UNAVAILABLE,
      'A publication is already being prepared in this conversation. Wait for its receipt and check its status; do not submit another upload.');
    this.preparingOwners.add(ownerId);
    try { return await this.#publish(input, context); }
    finally { this.preparingOwners.delete(ownerId); }
  }

  async #publish(input, context) {
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
    const unresolved = [...this.operations.values()].find(item => item.ownerId === ownerId && !['completed', 'failed'].includes(item.state));
    if (unresolved) return this.status({ publicationId: unresolved.publicationId }, context);
    const sourceDescriptor = input.resourceId
      ? await this.readAttachmentSource(await this.attachmentStore.resolvePublicationSource(ownerId, input.resourceId))
      : input.workspacePath
        ? await this.#readWorkspaceSource(ownerId, input.workspacePath)
        : {
            kind: 'text',
            name: 'Text',
            text: input.text,
            bytes: Buffer.byteLength(input.text, 'utf8'),
            contentType: input.contentType,
          };
    let scan;
    try { scan = await this.preparePublication(sourceDescriptor, { signal: context.signal }); }
    catch (error) {
      if (context.signal?.aborted) throw new AutomationError(ERROR_CODES.USER_CANCELLED, 'The publication was cancelled');
      throw new AutomationError(['PUBLICATION_EMPTY', 'PUBLICATION_TOO_MANY_FINDINGS'].includes(error?.code) ? ERROR_CODES.INVALID_ARGUMENT : ERROR_CODES.CAPABILITY_UNAVAILABLE,
        safeMessage(error, 'Freedom could not check the publication before upload'));
    }
    if (input.indexDocument && sourceDescriptor.kind !== 'folder') {
      throw new AutomationError(
        ERROR_CODES.INVALID_ARGUMENT,
        'indexDocument can only be used with a folder publication'
      );
    }
    if (typeof context.requestApproval !== 'function') {
      throw new AutomationError(
        ERROR_CODES.APPROVAL_REQUIRED,
        'Publishing to the public Swarm network requires user approval'
      );
    }
    const target = input.target === undefined ? PUBLICATION_TARGETS.PUBLIC : input.target;
    if (!Object.values(PUBLICATION_TARGETS).includes(target)) {
      throw new AutomationError(ERROR_CODES.INVALID_ARGUMENT, 'target must be public or draft');
    }
    const draft = target === PUBLICATION_TARGETS.DRAFT;
    const stableAddress = input.stableAddress === undefined ? null : await this.#planStableAddress(input.stableAddress, draft);
    const postage = await this.#previewPostage(ownerId, scan.source, draft);
    if (context.signal?.aborted) throw new AutomationError(ERROR_CODES.USER_CANCELLED, 'The publication was cancelled');
    // Each call is its own approval: a draft approved earlier never covers a
    // later public publication of the same content, or the reverse.
    const decision = await context.requestApproval({
      action: 'swarm_publish',
      operation: OPERATIONS.SWARM_PUBLISH,
      label: sourceDescriptor.name,
      // Shown to the user only. Excerpts are redacted and never reach the model.
      publication: {
        kind: scan.source.kind,
        name: scan.source.name,
        target,
        public: !draft,
        ...(draft && { encrypted: true }),
        ...(stableAddress && { stableAddress: {
          name: stableAddress.name,
          owner: stableAddress.owner,
          existing: stableAddress.existing,
          ...(stableAddress.latestIndex !== undefined && { latestIndex: stableAddress.latestIndex }),
          ...(stableAddress.previousBzzUrl && { currentBzzUrl: stableAddress.previousBzzUrl }),
        } }),
        ...(postage && { postage }),
        ...(scan.source.files && { files: scan.source.files.map(file => ({ path: file.path, bytes: file.bytes.length })) }),
        ...(scan.findings.length && { findings: scan.findings }),
        ...(scan.excluded.length && { excluded: scan.excluded }),
        ...(scan.stripped.length && { stripped: scan.stripped }),
        ...(scan.source.kind === 'text' && { text: scan.source.text }),
        ...(Number.isSafeInteger(scan.source.bytes) && { bytes: scan.source.bytes }),
        ...(sourceDescriptor.contentType && { contentType: sourceDescriptor.contentType }),
        ...(sourceDescriptor.sourceType === 'workspace' && {
          workspacePath: sourceDescriptor.workspacePath,
        }),
        ...(input.indexDocument && { indexDocument: input.indexDocument }),
      },
    });
    const resolved = resolveScan(scan, decision);
    if (!resolved) {
      throw new AutomationError(
        ERROR_CODES.SWARM_PUBLICATION_CANCELLED_BY_USER,
        'The user declined the Swarm publication'
      );
    }
    if (context.signal?.aborted) {
      throw new AutomationError(ERROR_CODES.USER_CANCELLED, 'The publication was cancelled');
    }
    // The upload sends these exact buffers: the scanned snapshot, minus any
    // files the user excluded on the approval card.
    const source = resolved.source;
    if (
      source.kind === 'folder' &&
      input.indexDocument &&
      !source.files.some((file) => file.path === input.indexDocument)
    ) {
      throw new AutomationError(
        ERROR_CODES.INVALID_ARGUMENT,
        'indexDocument does not identify a file in the selected workspace folder'
      );
    }

    const publicationId = this.publicationIdFactory();
    const history = this.addHistoryEntry({
      type: source.kind === 'folder' ? 'directory' : source.kind === 'file' ? 'file' : 'data',
      name: draft ? `${source.name} (private draft link)` : source.name,
      status: 'uploading',
      origin: AGENT_PUBLISH_ORIGIN,
      ...(Number.isSafeInteger(source.bytes) && { bytesSize: source.bytes }),
    });
    const operation = {
      publicationId,
      ownerId,
      state: this.postageReadiness ? PUBLICATION_STATES.WAITING_POSTAGE : PUBLICATION_STATES.UPLOADING,
      backendKey: this.postageReadiness?.backendKey(),
      createdAt: this.now(),
      dispatched: false,
      kind: source.kind,
      name: source.name,
      target,
      public: !draft,
      ...(draft && { encrypted: true }),
      ...(stableAddress && { stableAddress: { name: stableAddress.name, owner: stableAddress.owner, topic: stableAddress.topic,
        ...(stableAddress.latestIndex !== undefined && { knownIndex: stableAddress.latestIndex }) } }),
      // The batch the approval card showed is the batch the upload uses.
      ...(postage?.batchId && { plannedBatchId: postage.batchId }),
      progress: 0,
      historyId: history.id,
      ...(Number.isSafeInteger(source.bytes) && { bytes: source.bytes }),
      ...(input.indexDocument && { indexDocument: input.indexDocument }),
      prepublishScan: { ...publicationScanSummary(scan, resolved.findings), excludedByUser: resolved.excludedByUser },
    };
    this.operations.set(publicationId, operation);
    try { this.#emitProgress(operation, context.onProgress); }
    catch (error) {
      operation.state = PUBLICATION_STATES.FAILED;
      operation.message = 'Publication could not be recorded. No upload was sent; check available disk space before retrying.';
      this.updateHistoryEntry(operation.historyId, { status: 'failed', errorMessage: operation.message });
      throw error;
    }

    const onAbort = () => { operation.stopRequested = true; };
    context.signal?.addEventListener('abort', onAbort, { once: true });
    const active = this.#run(operation, source, input, context.onProgress);
    active.finally(() => context.signal?.removeEventListener('abort', onAbort)).catch(() => {});
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
    if (!this.active.has(input.publicationId) && operation.state === PUBLICATION_STATES.OUTCOME_UNKNOWN && operation.reference) {
      if (operation.backendKey && operation.backendKey !== this.postageReadiness?.backendKey()) return operationResult(operation);
      operation.stopRequested = false;
      const active = this.#finishUpload(operation, context.onProgress).catch(error => {
        operation.state = PUBLICATION_STATES.OUTCOME_UNKNOWN;
        operation.message = safeMessage(error, 'Publication could not be confirmed');
        this.#emitProgress(operation, context.onProgress);
      }).finally(() => this.active.delete(input.publicationId));
      this.active.set(input.publicationId, active);
    }
    const active = this.active.get(input.publicationId);
    if (active) await observe(active, this.statusWaitTimeoutMs, context.signal);
    return operationResult(operation);
  }

  async waitForPublications(ownerId, ids, signal) {
    const receipts = [];
    for (const id of new Set(ids)) {
      const operation = this.operations.get(id);
      if (!operation || operation.ownerId !== ownerId) continue;
      const active = this.active.get(id);
      if (active) {
        const result = await observe(active, this.jobTimeoutMs + this.progressTimeoutMs + 1000, signal);
        if (result.kind === 'aborted') { operation.stopRequested = true; return []; }
        if (result.kind === 'timeout') {
          operation.stopRequested = true;
          operation.state = PUBLICATION_STATES.OUTCOME_UNKNOWN;
          operation.message = 'Monitoring reached its deadline. Check this upload before retrying.';
          this.#emitProgress(operation);
        }
      }
      receipts.push(publicReceipt(operation));
    }
    return receipts;
  }

  stopObserving(ownerId, ids) {
    const receipts = [];
    for (const id of ids) {
      const operation = this.operations.get(id);
      if (!operation || operation.ownerId !== ownerId || ['completed', 'failed'].includes(operation.state)) continue;
      operation.stopRequested = true;
      operation.state = operation.dispatched ? PUBLICATION_STATES.OUTCOME_UNKNOWN : PUBLICATION_STATES.FAILED;
      operation.message = operation.dispatched ? 'Monitoring stopped. The upload may still finish; check it before retrying.' : 'Stopped before uploading. No content was sent.';
      this.#emitProgress(operation);
      receipts.push(publicReceipt(operation));
    }
    return receipts;
  }

  deleteConversation(ownerId) {
    this.store?.deleteConversation(ownerId);
    for (const [id, operation] of this.operations) if (operation.ownerId === ownerId) {
      operation.stopRequested = true;
      this.operations.delete(id);
    }
  }

  dispose() {
    this.disposed = true;
    for (const operation of this.operations.values()) {
      if (this.active.has(operation.publicationId)) {
        operation.stopRequested = true;
        operation.state = PUBLICATION_STATES.OUTCOME_UNKNOWN;
        operation.message = 'Freedom stopped observing the publication before it completed';
        this.store?.save(operation);
      }
    }
  }

  #checkOperation(operation) {
    if (this.disposed || operation.stopRequested) throw new Error('Publication monitoring was stopped. An upload already sent may still finish; check its receipt before retrying.');
    if (operation.backendKey && operation.backendKey !== this.postageReadiness?.backendKey()) throw new Error('The Swarm node changed. Reconnect the original node to check this publication.');
  }

  async #waitForPostage(operation, deadline, onProgress) {
    operation.state = PUBLICATION_STATES.WAITING_POSTAGE;
    operation.message = 'Waiting for postage to become ready';
    this.#emitProgress(operation, onProgress);
    while (this.now() < deadline) {
      this.#checkOperation(operation);
      try {
        const result = await this.postageReadiness.inspect(operation.batchId, operation.bytes || 0, operation.firstConfirmedBlock);
        operation.firstConfirmedBlock = result.firstConfirmedBlock;
        operation.message = result.ready ? 'Postage is ready' : result.blocksRemaining > 0
          ? `Waiting for postage · ${result.blocksRemaining} more blocks` : 'Waiting for the node to accept this postage batch';
        this.#emitProgress(operation, onProgress);
        if (result.ready) return;
      } catch (error) { if (error.permanent) throw error; }
      await this.sleep(this.readinessPollMs);
    }
    throw new Error('Postage readiness could not be confirmed in time. The existing batch was retained; no additional purchase was made.');
  }

  async #readWorkspaceSource(ownerId, workspacePath) {
    if (typeof this.workspaceSourceReader?.read !== 'function') {
      throw new AutomationError(
        ERROR_CODES.CAPABILITY_UNAVAILABLE,
        'Managed workspace publication is unavailable'
      );
    }
    try {
      return await this.workspaceSourceReader.read(ownerId, workspacePath);
    } catch (error) {
      throw new AutomationError(
        error?.code === 'INVALID_WORKSPACE_PUBLICATION_PATH'
          ? ERROR_CODES.INVALID_ARGUMENT
          : ERROR_CODES.CAPABILITY_UNAVAILABLE,
        safeMessage(error, 'Freedom could not read the managed workspace publication source')
      );
    }
  }

  async #run(operation, source, input, onProgress) {
    try {
      const deadline = this.now() + this.jobTimeoutMs;
      if (this.postageReadiness) {
        operation.batchId = operation.plannedBatchId || await this.postageReadiness.select(operation.ownerId, operation.bytes || 0);
        operation.firstConfirmedBlock = [...this.operations.values()].find(previous => previous !== operation && previous.batchId === operation.batchId && previous.backendKey === operation.backendKey && Number.isSafeInteger(previous.firstConfirmedBlock))?.firstConfirmedBlock;
        await this.#waitForPostage(operation, deadline, onProgress);
      }
      let result;
      for (let attempt = 0; attempt < 3; attempt++) {
        this.#checkOperation(operation);
        operation.state = PUBLICATION_STATES.UPLOADING;
        operation.message = attempt ? 'Retrying upload with the same postage batch' : 'Uploading to Swarm';
        operation.dispatched = true;
        operation.failureKnown = false;
        this.#emitProgress(operation, onProgress); // Persist before dispatch.
        const options = {
          ...(operation.batchId && { batchId: operation.batchId }),
          // Swarm-Encrypt: true. Only ever set for an approved draft link.
          ...(operation.target === PUBLICATION_TARGETS.DRAFT && { encrypt: true }),
        };
        const upload = source.kind === 'folder'
          ? this.publishCollection(source.files, { ...options, indexDocument: input.indexDocument })
          : source.kind === 'file'
            ? this.publishData(source.data, { ...options, name: source.name, contentType: source.contentType })
            : this.publishData(source.text, { ...options, contentType: source.contentType });
        const observed = await observe(Promise.resolve(upload), Math.max(1, deadline - this.now()));
        if (observed.kind === 'timeout') {
          // The transport may still resolve. Retain its late receipt without
          // waking a stopped turn or dispatching any further network request.
          Promise.resolve(upload).then(result => {
            if (!this.operations.has(operation.publicationId)) return;
            try {
              this.#recordUploadResult(operation, result);
            } catch (error) {
              // A late draft result that came back unencrypted is a known
              // failure with a known public reference: record it rather than
              // leaving the receipt unknown with the reference unsaved.
              if (!operation.unencryptedReference) return;
              operation.state = PUBLICATION_STATES.FAILED;
              operation.error = safeMessage(error, 'The Swarm publication failed');
              operation.message = 'Upload failed. The existing postage batch was retained.';
              // History still holds the timeout's "outcome is unknown" text.
              this.updateHistoryEntry(operation.historyId, { status: 'failed', errorMessage: operation.error });
            }
            this.#emitProgress(operation);
          }).catch(() => {});
          throw new Error('The upload has not returned a result. Its outcome is unknown; do not start another upload.');
        }
        if (observed.kind === 'result') { result = observed.value; break; }
        const error = observed.error;
        // Only the explicit peer batch-not-found response is a propagation
        // retry. A transport timeout or arbitrary 422 may have applied.
        const propagation = operation.batchId && new RegExp(String.raw`postage batch (?:0x)?${operation.batchId} rejected by \d+ peer\(s\) as not found on-chain`, 'i').test(error?.message || '');
        operation.failureKnown = propagation || (error?.status >= 400 && error.status < 500);
        if (!propagation || attempt === 2 || this.now() + this.retryDelayMs >= deadline) throw error;
        operation.state = PUBLICATION_STATES.WAITING_POSTAGE;
        operation.message = 'Peers have not recognized this batch yet. Waiting before retrying the same upload.';
        this.#emitProgress(operation, onProgress);
        await this.sleep(this.retryDelayMs);
        await this.#waitForPostage(operation, deadline, onProgress);
      }
      this.#recordUploadResult(operation, result);
      this.#emitProgress(operation, onProgress);
      await this.#finishUpload(operation, onProgress);
      return operationResult(operation);
    } catch (error) {
      operation.state = operation.dispatched && !operation.failureKnown ? PUBLICATION_STATES.OUTCOME_UNKNOWN : PUBLICATION_STATES.FAILED;
      operation.error = safeMessage(error, 'The Swarm publication failed');
      operation.message = operation.state === 'outcome_unknown' ? 'Publication could not be confirmed. Inspect the existing upload before retrying.' : operation.dispatched ? 'Upload failed. The existing postage batch was retained.' : 'Publication could not start. Check postage readiness.';
      if (error?.capacity) operation.error += ` Upload: ${error.capacity.uploadBytes} bytes; required with safety margin: ${error.capacity.requiredBytes} bytes; largest usable batch remaining: ${error.capacity.largestRemainingBytes} bytes.`;
      this.updateHistoryEntry(operation.historyId, { status: operation.state === 'failed' ? 'failed' : 'uploading', errorMessage: operation.error });
      this.#emitProgress(operation, onProgress);
      throw error instanceof AutomationError ? error : new AutomationError(
        [ERROR_CODES.POSTAGE_CAPACITY_INSUFFICIENT, ERROR_CODES.POSTAGE_UNAVAILABLE].includes(error?.code) ? error.code : ERROR_CODES.CAPABILITY_UNAVAILABLE,
        operation.error, { suggestedAction: 'Check this publication and existing stamps; compare effective remaining capacity. Do not repeat a completed purchase or an upload with unknown outcome.' });
    }
  }

  #recordUploadResult(operation, result) {
    const draft = operation.target === PUBLICATION_TARGETS.DRAFT;
    if (draft && /^[a-f0-9]{64}$/.test(result?.reference || '')) {
      // The node ignored Swarm-Encrypt. Never present this as a private link,
      // but record where the now-public content is, so the user can check it.
      operation.unencryptedReference = result.reference;
      this.updateHistoryEntry(operation.historyId, { status: 'failed', reference: result.reference, bzzUrl: `bzz://${result.reference}` });
      operation.failureKnown = true;
      throw new Error(`The node did not encrypt this upload: it returned the unencrypted reference ${result.reference}. Treat the content as public, and do not share it as a private draft link.`);
    }
    if (!(draft ? /^[a-f0-9]{128}$/ : /^[a-f0-9]{64}$/).test(result?.reference || '') || result.bzzUrl !== `bzz://${result.reference}`) throw new Error('The node returned no valid publication reference. Inspect the upload before retrying.');
    operation.reference = result.reference;
    operation.bzzUrl = result.bzzUrl;
    operation.tagUid = result.tagUid;
    operation.batchId = operation.batchId || result.batchIdUsed;
    if (Number.isSafeInteger(result.bytesSize)) operation.bytes = result.bytesSize;
  }

  async #finishUpload(operation, onProgress) {
    this.#checkOperation(operation);
    if (Number.isSafeInteger(operation.tagUid)) {
      operation.state = PUBLICATION_STATES.CONFIRMING;
      operation.message = 'Waiting for network confirmation';
      this.#emitProgress(operation, onProgress);
      const deadline = this.now() + this.progressTimeoutMs;
      let confirmed = false;
      while (this.now() < deadline) {
        this.#checkOperation(operation);
        try {
          const observed = await observe(Promise.resolve().then(() => this.getUploadStatus(operation.tagUid)), Math.min(10_000, Math.max(1, deadline - this.now())));
          if (observed.kind !== 'result') throw new Error('Status unavailable');
          const status = observed.value;
          if (Number.isSafeInteger(status.progress)) operation.progress = Math.min(99, Math.max(operation.progress || 0, status.progress));
          this.#emitProgress(operation, onProgress);
          const matches = tagMatchesReference(status.reference, operation.reference);
          if (status.done && matches && (!operation.recovered || status.reference)) { confirmed = true; break; }
        } catch { /* A failed poll is not evidence of successful publication. */ }
        await this.sleep(this.progressPollMs);
      }
      if (!confirmed) throw new Error('Network confirmation is still unavailable. Keep this upload receipt and check it again; do not upload another copy.');
    }
    this.#checkOperation(operation);
    if (operation.stableAddress && operation.stableAddress.updated !== true) await this.#updateStableAddress(operation, onProgress);
    this.#checkOperation(operation);
    operation.state = PUBLICATION_STATES.VERIFYING;
    operation.message = 'Checking retrieval';
    this.#emitProgress(operation, onProgress);
    const verified = await observe(Promise.resolve().then(() => this.verifyPublication(operation.reference)), 30_000);
    this.#checkOperation(operation);
    operation.verified = verified.kind === 'result' && verified.value !== false;
    operation.state = PUBLICATION_STATES.COMPLETED;
    operation.progress = 100;
    const done = operation.target === PUBLICATION_TARGETS.DRAFT ? 'Private draft link ready' : 'Published';
    operation.message = `${done} · ${operation.verified ? 'retrieval verified' : 'retrieval verification unavailable'}`;
    if (operation.stableAddress && operation.stableAddress.updated !== true) operation.message += ' · the stable address was not updated';
    delete operation.error;
    if (verified.kind === 'error') operation.error = safeMessage(verified.error, 'Retrieval could not be verified');
    this.updateHistoryEntry(operation.historyId, { status: 'completed', reference: operation.reference, bzzUrl: operation.bzzUrl, tagUid: operation.tagUid, batchIdUsed: operation.batchId });
    this.#emitProgress(operation, onProgress);
  }

  async #planStableAddress(name, draft) {
    if (draft) throw new AutomationError(ERROR_CODES.INVALID_ARGUMENT, 'A private draft link cannot have a stable address');
    if (typeof name !== 'string' || !STABLE_ADDRESS_NAME.test(name)) {
      throw new AutomationError(ERROR_CODES.INVALID_ARGUMENT, 'stableAddress must be 1-64 lowercase letters, digits or inner hyphens');
    }
    let signer;
    try { signer = await this.feedSigner(); }
    catch {
      throw new AutomationError(ERROR_CODES.CAPABILITY_UNAVAILABLE,
        'A stable address is signed with your Swarm identity, which needs Freedom’s vault unlocked. Ask the user to unlock it, then publish again.');
    }
    const owner = String(signer?.address || '').toLowerCase();
    if (!/^0x[a-f0-9]{40}$/.test(owner)) throw new AutomationError(ERROR_CODES.CAPABILITY_UNAVAILABLE, 'Your Swarm identity is unavailable');
    const topic = `${STABLE_ADDRESS_TOPIC_PREFIX}${name}`;
    // The latest completed update of this name by this identity, in any
    // conversation: the card says which address is being updated.
    const previous = [...this.operations.values()].filter(item => item.stableAddress?.name === name &&
      item.stableAddress.owner === owner && item.stableAddress.updated === true && item.stableAddress.bzzUrl).at(-1);
    // The address is derived from owner and topic alone, so it can already be
    // live (and linked to a name) with no local record of it: a deleted
    // conversation, an evicted record, a restored vault. Ask the network
    // rather than assume it is new; only a definite "no update yet" says new.
    let existing = previous ? 'yes' : 'unknown';
    let latestIndex;
    if (!previous) {
      const state = await observe(Promise.resolve().then(() => this.readFeedState(owner, topic)), this.interactiveTimeoutMs);
      if (state.kind === 'result' && state.value?.exists === true) {
        existing = 'yes';
        if (Number.isSafeInteger(state.value.index) && state.value.index >= 0) latestIndex = state.value.index;
      } else if (state.kind === 'result' && state.value?.exists === false) existing = 'no';
    }
    return { name, owner, topic, existing,
      ...(latestIndex !== undefined && { latestIndex }),
      ...(previous && { previousBzzUrl: previous.stableAddress.bzzUrl }) };
  }

  async #previewPostage(ownerId, source, encrypted) {
    if (typeof this.postageReadiness?.preview !== 'function') return undefined;
    try {
      const preview = await this.postageReadiness.preview(ownerId, source.bytes || 0,
        { encrypted, files: source.kind === 'folder' ? source.files.length : 1 });
      return preview && ['ready', 'none'].includes(preview.status) ? preview : { status: 'unknown' };
    } catch {
      // Postage details are shown when they can be read; reading them never
      // decides the publication. Readiness is still checked before upload.
      return { status: 'unknown' };
    }
  }

  async #updateStableAddress(operation, onProgress) {
    const stableAddress = operation.stableAddress;
    operation.message = 'Updating the stable address';
    this.#emitProgress(operation, onProgress);
    try {
      const signer = await this.feedSigner();
      if (String(signer?.address || '').toLowerCase() !== stableAddress.owner) {
        throw new Error('Your Swarm identity changed after approval, so the stable address was not updated');
      }
      // The network can read a live address low (its first update expired
      // with its batch, or a gap), so never write below an index this
      // browser already knows was written.
      const known = [stableAddress.knownIndex, ...[...this.operations.values()]
        .filter(item => item.stableAddress?.name === stableAddress.name && item.stableAddress.owner === stableAddress.owner &&
          item.stableAddress.updated === true)
        .map(item => item.stableAddress.index)]
        .filter(index => Number.isSafeInteger(index) && index >= 0);
      let minIndex = known.length ? Math.max(...known) + 1 : 0;
      let update;
      for (let attempt = 0; ; attempt += 1) {
        const options = {
          ...(minIndex > 0 && { minIndex }),
          ...(Number.isSafeInteger(signer.epoch) && { epoch: signer.epoch }),
        };
        const written = await observe(Promise.resolve().then(() =>
          this.updateFeed(signer.privateKey, stableAddress.topic, operation.reference, operation.batchId,
            ...(Object.keys(options).length ? [options] : []))), FEED_TIMEOUT_MS);
        if (written.kind !== 'result') throw written.error || new Error('The feed update did not finish in time');
        update = written;
        const index = written.value?.index;
        if (!Number.isSafeInteger(index)) break;
        // Read the address back: a later index still served means this
        // update landed under the live head and changed nothing. A read that
        // fails, or lags behind the write, proves nothing either way.
        const readBack = await observe(Promise.resolve().then(() =>
          this.readFeedState(stableAddress.owner, stableAddress.topic)), this.interactiveTimeoutMs);
        const head = readBack.kind === 'result' && readBack.value?.exists === true ? readBack.value.index : undefined;
        if (!Number.isSafeInteger(head) || head <= index) break;
        if (attempt === 1) {
          throw new Error(`The stable address still serves its later version ${head}, so this update (version ${index}) is not shown`);
        }
        minIndex = head + 1;
      }
      const manifest = await observe(Promise.resolve().then(() =>
        this.createFeed(signer.privateKey, stableAddress.topic, operation.batchId)), FEED_TIMEOUT_MS);
      if (manifest.kind !== 'result') throw manifest.error || new Error('The stable address manifest did not finish in time');
      const reference = String(manifest.value?.manifestReference || '').toLowerCase();
      if (!/^[a-f0-9]{64}$/.test(reference)) throw new Error('The node returned no valid stable address');
      Object.assign(stableAddress, { reference, bzzUrl: `bzz://${reference}`, updated: true,
        ...(Number.isSafeInteger(update.value?.index) && { index: update.value.index }) });
      delete stableAddress.error;
    } catch (error) {
      // The content itself is published; only the address still points at
      // the previous version (or nowhere yet).
      stableAddress.updated = false;
      stableAddress.error = safeMessage(error, 'The stable address could not be updated');
    }
    this.#emitProgress(operation, onProgress);
  }

  #emitProgress(operation, onProgress) {
    if (this.operations.has(operation.publicationId)) this.store?.save(operation);
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
  PUBLICATION_TARGETS,
  STABLE_ADDRESS_TOPIC_PREFIX,
  SwarmPublicationController,
  opaquePublicationId,
  publicReceipt,
};
