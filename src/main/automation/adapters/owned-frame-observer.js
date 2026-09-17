'use strict';

const crypto = require('crypto');
const { AutomationError, ERROR_CODES } = require('../contract/errors');

const MAX_FRAMES = 64;
const MAX_HANDLES = 128;
const MAX_METADATA_BYTES = 65_536;
const CONNECTION_TIMEOUT_MS = 5_000;

function unavailable(message = 'Frame observation is unavailable for this page') {
  return new AutomationError(ERROR_CODES.CAPABILITY_UNAVAILABLE, message, { retryable: true });
}

function staleFrame() {
  return new AutomationError(
    ERROR_CODES.STALE_ELEMENT_REFERENCE,
    'The observed frame document changed',
    {
      retryable: true,
      suggestedAction: 'List frames again before reading the replacement document',
    }
  );
}

// Owns a short-lived debugger connection to exactly one WebContents. It does
// not borrow an existing debugger or accept script bodies from operation input.
class OwnedFrameObserver {
  constructor(webContents, snapshotSource) {
    if (typeof snapshotSource !== 'function')
      throw new TypeError('A fixed snapshot source is required');
    this.webContents = webContents;
    this.snapshotSource = snapshotSource;
    this.worldName = `freedom-frame-${crypto.randomUUID()}`;
    this.handles = new Map();
    this.pending = Promise.resolve();
    this.disposed = false;
    this.cancelPending = null;
    this.generation = 0;
  }

  list() {
    return this.#connected(async (connection) => {
      const discovered = await this.#discover(connection);
      const frames = [];
      const references = new Map();
      let bytes = 0;
      let truncated = discovered.truncated;
      for (const frame of discovered.frames.values()) references.set(frame.id, this.#handle(frame));
      for (const frame of discovered.frames.values()) {
        const item = {
          ...this.#publicFrame(frame, references.get(frame.id)),
          parentRef: references.get(frame.parentId) || null,
        };
        bytes += Buffer.byteLength(JSON.stringify(item));
        if (bytes > MAX_METADATA_BYTES) {
          truncated = true;
          break;
        }
        frames.push(item);
      }
      return { frames, truncated };
    });
  }

  read(frameRef, options, authorizeFrame) {
    return this.#connected(async (connection) => {
      const handle = this.handles.get(frameRef);
      if (!handle) throw staleFrame();
      const discovered = await this.#discover(connection);
      const frame = discovered.frames.get(handle.id);
      if (!frame || !this.#sameDocument(frame, handle)) throw staleFrame();
      // The caller supplies policy from the trusted controller, never from tool
      // arguments. Opaque/unsupported origins cannot be silently treated as the
      // embedding page's origin.
      if (
        typeof authorizeFrame !== 'function' ||
        (await authorizeFrame(this.#publicFrame(frame, frameRef))) !== true
      ) {
        throw new AutomationError(
          ERROR_CODES.POLICY_DENIED,
          'Reading this frame origin is not allowed'
        );
      }
      const send = (method, params) => connection.send(method, params, frame.sessionId);
      await send('Runtime.enable', {});
      const world = await send('Page.createIsolatedWorld', {
        frameId: frame.id,
        worldName: this.worldName,
        grantUniveralAccess: false,
      });
      const context = connection.contexts.find(
        (context) =>
          context.sessionId === frame.sessionId && context.id === world.executionContextId
      );
      if (!context?.uniqueId || context.origin !== frame.origin)
        throw unavailable('The frame did not provide an isolated document context');
      const beforeRead = (await this.#discover(connection)).frames.get(handle.id);
      if (!beforeRead || !this.#sameDocument(beforeRead, handle)) throw staleFrame();
      const result = await send('Runtime.evaluate', {
        expression: this.snapshotSource(options),
        uniqueContextId: context.uniqueId,
        returnByValue: true,
        timeout: 1_000,
      });
      if (result.exceptionDetails || !Array.isArray(result.result?.value?.elements))
        throw unavailable();
      const after = (await this.#discover(connection)).frames.get(handle.id);
      if (!after || !this.#sameDocument(after, handle)) throw staleFrame();
      const snapshot = result.result.value;
      // Cross-frame interaction routing is not part of this read capability.
      // Do not advertise child-world references as usable root-page controls.
      const elements = snapshot.elements.map(
        ({ ref: _ref, scrollOnly: _scrollOnly, ...element }) => element
      );
      const frames = snapshot.frames.map(({ viewport, ...entry }) => ({
        ...entry,
        ...(viewport && {
          viewport: Object.fromEntries(Object.entries(viewport).filter(([key]) => key !== 'ref')),
        }),
      }));
      return {
        ...snapshot,
        elements,
        frames,
        frame: this.#publicFrame(after, frameRef),
        readOnly: true,
      };
    });
  }

  cancel() {
    this.generation += 1;
    this.cancelPending?.();
  }

  dispose() {
    this.disposed = true;
    this.handles.clear();
    this.cancel();
  }

  #sameDocument(frame, handle) {
    return (
      frame.id === handle.id &&
      frame.loaderId === handle.loaderId &&
      frame.origin === handle.origin &&
      frame.documentContextId === handle.documentContextId
    );
  }

  #handle(frame) {
    for (const [ref, handle] of this.handles) if (this.#sameDocument(frame, handle)) return ref;
    const ref = `frame_${crypto.randomUUID()}`;
    this.handles.set(ref, {
      id: frame.id,
      loaderId: frame.loaderId,
      origin: frame.origin,
      documentContextId: frame.documentContextId,
    });
    while (this.handles.size > MAX_HANDLES) this.handles.delete(this.handles.keys().next().value);
    return ref;
  }

  #publicFrame(frame, ref) {
    const url = String(frame.url || '');
    return {
      ref,
      origin: frame.origin,
      name: String(frame.name || '').slice(0, 240),
      ...(url.length <= 2_000 && !/^[a-z]+:\/\/[^/]*@/i.test(url) ? { url } : { urlOmitted: true }),
    };
  }

  async #discover(connection) {
    const frames = new Map();
    let truncated = false;
    const visit = (branch, sessionId, depth = 0) => {
      if (depth > 16 || frames.size >= MAX_FRAMES) {
        truncated = true;
        return;
      }
      const frame = branch.frame;
      if (typeof frame?.id !== 'string' || typeof frame.loaderId !== 'string') return;
      frames.set(frame.id, { ...frame, sessionId });
      for (const child of branch.childFrames || []) visit(child, sessionId, depth + 1);
    };
    for (let index = 0; index < connection.sessions.length && index < MAX_FRAMES; index += 1) {
      const sessionId = connection.sessions[index];
      await connection.send(
        'Target.setAutoAttach',
        { autoAttach: true, waitForDebuggerOnStart: false, flatten: true },
        sessionId
      );
      await connection.send('Runtime.enable', {}, sessionId);
      const tree = await connection.send('Page.getFrameTree', {}, sessionId);
      visit(tree.frameTree, sessionId);
    }
    // Page.getFrameTree.securityOrigin retains a sandboxed frame's URL origin.
    // Only the browser's default execution context supplies its effective origin.
    for (const frame of frames.values()) {
      const context = connection.contexts.findLast(
        (entry) =>
          entry.sessionId === frame.sessionId &&
          entry.auxData?.frameId === frame.id &&
          entry.auxData?.isDefault === true
      );
      frame.documentContextId = context?.uniqueId || '';
      frame.origin =
        context?.origin && context.origin !== '://' && context.origin.length <= 2_000
          ? context.origin
          : 'null';
    }
    return { frames, truncated: truncated || connection.truncated };
  }

  #connected(task) {
    const generation = this.generation;
    const cancelled = () =>
      new AutomationError(ERROR_CODES.USER_CANCELLED, 'Frame observation stopped');
    const operation = this.pending
      .catch(() => {})
      .then(async () => {
        if (this.disposed || this.webContents.isDestroyed?.()) throw unavailable();
        if (generation !== this.generation) throw cancelled();
        const api = this.webContents.debugger;
        if (!api || api.isAttached())
          throw unavailable(
            'Another debugger is using this page; frame reading cannot take it over'
          );
        const sessions = [''];
        const contexts = [];
        let attached = false;
        let expired = false;
        let rejectInterrupted;
        const interruption = new Promise((_resolve, reject) => {
          rejectInterrupted = reject;
        });
        const connection = {
          sessions,
          contexts,
          truncated: false,
          send: async (method, params, sessionId = '') => {
            if (expired || this.disposed || !attached) throw unavailable();
            return api.sendCommand(method, params, sessionId || undefined);
          },
        };
        const detach = () => {
          if (!attached) return;
          attached = false;
          try {
            if (api.isAttached()) api.detach();
          } catch {
            /* The page may already have closed. */
          }
        };
        const onDetach = () => {
          if (!attached) return;
          attached = false;
          rejectInterrupted(unavailable());
        };
        const onMessage = (_event, method, params, sourceSession = '') => {
          if (
            method === 'Target.attachedToTarget' &&
            params.targetInfo?.type === 'iframe' &&
            sessions.includes(sourceSession || '')
          ) {
            if (sessions.length >= MAX_FRAMES) connection.truncated = true;
            else if (!sessions.includes(params.sessionId)) sessions.push(params.sessionId);
          }
          if (method === 'Runtime.executionContextsCleared') {
            for (let index = contexts.length - 1; index >= 0; index -= 1)
              if (contexts[index].sessionId === (sourceSession || '')) contexts.splice(index, 1);
          }
          if (method === 'Runtime.executionContextDestroyed') {
            const index = contexts.findIndex(
              (entry) =>
                entry.sessionId === (sourceSession || '') && entry.id === params.executionContextId
            );
            if (index >= 0) contexts.splice(index, 1);
          }
          if (
            method === 'Runtime.executionContextCreated' &&
            sessions.includes(sourceSession || '')
          ) {
            if (contexts.length >= 256) contexts.shift();
            contexts.push({ ...params.context, sessionId: sourceSession || '' });
          }
        };
        let timer;
        try {
          api.attach('1.3');
          attached = true;
          this.cancelPending = () => {
            expired = true;
            rejectInterrupted(cancelled());
            detach();
          };
          api.on('message', onMessage);
          api.on('detach', onDetach);
          timer = setTimeout(() => {
            expired = true;
            rejectInterrupted(unavailable('Frame observation timed out'));
            detach();
          }, CONNECTION_TIMEOUT_MS);
          return await Promise.race([task(connection), interruption]);
        } catch (error) {
          if (error instanceof AutomationError) throw error;
          throw unavailable(expired ? 'Frame observation timed out' : undefined);
        } finally {
          clearTimeout(timer);
          api.removeListener('message', onMessage);
          api.removeListener('detach', onDetach);
          detach();
          this.cancelPending = null;
        }
      });
    this.pending = operation;
    return operation;
  }
}

module.exports = { OwnedFrameObserver };
