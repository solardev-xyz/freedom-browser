'use strict';

// Claude owns subscription authentication and organization automation.
// Freedom owns the model tools exposed through its bridge.
// Never read credentials or launch through a shell.
const http = require('http');
const { randomBytes, randomUUID } = require('crypto');
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
const MAX_BRIDGE_REQUEST_BYTES = 8 * 1024 * 1024;

async function createClaudeDirectory(prefix) {
  const parent = await fs.promises.mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    await fs.promises.chmod(parent, 0o700);
    const directory = path.join(parent, 'work');
    await fs.promises.mkdir(directory, { mode: 0o700 });
    return directory;
  } catch (error) {
    await fs.promises.rm(parent, { recursive: true, force: true });
    throw error;
  }
}

function claudeEnvironment(source = process.env) {
  // Do not accidentally bill an inherited API key or load injected providers,
  // hooks, Node options, Electron flags, or a parent Claude session's settings.
  const names = ['HOME', 'USERPROFILE', 'PATH', 'Path', 'USER', 'LOGNAME', 'LANG', 'LC_ALL',
    'TMPDIR', 'TEMP', 'TMP', 'SystemRoot', 'WINDIR', 'APPDATA', 'LOCALAPPDATA'];
  return Object.fromEntries(names.filter(name => source[name] !== undefined).map(name => [name, source[name]]));
}

async function createToolBridge(tools, signal, onTool = () => {}, isReady = () => true) {
  const token = randomBytes(32).toString('hex');
  const inventory = new Map(tools.map(tool => [tool.name, tool]));
  if (inventory.size !== tools.length || tools.some(tool => !/^[a-z][a-z0-9_]*$/.test(tool.name))) {
    throw new Error('Invalid Claude tool inventory');
  }
  const calls = new Set();
  const server = http.createServer(async (req, res) => {
    const send = (status, body) => {
      if (res.destroyed) return;
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(body === undefined ? '' : JSON.stringify(body));
    };
    if (req.headers.authorization !== `Bearer ${token}` || req.headers.origin) return send(403);
    if (req.url !== '/mcp' || req.method !== 'POST') return send(405);
    let message;
    try {
      const chunks = [];
      let bytes = 0;
      req.setEncoding('utf8');
      for await (const part of req) {
        bytes += Buffer.byteLength(part);
        if (bytes > MAX_BRIDGE_REQUEST_BYTES) return send(413);
        chunks.push(part);
      }
      message = JSON.parse(chunks.join(''));
    } catch { return send(400); }
    if (signal.aborted) return send(410);
    if (!message || message.jsonrpc !== '2.0' || Array.isArray(message)) return send(400);
    const reply = result => send(200, { jsonrpc: '2.0', id: message.id, result });
    if (message.id === undefined) return send(202);
    if (message.method === 'initialize') return reply({ protocolVersion: '2025-03-26',
      capabilities: { tools: {} }, serverInfo: { name: 'Freedom Browser', version: '0.1' } });
    if (message.method === 'ping') return reply({});
    if (message.method === 'tools/list') return reply({ tools: tools.map(tool => ({
      name: tool.name, description: tool.description, inputSchema: tool.parameters,
    })) });
    const tool = inventory.get(message.params?.name);
    if (message.method !== 'tools/call' || !tool) return send(200, {
      jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Unknown method or tool' },
    });
    // This adapter does not grant permissions. The supplied controller performs
    // schema/scope checks and awaits Freedom's approval inside execute().
    if (!isReady()) return send(409);
    if (calls.size >= 32) return send(429);
    const pending = Promise.resolve().then(async () => {
      signal.throwIfAborted();
      onTool({ name: tool.name, state: 'started' });
      const result = await tool.execute(randomUUID(), message.params.arguments || {}, signal);
      signal.throwIfAborted();
      onTool({ name: tool.name, state: 'finished', isError: result.isError === true });
      return { content: result.content, isError: result.isError === true };
    });
    calls.add(pending);
    try { reply(await pending); }
    catch (error) {
      const code = /^[A-Z_]{1,80}$/.test(error.code || '') ? error.code : 'TOOL_FAILED';
      onTool({ name: tool.name, state: signal.aborted ? 'cancelled' : 'failed', code });
      const text = signal.aborted ? 'Stopped' : code === 'USER_CANCELLED'
        ? 'The user declined or cancelled this action. It was not performed. Do not retry.'
        : `Freedom refused or failed this action (${code}). Do not claim it succeeded.`;
      reply({ isError: true, content: [{ type: 'text', text }] });
    }
    finally { calls.delete(pending); }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  server.maxConnections = 40;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return {
    config: { mcpServers: { freedom: { type: 'http', url: `http://127.0.0.1:${server.address().port}/mcp`, headers: { Authorization: `Bearer ${token}` } } } },
    async close() {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
      // The supplied tools must honour AbortSignal; cancellation tests prove
      // this for the selected browser operations, not arbitrary future tools.
      await Promise.allSettled([...calls]);
    },
  };
}


const CLAUDE_PROVIDER_ID = 'anthropic-claude';
const CLAUDE_MODELS = ['sonnet', 'opus', 'haiku'].map(id => ({
  id, name: `Claude ${id[0].toUpperCase()}${id.slice(1)} · CLI default`,
  provider: CLAUDE_PROVIDER_ID, api: 'claude-cli', baseUrl: 'https://api.anthropic.com',
  reasoning: true, input: ['text', 'image'], contextWindow: 200000, maxTokens: 32000,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
}));

// SDK initialize returns the same ModelInfo catalogue as supportedModels().
// Keep alias IDs stable for saved selections/favourites; take labels from the
// installed CLI rather than guessing the version an alias resolves to.
function normalizeClaudeModels(entries) {
  if (!Array.isArray(entries)) throw cliError('Claude did not return its model catalogue.');
  const seen = new Set();
  const models = entries.flatMap(entry => {
    if (!entry || typeof entry.value !== 'string' || entry.value === 'default' ||
        !/^[a-z][a-z0-9.-]{0,119}(?:\[1m\])?$/.test(entry.value) || seen.has(entry.value) ||
        typeof entry.displayName !== 'string' || !entry.displayName.trim() || entry.displayName.length > 160) return [];
    seen.add(entry.value);
    return [{ ...CLAUDE_MODELS[0], id: entry.value,
      name: /^Claude\b/.test(entry.displayName) ? entry.displayName.trim() : `Claude ${entry.displayName.trim()}`,
      reasoning: entry.supportsEffort === true || entry.supportsAdaptiveThinking === true,
      ...(typeof entry.resolvedModel === 'string' && /^claude-[a-z0-9.-]{1,120}$/.test(entry.resolvedModel)
        ? { resolvedModel: entry.resolvedModel } : {}),
    }];
  });
  if (!models.length) throw cliError('Claude returned an empty model catalogue.');
  return models;
}

async function discoverClaudeModels({ signal, startProcess = startClaudeProcess,
  findExecutable = findClaudeExecutable } = {}) {
  const controller = new AbortController();
  const ownedSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const requestId = randomUUID();
  const statusRequestId = randomUUID();
  let child, resolve, reject, models, statusTimer;
  const result = new Promise((yes, no) => { resolve = yes; reject = no; });
  // Attach immediately: abort/startup may reject before the process is ready.
  result.catch(() => {});
  const abort = () => reject(cliError('Claude model discovery was interrupted.'));
  ownedSignal.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => {
    // A bridge that never connects must not turn into a successful alias-only connection.
    if (models) reject(configurationError());
    controller.abort();
  }, 15000);
  try {
    ownedSignal.throwIfAborted();
    child = await startProcess({ executable: await findExecutable(), model: 'sonnet',
      systemPrompt: 'Model discovery only.', tools: [], signal: ownedSignal,
      onEvent(event) {
        if (event.type !== 'control_response' || ![requestId, statusRequestId].includes(event.response?.request_id)) return;
        try {
          if (event.response.subtype !== 'success') {
            if (event.response.request_id === requestId) throw cliError('Claude model discovery failed.');
            throw Object.assign(new Error('Update Claude Code to a current native version with MCP status support.'), { code: 'AGENT_CLAUDE_VERSION' });
          }
          if (event.response.request_id === requestId) {
            models = normalizeClaudeModels(event.response.response?.models);
          } else {
            const servers = event.response.response?.mcpServers;
            if (!Array.isArray(servers) || servers.length !== 1 || servers[0].name !== 'freedom') throw configurationError();
            if (servers[0].status === 'connected') { resolve(models); return; }
            if (servers[0].status !== 'pending') throw configurationError();
          }
          // The CLI status API waits for the actual bridge connection, without
          // an inference prompt or giving discovery any executable tools.
          const check = () => { void Promise.resolve(child.write({ type: 'control_request', request_id: statusRequestId,
            request: { subtype: 'mcp_status' } })).catch(reject); };
          if (event.response.request_id === requestId) check();
          else statusTimer = setTimeout(check, 100);
        } catch (error) { reject(error); }
      },
      onClose(error) { reject(error || cliError('Claude closed before returning its model catalogue.')); },
    });
    await child.write({ type: 'control_request', request_id: requestId, request: { subtype: 'initialize', hooks: {} } });
    return await result;
  } finally {
    clearTimeout(timer);
    clearTimeout(statusTimer);
    ownedSignal.removeEventListener('abort', abort);
    controller.abort();
    await child?.close();
  }
}
function configurationError() {
  return Object.assign(new Error('Claude’s authentication or tool configuration is incompatible with Freedom. Check organization policies for additional tools, a blocked Freedom bridge or API authentication.'), { code: 'AGENT_CLAUDE_CONFIGURATION' });
}

function cliError(message) {
  return Object.assign(new Error(message), { code: 'AGENT_CLAUDE_UNAVAILABLE' });
}

async function findClaudeExecutable({ home = os.homedir(), env = process.env, platform = process.platform } = {}) {
  const filename = platform === 'win32' ? 'claude.exe' : 'claude';
  const candidates = [path.join(home, '.local', 'bin', filename),
    ...(env.PATH || env.Path || '').split(path.delimiter).filter(p => path.isAbsolute(p)).map(p => path.join(p, filename))];
  for (const candidate of [...new Set(candidates)]) {
    try {
      const target = await fs.promises.realpath(candidate);
      const info = await fs.promises.stat(target);
      if (!info.isFile()) continue;
      const handle = await fs.promises.open(target, 'r');
      let magic;
      try { const bytes = Buffer.alloc(4); await handle.read(bytes, 0, 4, 0); magic = bytes.toString('hex'); }
      finally { await handle.close(); }
      if (!['cffaedfe', 'cefaedfe', 'feedfacf', 'cafebabe', 'bebafeca', '7f454c46'].includes(magic) && !magic.startsWith('4d5a')) continue;
      await fs.promises.access(target, fs.constants.X_OK);
      return target;
    } catch { /* Try the next standard installation location. */ }
  }
  throw cliError('Install Claude Code using its native installer, run claude auth login in a terminal, then connect again.');
}

async function checkClaudeLogin({ signal, executable, run = execFileAsync } = {}) {
  executable ||= await findClaudeExecutable();
  const directory = await createClaudeDirectory('freedom-claude-auth-');
  let status;
  try {
    await fs.promises.chmod(directory, 0o700);
    const isolation = ['--restricted', '--setting-sources', ''];
    const version = await run(executable, [...isolation, '--version'], { env: claudeEnvironment(), cwd: directory, timeout: 10000, maxBuffer: 65536, signal, windowsHide: true });
    const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version.stdout.trim());
    if (!match || (Number(match[1]) < 2 || Number(match[1]) === 2 && (Number(match[2]) < 1 || Number(match[2]) === 1 && Number(match[3]) < 290))) {
      throw Object.assign(new Error('Update Claude Code to version 2.1.290 or newer, then connect again.'), { code: 'AGENT_CLAUDE_VERSION' });
    }
    const result = await run(executable, [...isolation, 'auth', 'status', '--json'], {
      env: claudeEnvironment(), cwd: directory, timeout: 15000, maxBuffer: 65536, signal, windowsHide: true,
    });
    status = JSON.parse(result.stdout);
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    if (error.code === 'AGENT_CLAUDE_VERSION') throw error;
    throw cliError('Claude Code could not confirm its login. Run claude auth login in a terminal, then try again.');
  } finally {
    await fs.promises.rm(path.dirname(directory), { recursive: true, force: true });
  }
  if (status.loggedIn !== true || status.authMethod !== 'claude.ai' || status.apiProvider !== 'firstParty') {
    throw cliError('Sign in to Claude Code with your Claude subscription using claude auth login, then try again. API billing is not used by this connection.');
  }
  if (!['pro', 'max', 'team', 'enterprise'].includes(status.subscriptionType)) {
    throw Object.assign(new Error('Sign in to Claude Code with a Pro, Max, Team or Enterprise subscription, then connect again.'), { code: 'AGENT_CLAUDE_SUBSCRIPTION_REQUIRED' });
  }
  return executable;
}

// One child per live session. Stream input keeps Claude's context in memory;
// --no-session-persistence prevents a second conversation archive in Claude.
async function startClaudeProcess({ executable, model, systemPrompt, tools, signal: ownerSignal, onEvent, onClose,
  checkLogin = checkClaudeLogin, spawnProcess = spawn }) {
  await checkLogin({ executable, signal: ownerSignal });
  const localAbort = new AbortController();
  const signal = AbortSignal.any([ownerSignal, localAbort.signal]);
  const directory = await createClaudeDirectory('freedom-claude-');
  let ready = false, child, bridge, killTimer, closed = false, failure, completion;
  const config = path.join(directory, 'mcp.json');
  const promptFile = path.join(directory, 'system.txt');
  const revoke = async () => {
    await Promise.allSettled([fs.promises.writeFile(config, '{}', { mode: 0o600 }),
      fs.promises.writeFile(promptFile, '', { mode: 0o600 })]);
    await fs.promises.rm(path.dirname(directory), { recursive: true, force: true });
  };
  try {
    await fs.promises.chmod(directory, 0o700);
    signal.throwIfAborted();
    bridge = await createToolBridge(tools, signal, undefined, () => ready);
    await fs.promises.writeFile(config, JSON.stringify(bridge.config), { mode: 0o600 });
    await fs.promises.writeFile(promptFile, systemPrompt, { mode: 0o600 });
    signal.throwIfAborted();
    const args = ['-p', '--restricted', '--tools', '', '--setting-sources', '',
      '--settings', JSON.stringify({ disableAllHooks: true, autoMemoryEnabled: false, claudeMdExcludes: ['/**', '**'] }),
      '--strict-mcp-config', '--mcp-config', config, '--no-session-persistence', '--no-chrome',
      '--disable-slash-commands', '--permission-mode', 'dontAsk', '--input-format', 'stream-json',
      '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
      '--model', model, '--system-prompt-file', promptFile];
    if (tools.length) args.push('--allowedTools', tools.map(t => `mcp__freedom__${t.name}`).join(','));
    signal.throwIfAborted();
    child = spawnProcess(executable, args, { cwd: directory, env: claudeEnvironment(),
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let buffer = '', stopping = false;
    const stop = () => {
      if (closed || stopping) return;
      stopping = true; ready = false; localAbort.abort();
      child.kill('SIGTERM');
      killTimer ||= setTimeout(() => child.kill('SIGKILL'), 2000);
    };
    signal.addEventListener('abort', stop, { once: true });
    if (signal.aborted) stop();
    child.stderr.on('data', () => {});
    child.stdin.on('error', () => { failure ||= cliError('The Claude connection closed. Reconnect and try again.'); stop(); });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      buffer += chunk;
      // Bound an individual protocol frame, not the duration or cumulative output.
      if (Buffer.byteLength(buffer) > 32 * 1024 * 1024) {
        failure = cliError('Claude returned an oversized protocol message.'); stop(); return;
      }
      let boundary;
      while ((boundary = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 1);
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          if (event.type === 'system' && event.subtype === 'init') {
            const expected = new Set(tools.map(t => `mcp__freedom__${t.name}`));
            if (event.apiKeySource !== 'none' || !Array.isArray(event.tools) ||
                event.tools.some(name => !expected.has(name) && name !== 'EndConversation') ||
                ![...expected].every(name => event.tools.includes(name))) {
              throw configurationError();
            }
            ready = true;
          }
          if (signal.aborted || failure) continue;
          onEvent(event);
        } catch (error) { failure = ['AGENT_CLAUDE_UNAVAILABLE', 'AGENT_CLAUDE_CONFIGURATION'].includes(error.code) ? error : cliError('Claude returned an invalid protocol message.'); stop(); }
      }
    });
    child.once('error', () => { failure = cliError('Could not start Claude Code. Update its native installation and reconnect.'); });
    completion = new Promise(resolve => child.once('close', async code => {
      closed = true;
      clearTimeout(killTimer);
      signal.removeEventListener('abort', stop);
      ready = false;
      const unexpected = !signal.aborted;
      localAbort.abort();
      await bridge.close();
      await revoke().catch(() => {});
      onClose(failure || (unexpected ? cliError(`Claude Code exited unexpectedly (${code}). Check your CLI login and subscription availability.`) : null));
      resolve();
    }));
    return {
      get closed() { return closed; },
      async write(message) {
        signal.throwIfAborted();
        if (closed) throw cliError('The Claude connection is closed.');
        child.stdin.write(JSON.stringify(message) + '\n');
      },
      async close() { stop(); await completion; },
    };
  } catch (error) {
    localAbort.abort();
    await completion;
    await bridge?.close(); await revoke().catch(() => {}); throw error;
  }
}

module.exports = { MAX_BRIDGE_REQUEST_BYTES, CLAUDE_PROVIDER_ID, CLAUDE_MODELS, cliError, claudeEnvironment,
  findClaudeExecutable, checkClaudeLogin, createToolBridge, startClaudeProcess,
  normalizeClaudeModels, discoverClaudeModels };
