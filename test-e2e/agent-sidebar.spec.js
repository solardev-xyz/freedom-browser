const { test: baseTest, expect } = require('./fixtures');
const { _electron: electron } = require('@playwright/test');
const path = require('path');
const http = require('http');
const fs = require('fs');
const os = require('os');

const test = baseTest.extend({
  ollamaServer: async ({ electronApp: _electronApp }, use) => {
    const server = http.createServer((request, response) => {
      response.setHeader('Content-Type', 'application/json');
      if (request.method === 'GET' && request.url === '/api/tags') {
        response.end(JSON.stringify({ models: [{ name: 'freedom-e2e-no-server' }] }));
      } else {
        response.writeHead(404);
        response.end(JSON.stringify({ error: 'Model unavailable in discovery-only fixture' }));
      }
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      await use(`http://127.0.0.1:${server.address().port}/v1`);
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  },
});

const repositoryRoot = path.resolve(__dirname, '..');

test('Agent stays hidden throughout startup and opens only on request', async ({ window }) => {
  await window.addInitScript(() => {
    window.agentStartupFrames = [];
    const sample = () => {
      const panel = document.getElementById('agent-sidebar');
      if (panel) {
        const bounds = panel.getBoundingClientRect();
        const style = getComputedStyle(panel);
        window.agentStartupFrames.push({
          visible: bounds.width > 0 && bounds.height > 0 &&
            style.visibility === 'visible' && style.display !== 'none',
          floating: panel.classList.contains('agent-floating'),
        });
      }
      window.agentStartupFrame = requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  await window.reload();
  await expect(window.locator('#agent-sidebar')).toHaveClass(/agent-floating/);
  // Include the closing transition interval, not just the settled state.
  await window.waitForTimeout(500);
  const frames = await window.evaluate(() => {
    cancelAnimationFrame(window.agentStartupFrame);
    return window.agentStartupFrames;
  });
  expect(frames.some(frame => frame.floating)).toBe(true);
  expect(frames.filter(frame => frame.visible)).toEqual([]);

  await window.locator('[data-test="agent-toggle-btn"]').click();
  await expect(window.locator('#agent-sidebar')).toBeVisible();
  await window.locator('#agent-sidebar-close').click();
  await expect(window.locator('#agent-sidebar')).toBeHidden();
});

test('ChatGPT callback uses Freedom branding and a declined login can be retried', async ({ electronApp, window }, testInfo) => {
  await electronApp.evaluate(({ shell }) => {
    shell.openExternal = async url => { globalThis.chatGPTAuthorization = url; };
  });
  await window.locator('[data-test="agent-toggle-btn"]').click();
  await window.locator('#agent-provider-add').click();
  await window.locator('#agent-provider-choices').getByRole('button', { name: 'OpenAI', exact: true }).click();
  await window.locator('#agent-provider-chatgpt').click();
  await window.locator('#agent-provider-login').click();
  await expect.poll(() => electronApp.evaluate(() => globalThis.chatGPTAuthorization)).toBeTruthy();
  const authorization = new URL(await electronApp.evaluate(() => globalThis.chatGPTAuthorization));
  expect(authorization.searchParams.get('agent_name_hint')).toBe('Freedom Browser');
  const callback = new URL(authorization.searchParams.get('redirect_uri'));
  callback.search = new URLSearchParams({ state: authorization.searchParams.get('state'), error: 'access_denied' }).toString();
  const callbackWindow = electronApp.waitForEvent('window');
  await electronApp.evaluate(({ BrowserWindow, session }, url) => {
    // This test visits only the local callback, which the harness normally blocks.
    session.defaultSession.protocol.unhandle('http');
    const callback = new BrowserWindow({ width: 720, height: 560, show: false,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
    void callback.loadURL(url);
  }, callback.toString());
  const page = await callbackWindow;
  await expect(page.getByRole('heading', { name: 'Connection cancelled' })).toBeVisible();
  await expect(page.getByRole('img', { name: 'Freedom Browser' })).toBeVisible();
  for (const colorScheme of ['dark', 'light']) {
    await page.emulateMedia({ colorScheme });
    await page.screenshot({ path: testInfo.outputPath(`chatgpt-cancelled-${colorScheme}.png`) });
  }
  await expect(window.locator('#agent-provider-login')).toBeVisible();
  await window.locator('#agent-provider-login').click();
  await expect.poll(() => electronApp.evaluate(() => globalThis.chatGPTAuthorization)).not.toBe(authorization.toString());
  await window.locator('#agent-provider-cancel-login').click();
  await expect(window.locator('#agent-provider-login')).toBeVisible();
  await page.close();
});

test('model picker collapses providers while keeping favorites and searchable models in both themes', async ({ electronApp, window }, testInfo) => {
  await electronApp.evaluate((_electron, root) => {
    const require = process.getBuiltinModule('module').createRequire(`${root}/package.json`);
    const { AgentProviderResolver } = require(root + '/src/main/agent/provider-resolver');
    AgentProviderResolver.prototype.getStatus = () => ({
      configured: true, providerId: 'openai', modelId: 'favorite',
      connections: [
        { kind: 'hosted', providerId: 'openai', modelId: 'favorite', favoriteModelIds: ['favorite'] },
        { kind: 'ollama', providerId: 'ollama', modelId: 'qwen3:8b', modelIds: ['qwen3:8b'], favoriteModelIds: [] },
      ],
    });
    AgentProviderResolver.prototype.getCatalog = async () => [{
      providerId: 'openai', name: 'OpenAI', models: [
        { id: 'favorite', name: 'Favorite model' }, { id: 'another', name: 'Another model' },
      ],
    }];
  }, repositoryRoot);
  await window.reload();
  await window.locator('[data-test="agent-toggle-btn"]').click();
  await window.locator('#agent-model-menu-button').click();
  const menu = window.locator('#agent-model-menu');
  const openai = menu.getByRole('button', { name: 'OpenAI · API', exact: true });
  const ollama = menu.getByRole('button', { name: /Ollama/ });
  const search = window.locator('#agent-model-menu-search');
  for (const theme of ['dark', 'light']) {
    await window.evaluate(value => document.documentElement.dataset.theme = value, theme);
    await expect(openai).toHaveAttribute('aria-expanded', 'false');
    await expect(menu.getByRole('menuitemradio', { name: /Favorite model/ })).toBeVisible();
    await expect(menu.getByRole('menuitemradio', { name: 'Another model' })).toHaveCount(0);
    await expect(menu.getByRole('menuitemradio', { name: 'qwen3:8b' })).toHaveCount(0);
    await menu.screenshot({ path: testInfo.outputPath(`models-${theme}-collapsed.png`) });
    await openai.focus();
    await window.keyboard.press('Enter');
    await expect(openai).toBeFocused();
    await expect(menu.getByRole('menuitemradio', { name: 'Another model' })).toBeVisible();
    await expect(ollama).toHaveAttribute('aria-expanded', 'false');
    await menu.screenshot({ path: testInfo.outputPath(`models-${theme}-expanded.png`) });
    await window.keyboard.press('Space');
    await search.fill('Another');
    await expect(menu.getByRole('menuitemradio', { name: 'Another model' })).toBeVisible();
    await search.fill('');
    await expect(openai).toHaveAttribute('aria-expanded', 'false');
    await expect(menu.getByRole('menuitemradio', { name: 'Another model' })).toHaveCount(0);
  }
});

test('ChatGPT browser sign-in supports cancellation and a private callback fallback in both themes', async ({ electronApp, window }, testInfo) => {
  // Exercise the real IPC/store/UI without opening an external browser or using
  // real credentials. Native Pi OAuth and refresh are tested at the HTTP boundary.
  await electronApp.evaluate(({ shell }, root) => {
    const require = process.getBuiltinModule('module').createRequire(`${root}/package.json`);
    const { AgentProviderResolver } = require(root + '/src/main/agent/provider-resolver');
    shell.openExternal = async () => {};
    AgentProviderResolver.prototype.loginSubscription = async function(input, interaction) {
      interaction.notify({ type: 'auth_url', url: 'https://auth.openai.com/api/accounts/authorize?state=test-only' });
      const callback = await interaction.prompt({ type: 'manual_code', signal: interaction.signal });
      if (!callback.includes('code=fixture')) throw new Error('Invalid fixture callback');
      await this.credentials.modify(input.providerId, async () => ({ type: 'oauth', access: 'fixture-access', refresh: 'fixture-refresh', expires: Date.now() + 3600000, clientId: 'fixture-client' }));
      this.store.saveSubscription(input);
      return this.getStatus();
    };
  }, repositoryRoot);
  await window.locator('[data-test="agent-toggle-btn"]').click();
  await window.locator('#agent-provider-add').click();
  await window.locator('#agent-provider-choices').getByRole('button', { name: 'OpenAI', exact: true }).click();
  await window.locator('#agent-provider-chatgpt').click();
  await expect(window.locator('#agent-provider-select')).toHaveValue('openai-chatgpt');
  await expect(window.locator('#agent-model-select')).toHaveValue('gpt-6.1-sol');
  for (const theme of ['dark', 'light']) {
    await window.evaluate(value => document.documentElement.setAttribute('data-theme', value), theme);
    await window.locator('#agent-setup-view').screenshot({ path: testInfo.outputPath(`chatgpt-${theme}-before.png`) });
    await window.locator('#agent-provider-login').click();
    await expect(window.locator('#agent-provider-message')).toContainText('Finish signing in');
    await expect(window.locator('#agent-auth-code')).toBeHidden();
    await window.locator('#agent-auth-callback summary').click();
    await expect(window.locator('#agent-auth-callback-input')).toBeVisible();
    await expect(window.locator('#agent-auth-callback-input')).toHaveAttribute('type', 'password');
    await window.locator('#agent-setup-view').screenshot({ path: testInfo.outputPath(`chatgpt-${theme}-callback.png`) });
    await window.locator('#agent-provider-cancel-login').click();
    await expect(window.locator('#agent-provider-login')).toBeVisible();
    await expect(window.locator('#agent-auth-callback')).toBeHidden();
  }
  await window.locator('#agent-provider-login').click();
  await window.locator('#agent-auth-callback summary').click();
  await window.locator('#agent-auth-callback-input').fill('http://127.0.0.1:1455/auth/callback?code=fixture&state=test&client_id=test');
  await window.locator('#agent-auth-callback-submit').click();
  await expect(window.locator('#agent-provider-status')).toHaveText('Connected');
  await expect(window.locator('#agent-auth-callback-input')).toHaveValue('');
  await expect(window.locator('#agent-auth-callback')).toBeHidden();
  await expect(window.locator('#agent-provider-login')).toBeHidden();
  window.once('dialog', dialog => dialog.accept());
  await window.locator('#agent-provider-disconnect').click();
  await expect(window.locator('#agent-provider-add')).toBeVisible();
  expect((await window.evaluate(() => window.electronAPI.getAgentProviderStatus())).status.configured).toBe(false);
  await window.locator('#agent-provider-add').click();
  await window.locator('#agent-provider-choices').getByRole('button', { name: 'Meta (Muse)', exact: true }).click();
  await window.locator('#agent-provider-api').click();
  await expect(window.locator('#agent-model-select')).toHaveValue('muse-spark-1.3');
  await expect(window.locator('#agent-provider-models-list')).toContainText('Muse Spark');
});

test('Meta subscription sign-in shows device codes, cancels and connects in both themes', async ({ electronApp, window }, testInfo) => {
  await electronApp.evaluate(({ shell }, root) => {
    const require = process.getBuiltinModule('module').createRequire(`${root}/package.json`);
    const { AgentProviderResolver } = require(root + '/src/main/agent/provider-resolver');
    shell.openExternal = async url => { globalThis.metaLoginUrl = url; };
    AgentProviderResolver.prototype.loginSubscription = async function(input, interaction) {
      interaction.notify({ type: 'device_code', userCode: 'TEST-1234', verificationUri: 'https://auth.meta.com/device' });
      await new Promise((resolve, reject) => {
        globalThis.completeMetaLogin = resolve;
        interaction.signal.addEventListener('abort', () => reject(new Error('Cancelled')), { once: true });
      });
      await this.credentials.modify(input.providerId, async () => ({ type: 'oauth', access: 'fixture-access', refresh: 'fixture-identity', expires: Date.now() + 3600000 }));
      this.store.saveSubscription(input);
      return this.getStatus();
    };
  }, repositoryRoot);
  await window.locator('[data-test="agent-toggle-btn"]').click();
  await window.locator('#agent-provider-add').click();
  await window.locator('#agent-provider-choices').getByRole('button', { name: 'Meta (Muse)', exact: true }).click();
  await expect(window.locator('#agent-provider-chatgpt')).toContainText('Meta subscription');
  await window.locator('#agent-provider-chatgpt').click();
  await expect(window.locator('#agent-provider-select')).toHaveValue('meta-subscription');
  await expect(window.locator('#agent-api-key')).toBeHidden();
  await expect(window.locator('#agent-provider-login')).toHaveText('Sign in with Meta');
  for (const theme of ['dark', 'light']) {
    await window.evaluate(value => document.documentElement.setAttribute('data-theme', value), theme);
    await window.locator('#agent-provider-login').click();
    await expect(window.locator('#agent-auth-code')).toContainText('TEST-1234');
    await expect(window.locator('#agent-auth-code')).toContainText('Meta page');
    await expect(window.locator('#agent-auth-callback')).toBeHidden();
    await window.locator('#agent-setup-view').screenshot({ path: testInfo.outputPath(`meta-${theme}-login.png`) });
    await window.locator('#agent-provider-cancel-login').click();
    await expect(window.locator('#agent-provider-login')).toBeVisible();
  }
  expect(await electronApp.evaluate(() => globalThis.metaLoginUrl)).toBe('https://auth.meta.com/device');
  await window.locator('#agent-provider-login').click();
  await expect(window.locator('#agent-auth-code')).toBeVisible();
  await electronApp.evaluate(() => globalThis.completeMetaLogin());
  await expect(window.locator('#agent-provider-status')).toHaveText('Connected');
  await expect(window.locator('#agent-provider-login')).toBeHidden();
  await window.locator('#agent-provider-detail-back').click();
  await window.locator('#agent-provider-add').click();
  await window.locator('#agent-provider-choices').getByRole('button', { name: 'Meta (Muse)', exact: true }).click();
  await expect(window.locator('#agent-provider-status')).toHaveText('Connected');
  await expect(window.locator('#agent-provider-chatgpt-state')).toHaveText('Connected');
  await expect(window.locator('#agent-provider-api-state')).toHaveText('Connect');
  await window.locator('#agent-provider-chatgpt').click();
  window.once('dialog', dialog => dialog.accept());
  await window.locator('#agent-provider-disconnect').click();
  await expect(window.locator('#agent-provider-add')).toBeVisible();
  expect((await window.evaluate(() => window.electronAPI.getAgentProviderStatus())).status.configured).toBe(false);
});

for (const database of ['agent-history.sqlite', 'agent-node-operations.sqlite', 'agent-workspaces.sqlite']) {
  test(`browser starts without resetting unavailable ${database}`, async ({ userDataDir, relaunchApp }) => {
    const databasePath = path.join(userDataDir, database);
    const damaged = Buffer.from('Corrupt database fixture: preserve these bytes');
    fs.writeFileSync(databasePath, damaged);
    const app = await relaunchApp();
    const window = await app.firstWindow();
    await expect(window.locator('[data-test="address-input"]')).toBeVisible();
    await window.locator('[data-test="agent-toggle-btn"]').click();
    await expect(window.locator('#agent-provider-message')).toContainText('Agent storage is unavailable');
    const state = await window.evaluate(() => window.electronAPI.getAgentState());
    expect(state).toMatchObject({ ok: false, error: { code: 'AGENT_STORAGE_UNAVAILABLE' } });
    expect(fs.readFileSync(databasePath).equals(damaged)).toBe(true);
  });
}

test('read-only external projects accept SSH remotes and physical ASAR archives', async ({ electronApp, userDataDir }) => {
  const result = await electronApp.evaluate(async (_electron, { root, userDataDir }) => {
    const require = process.getBuiltinModule('module').createRequire(`${root}/package.json`);
    const fs = require('original-fs'); const path = require('path');
    const { AgentManagedWorkspaceStore } = require(root + '/src/main/agent/managed-workspace-store');
    const { ManagedWorkspaceController } = require(root + '/src/main/agent/managed-workspace-controller');
    const profile = path.join(userDataDir, 'read-profile');
    const project = path.join(userDataDir, 'read-project');
    fs.mkdirSync(profile, { recursive: true });
    fs.mkdirSync(path.join(project, '.git'), { recursive: true });
    fs.mkdirSync(path.join(project, 'node_modules'), { recursive: true });
    fs.writeFileSync(path.join(project, '.git/config'), '[remote "origin"]\n url = ssh://git@example.com/project.git\n');
    fs.writeFileSync(path.join(project, 'README.md'), 'External project fixture');
    fs.copyFileSync(path.join(process.resourcesPath, 'default_app.asar'), path.join(project, 'node_modules/app.asar'));
    // An archive outside ignored dependencies must stay a file during search too.
    fs.copyFileSync(path.join(process.resourcesPath, 'default_app.asar'), path.join(project, 'build.asar'));
    const store = new AgentManagedWorkspaceStore({ userDataDir: profile });
    const controller = new ManagedWorkspaceController({ store });
    try {
      const workspace = await store.attachProject('read-project', project);
      const [read, listing, found] = await Promise.all([
        controller.readFile('read-project', 'README.md'),
        controller.listDirectory('read-project', '.'),
        controller.findFiles('read-project', '.', { pattern: '**/README*' }),
      ]);
      let writeError;
      try { await controller.writeFile('read-project', 'README.md', 'Unauthorized'); } catch (error) { writeError = error.code; }
      return { mode: workspace.project.mode, read: read.toString('utf8'), listed: listing.entries.some(entry => entry.name === 'README.md'),
        found: found.results.includes('README.md'), writeError,
        unchanged: fs.readFileSync(path.join(project, 'README.md'), 'utf8') === 'External project fixture' };
    } finally { await controller.dispose(); store.close(); }
  }, { root: repositoryRoot, userDataDir });
  expect(result).toEqual({ mode: 'read', read: 'External project fixture', listed: true, found: true, writeError: 'PROJECT_READ_ONLY', unchanged: true });
});

test('reads a live external project without granting writes or socket access', async ({ electronApp, userDataDir }) => {
  test.skip(process.platform === 'win32', 'Unix socket fixture');
  const result = await electronApp.evaluate(async (_electron, { root, userDataDir }) => {
    const require = process.getBuiltinModule('module').createRequire(`${root}/package.json`);
    const fs = require('original-fs'); const path = require('path'); const net = require('net');
    const { AgentManagedWorkspaceStore } = require(root + '/src/main/agent/managed-workspace-store');
    const { ManagedWorkspaceController } = require(root + '/src/main/agent/managed-workspace-controller');
    const { createWorkspaceFileReadPolicy, createWorkspaceExecutionPolicy } = require(root + '/src/main/agent/workspace-execution/execution-policy');
    const directory = fs.mkdtempSync(path.join(require('os').tmpdir(), 'fr-'));
    const project = path.join(directory, 'p');
    fs.mkdirSync(project);
    fs.mkdirSync(path.join(project, '.git'));
    fs.writeFileSync(path.join(project, 'README.md'), 'Live project fixture');
    const outside = path.join(directory, 'outside.txt');
    fs.writeFileSync(outside, 'outside fixture');
    fs.symlinkSync(outside, path.join(project, 'link.txt'));
    fs.linkSync(outside, path.join(project, 'hardlink.txt'));
    let connections = 0;
    const socket = net.createServer(connection => { connections += 1; connection.end(); });
    await new Promise((resolve, reject) => { socket.once('error', reject); socket.listen(path.join(project, 'live.sock'), resolve); });
    const changing = setInterval(() => fs.writeFileSync(path.join(project, 'runtime.log'), String(Date.now())), 10);
    const profile = path.join(userDataDir, 'live-read-profile');
    fs.mkdirSync(profile);
    const store = new AgentManagedWorkspaceStore({ userDataDir: profile });
    let readPolicy;
    const controller = new ManagedWorkspaceController({ store, createReadPolicy: async options => {
      readPolicy = await createWorkspaceFileReadPolicy(options); return readPolicy;
    } });
    try {
      await store.attachProject('live-project', project);
      const [read, listing, found, matches] = await Promise.all([
        controller.readFile('live-project', 'README.md'), controller.listDirectory('live-project', '.'),
        controller.findFiles('live-project', '.', { pattern: '*.md' }),
        controller.grepFiles('live-project', '.', { pattern: 'Live project', glob: '*.md', literal: true }),
      ]);
      const denied = {};
      for (const name of ['live.sock', 'link.txt', 'hardlink.txt']) {
        try { await controller.readFile('live-project', name); } catch (error) { denied[name] = error.code; }
      }
      let writeError;
      try { await controller.writeFile('live-project', 'README.md', 'changed'); } catch (error) { writeError = error.code; }
      const executionRoot = process.platform === 'linux' ? '/workspace' : fs.realpathSync(project);
      const attemptedWrite = await controller.executor.execute(readPolicy, {
        command: '/bin/sh', args: ['-c', 'printf changed > "$1"', 'write-probe', executionRoot + '/README.md'],
      });
      const socketProbe = await controller.executor.execute(readPolicy, {
        command: controller.runtime.sandboxExecutablePath,
        args: ['-e', "const c=require('net').connect(process.argv[1]); c.on('connect',()=>{c.end();process.exitCode=1;}); c.on('error',()=>{process.exitCode=0;});", executionRoot + '/live.sock'],
      });
      let commandPolicyError;
      try { await createWorkspaceExecutionPolicy({ workspaceRoot: project }); } catch (error) { commandPolicyError = error.code; }
      return { read: read.toString(), listed: listing.entries.some(entry => entry.name === 'README.md'),
        found: found.results.includes('README.md'), matched: matches.output.includes('Live project'), denied, writeError,
        sandboxWriteDenied: attemptedWrite.exitCode !== 0, socketDenied: socketProbe.exitCode === 0 && connections === 0,
        unchanged: fs.readFileSync(path.join(project, 'README.md'), 'utf8') === 'Live project fixture',
        commandStillValidated: ['WORKSPACE_SPECIAL_FILE_DENIED', 'WORKSPACE_HARDLINK_DENIED', 'WORKSPACE_CHANGED_DURING_VALIDATION'].includes(commandPolicyError) };
    } finally {
      clearInterval(changing); await controller.dispose(); store.close();
      await new Promise(resolve => socket.close(resolve));
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }, { root: repositoryRoot, userDataDir });
  expect(result).toEqual({ read: 'Live project fixture', listed: true, found: true, matched: true,
    denied: { 'live.sock': 'WORKSPACE_PATH_TYPE_MISMATCH', 'link.txt': 'WORKSPACE_FILE_UNSAFE', 'hardlink.txt': 'WORKSPACE_FILE_UNSAFE' },
    writeError: 'PROJECT_READ_ONLY', sandboxWriteDenied: true, socketDenied: true, unchanged: true, commandStillValidated: true });
});

for (const kind of ['managed', 'external']) test(`scoped helper edits ${kind} files through Pi tools and the real sandbox`, async ({ electronApp, userDataDir }) => {
  const result = await electronApp.evaluate(async (_electron, { root, userDataDir, kind }) => {
    const require = process.getBuiltinModule('module').createRequire(`${root}/package.json`);
    const fs = require('original-fs'); const path = require('path');
    const { AgentManagedWorkspaceStore } = require(root + '/src/main/agent/managed-workspace-store');
    const { ManagedWorkspaceController } = require(root + '/src/main/agent/managed-workspace-controller');
    const { createSubagentTool } = require(root + '/src/main/agent/pi-subagent-tools');
    const { createWorkspaceTools } = require(root + '/src/main/agent/pi-workspace-tools');
    const sdk = await require(root + '/src/main/agent/pi-sdk').loadPiSdk();
    const profile = path.join(userDataDir, 'editing-profile'); fs.mkdirSync(profile);
    const store = new AgentManagedWorkspaceStore({ userDataDir: profile });
    const controller = new ManagedWorkspaceController({ store });
    const conversationId = 'editing';
    const owner = { userText: 'Improve README', subagentAbortController: new AbortController() };
    try {
      let project;
      if (kind === 'external') {
        project = path.join(userDataDir, 'editing-project'); fs.mkdirSync(project); fs.mkdirSync(path.join(project, '.git'));
        await store.attachProject(conversationId, project);
      } else {
        await controller.enable(conversationId);
        project = await store.resolvePath(store.getForConversation(conversationId).workspaceId);
      }
      fs.writeFileSync(path.join(project, 'README.md'), 'before');
      let permissionError;
      if (kind === 'external') {
        try { await controller.createDelegatedWriter(conversationId, ['README.md']); } catch (error) { permissionError = error.code; }
        await controller.setProjectAccess(conversationId, 'write');
      }
      let parentDenied = false; let scopeDenied; let toolFailure; let toolStage;
      const tool = createSubagentTool({ sdk, getOwner: () => owner,
        createWriter: (_owner, files, signal) => controller.createDelegatedWriter(conversationId, files, { signal }),
        createTools: (_owner, scoped) => createWorkspaceTools({ sdk, controller: scoped, conversationId, requestApproval: () => { throw new Error('Unexpected approval'); } }),
        createSession: async ({ customTools }) => {
          let listener;
          const get = name => customTools.find(tool => tool.name === name);
          return { session: { subscribe: fn => { listener = fn; return () => {}; }, abort: async () => {}, dispose: () => {},
            prompt: async () => {
              try { await controller.execute(conversationId, { command: 'echo competing' }); } catch (error) { parentDenied = error.code === 'WORKSPACE_WRITER_BUSY'; }
              try { await get('write').execute('outside', { path: 'outside.md', content: 'denied' }); } catch (error) { scopeDenied = error.code; }
              try {
              toolStage = 'read'; await get('read').execute('read', { path: 'README.md' });
              toolStage = 'edit'; await get('edit').execute('edit', { path: 'README.md', edits: [{ oldText: 'before', newText: 'after' }] });
              toolStage = 'new'; await get('write').execute('new', { path: 'docs/helper.md', content: 'created by helper' });
              } catch (error) { toolFailure = { stage: toolStage, code: error.code, message: error.message }; throw error; }
              listener({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'Updated README and added documentation; tests are for the parent.' }] } });
            } } };
        },
      });
      const report = await tool.execute('delegate', { title: 'Improve docs', task: 'Improve the assigned files', mode: 'edit', files: ['README.md', 'docs/helper.md'] });
      const scope = await controller.createDelegatedWriter(conversationId, ['README.md']);
      let staleDenied;
      try {
        await scope.controller.readFile(conversationId, 'README.md');
        fs.writeFileSync(path.join(project, 'README.md'), 'external change');
        try { await scope.controller.writeFile(conversationId, 'README.md', 'stale overwrite'); } catch (error) { staleDenied = error.code; }
      } finally { scope.release(); }
      return { report: report.details.subagent, parentDenied, scopeDenied, permissionError, staleDenied, toolFailure,
        current: fs.readFileSync(path.join(project, 'README.md'), 'utf8'), created: fs.existsSync(path.join(project, 'docs/helper.md')) ? fs.readFileSync(path.join(project, 'docs/helper.md'), 'utf8') : null,
        outsideExists: fs.existsSync(path.join(project, 'outside.md')) };
    } finally { owner.subagentAbortController.abort(); await controller.dispose(); store.close(); }
  }, { root: repositoryRoot, userDataDir, kind });
  expect(result.toolFailure).toBeUndefined();
  expect(result).toMatchObject({ report: { mode: 'edit', state: 'completed', changedFiles: ['README.md', 'docs/helper.md'], writesPending: false },
    parentDenied: true, scopeDenied: 'DELEGATED_PATH_DENIED', staleDenied: 'WORKSPACE_HISTORY_CHANGED', current: 'external change', created: 'created by helper', outsideExists: false });
  if (kind === 'external') expect(result.permissionError).toBe('PROJECT_READ_ONLY');
});

for (const kind of ['managed', 'external']) test(`parallel helper and parent edits preserve ${kind} file ownership in the real sandbox`, async ({ electronApp, userDataDir }) => {
  const result = await electronApp.evaluate(async (_electron, { root, userDataDir, kind }) => {
    const require = process.getBuiltinModule('module').createRequire(`${root}/package.json`);
    const fs = require('original-fs'); const path = require('path');
    const { AgentManagedWorkspaceStore } = require(root + '/src/main/agent/managed-workspace-store');
    const { ManagedWorkspaceController } = require(root + '/src/main/agent/managed-workspace-controller');
    const { createSubagentTool } = require(root + '/src/main/agent/pi-subagent-tools');
    const { createWorkspaceTools } = require(root + '/src/main/agent/pi-workspace-tools');
    const sdk = await require(root + '/src/main/agent/pi-sdk').loadPiSdk();
    const profile = path.join(userDataDir, 'parallel-profile'); fs.mkdirSync(profile);
    const store = new AgentManagedWorkspaceStore({ userDataDir: profile });
    const controller = new ManagedWorkspaceController({ store });
    const conversationId = 'parallel';
    const owner = { userText: 'Build separate components', subagentAbortController: new AbortController() };
    let release; const barrier = new Promise(resolve => { release = resolve; });
    let ready; const admitted = new Promise(resolve => { ready = resolve; });
    let started = 0; const failures = [];
    try {
      let project;
      if (kind === 'external') {
        project = path.join(userDataDir, 'parallel-project'); fs.mkdirSync(project);
        await store.attachProject(conversationId, project);
        await controller.setProjectAccess(conversationId, 'write');
      } else {
        await controller.enable(conversationId);
        project = await store.resolvePath(store.getForConversation(conversationId).workspaceId);
      }
      fs.mkdirSync(path.join(project, 'app'));
      fs.writeFileSync(path.join(project, 'app/a.js'), 'before');
      const tool = createSubagentTool({ sdk, getOwner: () => owner,
        createWriter: (_owner, files, signal) => controller.createDelegatedWriter(conversationId, files, { signal }),
        createTools: (_owner, scoped) => createWorkspaceTools({ sdk, controller: scoped, conversationId, requestApproval: () => { throw new Error('Unexpected approval'); } }),
        createSession: async ({ customTools }) => {
          let listener;
          const get = name => customTools.find(tool => tool.name === name);
          return { session: { subscribe: fn => { listener = fn; return () => {}; }, abort: async () => {}, dispose: () => {},
            prompt: async prompt => {
              const { assignment: name } = JSON.parse(prompt);
              if (++started === 2) ready();
              await barrier;
              try {
                if (name === 'a') await get('read').execute('read', { path: 'app/a.js' });
                await get('write').execute('write', { path: `app/${name}.js`, content: name });
                await get('write').execute('new', { path: `shared/new/${name}.js`, content: name });
                listener({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'Implemented assigned component.' }] } });
              } catch (error) { failures.push({ code: error.code, message: error.message }); throw error; }
            } } };
        },
      });
      const pending = tool.execute('batch', { tasks: ['a', 'b'].map(name => ({ title: name, task: name, mode: 'edit', files: [`app/${name}.js`, `shared/new/${name}.js`] })) });
      await admitted;
      await controller.readFile(conversationId, 'app/a.js');
      const blocked = {};
      for (const [name, action] of Object.entries({
        overlap: () => controller.writeFile(conversationId, 'app/a.js', 'wrong'),
        alias: () => controller.writeFile(conversationId, 'app/A.js', 'wrong'),
        command: () => controller.execute(conversationId, { command: 'echo unsafe' }),
        history: () => controller.reviewWorkspaceHistory(conversationId, { action: 'status' }),
      })) { try { await action(); } catch (error) { blocked[name] = error.code; } }
      await controller.writeFile(conversationId, 'parent.js', 'parent');
      release();
      const reports = (await pending).details.subagents;
      let stale;
      try { await controller.writeFile(conversationId, 'app/a.js', 'stale'); } catch (error) { stale = error.code; }
      await controller.readFile(conversationId, 'app/a.js');
      await controller.writeFile(conversationId, 'app/a.js', 'integrated');
      return { started, failures, blocked, stale, reports: reports.map(report => ({ state: report.state, changedFiles: report.changedFiles })),
        files: ['app/a.js', 'app/b.js', 'shared/new/a.js', 'shared/new/b.js', 'parent.js'].map(file => fs.existsSync(path.join(project, file)) ? fs.readFileSync(path.join(project, file), 'utf8') : null) };
    } finally { release(); owner.subagentAbortController.abort(); await controller.dispose(); store.close(); }
  }, { root: repositoryRoot, userDataDir, kind });
  expect(result.failures).toEqual([]);
  expect(result).toMatchObject({ started: 2, blocked: { overlap: 'WORKSPACE_WRITER_BUSY', alias: 'WORKSPACE_WRITER_BUSY', command: 'WORKSPACE_WRITER_BUSY', history: 'WORKSPACE_WRITER_BUSY' },
    stale: 'WORKSPACE_HISTORY_CHANGED', files: ['integrated', 'b', 'a', 'b', 'parent'],
    reports: [{ state: 'completed', changedFiles: ['app/a.js', 'shared/new/a.js'] }, { state: 'completed', changedFiles: ['app/b.js', 'shared/new/b.js'] }] });
});

test('helper history persists reports and marks crash-left work interrupted in real SQLite', async ({ electronApp }) => {
  const result = await electronApp.evaluate(({ app }, root) => {
    const require = process.getBuiltinModule('module').createRequire(`${root}/package.json`);
    const path = require('path');
    const fs = require('fs');
    const { AgentSessionHistoryStore } = require(path.join(root, 'src/main/agent/session-history-store'));
    const userDataDir = path.join(app.getPath('userData'), 'helper-history-fixture');
    fs.mkdirSync(userDataDir, { recursive: true });
    let store = new AgentSessionHistoryStore({ userDataDir });
    store.createSession({ conversationId: 'helper-history', title: 'Review', approvalMode: 'every_interaction' });
    store.startTurn({ conversationId: 'helper-history', runId: 'finished', userText: 'Review', approvalMode: 'every_interaction' });
    store.finishTurn({ conversationId: 'helper-history', runId: 'finished', status: 'completed', assistantText: 'Reviewed', activity: [
      { toolCallId: 'first', operation: 'delegate_task', status: 'succeeded', label: 'Received helper report',
        subagent: { taskId: 'delegate_' + 'a'.repeat(24), title: 'Edit README', mode: 'edit', changedFiles: ['README.md'], attemptedFiles: ['README.md'], state: 'completed', report: 'Check README.md', toolCalls: 1 } },
    ] });
    store.updateTurnActivity({ conversationId: 'helper-history', runId: 'finished', activity: [
      { toolCallId: 'batch', operation: 'delegate_task', status: 'failed', subagents: [
        { taskId: 'delegate_' + 'a'.repeat(24), title: 'First', state: 'completed', report: 'Check README.md' },
        { taskId: 'delegate_' + 'b'.repeat(24), title: 'Second', state: 'cancelled', report: '' },
      ] },
    ] });
    const lateWrite = store.updateTurnActivity({ conversationId: 'helper-history', runId: 'finished', running: true, activity: [] });
    store.startTurn({ conversationId: 'helper-history', runId: 'interrupted', position: 1, userText: 'Review more', approvalMode: 'every_interaction' });
    const runningSaved = store.updateTurnActivity({ conversationId: 'helper-history', runId: 'interrupted', running: true, activity: [
      { toolCallId: 'second', operation: 'delegate_task', status: 'succeeded', label: '1 report received · 1 helper working', subagents: [
        { taskId: 'delegate_' + 'c'.repeat(24), title: 'Finished sibling', state: 'completed', report: 'Retained before crash' },
        { taskId: 'delegate_' + 'd'.repeat(24), title: 'Active sibling', mode: 'browser', tabIds: ['tab_helper'], browserActions: [{ operation: 'browser_snapshot', status: 'succeeded', pageTitle: 'Fixture', origin: 'https://helper.test' }], state: 'running', report: '' },
      ] },
    ] });
    store.startTurn({ conversationId: 'helper-history', runId: 'six-helpers', position: 2, userText: 'Six topics', approvalMode: 'every_interaction' });
    store.updateTurnActivity({ conversationId: 'helper-history', runId: 'six-helpers', running: true, activity: [
      { toolCallId: 'six', operation: 'delegate_task', subagents: Array.from({ length: 6 }, (_, i) => ({
        taskId: 'delegate_' + String(i).repeat(24), title: `Topic ${i}`, state: i < 3 ? 'completed' : 'running', report: i < 3 ? `Report ${i}` : '',
      })) },
    ] });
    store.close();
    store = new AgentSessionHistoryStore({ userDataDir });
    store.markStaleRunningAsInterrupted();
    const transcript = store.getSession('helper-history').transcript;
    store.close();
    return { lateWrite, runningSaved, transcript };
  }, repositoryRoot);
  expect(result.lateWrite).toBe(false);
  expect(result.runningSaved).toBe(true);
  expect(result.transcript[2].activity[0].subagents.map(item => item.state)).toEqual(['completed', 'completed', 'completed', 'cancelled', 'cancelled', 'cancelled']);
  expect(result.transcript[2].activity[0].subagents.slice(0, 3).map(item => item.report)).toEqual(['Report 0', 'Report 1', 'Report 2']);
  expect(result.transcript[0].activity[0].subagents[0].report).toBe('Check README.md');
  expect(result.transcript[0].activity[0].subagents[1].state).toBe('cancelled');
  expect(result.transcript[1]).toMatchObject({ status: 'interrupted', activity: [
    { operation: 'delegate_task', status: 'failed', label: 'Helper interrupted', subagents: [
      { state: 'completed', report: 'Retained before crash' }, { mode: 'browser', tabIds: ['tab_helper'], browserActions: [expect.objectContaining({ pageTitle: 'Fixture' })], state: 'cancelled', report: expect.stringContaining('not restarted') },
    ] },
  ] });
});

test('delegated reports are expandable, inert and coherent in both themes and layouts', async ({ electronApp, window, ollamaServer }, testInfo) => {
  await window.locator('[data-test="agent-toggle-btn"]').click();
  await window.locator('#agent-provider-add').click();
  await window.locator('#agent-provider-choices').getByRole('button', { name: 'Ollama', exact: true }).click();
  await window.locator('#agent-provider-advanced > summary').click();
  await window.locator('#agent-ollama-url').fill(ollamaServer);
  await window.locator('#agent-provider-save').click();
  await expect(window.locator('#agent-provider-status')).toHaveText('Connected');
  await window.locator('#agent-sidebar-back').click();
  await electronApp.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find(item => !item.isDestroyed());
    const emit = event => window.webContents.send('agent:event', { runId: 'run_helper_ui', ...event });
    emit({ type: 'run_started', userText: 'Review the solar-system project' });
    emit({ type: 'tool_started', toolCallId: 'parent-read', operation: 'read', intent: 'Read README.md' });
    emit({ type: 'tool_finished', toolCallId: 'parent-read', operation: 'read', status: 'succeeded', label: 'Read README.md' });
    emit({ type: 'tool_started', toolCallId: 'helper', operation: 'delegate_task', intent: 'Delegating: Review planet controls' });
  });
  await expect(window.locator('.agent-tool-list')).toContainText('Delegating: Review planet controls');
  await window.screenshot({ path: testInfo.outputPath('helper-running.png') });
  await electronApp.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find(item => !item.isDestroyed());
    window.webContents.send('agent:event', { runId: 'run_helper_ui', type: 'tool_finished', toolCallId: 'helper', operation: 'delegate_task', status: 'succeeded', label: '1 report received · 1 helper working',
      subagents: [{ taskId: 'delegate_' + 'a'.repeat(24), title: 'Update planet controls', mode: 'edit', changedFiles: ['app/PlanetControls.tsx'], attemptedFiles: ['app/PlanetControls.tsx'], state: 'completed', report: 'Updated planet controls, while the reviewer works.' },
        { taskId: 'delegate_' + 'c'.repeat(24), title: 'Review accessibility', state: 'running', report: '' }] });
  });
  await expect(window.locator('.agent-subagent-report')).toHaveCount(2);
  await expect(window.locator('.agent-tool-item:visible')).toHaveCount(0);
  await window.locator('.agent-turn-activity > summary').click();
  await expect(window.locator('.agent-tool-item:visible')).toHaveCount(1);
  await window.locator('.agent-subagent-report').first().locator('summary').click();
  const helperStop = window.getByRole('button', { name: 'Stop helper: Review accessibility' });
  await expect(helperStop).toBeVisible();
  await expect(helperStop.locator('svg rect')).toHaveAttribute('width', '10');
  await expect(helperStop).toHaveText('');
  await helperStop.focus();
  await electronApp.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find(item => !item.isDestroyed());
    window.webContents.send('agent:event', { runId: 'run_helper_ui', type: 'tool_finished', toolCallId: 'helper', operation: 'delegate_task', status: 'succeeded',
      subagents: [{ taskId: 'delegate_' + 'a'.repeat(24), title: 'Update planet controls', mode: 'edit', changedFiles: ['app/PlanetControls.tsx'], state: 'completed', report: 'Updated planet controls, while the reviewer works.' },
        { taskId: 'delegate_' + 'c'.repeat(24), title: 'Review accessibility', state: 'running', activity: 'Reading a file', report: '' }] });
  });
  await expect(helperStop).toBeFocused();
  await expect(window.locator('.agent-helper-status').last()).toContainText('Reading a file');
  await window.locator('.agent-turn-activity > summary').click();
  await expect(helperStop).toBeVisible();

  for (const theme of ['dark', 'light']) {
    await window.evaluate(value => document.documentElement.dataset.theme = value, theme);
    await window.screenshot({ path: testInfo.outputPath(`helper-background-${theme}.png`) });
  }
  await electronApp.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find(item => !item.isDestroyed());
    const emit = event => window.webContents.send('agent:event', { runId: 'run_helper_ui', ...event });
    emit({ type: 'tool_finished', toolCallId: 'helper', operation: 'delegate_task', status: 'succeeded', label: '2 reports received',
      subagents: [{ taskId: 'delegate_' + 'a'.repeat(24), title: 'Update planet controls', mode: 'edit', changedFiles: ['app/PlanetControls.tsx'], attemptedFiles: ['app/PlanetControls.tsx'], state: 'completed', toolCalls: 3, toolScripts: 2,
        report: '### Findings\n- **Playback controls** are wired correctly in `app/SolarScene.tsx`.\n- Keyboard focus needs a visible style.\n\nNo tests were run.\n<img src="https://invalid.test/tracker"> <script>globalThis.helperInjection = true</script>' },
        { taskId: 'delegate_' + 'c'.repeat(24), title: 'Review accessibility', state: 'completed', toolCalls: 2, toolScripts: 1, report: 'Add a visible keyboard focus style.' },
        ...Array.from({ length: 4 }, (_, i) => ({ taskId: 'delegate_' + String(i).repeat(24), title: `Research topic ${i + 3}`, state: 'completed', toolCalls: 2, report: `Findings for topic ${i + 3}.` }))] });
    emit({ type: 'tool_started', toolCallId: 'stopped', operation: 'delegate_task', intent: 'Delegating: Check labels' });
    emit({ type: 'tool_finished', toolCallId: 'stopped', operation: 'delegate_task', status: 'failed', label: 'Helper stopped — Check labels',
      subagent: { taskId: 'delegate_' + 'b'.repeat(24), title: 'Check labels', mode: 'browser', state: 'cancelled', toolCalls: 2, browserPending: true, browserActions: [{ operation: 'browser_snapshot', label: 'Read page', status: 'succeeded', pageTitle: 'Planet preview' }, { operation: 'browser_click', label: 'Clicked on page', status: 'failed', pageTitle: '<img src=x> Untrusted title' }], report: '' } });
    emit({ type: 'run_finished', status: 'completed', durationMs: 2000, actionCount: 2, outcome: { kind: 'completed', verification: 'delegated_report', tone: 'neutral', headline: 'Helper reports received', detail: '2 reports received · 1 task stopped. Editing helpers recorded 1 changed file. Review current changes before testing or committing; stopped tasks can leave partial edits.' } });
  });
  await expect(window.locator('.agent-subagent-report')).toHaveCount(7);
  await expect(window.locator('.agent-subagent-report').nth(5)).toContainText('Research topic 6');
  await expect(window.locator('.agent-turn-outcome')).toBeHidden();
  await expect(window.locator('.agent-turn-outcome.caution')).toHaveCount(0);
  await window.locator('.agent-turn-activity > summary').click();
  const report = window.locator('.agent-subagent-report').first();
  await expect(report).toHaveAttribute('open', '');
  await expect(report).toContainText('3 tool calls · 2 tool scripts');
  await expect(report.locator('p').last()).toBeVisible();
  await expect(report.locator('img, script')).toHaveCount(0);
  await expect(report.locator('.agent-helper-report-body strong')).toHaveText('Playback controls');
  await expect(report.locator('.agent-helper-report-body li')).toHaveCount(2);
  expect(await window.evaluate(() => globalThis.helperInjection)).toBeUndefined();
  await expect(window.locator('.agent-helper-status').last()).toContainText('Stopped');
  const browserReport = window.locator('.agent-subagent-report').last();
  await browserReport.locator('summary').click();
  await expect(browserReport).toContainText('Browser helper');
  await expect(browserReport).toContainText('Planet preview');
  await expect(browserReport.locator('img')).toHaveCount(0);
  for (const layout of ['browser', 'agent']) {
    if (layout === 'agent') await window.locator('[data-test="agent-first-toggle"]').click();
    for (const theme of ['dark', 'light']) {
      await window.evaluate(value => document.documentElement.dataset.theme = value, theme);
      await expect(report).toBeVisible();
      expect(await report.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
      await report.scrollIntoViewIfNeeded();
      await window.screenshot({ path: testInfo.outputPath(`helper-report-${layout}-${theme}.png`) });
      const sixth = window.locator('.agent-subagent-report').nth(5);
      await sixth.scrollIntoViewIfNeeded();
      await expect(sixth).toBeVisible();
      await window.screenshot({ path: testInfo.outputPath(`helper-sixth-${layout}-${theme}.png`) });
      await browserReport.scrollIntoViewIfNeeded();
      await window.screenshot({ path: testInfo.outputPath(`helper-browser-${layout}-${theme}.png`) });
    }
  }
});

// Presentation coverage only: a main-process fixture emits the same bounded
// events as the service. Authority/grant application is covered by production
// qualification and unit tests; this test does not grant project access.
test('project editing approval sheet is clear in both layouts and themes', async ({ electronApp, window, ollamaServer }, testInfo) => {
  await window.locator('[data-test="agent-toggle-btn"]').click();
  await window.locator('#agent-provider-add').click();
  await window.locator('#agent-provider-choices').getByRole('button', { name: 'Ollama', exact: true }).click();
  await window.locator('#agent-provider-advanced > summary').click();
  await window.locator('#agent-ollama-url').fill(ollamaServer);
  await window.locator('#agent-provider-save').click();
  await expect(window.locator('#agent-provider-status')).toHaveText('Connected');
  await window.locator('#agent-sidebar-back').click();
  await electronApp.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find(item => !item.isDestroyed());
    window.webContents.send('agent:event', { type: 'run_started', runId: 'run_project_approval_ui' });
    window.webContents.send('agent:event', { type: 'approval_requested', runId: 'run_project_approval_ui',
      approvalId: 'approval_project_ui', action: 'project_write', operation: 'request_permissions',
      label: 'Commit the reviewed cookbook changes',
      projectAccess: { name: 'Vegan cookbook', mode: 'write', scope: 'conversation' } });
  });
  await expect(window.locator('#agent-approval-action')).toHaveText('Allow editing “Vegan cookbook”?');
  await expect(window.locator('#agent-approval-origin')).toContainText('local Git commits');
  await expect(window.locator('#agent-approval-approve')).toHaveText('Allow editing');
  await expect(window.locator('#agent-approval-allow-conversation')).toBeHidden();
  for (const layout of ['browser', 'agent']) {
    if (layout === 'agent') await window.locator('[data-test="agent-first-toggle"]').click();
    for (const theme of ['dark', 'light']) {
      await window.evaluate(value => document.documentElement.setAttribute('data-theme', value), theme);
      await expect(window.locator('#agent-approval-approve')).toBeVisible();
      await window.screenshot({ path: testInfo.outputPath(`project-approval-${layout}-${theme}.png`) });
    }
  }
  await electronApp.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows().find(item => !item.isDestroyed()).webContents.send('agent:event', {
      type: 'approval_requested', runId: 'run_project_approval_ui', approvalId: 'approval_invisible_controls',
      action: 'project_write', operation: 'request_permissions', label: 'Review\u200B these changes',
      projectAccess: { name: 'Cookbook\u202Eproject', mode: 'write', scope: 'conversation' },
    });
  });
  await expect(window.locator('#agent-approval-action')).toHaveText('Allow editing “Cookbook\\u{202E}project”?');
  await expect(window.locator('#agent-approval-origin')).toContainText('Review\\u{200B} these changes');
  for (const theme of ['dark', 'light']) {
    await window.evaluate(value => document.documentElement.setAttribute('data-theme', value), theme);
    await window.screenshot({ path: testInfo.outputPath(`project-approval-controls-${theme}.png`) });
  }
});

test('existing project picker and access controls work in both layouts and themes', async ({ electronApp, window, ollamaServer }, testInfo) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-project-ui-'));
  const project = path.join(root, 'Existing project'); fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, 'README.md'), '# Existing project\n');
  try {
    await electronApp.evaluate(({ dialog }, selected) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] });
    }, project);
    await window.locator('[data-test="agent-toggle-btn"]').click();
    await window.locator('#agent-provider-add').click();
    await window.locator('#agent-provider-choices').getByRole('button', { name: 'Ollama', exact: true }).click();
    await window.locator('#agent-provider-advanced > summary').click();
    await window.locator('#agent-ollama-url').fill(ollamaServer);
    await window.locator('#agent-provider-save').click();
    await expect(window.locator('#agent-provider-status')).toHaveText('Connected');
    await window.locator('#agent-sidebar-back').click();
    await window.locator('#agent-attachment-button').click();
    await window.locator('#agent-open-project').click();
    await expect(window.locator('#agent-run-message')).toContainText('Project opened');
    await window.locator('#agent-process-compact-toggle').click();
    const row = window.locator('[data-workspace-focus="project"]:visible');
    await expect(row).toContainText('Existing project');
    await expect(row).toContainText('Read only');
    await row.click();
    await window.locator('.agent-workspace-popover').getByRole('button', { name: 'Allow editing', exact: true }).click();
    await expect(row).toContainText('Can edit');
    for (const layout of ['browser', 'agent']) {
      if (layout === 'agent') await window.locator('[data-test="agent-first-toggle"]').click();
      for (const theme of ['dark', 'light']) {
        await window.evaluate((value) => document.documentElement.setAttribute('data-theme', value), theme);
        await row.click();
        await expect(window.locator('.agent-workspace-popover')).toBeVisible();
        await window.screenshot({ path: testInfo.outputPath(`project-${layout}-${theme}.png`) });
        await window.locator('.agent-workspace-popover').getByRole('button', { name: 'Close', exact: true }).click();
      }
    }
    await row.click();
    await window.locator('.agent-workspace-popover').getByRole('button', { name: 'Remove access', exact: true }).click();
    await expect(row).toContainText('Reconnect');
    await row.click();
    await window.locator('.agent-workspace-popover').getByRole('button', { name: 'Reconnect project…', exact: true }).click();
    await expect(row).toContainText('Read only');
    expect(fs.readFileSync(path.join(project, 'README.md'), 'utf8')).toBe('# Existing project\n');
    expect(fs.existsSync(path.join(project, '.git'))).toBe(false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('Agent, wallet, and menu actions remain on the address-bar row', async ({ window }) => {
  const geometry = await window.evaluate(() => {
    const rect = (selector) => {
      const { top, bottom, height } = document.querySelector(selector).getBoundingClientRect();
      return { top, bottom, center: top + height / 2 };
    };
    return {
      toolbar: rect('.toolbar'),
      address: rect('[data-test="address-input"]'),
      agent: rect('[data-test="agent-toggle-btn"]'),
      wallet: rect('#wallet-toggle-btn'),
      menu: rect('#menu-button'),
    };
  });

  expect(Math.abs(geometry.agent.center - geometry.address.center)).toBeLessThanOrEqual(1);
  expect(Math.abs(geometry.wallet.center - geometry.address.center)).toBeLessThanOrEqual(1);
  expect(Math.abs(geometry.menu.center - geometry.address.center)).toBeLessThanOrEqual(1);
  expect(geometry.menu.top).toBeGreaterThanOrEqual(geometry.toolbar.top);
  expect(geometry.menu.bottom).toBeLessThanOrEqual(geometry.toolbar.bottom);
});

test('attachments do not reveal a hidden homepage context pill', async ({ window }) => {
  const state = await window.evaluate(() => {
    const contexts = document.querySelector('#agent-page-contexts');
    const page = document.querySelector('#agent-page-context');
    const attachments = document.querySelector('#agent-attachment-contexts');
    const attachment = document.createElement('div');
    attachment.className = 'agent-attachment-chip';
    attachment.textContent = 'notes.txt';
    attachments.replaceChildren(attachment);
    contexts.hidden = false;
    page.hidden = true;
    return {
      pageDisplay: getComputedStyle(page).display,
      attachmentDisplay: getComputedStyle(attachment).display,
    };
  });

  expect(state.pageDisplay).toBe('none');
  expect(state.attachmentDisplay).not.toBe('none');
});

test('sent attachments form a compact horizontally scrollable shelf', async ({ window }) => {
  await window.locator('[data-test="agent-toggle-btn"]').click();
  const geometry = await window.evaluate(() => {
    document.querySelector('#agent-setup-view').hidden = true;
    document.querySelector('#agent-workspace-view').hidden = false;
    const transcript = document.querySelector('#agent-transcript');
    transcript.hidden = false;
    const row = document.createElement('div');
    row.className = 'agent-message-row user';
    const shelf = document.createElement('div');
    shelf.className = 'agent-user-attachments';
    shelf.setAttribute('role', 'list');
    for (let index = 0; index < 8; index += 1) {
      const tile = document.createElement('div');
      tile.className = 'agent-message-attachment';
      tile.dataset.kind = index === 0 ? 'pdf' : index === 1 ? 'folder' : 'text';
      const visual = document.createElement('span');
      visual.className = 'agent-message-attachment-visual';
      const name = document.createElement('span');
      name.className = 'agent-message-attachment-name';
      name.textContent = `long-attachment-filename-${index}.txt`;
      tile.append(visual, name);
      shelf.appendChild(tile);
    }
    row.appendChild(shelf);
    transcript.replaceChildren(row);
    const shelfRect = shelf.getBoundingClientRect();
    const tileRect = shelf.firstElementChild.getBoundingClientRect();
    const shelfStyle = getComputedStyle(shelf);
    const nameStyle = getComputedStyle(shelf.querySelector('.agent-message-attachment-name'));
    return {
      clientWidth: shelf.clientWidth,
      scrollWidth: shelf.scrollWidth,
      shelfWidth: shelfRect.width,
      tileWidth: tileRect.width,
      overflowX: shelfStyle.overflowX,
      lineClamp: nameStyle.webkitLineClamp,
    };
  });

  expect(geometry.shelfWidth).toBeGreaterThan(0);
  expect(geometry.tileWidth).toBeGreaterThanOrEqual(80);
  expect(geometry.scrollWidth).toBeGreaterThan(geometry.clientWidth);
  expect(geometry.overflowX).toBe('auto');
  expect(geometry.lineClamp).toBe('2');
});

test('Agent sidebar configures hosted and local models and reports the run lifecycle', async ({
  electronApp,
  window,
  ollamaServer,
}) => {
  const toggle = window.locator('[data-test="agent-toggle-btn"]');
  const panel = window.locator('#agent-sidebar');

  await expect(toggle).toBeVisible();
  await toggle.click();
  await expect(panel).not.toHaveClass(/collapsed/);
  await expect(window.locator('#agent-setup-view')).toBeVisible();
  await expect(window.locator('#agent-workspace-view')).toBeHidden();
  await expect(window.locator('#agent-sidebar-title')).toHaveText('Set up Agent');
  await expect(window.locator('#agent-provider-status')).toHaveText('Not connected');

  await window.locator('#agent-provider-add').click();
  await window.locator('#agent-provider-choices').getByRole('button', { name: 'OpenAI', exact: true }).click();
  await window.locator('#agent-provider-api').click();
  await expect(window.locator('#agent-provider-privacy')).toContainText('Requests go to OpenAI');
  await expect(window.locator('#agent-model-select')).not.toHaveValue('');
  const hostedModelName = await window.locator('#agent-model-select option:checked').textContent();
  await window.locator('#agent-api-key').fill('test-only-not-a-credential');
  await window.locator('#agent-provider-save').click();
  await expect(window.locator('#agent-provider-status')).toHaveText('Connected');
  await expect(window.locator('#agent-api-key')).toHaveValue('');
  await expect(window.locator('#agent-setup-view')).toBeVisible();
  await expect(window.locator('#agent-model-menu')).toBeHidden();
  await window.locator('#agent-sidebar-back').click();
  await expect(window.locator('#agent-workspace-view')).toBeVisible();
  await expect(window.locator('#agent-setup-view')).toBeHidden();
  await expect(window.locator('#agent-active-model-label')).toHaveText(hostedModelName);
  await window.locator('#agent-approval-mode-button').click();
  await expect(window.locator('#agent-approval-mode-popover')).toBeVisible();
  await expect(window.locator('#agent-approval-mode-every')).toContainText(
    'Ask frequently'
  );
  await expect(window.locator('#agent-approval-mode-sensitive')).toBeEnabled();
  await expect(window.locator('#agent-approval-mode-sensitive')).toContainText(
    'Ask when needed'
  );
  await expect(window.locator('#agent-approval-mode-allow')).toContainText(
    'Fewer interruptions'
  );

  await window.locator('#agent-model-menu-button').click();
  await expect(window.locator('#agent-model-menu')).toBeVisible();
  await window.locator('#agent-manage-providers').click();
  await expect(window.locator('#agent-setup-view')).toBeVisible();
  await expect(window.locator('#agent-connected-provider-list')).toContainText('OpenAI');

  await window.locator('#agent-provider-add').click();
  await window.locator('#agent-provider-choices').getByRole('button', { name: 'OpenAI', exact: true }).click();
  await window.locator('#agent-provider-chatgpt').click();
  await expect(window.locator('#agent-provider-privacy')).toContainText(
    'through your ChatGPT subscription'
  );
  await expect(window.locator('#agent-subscription-fields')).not.toHaveClass(/hidden/);
  await expect(window.locator('#agent-api-key-field')).toHaveClass(/hidden/);
  await expect(window.locator('#agent-provider-save')).toBeHidden();
  await expect(window.locator('#agent-provider-login')).toHaveText('Continue with ChatGPT');
  await expect(window.locator('#agent-model-select')).not.toHaveValue('');

  await window.locator('#agent-provider-detail-back').click();
  await window.locator('#agent-provider-add').click();
  await window.locator('#agent-provider-choices').getByRole('button', { name: 'Ollama', exact: true }).click();
  await expect(window.locator('#agent-provider-privacy')).toHaveText(
    'Model requests stay on this device and are sent only to your local Ollama server.'
  );
  await expect(window.locator('#agent-hosted-fields')).toHaveClass(/hidden/);
  await expect(window.locator('#agent-ollama-fields')).not.toHaveClass(/hidden/);
  await expect(window.locator('#agent-ollama-model')).toHaveCount(0);
  await window.locator('#agent-provider-advanced > summary').click();
  await window.locator('#agent-ollama-url').fill(ollamaServer);
  await window.locator('#agent-provider-save').click();

  await expect(window.locator('#agent-provider-status')).toHaveText('Connected');
  await expect(window.locator('#agent-provider-message')).toHaveText(
    'Ollama models ready'
  );
  await expect(window.locator('#agent-setup-view')).toBeVisible();
  await expect(window.locator('#agent-provider-models-list')).toContainText('freedom-e2e-no-server');
  await expect(window.locator('#agent-model-menu')).toBeHidden();
  await window.locator('#agent-sidebar-back').click();
  await expect(window.locator('#agent-workspace-view')).toBeVisible();
  await expect(window.locator('#agent-active-model-label')).toHaveText('freedom-e2e-no-server');
  await window.locator('#agent-model-menu-button').click();
  await expect(window.locator('#agent-model-menu')).toBeVisible();
  await expect(window.locator('#agent-model-menu-list')).toContainText(hostedModelName);
  await expect(window.locator('#agent-model-menu-list')).toContainText('freedom-e2e-no-server');
  await window.locator('#agent-model-menu-search').fill(hostedModelName);
  await window.locator('#agent-model-menu-list').getByText(hostedModelName, { exact: true }).click();
  await expect(window.locator('#agent-active-model-label')).toHaveText(hostedModelName);
  await window.locator('#agent-model-menu-button').click();
  await window.locator('#agent-model-menu-search').fill('freedom-e2e-no-server');
  await window.getByRole('menuitemradio', { name: 'freedom-e2e-no-server' }).click();
  await expect(window.locator('#agent-active-model-label')).toHaveText('freedom-e2e-no-server');
  await window.locator('#agent-model-menu-button').click();
  await window.locator('#agent-manage-providers').click();
  await expect(window.locator('#agent-connected-provider-list')).toContainText('OpenAI');
  await expect(window.locator('#agent-connected-provider-list')).toContainText('Ollama');
  await window.locator('#agent-sidebar-back').click();

  const compactComposer = await window.evaluate(() => {
    const footer = document.querySelector('.agent-composer-footer').getBoundingClientRect();
    const controls = [
      '[data-test="agent-attachment"]',
      '#agent-approval-mode-button',
      '#agent-model-menu-button',
      '[data-test="agent-dictation"]',
      '#agent-run',
    ].map((selector) => document.querySelector(selector).getBoundingClientRect());
    return {
      footer: { left: footer.left, right: footer.right },
      controls: controls.map(({ left, right }) => ({ left, right })),
      separatorWidth: getComputedStyle(document.querySelector('.agent-composer-wrap'))
        .borderTopWidth,
    };
  });
  expect(compactComposer.separatorWidth).toBe('0px');
  for (const control of compactComposer.controls) {
    expect(control.left).toBeGreaterThanOrEqual(compactComposer.footer.left);
    expect(control.right).toBeLessThanOrEqual(compactComposer.footer.right);
  }

  await window.locator('#agent-sidebar-close').click();
  await expect(panel).toHaveClass(/collapsed/);
  await toggle.click();
  await expect(window.locator('#agent-prompt')).toBeFocused();

  const agentFirstToggle = window.locator('[data-test="agent-first-toggle"]');
  await expect(agentFirstToggle).toBeVisible();
  await agentFirstToggle.click();
  await expect(window.locator('#agent-prompt')).toBeFocused();
  await expect(window.locator('body')).toHaveClass(/agent-first-mode/);
  await expect(window.locator('.toolbar')).toBeHidden();
  await expect(window.locator('#agent-first-titlebar')).toBeVisible();
  await expect(window.locator('[data-test="agent-session-sidebar"]')).toBeVisible();
  await expect(window.locator('[data-test="agent-task-pages"]')).toBeVisible();
  await expect(window.locator('#agent-page-surface .content')).toBeVisible();
  await expect(window.locator('#agent-task-page-count')).toHaveText('1');
  await expect(window.locator('#agent-task-page-list .tab:not([hidden])')).toHaveCount(1);
  await expect(window.locator('#agent-task-pages-note')).toContainText('currently viewing');
  await expect(window.locator('#agent-workspace-nav')).toBeVisible();
  await expect(
    window.locator('#agent-workspace-address-host > .address-bar-container')
  ).toHaveCount(1);
  await expect(window.locator('#agent-workspace-address-host #trust-shield')).toHaveCount(1);
  await expect(window.locator('#agent-workspace-address-host #permission-indicator')).toHaveCount(1);
  await expect(window.locator('#agent-workspace-address-host #add-bookmark-btn')).toHaveCount(1);
  await expect(window.locator('#agent-workspace-address-host #address-input')).toHaveValue('');
  const paneOrder = await window.evaluate(() => ({
    sessions: document.querySelector('#agent-session-sidebar').getBoundingClientRect().left,
    conversation: document.querySelector('#agent-sidebar').getBoundingClientRect().left,
    workspace: document.querySelector('#agent-page-surface').getBoundingClientRect().left,
  }));
  expect(paneOrder.sessions).toBeLessThan(paneOrder.conversation);
  expect(paneOrder.conversation).toBeLessThan(paneOrder.workspace);
  const titlebarLayout = await window.evaluate(() => {
    const rect = (selector) => {
      const { left, right, top, bottom, width } = document
        .querySelector(selector)
        .getBoundingClientRect();
      return { left, right, top, bottom, width };
    };
    return {
      titlebar: rect('.title-bar'),
      sessionTitlebar: rect('.agent-first-titlebar-left'),
      sessions: rect('#agent-session-sidebar'),
      conversationTitlebar: rect('.agent-first-titlebar-center'),
      conversation: rect('#agent-sidebar'),
      title: rect('#agent-first-title'),
      workspaceTitlebar: rect('.agent-first-titlebar-right'),
      workspace: rect('#agent-page-surface'),
      workspaceContent: rect('#agent-page-surface .content'),
      tabs: rect('#agent-task-pages'),
      firstTab: rect('#agent-task-page-list .tab:not([hidden])'),
      sessionDividerShadow: getComputedStyle(
        document.querySelector('.agent-first-titlebar-left'),
        '::before'
      ).boxShadow,
      centerDividerWidth: getComputedStyle(document.querySelector('.agent-first-titlebar-center'))
        .borderRightWidth,
    };
  });
  expect(
    Math.abs(titlebarLayout.sessionTitlebar.right - titlebarLayout.sessions.right)
  ).toBeLessThan(2);
  expect(titlebarLayout.sessionDividerShadow).not.toBe('none');
  expect(
    Math.abs(titlebarLayout.conversationTitlebar.left - titlebarLayout.conversation.left)
  ).toBeLessThan(2);
  expect(
    Math.abs(titlebarLayout.workspaceTitlebar.left - titlebarLayout.workspace.left)
  ).toBeLessThan(2);
  expect(titlebarLayout.centerDividerWidth).toBe('0px');
  expect(
    Math.abs(titlebarLayout.firstTab.left - titlebarLayout.workspaceContent.left)
  ).toBeLessThan(2);
  expect(titlebarLayout.title.left).toBeLessThan(
    titlebarLayout.conversationTitlebar.left + titlebarLayout.conversationTitlebar.width / 3
  );
  expect(titlebarLayout.tabs.top).toBeGreaterThanOrEqual(titlebarLayout.titlebar.top);
  expect(titlebarLayout.tabs.bottom).toBeLessThanOrEqual(titlebarLayout.titlebar.bottom + 1);
  const unifiedChrome = await window.evaluate(() => {
    const background = (selector) =>
      getComputedStyle(document.querySelector(selector)).backgroundColor;
    return {
      titlebar: background('.title-bar'),
      sessions: background('#agent-session-sidebar'),
      conversation: background('#agent-sidebar'),
      workspace: background('#agent-task-pages'),
      composer: background('.agent-composer-wrap'),
    };
  });
  expect(unifiedChrome.sessions).not.toBe(unifiedChrome.titlebar);
  expect(unifiedChrome.conversation).toBe(unifiedChrome.titlebar);
  expect(unifiedChrome.workspace).toBe(unifiedChrome.titlebar);
  // The floating composer exposes the conversation background beneath it.
  expect(unifiedChrome.composer).toBe('rgba(0, 0, 0, 0)');
  await expect(window.locator('[data-test="agent-attachment"]')).toBeEnabled();
  await window.locator('[data-test="agent-attachment"]').click();
  await expect(window.locator('#agent-attachment-menu')).toBeVisible();
  await expect(window.locator('#agent-attachment-menu')).toContainText('Attach files');
  await expect(window.locator('#agent-attachment-menu')).toContainText('Add folder');
  const broadAttachmentMenu = await window.evaluate(() => {
    const composer = document.querySelector('.agent-composer').getBoundingClientRect();
    const menu = document.querySelector('#agent-attachment-menu').getBoundingClientRect();
    return { composerWidth: composer.width, menuWidth: menu.width };
  });
  expect(Math.abs(broadAttachmentMenu.menuWidth - broadAttachmentMenu.composerWidth)).toBeLessThan(2);
  await window.locator('[data-test="agent-attachment"]').click();
  await expect(window.locator('#agent-attachment-menu')).toBeHidden();
  await window.locator('#agent-approval-mode-button').click();
  await expect(window.locator('#agent-approval-mode-popover')).toBeVisible();
  const approvalMenuWidth = await window
    .locator('#agent-approval-mode-popover')
    .evaluate((element) => element.getBoundingClientRect().width);
  expect(approvalMenuWidth).toBeLessThan(broadAttachmentMenu.menuWidth);
  await window.locator('#agent-approval-mode-button').click();
  await window.locator('#agent-model-menu-button').click();
  await expect(window.locator('#agent-model-menu')).toBeVisible();
  const modelMenuWidth = await window
    .locator('#agent-model-menu')
    .evaluate((element) => element.getBoundingClientRect().width);
  expect(modelMenuWidth).toBeLessThan(broadAttachmentMenu.menuWidth);
  await window.locator('#agent-model-menu-button').click();
  await expect(window.locator('[data-test="agent-dictation"]')).toBeDisabled();
  const composerLayout = await window.evaluate(() => {
    const rect = (selector) => {
      const { left, right, width, height } = document
        .querySelector(selector)
        .getBoundingClientRect();
      return { left, right, width, height };
    };
    const composerStyle = getComputedStyle(document.querySelector('.agent-composer'));
    const promptStyle = getComputedStyle(document.querySelector('#agent-prompt'));
    const sendStyle = getComputedStyle(document.querySelector('#agent-run'));
    return {
      attachment: rect('[data-test="agent-attachment"]'),
      approval: rect('#agent-approval-mode-button'),
      model: rect('#agent-model-menu-button'),
      dictation: rect('[data-test="agent-dictation"]'),
      send: rect('#agent-run'),
      borderRadius: Number.parseFloat(composerStyle.borderTopLeftRadius),
      promptFontSize: Number.parseFloat(promptStyle.fontSize),
      promptMinHeight: Number.parseFloat(promptStyle.minHeight),
      sendRadius: Number.parseFloat(sendStyle.borderTopLeftRadius),
    };
  });
  expect(composerLayout.attachment.left).toBeLessThan(composerLayout.approval.left);
  expect(composerLayout.approval.right).toBeLessThanOrEqual(composerLayout.model.left);
  expect(composerLayout.model.left).toBeLessThan(composerLayout.dictation.left);
  expect(composerLayout.dictation.left).toBeLessThan(composerLayout.send.left);
  expect(composerLayout.borderRadius).toBeGreaterThanOrEqual(20);
  expect(composerLayout.promptFontSize).toBe(15);
  expect(composerLayout.promptMinHeight).toBeGreaterThanOrEqual(60);
  expect(Math.abs(composerLayout.send.width - composerLayout.send.height)).toBeLessThan(1);
  expect(composerLayout.sendRadius).toBeGreaterThanOrEqual(composerLayout.send.width / 2 - 1);
  const sidebarThemeContrast = await window.evaluate(() => {
    const root = document.documentElement;
    const originalTheme = root.getAttribute('data-theme');
    const intensity = (color) => {
      const values = color
        .match(/[\d.]+/g)
        .map(Number)
        .slice(0, 3);
      const scale = color.startsWith('color(') ? 255 : 1;
      return values.reduce((total, value) => total + value * scale, 0);
    };
    const sample = (theme) => {
      root.setAttribute('data-theme', theme);
      const background = (selector) =>
        getComputedStyle(document.querySelector(selector)).backgroundColor;
      const browserChrome = background('#agent-workspace-nav');
      const browserAddress = background('#agent-workspace-address-host #address-input');
      const titlebarBorderWidth = getComputedStyle(
        document.querySelector('.title-bar')
      ).borderBottomWidth;
      return {
        sidebar: intensity(
          getComputedStyle(document.querySelector('#agent-session-sidebar')).backgroundColor
        ),
        main: intensity(getComputedStyle(document.querySelector('#agent-sidebar')).backgroundColor),
        browserChrome,
        browserAddress,
        browserChromeIntensity: intensity(browserChrome),
        browserAddressIntensity: intensity(browserAddress),
        activeTab: background('#agent-task-page-list .tab.active'),
        titlebarBorderWidth,
        workspaceDivider: getComputedStyle(document.querySelector('#agent-page-surface'))
          .borderLeftColor,
        navigationDivider: getComputedStyle(document.querySelector('#agent-workspace-nav'))
          .borderBottomColor,
        activeTabDivider: getComputedStyle(document.querySelector('#agent-task-page-list .tab.active'))
          .borderTopColor,
        composerBorder: getComputedStyle(document.querySelector('.agent-composer')).borderTopColor,
      };
    };
    const result = { dark: sample('dark'), light: sample('light') };
    if (originalTheme === null) root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', originalTheme);
    return result;
  });
  expect(sidebarThemeContrast.dark.sidebar).toBeGreaterThan(sidebarThemeContrast.dark.main);
  expect(sidebarThemeContrast.light.sidebar).toBeLessThan(sidebarThemeContrast.light.main);
  for (const theme of [sidebarThemeContrast.dark, sidebarThemeContrast.light]) {
    expect(theme.activeTab).toBe(theme.browserChrome);
    expect(theme.browserChrome).not.toBe(theme.browserAddress);
    expect(theme.browserChromeIntensity).toBeGreaterThan(theme.browserAddressIntensity);
    expect(theme.titlebarBorderWidth).toBe('0px');
    expect(theme.navigationDivider).toBe(theme.workspaceDivider);
    expect(theme.activeTabDivider).toBe(theme.workspaceDivider);
    expect(theme.composerBorder).toBe(theme.workspaceDivider);
  }

  const paneMotion = await window.evaluate(() => ({
    sessions: getComputedStyle(document.querySelector('#agent-session-sidebar')).transitionDuration,
    workspace: getComputedStyle(document.querySelector('#agent-page-surface')).transitionDuration,
  }));
  expect(paneMotion.sessions).not.toBe('0s');
  expect(paneMotion.workspace).not.toBe('0s');

  const initialSessionWidth = await window
    .locator('#agent-session-sidebar')
    .evaluate((sidebar) => sidebar.getBoundingClientRect().width);
  const sessionResizeBox = await window
    .locator('[data-test="agent-session-resizer"]')
    .boundingBox();
  await window.mouse.move(
    sessionResizeBox.x + sessionResizeBox.width / 2,
    sessionResizeBox.y + sessionResizeBox.height / 2
  );
  await window.mouse.down();
  await expect(window.locator('body')).toHaveClass(/agent-sidebar-resizing/);
  await window.mouse.move(
    sessionResizeBox.x + 36,
    sessionResizeBox.y + sessionResizeBox.height / 2
  );
  await window.mouse.up();
  const resizedSessionGeometry = await window.evaluate(() => ({
    sidebar: document.querySelector('#agent-session-sidebar').getBoundingClientRect().width,
    titlebar: document.querySelector('.agent-first-titlebar-left').getBoundingClientRect().width,
  }));
  expect(resizedSessionGeometry.sidebar).toBeGreaterThan(initialSessionWidth + 25);
  expect(Math.abs(resizedSessionGeometry.sidebar - resizedSessionGeometry.titlebar)).toBeLessThan(
    2
  );

  const initialWorkspaceWidth = await window
    .locator('#agent-page-surface')
    .evaluate((sidebar) => sidebar.getBoundingClientRect().width);
  const workspaceResizeBox = await window
    .locator('[data-test="agent-workspace-resizer"]')
    .boundingBox();
  await window.mouse.move(
    workspaceResizeBox.x + workspaceResizeBox.width / 2,
    workspaceResizeBox.y + workspaceResizeBox.height / 2
  );
  await window.mouse.down();
  await expect(window.locator('body')).toHaveClass(/agent-sidebar-resizing/);
  await window.mouse.move(
    workspaceResizeBox.x - 36,
    workspaceResizeBox.y + workspaceResizeBox.height / 2
  );
  await window.mouse.up();
  const resizedWorkspaceGeometry = await window.evaluate(() => ({
    sidebar: document.querySelector('#agent-page-surface').getBoundingClientRect().width,
    titlebar: document.querySelector('.agent-first-titlebar-right').getBoundingClientRect().width,
  }));
  expect(resizedWorkspaceGeometry.sidebar).toBeGreaterThan(initialWorkspaceWidth + 25);
  expect(
    Math.abs(resizedWorkspaceGeometry.sidebar - resizedWorkspaceGeometry.titlebar)
  ).toBeLessThan(2);

  const openSessionToggleLeft = await window
    .locator('[data-test="agent-session-sidebar-toggle"]')
    .evaluate((button) => button.getBoundingClientRect().left);
  await window.locator('[data-test="agent-session-sidebar-toggle"]').click();
  await expect(window.locator('body')).toHaveClass(/agent-session-sidebar-closed/);
  await window.waitForTimeout(260);
  const closedSessionToggleLeft = await window
    .locator('[data-test="agent-session-sidebar-toggle"]')
    .evaluate((button) => button.getBoundingClientRect().left);
  expect(Math.abs(closedSessionToggleLeft - openSessionToggleLeft)).toBeLessThan(1);
  const closedSessionChrome = await window.evaluate(() => ({
    sidebarDisplay: getComputedStyle(document.querySelector('#agent-session-sidebar')).display,
    headerBackground: getComputedStyle(document.querySelector('.agent-first-titlebar-left'))
      .backgroundColor,
    titlebarBackground: getComputedStyle(document.querySelector('.title-bar')).backgroundColor,
    slidingSurfaceTransform: getComputedStyle(
      document.querySelector('.agent-first-titlebar-left'),
      '::before'
    ).transform,
  }));
  expect(closedSessionChrome.sidebarDisplay).toBe('flex');
  expect(closedSessionChrome.headerBackground).toBe(closedSessionChrome.titlebarBackground);
  expect(closedSessionChrome.slidingSurfaceTransform).not.toBe('none');
  await window.locator('[data-test="agent-workspace-sidebar-toggle"]').click();
  await expect(window.locator('body')).toHaveClass(/agent-workspace-sidebar-closed/);
  await window.waitForTimeout(260);
  await expect(window.locator('#agent-page-surface')).toHaveCSS('display', 'flex');
  await window.locator('[data-test="agent-session-sidebar-toggle"]').click();
  await window.locator('[data-test="agent-workspace-sidebar-toggle"]').click();

  await window.locator('#agent-mode-toggle').click();
  await window.locator('#agent-mode-browser').click();
  await expect(window.locator('body')).not.toHaveClass(/agent-first-mode/);
  await expect(window.locator('.toolbar')).toBeVisible();
  await expect(window.locator('#nav-form > .address-bar-container')).toHaveCount(1);

  await window.locator('webview:not(.hidden)').waitFor({ state: 'attached' });
  await window.locator('#agent-prompt').fill('Summarize this page');
  await expect(window.locator('#agent-run')).toHaveAttribute('data-action', 'send');
  const tabMarkedAtStart = await window.evaluate(() => {
    document.querySelector('#agent-run').click();
    return document
      .querySelector('[data-test="tab"].active')
      .classList.contains('agent-controlled');
  });
  expect(tabMarkedAtStart).toBe(false);

  await expect(window.locator('#agent-run-status')).toHaveText('Provider issue', {
    timeout: 15_000,
  });
  await expect(window.locator('#agent-run-message')).toHaveText('');
  await expect(window.locator('.agent-turn-outcome')).toContainText('Model connection failed');
  await expect(window.locator('.agent-turn-outcome')).toContainText(
    'Ollama using freedom-e2e-no-server cannot use the selected model.'
  );
  await expect(window.locator('.agent-turn-outcome-technical')).toContainText(
    'Technical details'
  );
  await expect(window.locator('.agent-turn-outcome-actions')).toBeHidden();
  await expect(window.locator('.agent-user-message')).toHaveText('Summarize this page');
  await expect(window.locator('#agent-prompt')).toBeEnabled();
  await expect(window.locator('#agent-run')).toBeDisabled();
  await expect(window.locator('#agent-new-chat')).toBeEnabled();
  await expect(window.locator('#agent-model-menu-button')).toBeDisabled();
  await expect(window.locator('#agent-approval-mode-button')).toBeEnabled();
  await expect(window.locator('[data-test="tab"].active')).not.toHaveClass(/agent-controlled/);

  await window.locator('#agent-approval-mode-button').click();
  await window.locator('#agent-approval-mode-allow').click();
  await expect(window.locator('#agent-active-approval-mode-label')).toHaveText(
    'Fewer interruptions'
  );
  await expect(window.locator('#agent-run-message')).toHaveText(
    'Approval setting updated for the next message.'
  );

  await window.locator('#agent-new-chat').click();
  await expect(window.locator('#agent-empty-state')).toBeVisible();
  await expect(window.locator('#agent-transcript')).toBeHidden();
  await expect(window.locator('#agent-model-menu-button')).toBeEnabled();
  await expect(window.locator('#agent-approval-mode-button')).toBeEnabled();

  await window.locator('[data-test="agent-first-toggle"]').click();
  await expect(window.locator('#agent-session-list .agent-session-row')).toHaveCount(1);
  await expect(window.locator('#agent-session-list')).toContainText('Summarize this page');
  await window.locator('#agent-session-list .agent-session-select').click();
  await expect(window.locator('.agent-user-message')).toHaveText('Summarize this page');
  await expect(window.locator('#agent-task-page-count')).toHaveText('0');
  await expect(window.locator('#agent-run-message')).toContainText('Live conversation');

  const userDataDir = await electronApp.evaluate(({ app }) => app.getPath('userData'));
  await electronApp.close();
  const reopened = await electron.launch({
    args: ['.'],
    cwd: repositoryRoot,
    env: {
      ...process.env,
      FREEDOM_TEST_MODE: '1',
      FREEDOM_TEST_USER_DATA: userDataDir,
      ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
      LANG: 'en_US.UTF-8',
    },
    timeout: 20_000,
  });
  try {
    const reopenedWindow = await reopened.firstWindow();
    await reopenedWindow.waitForLoadState('domcontentloaded');
    await reopenedWindow.waitForSelector('[data-test="address-input"]', { state: 'visible' });
    await reopenedWindow.locator('[data-test="agent-toggle-btn"]').click();
    await reopenedWindow.locator('[data-test="agent-first-toggle"]').click();
    await expect(reopenedWindow.locator('#agent-session-list .agent-session-row')).toHaveCount(1);
    await expect(reopenedWindow.locator('#agent-session-list')).toContainText('Summarize this page');
    await reopenedWindow.locator('#agent-session-list .agent-session-select').click();
    await expect(reopenedWindow.locator('.agent-user-message')).toHaveText('Summarize this page');
    await expect(reopenedWindow.locator('#agent-task-page-count')).toHaveText('0');
  } finally {
    await reopened.close();
  }
});

test('browser helpers use separate real pages with approval, handoff and Stop', async ({ electronApp, window, harness }) => {
  await expect(window.locator('body')).toBeVisible();
  const urls = ['parent', 'approved', 'declined', 'stopped', 'next-turn', 'approved-third'].map(name => `https://helper-browser.test/${name}`);
  for (const url of urls) await harness.setContentFixture(url, { body: `<!doctype html><title>Helper fixture</title>
    <button onclick="globalThis.clicks++;document.querySelector('output').textContent=globalThis.clicks">Increment</button>
    <output>0</output><script>globalThis.clicks=0</script>` });
  const result = await electronApp.evaluate(async ({ webContents }, { root, urls }) => {
    const req = file => process.mainModule.require(root + '/src/main/' + file);
    const { WebContentsPageAdapter } = req('automation/adapters/web-contents-page-adapter');
    const { AutomationController } = req('automation/automation-controller');
    const { createInitialAutomationPolicy } = req('automation/policy-controller');
    const { createOriginScopedAutomationController } = req('automation/origin-scoped-controller');
    const { createFreedomBrowserTools } = req('agent/pi-browser-tools');
    const { createSubagentTool } = req('agent/pi-subagent-tools');
    const { loadPiSdk } = req('agent/pi-sdk');
    const sdk = await loadPiSdk();
    const controller = new AutomationController({ policyController: createInitialAutomationPolicy() });
    const pages = new Map(); const nativeIds = []; const approvals = []; const deniedParentReads = [];
    const createPage = async url => {
      nativeIds.push(await globalThis.__FREEDOM_TEST_HARNESS__.createHiddenAutomationPage(url));
      const content = webContents.getAllWebContents().find(w => w.getURL() === url);
      const adapter = new WebContentsPageAdapter(content); const id = controller.registerPage(adapter);
      pages.set(id, { content, adapter }); return id;
    };
    controller.setPageLifecycle({ createPage, closePage: async id => pages.get(id)?.content.close() });
    const parentTab = await createPage(urls[0]);
    const scoped = await createOriginScopedAutomationController({ controller, tabId: parentTab,
      approvalMode: 'every_interaction', createWorkspacePage: createPage });
    const owner = { userText: 'Test browser helpers', subagentAbortController: new AbortController() };
    let reachedApproval; const approvalReached = new Promise(resolve => { reachedApproval = resolve; });
    let releaseApproval; const pendingApproval = new Promise(resolve => { releaseApproval = resolve; });
    const delegate = createSubagentTool({ sdk, getOwner: () => owner,
      createBrowser: (_owner, signal, _taskId, tabIds) => scoped.createDelegatedBrowser({ signal, tabIds, requestApproval: request => {
        approvals.push(request);
        const url = pages.get(request.tabId)?.content.getURL();
        if (url === urls[3]) { reachedApproval(); return pendingApproval; }
        return url === urls[2] ? 'declined' : 'approved';
      } }),
      createTools: (_owner, _writer, browser) => createFreedomBrowserTools({ sdk, controller: browser.controller,
        tabId: null, onToolOutcome: outcome => browser.recordOutcome(outcome) }),
      createSession: async ({ customTools }) => {
        let listener;
        const tool = name => customTools.find(item => item.name === name);
        return { session: { subscribe: fn => { listener = fn; return () => {}; }, abort: async () => {}, dispose: () => {},
          prompt: async prompt => {
            const assignment = JSON.parse(prompt);
            const opened = assignment.assignedTabIds ? null : await tool('browser_create_tab').execute('open', { url: assignment.assignment });
            const tabId = assignment.assignedTabIds?.[0] || opened.details.envelope.result.tab.tabId;
            deniedParentReads.push(!(await scoped.execute('browser_snapshot', { tabId })).ok);
            const observation = await tool('browser_snapshot').execute('read', {});
            const ref = observation.details.envelope.result.elements.find(element => element.name === 'Increment').ref;
            await tool('browser_click').execute('click', { ref, intent: 'Increment the fixture counter' });
            listener({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'Inspected fixture; review tool receipts.' }] } });
          },
        } };
      },
    });
    try {
      const running = delegate.execute('parallel', { tasks: [
        { title: 'Approved page', task: urls[1], mode: 'browser' }, { title: 'Declined page', task: urls[2], mode: 'browser' },
        { title: 'Third independent page', task: urls[5], mode: 'browser' },
      ] });
      const parentRead = await scoped.execute('browser_snapshot', { tabId: parentTab });
      const reports = (await running).details.subagents;
      const returned = await scoped.execute('browser_list_tabs');
      const stopping = await delegate.execute('stopped', { title: 'Stopped page', task: urls[3], mode: 'browser', background: true });
      await approvalReached;
      const individuallyStopped = await delegate.stop(owner, stopping.details.subagent.taskId);
      const stopped = (await delegate.collect(owner))[0];
      const parentStillActive = !owner.subagentAbortController.signal.aborted && (await scoped.execute('browser_snapshot', { tabId: parentTab })).ok;
      releaseApproval('approved');
      for (let i = 0; i < 25; i++) await new Promise(resolve => setTimeout(resolve, 10));
      const originalPage = pages.get(parentTab).content.id;
      const delegatedExisting = (await delegate.execute('existing', {
        title: 'Use existing page', task: 'Click the existing counter', mode: 'browser', tabIds: [parentTab],
      })).details.subagent;
      const requiredFresh = await scoped.execute('browser_click', { tabId: parentTab, ref: 'old_ref' });
      const handedBack = await scoped.execute('browser_snapshot', { tabId: parentTab });
      const existingPagePreserved = originalPage === pages.get(parentTab).content.id;
      // Reproduce a new user turn opening and reading a page after delegation.
      await scoped.prepareResume();
      const parentTools = await createFreedomBrowserTools({ sdk, controller: scoped, tabId: parentTab });
      const parentTool = name => parentTools.find(tool => tool.name === name);
      const nextPage = await parentTool('browser_create_tab').execute('next-open', { url: urls[4] });
      const nextRead = await parentTool('browser_snapshot').execute('next-read', {});
      const staleParent = await parentTool('browser_click').execute('stale-parent', { tabId: parentTab, ref: 'old_ref', intent: 'Increment' })
        .then(() => null, error => ({ code: error.code, recovery: error.recovery }));
      const counts = {};
      for (const { content } of pages.values()) counts[content.getURL()] = await content.executeJavaScript('globalThis.clicks');
      return { nextPage: nextPage.details.envelope.ok, nextRead: nextRead.details.envelope.ok,
        nextElements: nextRead.details.envelope.result?.elements, staleParent,
        delegatedExisting, requiredFresh: requiredFresh.error?.message, handedBack: handedBack.ok, existingPagePreserved, parentRead: parentRead.ok, individuallyStopped, parentStillActive, deniedParentReads, reports, stopped, counts,
        returnedTabs: returned.result.tabs.length, activeUnchanged: scoped.getActiveTabId() === parentTab,
        approvals: approvals.length, remainingOwners: scoped.delegatedBrowsers.size };
    } finally {
      owner.subagentAbortController.abort();
      for (const { adapter } of pages.values()) adapter.dispose();
      for (const id of nativeIds) globalThis.__FREEDOM_TEST_HARNESS__.closeHiddenAutomationPage(id);
    }
  }, { root: repositoryRoot, urls });
  expect(result.parentRead).toBe(true);
  expect(result.individuallyStopped).toBe(true);
  expect(result.parentStillActive).toBe(true);
  expect(result.deniedParentReads).toEqual([true, true, true, true, true]);
  expect(result.delegatedExisting).toMatchObject({ state: 'completed', mode: 'browser' });
  expect(result.requiredFresh).toContain('fresh browser_snapshot');
  expect(result.handedBack).toBe(true);
  expect(result.existingPagePreserved).toBe(true);
  expect(result.nextPage).toBe(true);
  expect(result.nextRead).toBe(true);
  expect(result.nextElements).toContainEqual(expect.objectContaining({ name: 'Increment' }));
  expect(result.staleParent.code).toBe('OBSERVATION_REQUIRED');
  expect(result.staleParent.recovery.action).toBe('refresh_state');
  expect(result.counts).toEqual({ [urls[0]]: 1, [urls[1]]: 1, [urls[2]]: 0, [urls[3]]: 0, [urls[4]]: 0, [urls[5]]: 1 });
  expect(result.returnedTabs).toBe(4);
  expect(result.activeUnchanged).toBe(false); // Keep the other available parent tab selected after the lease.
  expect(result.approvals).toBe(5);
  expect(result.remainingOwners).toBe(0);
  expect(result.reports[0]).toMatchObject({ mode: 'browser', state: 'completed', browserActions: expect.arrayContaining([
    expect.objectContaining({ operation: 'browser_click', status: 'succeeded' }),
  ]) });
  expect(result.reports).toHaveLength(3);
  expect(result.reports[2]).toMatchObject({ mode: 'browser', state: 'completed' });
  expect(result.reports[1].browserActions).toContainEqual(expect.objectContaining({ operation: 'browser_click', status: 'failed' }));
  expect(result.stopped).toMatchObject({ mode: 'browser', state: 'cancelled', browserPending: true });
});

test('saved helper reports load on expansion and page through complete SQLite text', async ({ electronApp, window, ollamaServer, userDataDir }, testInfo) => {
  await window.locator('[data-test="agent-toggle-btn"]').click();
  await window.locator('#agent-provider-add').click();
  await window.locator('#agent-provider-choices').getByRole('button', { name: 'Ollama', exact: true }).click();
  await window.locator('#agent-provider-advanced > summary').click();
  await window.locator('#agent-ollama-url').fill(ollamaServer);
  await window.locator('#agent-provider-save').click();
  await expect(window.locator('#agent-provider-status')).toHaveText('Connected');
  await window.locator('#agent-sidebar-back').click();
  await electronApp.evaluate(({ BrowserWindow, ipcMain }, { root, userDataDir }) => {
    const require = process.getBuiltinModule('module').createRequire(`${root}/package.json`);
    const { AgentSessionHistoryStore } = require(root + '/src/main/agent/session-history-store');
    const path = require('path'); const fs = require('fs');
    const directory = path.join(userDataDir, 'report-fixture'); fs.mkdirSync(directory);
    const store = new AgentSessionHistoryStore({ userDataDir: directory });
    store.createSession({ conversationId: 'reports', title: 'Saved reports', approvalMode: 'every_interaction' });
    store.startTurn({ conversationId: 'reports', runId: 'report-turn', userText: 'Review', approvalMode: 'every_interaction' });
    const receipt = store.saveHelperReport('reports', 'report-turn', { taskId: 'delegate_' + 'f'.repeat(24), title: 'Accessibility review', state: 'completed',
      report: '# Review findings\n\n**Keyboard access** needs review.\n\n' + 'Detailed supporting evidence. '.repeat(650) + '\n\n## Final recommendation\n\nUse semantic buttons. <img src=x onerror=alert(1)>' });
    store.finishTurn({ conversationId: 'reports', runId: 'report-turn', status: 'completed', activity: [{ operation: 'delegate_task', subagent: receipt }] });
    globalThis.helperReportReads = 0;
    ipcMain.removeHandler('agent:helper-reports');
    ipcMain.handle('agent:helper-reports', (_event, payload) => {
      globalThis.helperReportReads++;
      return { ok: true, result: store.helperReports(payload.conversationId, { action: 'read', reportId: payload.reportId, offset: payload.offset, limit: 16000 }) };
    });
    const host = BrowserWindow.getAllWindows().find(item => !item.isDestroyed());
    for (const event of [
      { type: 'run_started', conversationId: 'reports', userText: 'Review saved findings' },
      { type: 'tool_started', toolCallId: 'helper', operation: 'delegate_task' },
      { type: 'tool_finished', toolCallId: 'helper', operation: 'delegate_task', status: 'succeeded', subagent: receipt },
      { type: 'run_finished', status: 'completed' },
    ]) host.webContents.send('agent:event', { runId: 'report-turn', ...event });
  }, { root: repositoryRoot, userDataDir });
  const card = window.locator('.agent-subagent-report');
  await expect(card).toBeVisible();
  expect(await electronApp.evaluate(() => globalThis.helperReportReads)).toBe(0);
  await card.locator('summary').click();
  await expect(card.getByRole('button', { name: 'Show more', exact: true })).toBeVisible();
  expect(await electronApp.evaluate(() => globalThis.helperReportReads)).toBe(1);
  await expect(card.locator('.agent-helper-report-body')).not.toContainText('Final recommendation');
  await card.getByRole('button', { name: 'Show more', exact: true }).click();
  await expect(card.locator('.agent-helper-report-body h2')).toHaveText('Final recommendation');
  await expect(card.locator('.agent-helper-report-body img')).toHaveCount(0);
  await expect(card.getByRole('button', { name: 'Show more', exact: true })).toBeHidden();
  for (const layout of ['browser', 'agent']) {
    if (layout === 'agent') await window.locator('[data-test="agent-first-toggle"]').click();
    for (const theme of ['dark', 'light']) {
      await window.evaluate(value => document.documentElement.dataset.theme = value, theme);
      await card.locator('summary').scrollIntoViewIfNeeded();
      expect(await card.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
      await window.screenshot({ path: testInfo.outputPath(`saved-report-${layout}-${theme}.png`) });
    }
  }
  expect(await electronApp.evaluate(() => globalThis.helperReportReads)).toBe(2);
});

test('upgrades populated legacy helper history with the Electron SQLite driver', async ({ electronApp, userDataDir }) => {
  const result = await electronApp.evaluate((_electron, { root, userDataDir }) => {
    const require = process.getBuiltinModule('module').createRequire(`${root}/package.json`);
    const fs = require('fs'); const path = require('path');
    const Database = require('better-sqlite3');
    const { AgentSessionHistoryStore } = require(root + '/src/main/agent/session-history-store');
    const dir = path.join(userDataDir, 'legacy-helper-upgrade'); fs.mkdirSync(dir);
    const store = new AgentSessionHistoryStore({ userDataDir: dir });
    store.createSession({ conversationId: 'legacy', title: 'Legacy conversation', approvalMode: 'every_interaction' });
    for (let i = 0; i < 205; i++) {
      const runId = `turn_${String(i).padStart(3, '0')}`;
      store.startTurn({ conversationId: 'legacy', runId, userText: `Review ${i}`, approvalMode: 'every_interaction' });
      const subagent = { taskId: 'delegate_' + i.toString(16).padStart(24, '0'), title: `Review ${i}`,
        state: 'completed', report: `Legacy findings ${i}`, reportTruncated: i === 204 };
      store.getDb().prepare('UPDATE agent_turns SET activity_json = ? WHERE id = ?').run(JSON.stringify([{ operation: 'delegate_task', subagent }]), runId);
    }
    store.getDb().exec('DROP TABLE agent_helper_reports');
    store.getDb().exec('ALTER TABLE agent_sessions DROP COLUMN privacy_json');
    store.getDb().pragma('user_version = 4'); store.close();
    let injectFailure = true;
    class FaultOnceDatabase extends Database {
      prepare(sql) {
        const statement = super.prepare(sql);
        if (injectFailure && sql.startsWith('UPDATE agent_turns SET activity_json = ? WHERE id = ? AND session_id = ?')) {
          return { run: (...args) => {
            if (args[1] === 'turn_102') throw new Error('Injected migration write failure');
            return statement.run(...args);
          } };
        }
        return statement;
      }
    }
    const upgraded = new AgentSessionHistoryStore({ userDataDir: dir, Database: FaultOnceDatabase });
    let failure;
    try { upgraded.getDb(); } catch (error) { failure = error.message; }
    const closedAfterFailure = upgraded.db === null;
    const probe = new Database(path.join(dir, 'agent-history.sqlite'));
    const versionAfterFailure = probe.pragma('user_version', { simple: true });
    const legacyAfterFailure = JSON.parse(probe.prepare('SELECT activity_json FROM agent_turns WHERE id = ?').get('turn_000').activity_json)[0].subagent;
    probe.close();
    if (failure !== 'Injected migration write failure' || !closedAfterFailure) {
      upgraded.close();
      return { failure, closedAfterFailure, versionAfterFailure, legacyAfterFailure };
    }
    injectFailure = false;
    upgraded.markStaleRunningAsInterrupted();
    const transcript = upgraded.getSession('legacy').transcript;
    const reports = transcript.map(turn => upgraded.helperReports('legacy', { action: 'read', reportId: turn.activity[0].subagent.reportId }));
    const version = upgraded.getDb().pragma('user_version', { simple: true });
    const count = upgraded.getDb().prepare('SELECT count(*) AS n FROM agent_helper_reports').get().n;
    upgraded.close();
    const reopenedCount = upgraded.getSession('legacy').transcript.length;
    upgraded.close();
    return { failure, closedAfterFailure, versionAfterFailure, legacyAfterFailure, version, count, reopenedCount,
      allReportsMatch: reports.every((report, i) => report.text === `Legacy findings ${i}`), lastTruncated: reports.at(-1).reportTruncated };
  }, { root: repositoryRoot, userDataDir });
  expect(result.failure).toBe('Injected migration write failure');
  expect(result.closedAfterFailure).toBe(true);
  expect(result.versionAfterFailure).toBe(4);
  expect(result.legacyAfterFailure.report).toBe('Legacy findings 0');
  expect(result.legacyAfterFailure.reportId).toBeUndefined();
  expect(result).toMatchObject({ version: 6, count: 205, reopenedCount: 205, allReportsMatch: true, lastTruncated: true });
});

test('publication card follows one job through waiting, confirmation and completion in both themes', async ({ electronApp, window, ollamaServer }, testInfo) => {
  await window.locator('[data-test="agent-toggle-btn"]').click();
  await window.locator('#agent-provider-add').click();
  await window.locator('#agent-provider-choices').getByRole('button', { name: 'Ollama', exact: true }).click();
  await window.locator('#agent-provider-advanced > summary').click();
  await window.locator('#agent-ollama-url').fill(ollamaServer);
  await window.locator('#agent-provider-save').click();
  await expect(window.locator('#agent-provider-status')).toHaveText('Connected');
  await window.locator('#agent-sidebar-back').click();
  await electronApp.evaluate(({ BrowserWindow }) => {
    const page = BrowserWindow.getAllWindows().find(item => !item.isDestroyed());
    const emit = event => page.webContents.send('agent:event', { runId: 'run_publication_ui', ...event });
    emit({ type: 'run_started', userText: 'Publish my website' });
    emit({ type: 'tool_started', toolCallId: 'publish', operation: 'swarm_publish', intent: 'Publish site' });
  });
  const publication = { publicationId: `swarm_pub_${'c'.repeat(24)}`, kind: 'folder', name: 'dist', public: true, applicationState: 'possibly_applied' };
  for (const stage of [
    { state: 'waiting_postage', message: 'Waiting for postage · 8 more blocks' },
    { state: 'confirming', message: 'Waiting for network confirmation', progress: 80 },
    { state: 'outcome_unknown', message: 'Publication needs checking', error: 'A detailed fixture-only node error' },
    { state: 'completed', message: 'Published · retrieval verified', verified: true, reference: 'd'.repeat(64), bzzUrl: `bzz://${'d'.repeat(64)}` },
  ]) {
    await electronApp.evaluate(({ BrowserWindow }, publication) => {
      BrowserWindow.getAllWindows().find(item => !item.isDestroyed()).webContents.send('agent:event', {
        type: 'tool_progress', runId: 'run_publication_ui', toolCallId: 'publish', operation: 'swarm_publish', publication,
      });
    }, { ...publication, ...stage });
    const card = window.locator('.agent-publication');
    await expect(card).toHaveCount(1);
    await expect(card).toContainText(stage.message);
    await expect(card.getByRole('button', { name: 'Open', exact: true })).toHaveCount(stage.state === 'completed' ? 1 : 0);
    if (stage.error) {
      await expect(card.locator('details')).not.toHaveAttribute('open', '');
      await card.getByText('Technical details').click();
      await expect(card.locator('details p')).toBeVisible();
    }
    for (const theme of ['dark', 'light']) {
      await window.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
      await window.screenshot({ path: testInfo.outputPath(`publication-${stage.state}-${theme}.png`) });
    }
  }
});
