'use strict';

const { isValidatedExecutableRoot } = require('./executable-access');

const CAPABILITY_VERSION = 1;
const MAX_CAPABILITIES_PER_REQUEST = 32;
const CAPABILITY_KINDS = Object.freeze({
  EXECUTABLE_ROOT: 'executable_root',
  FILESYSTEM_READ: 'filesystem_read',
  FILESYSTEM_WRITE: 'filesystem_write',
  NETWORK_PUBLIC: 'network_public',
  NETWORK_LOOPBACK: 'network_loopback',
  NETWORK_PRIVATE: 'network_private',
  HOST_IPC: 'host_ipc',
});
const CAPABILITY_SCOPES = Object.freeze({
  ONCE: 'once',
  CONVERSATION: 'conversation',
});
const CAPABILITY_DEFINITIONS = Object.freeze({
  [CAPABILITY_KINDS.EXECUTABLE_ROOT]: Object.freeze({
    resource: 'executable_root',
    access: 'read_execute',
    implemented: true,
  }),
  [CAPABILITY_KINDS.FILESYSTEM_READ]: Object.freeze({
    resource: 'filesystem',
    access: 'read',
    implemented: false,
  }),
  [CAPABILITY_KINDS.FILESYSTEM_WRITE]: Object.freeze({
    resource: 'filesystem',
    access: 'write',
    implemented: false,
  }),
  [CAPABILITY_KINDS.NETWORK_PUBLIC]: Object.freeze({
    resource: 'network',
    access: 'public',
    implemented: false,
  }),
  [CAPABILITY_KINDS.NETWORK_LOOPBACK]: Object.freeze({
    resource: 'network',
    access: 'host_loopback',
    implemented: false,
  }),
  [CAPABILITY_KINDS.NETWORK_PRIVATE]: Object.freeze({
    resource: 'network',
    access: 'private_lan',
    implemented: false,
  }),
  [CAPABILITY_KINDS.HOST_IPC]: Object.freeze({
    resource: 'host_ipc',
    access: 'explicit_endpoint',
    implemented: false,
  }),
});

const trustedCapabilities = new WeakMap();
const trustedRequests = new WeakMap();

class WorkspaceCapabilityError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'WorkspaceCapabilityError';
    this.code = code;
  }
}

function requiredBoundedString(value, label, maximum) {
  if (typeof value !== 'string' || !value || value.length > maximum || value.includes('\0')) {
    throw new WorkspaceCapabilityError(
      'INVALID_CAPABILITY_REQUEST',
      `${label} must be a bounded non-empty string`
    );
  }
  return value;
}

function requiredConversationId(value) {
  return requiredBoundedString(value, 'Conversation ID', 160);
}

function capabilityDefinition(kind) {
  return CAPABILITY_DEFINITIONS[kind] || null;
}

function capabilityImplementationStatus(kind) {
  const definition = capabilityDefinition(kind);
  if (!definition) return 'unknown';
  return definition.implemented ? 'implemented' : 'unsupported';
}

function createExecutableRootCapability(root) {
  if (!isValidatedExecutableRoot(root)) {
    throw new WorkspaceCapabilityError(
      'UNTRUSTED_CAPABILITY_AUTHORITY',
      'Executable capability authority must come from Freedom executable resolution'
    );
  }
  const capability = Object.freeze({
    kind: CAPABILITY_KINDS.EXECUTABLE_ROOT,
    version: CAPABILITY_VERSION,
  });
  trustedCapabilities.set(
    capability,
    Object.freeze({
      identity: `${CAPABILITY_KINDS.EXECUTABLE_ROOT}:${root.id}`,
      authority: root,
    })
  );
  return capability;
}

function isTrustedWorkspaceCapability(value) {
  return Boolean(value && typeof value === 'object' && trustedCapabilities.has(value));
}

function executableRootForCapability(capability) {
  if (
    !isTrustedWorkspaceCapability(capability) ||
    capability.kind !== CAPABILITY_KINDS.EXECUTABLE_ROOT
  ) {
    return null;
  }
  return trustedCapabilities.get(capability).authority;
}

function createWorkspaceCapabilityRequest(options = {}) {
  const conversationId = requiredConversationId(options.conversationId);
  const command = requiredBoundedString(options.command, 'Command', 4_096);
  const workingDirectory = requiredBoundedString(
    options.workingDirectory,
    'Working directory',
    1_024
  );
  if (
    !Array.isArray(options.capabilities) ||
    options.capabilities.length < 1 ||
    options.capabilities.length > MAX_CAPABILITIES_PER_REQUEST
  ) {
    throw new WorkspaceCapabilityError(
      'INVALID_CAPABILITY_REQUEST',
      `Capability requests must contain between 1 and ${MAX_CAPABILITIES_PER_REQUEST} capabilities`
    );
  }
  const capabilities = [];
  const identities = new Set();
  for (const capability of options.capabilities) {
    if (!isTrustedWorkspaceCapability(capability)) {
      throw new WorkspaceCapabilityError(
        'UNTRUSTED_CAPABILITY_AUTHORITY',
        'Capability authority must come from a trusted Freedom resolver'
      );
    }
    const trusted = trustedCapabilities.get(capability);
    if (identities.has(trusted.identity)) continue;
    identities.add(trusted.identity);
    capabilities.push(capability);
  }
  const request = Object.freeze({
    kind: 'freedom.workspace-capability-request',
    version: CAPABILITY_VERSION,
    operation: Object.freeze({ command, workingDirectory }),
    capabilities: Object.freeze(capabilities),
  });
  trustedRequests.set(request, { conversationId, granted: false });
  return request;
}

function isTrustedWorkspaceCapabilityRequest(value) {
  return Boolean(value && typeof value === 'object' && trustedRequests.has(value));
}

function matchingOperation(request, operation) {
  return (
    request.operation.command === operation.command &&
    request.operation.workingDirectory === operation.workingDirectory
  );
}

function uniqueCapabilities(capabilities) {
  const unique = new Map();
  for (const capability of capabilities) {
    const trusted = trustedCapabilities.get(capability);
    if (!trusted) continue;
    unique.set(trusted.identity, capability);
  }
  return Object.freeze([...unique.values()]);
}

class WorkspaceCapabilityGrantStore {
  constructor() {
    this.grants = new Map();
  }

  grant(conversationId, request, scope) {
    const ownerId = requiredConversationId(conversationId);
    if (!Object.values(CAPABILITY_SCOPES).includes(scope)) {
      throw new WorkspaceCapabilityError(
        'INVALID_CAPABILITY_SCOPE',
        'Capability scope must be once or conversation'
      );
    }
    const requestState = trustedRequests.get(request);
    if (!requestState || requestState.granted || requestState.conversationId !== ownerId) {
      throw new WorkspaceCapabilityError(
        'INVALID_CAPABILITY_GRANT',
        'Freedom refused an invalid or already granted capability request'
      );
    }
    requestState.granted = true;
    let grants = this.grants.get(ownerId);
    if (!grants) {
      grants = { once: [], conversation: new Map() };
      this.grants.set(ownerId, grants);
    }
    if (scope === CAPABILITY_SCOPES.CONVERSATION) {
      for (const capability of request.capabilities) {
        const identity = trustedCapabilities.get(capability).identity;
        grants.conversation.set(identity, capability);
      }
    } else {
      grants.once.push(request);
    }
    return Object.freeze({
      scope,
      capabilities: Object.freeze(request.capabilities.map((capability) => capability.kind)),
      command: request.operation.command,
      workingDirectory: request.operation.workingDirectory,
    });
  }

  resolve(conversationId, operation = {}) {
    const ownerId = requiredConversationId(conversationId);
    const command = requiredBoundedString(operation.command, 'Command', 4_096);
    const workingDirectory = requiredBoundedString(
      operation.workingDirectory,
      'Working directory',
      1_024
    );
    const grants = this.grants.get(ownerId);
    if (!grants) return Object.freeze([]);
    const capabilities = [...grants.conversation.values()];
    const index = grants.once.findIndex((request) =>
      matchingOperation(request, { command, workingDirectory })
    );
    if (index >= 0) {
      const [request] = grants.once.splice(index, 1);
      capabilities.push(...request.capabilities);
    }
    if (!grants.once.length && grants.conversation.size === 0) {
      this.grants.delete(ownerId);
    }
    return uniqueCapabilities(capabilities);
  }

  clearOnce(conversationId) {
    const ownerId = requiredConversationId(conversationId);
    const grants = this.grants.get(ownerId);
    if (!grants) return false;
    const cleared = grants.once.length > 0;
    grants.once.length = 0;
    if (grants.conversation.size === 0) this.grants.delete(ownerId);
    return cleared;
  }

  deleteConversation(conversationId) {
    return this.grants.delete(requiredConversationId(conversationId));
  }

  clear() {
    this.grants.clear();
  }
}

module.exports = {
  CAPABILITY_DEFINITIONS,
  CAPABILITY_KINDS,
  CAPABILITY_SCOPES,
  CAPABILITY_VERSION,
  MAX_CAPABILITIES_PER_REQUEST,
  WorkspaceCapabilityError,
  WorkspaceCapabilityGrantStore,
  capabilityImplementationStatus,
  createExecutableRootCapability,
  createWorkspaceCapabilityRequest,
  executableRootForCapability,
  isTrustedWorkspaceCapability,
  isTrustedWorkspaceCapabilityRequest,
};
