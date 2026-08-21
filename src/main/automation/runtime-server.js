'use strict';

const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const path = require('path');

const RUNTIME_PROTOCOL_VERSION = 1;
const MAX_MESSAGE_BYTES = 1024 * 1024;
const HANDSHAKE_TIMEOUT_MS = 10_000;
const RUNTIME_DIR_NAME = 'automation-runtime';
const DISCOVERY_FILE_NAME = 'runtime.json';
const TOKEN_FILE_NAME = 'token';

function requireProfile(profile) {
  if (!profile?.userDataDir || !profile?.id) {
    throw new TypeError('Runtime server requires a profile with id and userDataDir');
  }
  return profile;
}

function ensurePrivateDirectory(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(dirPath);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Runtime path is not a private directory: ${dirPath}`);
  }
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new Error(`Runtime directory is owned by another user: ${dirPath}`);
  }
  fs.chmodSync(dirPath, 0o700);
  return dirPath;
}

function getRuntimePaths(profile) {
  const runtimeDir = path.join(requireProfile(profile).userDataDir, RUNTIME_DIR_NAME);
  return {
    runtimeDir,
    discoveryPath: path.join(runtimeDir, DISCOVERY_FILE_NAME),
    tokenPath: path.join(runtimeDir, TOKEN_FILE_NAME),
  };
}

function writePrivateFile(filePath, contents) {
  const flags =
    fs.constants.O_WRONLY |
    fs.constants.O_CREAT |
    fs.constants.O_TRUNC |
    (fs.constants.O_NOFOLLOW || 0);
  const descriptor = fs.openSync(filePath, flags, 0o600);
  try {
    fs.fchmodSync(descriptor, 0o600);
    fs.writeFileSync(descriptor, contents, { encoding: 'utf8' });
  } finally {
    fs.closeSync(descriptor);
  }
}

function writeDiscovery(discoveryPath, value) {
  writePrivateFile(discoveryPath, `${JSON.stringify(value, null, 2)}\n`);
}

function profileEndpointHash(profile) {
  return crypto
    .createHash('sha256')
    .update(path.resolve(profile.userDataDir))
    .digest('hex')
    .slice(0, 16);
}

function defaultUnixSocketRoot() {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 'user';
  return path.join('/tmp', `freedom-runtime-${uid}`);
}

function createRuntimeEndpoint(profile, options = {}) {
  const platform = options.platform || process.platform;
  const suffix = (options.endpointNonce || crypto.randomBytes(6).toString('hex')).replace(
    /[^a-zA-Z0-9_-]/g,
    ''
  );
  const profileHash = profileEndpointHash(requireProfile(profile));
  if (platform === 'win32') {
    return {
      kind: 'named-pipe',
      path: `\\\\.\\pipe\\freedom-runtime-${profileHash}-${suffix}`,
    };
  }

  const socketRoot = ensurePrivateDirectory(options.socketRoot || defaultUnixSocketRoot());
  const socketPath = path.join(socketRoot, `${profileHash}-${suffix}.sock`);
  if (Buffer.byteLength(socketPath) >= 100) {
    throw new Error(`Runtime socket path is too long: ${socketPath}`);
  }
  return { kind: 'unix', path: socketPath };
}

function safeRequestId(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (typeof value === 'string' && value.length > 0 && value.length <= 128) return value;
  return null;
}

function tokensEqual(expectedToken, candidate) {
  if (typeof candidate !== 'string' || !/^[a-f0-9]{64}$/.test(candidate)) return false;
  const expected = Buffer.from(expectedToken, 'utf8');
  const actual = Buffer.from(candidate, 'utf8');
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function createRuntimeServer(options = {}) {
  const profile = requireProfile(options.profile);
  if (!options.controller || typeof options.controller.execute !== 'function') {
    throw new TypeError('Runtime server requires an automation controller');
  }
  const controller = options.controller;
  const logger = options.logger || console;
  const appVersion = options.appVersion || '0.0.0';
  const runtimePaths = getRuntimePaths(profile);
  const endpoint = createRuntimeEndpoint(profile, options);
  const token = options.token || crypto.randomBytes(32).toString('hex');
  if (!/^[a-f0-9]{64}$/.test(token)) {
    throw new TypeError('Runtime authentication token must be 32 bytes encoded as hex');
  }
  const startedAt = new Date().toISOString();
  const sockets = new Set();
  let server = null;
  let state = 'stopped';
  let shutdownRequested = false;

  const publicProfile = {
    id: profile.id,
    displayName: profile.displayName || profile.id,
  };

  const statusPayload = () => ({
    state,
    pid: process.pid,
    startedAt,
    protocolVersion: RUNTIME_PROTOCOL_VERSION,
    appVersion,
    runtimeId: controller.runtimeId,
    contextId: controller.contextId,
    profile: publicProfile,
  });

  const discoveryPayload = () => ({
    schemaVersion: 1,
    ...statusPayload(),
    ...(state === 'starting' || state === 'ready'
      ? { endpoint, tokenPath: runtimePaths.tokenPath }
      : {}),
  });

  const writeResponse = (socket, response, onFlushed = null) => {
    if (socket.destroyed || !socket.writable) return false;
    socket.write(`${JSON.stringify(response)}\n`, () => onFlushed?.());
    return true;
  };

  const protocolError = (id, code, message) => ({
    id,
    ok: false,
    error: { code, message },
  });

  const handleRequest = async (socketState, request) => {
    const id = safeRequestId(request?.id);
    if (!request || typeof request !== 'object' || Array.isArray(request)) {
      writeResponse(
        socketState.socket,
        protocolError(id, 'INVALID_REQUEST', 'Request must be an object')
      );
      return;
    }
    if (id === null || typeof request.method !== 'string') {
      writeResponse(
        socketState.socket,
        protocolError(id, 'INVALID_REQUEST', 'Request id and method are required')
      );
      return;
    }

    if (!socketState.authenticated) {
      if (request.method !== 'runtime.handshake') {
        socketState.closedForRequests = true;
        writeResponse(
          socketState.socket,
          protocolError(id, 'UNAUTHENTICATED', 'Runtime handshake is required'),
          () => socketState.socket.end()
        );
        return;
      }
      const params = request.params;
      if (
        !params ||
        typeof params !== 'object' ||
        params.protocolVersion !== RUNTIME_PROTOCOL_VERSION ||
        !tokensEqual(token, params.token)
      ) {
        socketState.closedForRequests = true;
        writeResponse(
          socketState.socket,
          protocolError(id, 'UNAUTHENTICATED', 'Runtime authentication failed'),
          () => socketState.socket.end()
        );
        return;
      }
      socketState.authenticated = true;
      clearTimeout(socketState.handshakeTimeout);
      writeResponse(socketState.socket, {
        id,
        ok: true,
        result: {
          ...statusPayload(),
          capabilities: ['automation.execute', 'runtime.status', 'runtime.shutdown'],
        },
      });
      return;
    }

    if (request.method === 'runtime.handshake') {
      writeResponse(
        socketState.socket,
        protocolError(id, 'INVALID_REQUEST', 'Runtime handshake is already complete')
      );
      return;
    }
    if (request.method === 'runtime.status') {
      writeResponse(socketState.socket, { id, ok: true, result: statusPayload() });
      return;
    }
    if (request.method === 'automation.execute') {
      const params = request.params;
      if (!params || typeof params !== 'object' || typeof params.operation !== 'string') {
        writeResponse(
          socketState.socket,
          protocolError(id, 'INVALID_REQUEST', 'automation.execute requires an operation')
        );
        return;
      }
      const result = await controller.execute(params.operation, params.input);
      writeResponse(socketState.socket, { id, ok: true, result });
      return;
    }
    if (request.method === 'runtime.shutdown') {
      if (!shutdownRequested) {
        shutdownRequested = true;
        const queued = writeResponse(
          socketState.socket,
          { id, ok: true, result: { shuttingDown: true } },
          () => setImmediate(() => options.onShutdown?.())
        );
        if (!queued) setImmediate(() => options.onShutdown?.());
      } else {
        writeResponse(socketState.socket, { id, ok: true, result: { shuttingDown: true } });
      }
      return;
    }
    writeResponse(
      socketState.socket,
      protocolError(id, 'METHOD_NOT_FOUND', 'Unknown runtime method')
    );
  };

  const handleConnection = (socket) => {
    sockets.add(socket);
    socket.setEncoding('utf8');
    const socketState = {
      socket,
      authenticated: false,
      closedForRequests: false,
      buffer: '',
      handshakeTimeout: null,
    };
    socketState.handshakeTimeout = setTimeout(() => {
      socketState.closedForRequests = true;
      writeResponse(
        socket,
        protocolError(null, 'UNAUTHENTICATED', 'Runtime handshake timed out'),
        () => socket.end()
      );
    }, options.handshakeTimeoutMs || HANDSHAKE_TIMEOUT_MS);

    socket.on('data', (chunk) => {
      if (socketState.closedForRequests) return;
      socketState.buffer += chunk;
      const maxMessageBytes = options.maxMessageBytes || MAX_MESSAGE_BYTES;
      let newlineIndex = socketState.buffer.indexOf('\n');
      while (newlineIndex !== -1) {
        const line = socketState.buffer.slice(0, newlineIndex);
        socketState.buffer = socketState.buffer.slice(newlineIndex + 1);
        if (Buffer.byteLength(line) > maxMessageBytes) {
          socketState.closedForRequests = true;
          writeResponse(
            socket,
            protocolError(null, 'MESSAGE_TOO_LARGE', 'Runtime request is too large'),
            () => socket.end()
          );
          return;
        }
        if (line.trim()) {
          let request;
          try {
            request = JSON.parse(line);
          } catch {
            writeResponse(
              socket,
              protocolError(null, 'INVALID_JSON', 'Runtime request must be valid JSON')
            );
            newlineIndex = socketState.buffer.indexOf('\n');
            continue;
          }
          Promise.resolve(handleRequest(socketState, request)).catch((error) => {
            logger.error?.('[automation-runtime] Request failed:', error);
            writeResponse(
              socket,
              protocolError(
                safeRequestId(request?.id),
                'INTERNAL_ERROR',
                'Runtime request failed unexpectedly'
              )
            );
          });
          if (socketState.closedForRequests) return;
        }
        newlineIndex = socketState.buffer.indexOf('\n');
      }
      if (Buffer.byteLength(socketState.buffer) > maxMessageBytes) {
        socketState.closedForRequests = true;
        writeResponse(
          socket,
          protocolError(null, 'MESSAGE_TOO_LARGE', 'Runtime request is too large'),
          () => socket.end()
        );
      }
    });
    socket.once('close', () => {
      clearTimeout(socketState.handshakeTimeout);
      sockets.delete(socket);
    });
    socket.on('error', (error) => {
      logger.warn?.('[automation-runtime] Client connection error:', error.message);
    });
  };

  async function start() {
    if (state !== 'stopped') throw new Error(`Runtime server cannot start from state: ${state}`);
    ensurePrivateDirectory(runtimePaths.runtimeDir);
    writePrivateFile(runtimePaths.tokenPath, `${token}\n`);
    state = 'starting';
    writeDiscovery(runtimePaths.discoveryPath, discoveryPayload());
    server = net.createServer(handleConnection);

    try {
      await new Promise((resolve, reject) => {
        const onError = (error) => {
          server.off('listening', onListening);
          reject(error);
        };
        const onListening = () => {
          server.off('error', onError);
          resolve();
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(endpoint.path);
      });
      if (endpoint.kind === 'unix') fs.chmodSync(endpoint.path, 0o600);
      state = 'ready';
      writeDiscovery(runtimePaths.discoveryPath, discoveryPayload());
      return discoveryPayload();
    } catch (error) {
      state = 'failed';
      writePrivateFile(runtimePaths.tokenPath, '');
      writeDiscovery(runtimePaths.discoveryPath, discoveryPayload());
      throw error;
    }
  }

  async function stop() {
    if (state === 'stopped') return false;
    state = 'stopping';
    writeDiscovery(runtimePaths.discoveryPath, discoveryPayload());
    const activeServer = server;
    server = null;
    if (activeServer) {
      const closed = new Promise((resolve) => activeServer.close(resolve));
      for (const socket of sockets) socket.destroy();
      await closed;
    }
    state = 'stopped';
    writePrivateFile(runtimePaths.tokenPath, '');
    writeDiscovery(runtimePaths.discoveryPath, {
      ...discoveryPayload(),
      stoppedAt: new Date().toISOString(),
    });
    return true;
  }

  return {
    endpoint,
    paths: runtimePaths,
    start,
    stop,
    status: statusPayload,
  };
}

module.exports = {
  DISCOVERY_FILE_NAME,
  HANDSHAKE_TIMEOUT_MS,
  MAX_MESSAGE_BYTES,
  RUNTIME_DIR_NAME,
  RUNTIME_PROTOCOL_VERSION,
  TOKEN_FILE_NAME,
  createRuntimeEndpoint,
  createRuntimeServer,
  getRuntimePaths,
};
