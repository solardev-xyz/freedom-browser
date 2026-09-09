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
  }

  list(conversationId) {
    return (this.store.listServers?.(conversationId) || []).map(server => {
      const processId = this.bindings.get(server.serverId);
      let process;
      try { process = processId && this.processes.inspect(conversationId, processId); } catch { /* Terminal handles expire. */ }
      return { ...server, state: this.restarting.has(server.serverId) ? 'restarting' :
        process?.state === 'running' ? 'running' : processId ? 'stopped' : 'needs_restart',
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
    if (this.restarting.has(id)) throw serverError('Server restart already in progress');
    if (request.command !== server.command || (request.workingDirectory || '.') !== server.workingDirectory || request.previewPort !== server.port) {
      throw serverError('The saved server command changed; review it again');
    }
    // Validate the fresh grant before stopping a currently healthy generation.
    await this.assertNetwork(conversationId, server, request);
    if (request.signal?.aborted) throw serverError('Server restart stopped');
    if (this.restarting.has(id)) throw serverError('Server restart already in progress');
    this.restarting.add(id);
    try {
      if (server.processId) {
        const stopped = await this.processes.terminate(conversationId, server.processId, { waitMs: 5000, signal: request.signal });
        if (stopped.state === 'running' || stopped.receipt?.error) throw serverError('Previous server exit is unconfirmed');
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

// This is a collision check, not cryptographic listener ownership. The approved
// process/port association is still rechecked for every preview request.
function assertPortFree(port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', () => reject(serverError('The declared port is already occupied; stop its owner before restarting')));
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => server.close(error => error ? reject(error) : resolve()));
  });
}

module.exports = { ManagedWorkspaceServers, assertPortFree };
