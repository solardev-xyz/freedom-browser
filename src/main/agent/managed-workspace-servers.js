'use strict';

const net = require('net');

function serverError(message) {
  const error = new Error(message);
  error.code = 'WORKSPACE_PREVIEW_UNAVAILABLE';
  return error;
}

// A saved command is a recipe, never a persisted grant, PID or live-process claim.
class ManagedWorkspaceServers {
  constructor({ store, processes, assertNetwork, start, checkPort = assertPortFree }) {
    Object.assign(this, { store, processes, assertNetwork, start, checkPort });
    this.bindings = new Map();
    this.restarting = new Set();
    this.unconfirmedPorts = new Map();
  }

  list(conversationId) {
    return (this.store.listServers?.(conversationId) || []).map(server => {
      const processId = this.bindings.get(server.serverId);
      let process;
      try { process = processId && this.processes.inspect(conversationId, processId); } catch { /* Terminal handles expire. */ }
      return { ...server, state: this.restarting.has(server.serverId) ? 'restarting' :
        process?.state === 'running' ? 'running' : this.unconfirmedPorts.get(conversationId)?.has(server.port)
          ? 'exit_unconfirmed' : processId ? 'stopped' : 'needs_restart',
      ...(process?.state === 'running' && { processId }) };
    });
  }

  get(conversationId, id) {
    if (typeof id !== 'string' || !/^workspace_server_[a-f0-9]{24}$/.test(id)) throw serverError('Invalid server');
    const server = this.list(conversationId).find(entry => entry.serverId === id);
    if (!server) throw serverError('Saved server unavailable');
    return server;
  }

  deleteConversation(conversationId) {
    for (const server of this.store.listServers?.(conversationId) || []) this.bindings.delete(server.serverId);
    this.unconfirmedPorts.delete(conversationId);
  }

  recordCompletion(conversationId, port, receipt) {
    const confirmed = confirmedServerExit(receipt);
    if (!confirmed) {
      if (!this.unconfirmedPorts.has(conversationId)) this.unconfirmedPorts.set(conversationId, new Set());
      this.unconfirmedPorts.get(conversationId).add(port);
    }
    return confirmed;
  }

  remember(conversationId, request, process) {
    if (!this.store.rememberServer || !request.previewPort || process.state !== 'running') return null;
    const server = this.store.rememberServer(conversationId, {
      command: request.command, workingDirectory: process.workspace?.workingDirectory || process.workingDirectory || request.workingDirectory || '.', port: request.previewPort,
    });
    this.bindings.set(server.serverId, process.processId);
    return server;
  }

  async restart(conversationId, id, request = {}) {
    const server = this.get(conversationId, id);
    if (this.unconfirmedPorts.get(conversationId)?.has(server.port)) throw serverError('Previous server exit is unconfirmed');
    if (this.restarting.has(id)) throw serverError('Server restart already in progress');
    if (request.command !== server.command || (request.workingDirectory || '.') !== server.workingDirectory || request.previewPort !== server.port) {
      throw serverError('The saved server command changed; review it again');
    }
    // Validate the fresh grant before stopping a currently healthy generation.
    await this.assertNetwork(conversationId, server, request);
    if (request.signal?.aborted) throw serverError('Server restart stopped');
    if (this.restarting.has(id)) throw serverError('Server restart already in progress');
    if (this.unconfirmedPorts.get(conversationId)?.has(server.port)) throw serverError('Previous server exit is unconfirmed');
    const current = this.get(conversationId, id);
    if (current.processId !== server.processId) throw serverError('Server changed while checking permissions; review it again');
    this.restarting.add(id);
    try {
      if (server.processId) {
        const stopped = await this.processes.terminate(conversationId, server.processId, { waitMs: 5000, signal: request.signal });
        if (stopped.state === 'running' || stopped.receipt?.processExitConfirmed !== true) throw serverError('Previous server exit is unconfirmed');
      }
      if (request.signal?.aborted) throw serverError('Server restart stopped');
      await this.checkPort(server.port);
      if (request.signal?.aborted) throw serverError('Server restart stopped');
      const result = await this.start(conversationId, request);
      if (result.state === 'running') this.bindings.set(id, result.processId);
      return result;
    } finally { this.restarting.delete(id); }
  }
}

// Cancellation is a requested state, not exit evidence. Main derives this
// bounded fact from the current backend's original-instance completion receipt.
function confirmedServerExit(receipt) {
  if (!receipt || !['completed', 'failed', 'cancelled', 'timed_out', 'sandbox_denied'].includes(receipt.state)) return false;
  if (receipt.survivorsPossible === false && receipt.completeDescendantTermination === true &&
      ((receipt.backend === 'linux-bubblewrap' && receipt.terminationGuarantee === 'namespace_scoped' && receipt.terminationScope === 'pid_namespace') ||
        (receipt.terminationGuarantee === 'not_applicable' && receipt.sideEffects === 'none'))) return true;
  const facts = receipt.diagnostics;
  return receipt.backend === 'macos-seatbelt' && facts?.nativeSupervisor === true &&
    facts.nativeRootExitObserved === true && facts.nativeRootReaped === true &&
    ['completed', 'cancelled', 'timed_out', 'setup_failed'].includes(facts.nativeReason) &&
    !facts.supervisorExitedAbnormally && !facts.supervisorProtocolFailed;
}

// This is a collision check, not cryptographic listener ownership. The approved
// process/port association is still rechecked for every preview request.
function assertPortFree(port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', () => reject(serverError('The declared port is already occupied; stop its owner before restarting')));
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => server.close(error => error ? reject(error) : resolve()));
  });
}

module.exports = { ManagedWorkspaceServers, assertPortFree, confirmedServerExit };
