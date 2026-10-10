'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createRequire } = require('module');
const { pathToFileURL } = require('url');
const { PI_SDK_PACKAGE } = require('./pi-sdk');

// Consume the protocol implementation shipped with the pinned Pi SDK. Resolve
// from that package so a differently versioned top-level client is never used.
async function loadMcpSdk() {
  // These packages export only an ESM import condition, so CommonJS
  // require.resolve cannot resolve their entrypoints. Locate package metadata
  // through Node's normal dependency paths, then use the declared import targets.
  const packageRoot = (resolver, name) => {
    const directory = resolver.resolve.paths(name).map(base => path.join(base, name))
      .find(base => fs.existsSync(path.join(base, 'package.json')));
    if (!directory) throw new Error('The bundled Pi MCP client is missing. Reinstall Freedom.');
    return directory;
  };
  const piRoot = packageRoot(require, PI_SDK_PACKAGE);
  const piRequire = createRequire(path.join(piRoot, 'package.json'));
  const root = packageRoot(piRequire, '@earendil-works/pi-mcp');
  const metadata = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const [client, oauth] = await Promise.all([
    import(pathToFileURL(path.join(root, metadata.exports['.'].import)).href),
    import(pathToFileURL(path.join(root, metadata.exports['./oauth'].import)).href),
  ]);
  return { ...client, ...oauth };
}

function mcpUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Enter a complete MCP server URL.'); }
  const loopback = ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
      url.username || url.password || url.hash || url.search || url.href.length > 2048) {
    throw new Error('Use an HTTPS MCP URL (HTTP is allowed on localhost), without credentials, query parameters or a fragment.');
  }
  return url.href;
}

function validateMcpEndpoint(serverUrl, endpoint) {
  const server = new URL(serverUrl);
  const url = new URL(typeof endpoint === 'string' || endpoint instanceof URL ? endpoint : endpoint.url);
  const loopback = hostname => ['127.0.0.1', '[::1]', 'localhost'].includes(hostname);
  if (url.username || url.password || (url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && loopback(server.hostname) && loopback(url.hostname)))) {
    throw new Error('The service advertised an unsafe endpoint. Check its MCP configuration.');
  }
  return url;
}

class McpConnectionStore {
  constructor({ dataDir, safeStorage }) {
    this.file = path.join(dataDir, 'mcp-connections.json');
    this.safeStorage = safeStorage;
    this.binding = crypto.createHash('sha256').update(path.resolve(dataDir)).digest('hex');
  }
  read() {
    if (!fs.existsSync(this.file)) return [];
    const stat = fs.lstatSync(this.file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw new Error('MCP connection storage is unsafe.');
    const value = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    if (value.version !== 1 || value.binding !== this.binding || !Array.isArray(value.servers) || value.servers.length > 32) {
      throw new Error('MCP connection storage is invalid.');
    }
    return value.servers.map(server => {
      if (!/^[a-f0-9]{24}$/.test(server.id) || typeof server.name !== 'string' || server.name.length > 80 ||
          mcpUrl(server.url) !== server.url) throw new Error('MCP connection storage is invalid.');
      return server;
    });
  }
  write(servers) {
    this.read();
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.${crypto.randomBytes(8).toString('hex')}.tmp`;
    const payload = JSON.stringify({ version: 1, binding: this.binding, servers });
    if (Buffer.byteLength(payload) > 1024 * 1024) throw new Error('MCP connection storage is full. Remove an unused connection.');
    const fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL |
      (fs.constants.O_NOFOLLOW || 0), 0o600);
    try {
      fs.writeFileSync(fd, payload);
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    fs.renameSync(temporary, this.file);
  }
  credentials(id) {
    const server = this.read().find(item => item.id === id);
    if (!server?.credentials) return undefined;
    const value = JSON.parse(this.safeStorage.decryptString(Buffer.from(server.credentials, 'base64')));
    if (value.serverUrl !== server.url) throw new Error('MCP credentials belong to another server. Reconnect it.');
    return value;
  }
  saveCredentials(id, state) {
    if (!this.safeStorage.isEncryptionAvailable() || this.safeStorage.getSelectedStorageBackend?.() === 'basic_text') {
      throw new Error('Secure credential storage is unavailable. Enable the system keyring and sign in again.');
    }
    const servers = this.read();
    const server = servers.find(item => item.id === id);
    if (!server || state.serverUrl !== server.url) throw new Error('This connection was removed. Connect it again.');
    server.credentials = this.safeStorage.encryptString(JSON.stringify(state)).toString('base64');
    this.write(servers);
  }
}

class McpConnectionManager {
  constructor(options) {
    this.store = options.store || new McpConnectionStore(options);
    this.loadSdk = options.loadSdk || loadMcpSdk;
    this.openExternal = options.openExternal;
    this.fetch = options.fetch || globalThis.fetch;
    this.connections = new Map();
    this.pending = new Map();
    this.logins = new Map();
    this.errors = new Map();
    this.challenges = new Map();
    this.disposed = false;
  }
  list() {
    return this.store.read().map(({ id, name, url }) => ({ id, name, url,
      state: this.logins.has(id) ? 'signing-in' : this.pending.has(id) ? 'connecting'
        : this.connections.has(id) ? 'connected' : this.errors.get(id)?.state || 'disconnected',
      message: this.errors.get(id)?.message || '',
      tools: (this.connections.get(id)?.tools || []).map(({ name, description }) => ({ name, description: String(description || '').slice(0, 500) })),
    }));
  }
  async add({ name, url }) {
    url = mcpUrl(url);
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 80) throw new Error('Enter a connection name (up to 80 characters).');
    const servers = this.store.read();
    if (servers.length >= 32) throw new Error('Remove a connection before adding another (32 maximum).');
    if (servers.some(server => server.url === url)) throw new Error('This server is already connected. Use its Reconnect button.');
    const server = { id: crypto.randomBytes(12).toString('hex'), name: name.trim(), url };
    this.store.write([...servers, server]);
    await this.connect(server.id);
    return this.list();
  }
  server(id) {
    if (this.disposed) throw new Error('MCP connections have closed. Reopen Freedom.');
    const server = this.store.read().find(item => item.id === id);
    if (!server) throw new Error('MCP connection is unavailable. Open Connections and reconnect it.');
    return server;
  }
  async connect(id) {
    this.server(id);
    if (this.pending.has(id)) return this.pending.get(id);
    if (this.connections.has(id)) return this.connections.get(id);
    const pending = this.open(id).finally(() => this.pending.delete(id));
    this.pending.set(id, pending);
    return pending;
  }
  async open(id) {
    const server = this.server(id);
    const sdk = await this.loadSdk();
    const client = new sdk.McpClient({ name: 'Freedom Agent', version: '1.0', requestTimeoutMs: 30000 });
    try {
      const provider = new sdk.McpOAuthProvider({ serverUrl: server.url,
        redirectUrl: this.store.credentials(id)?.redirectUrl || 'http://127.0.0.1/callback',
        clientMetadata: { client_name: 'Freedom Agent', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' },
        store: { load: () => this.store.credentials(id), save: state => this.store.saveCredentials(id, state) },
        onRedirect: () => { throw new sdk.McpOAuthAuthorizationRequiredError(); },
      });
      const auth = sdk.adaptOAuthProvider(provider);
      const transport = new sdk.StreamableHttpTransport({ url: server.url,
        authProvider: { token: auth.token, onUnauthorized: async context => {
          this.challenges.set(id, sdk.parseWwwAuthenticate(context.response.headers.get('www-authenticate')));
          if (!this.store.credentials(id)?.tokens?.refresh_token) throw new sdk.McpOAuthAuthorizationRequiredError();
          return auth.onUnauthorized(context);
        } },
        // Never forward credentials through a server-controlled HTTP redirect.
        fetch: (url, init) => {
          validateMcpEndpoint(server.url, url);
          return this.fetch(url, { ...init, redirect: 'error',
            signal: AbortSignal.any([AbortSignal.timeout(30000), ...(init?.signal ? [init.signal] : [])]),
          });
        },
        maxMessageBytes: 4 * 1024 * 1024,
      });
      await client.connect(transport);
      const tools = client.serverCapabilities?.tools ? await client.listTools() : [];
      if (tools.length > 1000 || tools.some(tool => typeof tool.name !== 'string' || tool.name.length > 128)) throw new Error('Invalid MCP catalog.');
      this.server(id); // Removal while connecting cannot resurrect a connection.
      const connection = { client, tools, server };
      this.connections.set(id, connection);
      this.errors.delete(id);
      client.onClose(() => {
        if (this.connections.get(id) === connection) this.connections.delete(id);
      });
      return connection;
    } catch (error) {
      await client.close().catch(() => {});
      const needsAuth = error instanceof sdk.McpOAuthAuthorizationRequiredError || error instanceof sdk.McpAuthRequiredError;
      this.errors.set(id, { state: needsAuth ? 'needs-auth' : 'failed',
        message: needsAuth ? 'Sign in to connect this service.' : 'Could not connect. Check the MCP URL and reconnect.' });
      return null;
    }
  }
  async reconnect(id) {
    this.server(id);
    await this.connections.get(id)?.client.close();
    await this.connect(id);
    return this.list();
  }
  async signIn(id) {
    const server = this.server(id);
    if (this.logins.size) throw new Error('Finish or cancel the current sign-in first.');
    const controller = new AbortController();
    const login = { controller, callback: null };
    this.logins.set(id, login);
    try {
      const sdk = await this.loadSdk();
      const savedRedirect = this.store.credentials(id)?.redirectUrl;
      const callbackPort = savedRedirect ? Number(new URL(savedRedirect).port) : 0;
      const callback = await sdk.OAuthCallbackServer.listen({ port: callbackPort, timeoutMs: 180000 });
      login.callback = callback;
      controller.signal.throwIfAborted();
      let callbackResult;
      const provider = new sdk.McpOAuthProvider({ serverUrl: server.url, redirectUrl: callback.redirectUrl,
        clientMetadata: { client_name: 'Freedom Agent', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' },
        store: { load: () => this.store.credentials(id), save: state => {
          controller.signal.throwIfAborted();
          this.store.saveCredentials(id, { ...state, redirectUrl: callback.redirectUrl });
        } },
        onRedirect: async url => {
          controller.signal.throwIfAborted();
          validateMcpEndpoint(server.url, url);
          callbackResult = callback.waitForCallback(url.searchParams.get('state'));
          callbackResult.catch(() => {});
          await this.openExternal(url.href);
        },
      });
      const fetch = (url, init) => {
        validateMcpEndpoint(server.url, url);
        return this.fetch(url, { ...init, signal: AbortSignal.any([AbortSignal.timeout(30000), controller.signal, ...(init?.signal ? [init.signal] : [])]), redirect: 'error' });
      };
      const challenge = this.challenges.get(id);
      const result = await sdk.authorizeMcp(provider, { serverUrl: server.url, fetch, skipRefresh: true,
        resourceMetadataUrl: challenge?.resourceMetadataUrl,
        scope: sdk.stepUpScope(this.store.credentials(id)?.tokens?.scope, challenge?.scope),
      });
      if (result === 'REDIRECT') {
        const response = await callbackResult;
        controller.signal.throwIfAborted();
        await sdk.authorizeMcp(provider, { serverUrl: server.url, authorizationCode: response.code, iss: response.iss, fetch });
      }
      await this.reconnect(id);
      if (this.logins.get(id) === login) this.logins.delete(id);
      return this.list();
    } finally {
      await login.callback?.close();
      if (this.logins.get(id) === login) this.logins.delete(id);
    }
  }
  async cancelSignIn(id) {
    const login = this.logins.get(id);
    login?.controller.abort();
    await login?.callback?.close();
    if (this.logins.get(id) === login) this.logins.delete(id);
    return this.list();
  }
  async remove(id) {
    this.server(id);
    await this.cancelSignIn(id);
    this.store.write(this.store.read().filter(server => server.id !== id));
    await this.connections.get(id)?.client.close();
    this.connections.delete(id);
    this.errors.delete(id);
    this.challenges.delete(id);
    return this.list();
  }
  async waitForConnection(id, signal) {
    signal?.throwIfAborted();
    const connection = this.connect(id);
    if (!signal) return connection;
    let aborted;
    const stopped = new Promise((_, reject) => {
      aborted = () => reject(signal.reason || Object.assign(new Error('MCP request cancelled'), { code: 'ABORT_ERR' }));
      signal.addEventListener('abort', aborted, { once: true });
    });
    try { return await Promise.race([connection, stopped]); }
    finally { signal.removeEventListener('abort', aborted); }
  }
  async discover(id, query = '', signal) {
    const servers = id ? [this.server(id)] : this.store.read();
    return Promise.all(servers.map(async server => {
      const connection = await this.waitForConnection(server.id, signal);
      return { id: server.id, name: server.name, url: server.url,
        ...(connection ? { tools: connection.tools.filter(tool => `${tool.name} ${tool.description || ''}`.toLowerCase().includes(query.toLowerCase())).slice(0, id ? 20 : 10)
            .map(tool => ({ name: tool.name, description: String(tool.description || '').slice(0, 1000),
              ...(id && { inputSchema: tool.inputSchema }) })),
          hint: 'Use serverId and query to retrieve matching tool schemas. At most 20 matching schemas are returned.',
          resources: Boolean(connection.client.serverCapabilities?.resources) } : { error: this.errors.get(server.id)?.message }),
      };
    }));
  }
  async perform(params, requestApproval, signal) {
    params = JSON.parse(JSON.stringify(params));
    const server = this.server(params.serverId);
    const connection = await this.waitForConnection(server.id, signal);
    signal?.throwIfAborted();
    if (!connection) throw new Error(`${this.errors.get(server.id)?.message} Open Agent Connections to reconnect or sign in, then retry.`);
    if (params.action === 'call' && !connection.tools.some(tool => tool.name === params.name)) {
      throw new Error('This tool is unavailable. Discover the server tools again and use a listed name.');
    }
    const argumentsJSON = JSON.stringify(params.action === 'call' ? params.arguments || {} : { uri: params.uri });
    if (argumentsJSON.length > 8192) throw new Error('MCP arguments are too large for review. Use a smaller request.');
    const decision = await requestApproval({ action: 'mcp', operation: 'mcp_request', origin: server.url,
      label: params.action === 'call' ? params.name : params.action, mcp: { server: server.name, name: params.action === 'call' ? params.name : params.action, argumentsJSON } });
    signal?.throwIfAborted();
    if (!(decision === 'approved' || decision?.status === 'approved')) throw Object.assign(new Error('MCP request declined. Stop; ask the user before trying again.'), { code: 'USER_DECLINED' });
    this.server(server.id);
    if (this.connections.get(server.id) !== connection) throw new Error('MCP connection changed during approval. Discover it again before retrying.');
    try {
      if (params.action === 'call') return await connection.client.callTool(params.name, JSON.parse(argumentsJSON), { signal });
      if (params.action === 'list_resources') return { resources: await connection.client.listResources({ signal }), templates: await connection.client.listResourceTemplates({ signal }) };
      if (params.action === 'read_resource' && typeof params.uri === 'string') return await connection.client.readResource(params.uri, { signal });
      throw new Error('Unknown MCP action.');
    } catch (error) {
      if (['McpOAuthAuthorizationRequiredError', 'McpAuthRequiredError'].includes(error?.name)) {
        this.errors.set(server.id, { state: 'needs-auth', message: 'Sign in to reconnect this service.' });
        await connection.client.close().catch(() => {});
      }
      throw new Error('MCP request did not complete. Its effects may be unknown; inspect the service before retrying. Reconnect in Agent Connections if needed.', { cause: error });
    }
  }
  async dispose() {
    this.disposed = true;
    await Promise.allSettled([...this.logins.keys()].map(id => this.cancelSignIn(id)));
    await Promise.allSettled([...this.connections.values()].map(connection => connection.client.close()));
    await Promise.allSettled(this.pending.values());
    this.connections.clear();
  }
}

module.exports = { McpConnectionManager, McpConnectionStore, mcpUrl, validateMcpEndpoint, loadMcpSdk };
