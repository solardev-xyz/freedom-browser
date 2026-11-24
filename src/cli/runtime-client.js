'use strict';

const fs = require('fs');
const net = require('net');
const {
  RUNTIME_PROTOCOL_VERSION,
  getRuntimePaths,
} = require('../shared/automation-runtime-contract');
const { CliError } = require('./errors');
const { EXIT_CODES } = require('./exit-codes');

const MAX_DISCOVERY_BYTES = 64 * 1024;
const MAX_TOKEN_BYTES = 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

function readSafeFile(filePath, maxBytes, description) {
  let descriptor;
  try {
    descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  } catch (error) {
    throw new CliError('RUNTIME_UNAVAILABLE', `${description} is unavailable`, {
      exitCode: EXIT_CODES.RUNTIME_UNAVAILABLE,
      cause: error,
    });
  }
  try {
    const stat = fs.fstatSync(descriptor);
    const unsafeMode = process.platform !== 'win32' && (stat.mode & 0o077) !== 0;
    if (!stat.isFile() || stat.size > maxBytes || unsafeMode) {
      throw new CliError(
        'UNSAFE_RUNTIME_FILE',
        `Refusing to read unsafe ${description.toLowerCase()}`,
        { exitCode: EXIT_CODES.RUNTIME_UNAVAILABLE }
      );
    }
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
      throw new CliError('UNSAFE_RUNTIME_FILE', `${description} is owned by another user`, {
        exitCode: EXIT_CODES.RUNTIME_UNAVAILABLE,
      });
    }
    return fs.readFileSync(descriptor, 'utf8');
  } finally {
    fs.closeSync(descriptor);
  }
}

function readDiscovery(profile) {
  const paths = getRuntimePaths(profile);
  let discovery;
  try {
    discovery = JSON.parse(
      readSafeFile(paths.discoveryPath, MAX_DISCOVERY_BYTES, 'Runtime discovery file')
    );
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError('INVALID_DISCOVERY', 'Runtime discovery file is invalid', {
      exitCode: EXIT_CODES.RUNTIME_UNAVAILABLE,
      cause: error,
    });
  }
  if (
    discovery?.schemaVersion !== 1 ||
    discovery?.profile?.id !== profile.id ||
    discovery?.state !== 'ready' ||
    !Number.isSafeInteger(discovery?.pid) ||
    discovery.pid <= 0 ||
    !['unix', 'named-pipe'].includes(discovery?.endpoint?.kind) ||
    typeof discovery.endpoint.path !== 'string' ||
    discovery.endpoint.path.length === 0 ||
    discovery.tokenPath !== paths.tokenPath
  ) {
    throw new CliError('RUNTIME_NOT_READY', 'Freedom runtime is not ready for this profile', {
      exitCode: EXIT_CODES.RUNTIME_UNAVAILABLE,
      details: { state: discovery?.state || 'invalid' },
    });
  }
  if (discovery.protocolVersion !== RUNTIME_PROTOCOL_VERSION) {
    throw new CliError('PROTOCOL_MISMATCH', 'Freedom runtime protocol version is incompatible', {
      exitCode: EXIT_CODES.PROTOCOL_MISMATCH,
      details: {
        expected: RUNTIME_PROTOCOL_VERSION,
        received: discovery.protocolVersion,
      },
    });
  }
  return discovery;
}

function readToken(tokenPath) {
  const token = readSafeFile(tokenPath, MAX_TOKEN_BYTES, 'Runtime authentication token').trim();
  if (!/^[a-f0-9]{64}$/.test(token)) {
    throw new CliError('AUTH_FAILED', 'Runtime authentication token is invalid', {
      exitCode: EXIT_CODES.AUTH_FAILED,
    });
  }
  return token;
}

class RuntimeClient {
  constructor(socket, options = {}) {
    this.socket = socket;
    this.requestTimeoutMs = options.requestTimeoutMs || DEFAULT_REQUEST_TIMEOUT_MS;
    this.nextRequestId = 1;
    this.pending = new Map();
    this.buffer = '';
    this.closed = false;
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => this.handleData(chunk));
    socket.once('close', () => this.handleClose());
    socket.once('error', (error) => this.handleClose(error));
  }

  handleData(chunk) {
    this.buffer += chunk;
    let newlineIndex = this.buffer.indexOf('\n');
    while (newlineIndex !== -1) {
      const line = this.buffer.slice(0, newlineIndex);
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (Buffer.byteLength(line) > MAX_RESPONSE_BYTES) {
        this.socket.destroy(new Error('Runtime response exceeded the maximum size'));
        return;
      }
      if (line.trim()) this.handleLine(line);
      newlineIndex = this.buffer.indexOf('\n');
    }
    if (Buffer.byteLength(this.buffer) > MAX_RESPONSE_BYTES) {
      this.socket.destroy(new Error('Runtime response exceeded the maximum size'));
    }
  }

  handleLine(line) {
    let response;
    try {
      response = JSON.parse(line);
    } catch {
      this.socket.destroy(new Error('Runtime returned invalid JSON'));
      return;
    }
    const pending = this.pending.get(response?.id);
    if (!pending) return;
    this.pending.delete(response.id);
    clearTimeout(pending.timeout);
    if (response.ok === true) {
      pending.resolve(response.result);
      return;
    }
    const protocolCode = response?.error?.code || 'RUNTIME_ERROR';
    const exitCode = protocolCode === 'UNAUTHENTICATED'
      ? EXIT_CODES.AUTH_FAILED
      : EXIT_CODES.COMMAND_FAILED;
    pending.reject(
      new CliError(protocolCode, response?.error?.message || 'Runtime request failed', {
        exitCode,
        details: response?.error?.details,
      })
    );
  }

  handleClose(error) {
    if (this.closed) return;
    this.closed = true;
    const failure = new CliError('RUNTIME_DISCONNECTED', 'Freedom runtime disconnected', {
      exitCode: EXIT_CODES.RUNTIME_UNAVAILABLE,
      cause: error,
    });
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(failure);
    }
    this.pending.clear();
  }

  request(method, params = {}, options = {}) {
    if (this.closed || this.socket.destroyed) {
      return Promise.reject(
        new CliError('RUNTIME_DISCONNECTED', 'Freedom runtime is not connected', {
          exitCode: EXIT_CODES.RUNTIME_UNAVAILABLE,
        })
      );
    }
    const id = this.nextRequestId;
    this.nextRequestId += 1;
    const requestTimeoutMs = options.timeoutMs ?? this.requestTimeoutMs;
    if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1) {
      return Promise.reject(new TypeError('Runtime request timeout must be a positive integer'));
    }
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new CliError('REQUEST_TIMEOUT', `Runtime request timed out: ${method}`, {
            exitCode: EXIT_CODES.RUNTIME_UNAVAILABLE,
          })
        );
      }, requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timeout });
      this.socket.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }

  close() {
    if (!this.closed) this.socket.end();
  }
}

async function connectRuntime(profile, options = {}) {
  const discovery = readDiscovery(profile);
  const token = readToken(discovery.tokenPath);
  const socket = net.createConnection(discovery.endpoint.path);
  await new Promise((resolve, reject) => {
    const onConnect = () => {
      socket.off('error', onError);
      resolve();
    };
    const onError = (error) => {
      socket.off('connect', onConnect);
      reject(
        new CliError('RUNTIME_UNAVAILABLE', 'Unable to connect to the Freedom runtime', {
          exitCode: EXIT_CODES.RUNTIME_UNAVAILABLE,
          cause: error,
        })
      );
    };
    socket.once('connect', onConnect);
    socket.once('error', onError);
  });
  const client = new RuntimeClient(socket, options);
  try {
    const status = await client.request('runtime.handshake', {
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      token,
    });
    return { client, discovery, status };
  } catch (error) {
    client.close();
    throw error;
  }
}

module.exports = {
  DEFAULT_REQUEST_TIMEOUT_MS,
  RuntimeClient,
  connectRuntime,
  readDiscovery,
  readToken,
};
