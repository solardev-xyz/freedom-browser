const IPC = require('../shared/ipc-channels');
const { failure, success } = require('./ipc-contract');
const {
  createIpcMainMock,
  loadMainModule,
} = require('../../test/helpers/main-process-test-utils');

function createResponseMock(options = {}) {
  const listeners = new Map();

  return {
    statusCode: options.statusCode ?? 200,
    on: jest.fn((event, handler) => {
      if (!listeners.has(event)) {
        listeners.set(event, []);
      }
      listeners.get(event).push(handler);
    }),
    resume: jest.fn(),
    emit(event, ...args) {
      for (const handler of listeners.get(event) || []) {
        handler(...args);
      }
    },
  };
}

function createRequestMock() {
  const listeners = new Map();
  const request = {
    on: jest.fn((event, handler) => {
      if (!listeners.has(event)) {
        listeners.set(event, []);
      }
      listeners.get(event).push(handler);
      return request;
    }),
    destroy: jest.fn(),
    end: jest.fn(),
    emit(event, ...args) {
      for (const handler of listeners.get(event) || []) {
        handler(...args);
      }
    },
  };

  return request;
}

function matchesRoute(route, url) {
  if (route.url) {
    return route.url === url;
  }

  if (route.match instanceof RegExp) {
    return route.match.test(url);
  }

  if (typeof route.match === 'function') {
    return route.match(url);
  }

  return false;
}

function toBodyChunks(body) {
  if (body === undefined || body === null) return [];
  if (typeof body === 'string') return [body];
  return [JSON.stringify(body)];
}

function createGetMock(routes = []) {
  const queue = [...routes];

  return jest.fn((url, options, callback) => {
    let handler = callback;
    if (typeof options === 'function') {
      handler = options;
    }

    const routeIndex = queue.findIndex((route) => matchesRoute(route, url));
    if (routeIndex === -1) {
      throw new Error(`Unexpected GET request: ${url}`);
    }

    const route = queue.splice(routeIndex, 1)[0];
    const request = createRequestMock();

    process.nextTick(() => {
      if (route.error) {
        request.emit('error', route.error);
        return;
      }

      if (route.timeout) {
        request.emit('timeout');
        return;
      }

      const response = createResponseMock(route);
      handler(response);

      process.nextTick(() => {
        toBodyChunks(route.body).forEach((chunk) => response.emit('data', chunk));
        response.emit('end');
      });
    });

    return request;
  });
}

function createRequestFactory(routes = []) {
  const queue = [...routes];

  return jest.fn((url, _options, callback) => {
    const routeIndex = queue.findIndex((route) => matchesRoute(route, url));
    if (routeIndex === -1) {
      throw new Error(`Unexpected request: ${url}`);
    }

    const route = queue.splice(routeIndex, 1)[0];
    const request = createRequestMock();

    request.end.mockImplementation(() => {
      process.nextTick(() => {
        if (route.error) {
          request.emit('error', route.error);
          return;
        }

        if (route.timeout) {
          request.emit('timeout');
          return;
        }

        const response = createResponseMock(route);
        callback(response);

        process.nextTick(() => {
          toBodyChunks(route.body).forEach((chunk) => response.emit('data', chunk));
          response.emit('end');
        });
      });
    });

    return request;
  });
}

function createSenderMock(options = {}) {
  return {
    isDestroyed: jest.fn(() => options.destroyed ?? false),
    send: jest.fn(),
  };
}

function loadGithubBridgeModule(options = {}) {
  const ipcMain = options.ipcMain || createIpcMainMock();
  const execFileAsync = options.execFileAsync || jest.fn();
  const radicleDataPath = options.radicleDataPath || '/mock/radicle-data';
  const radicleBinDir = options.radicleBinDir || '/mock/radicle/bin';
  const tempDir = options.tempDir || '/tmp/freedom-bridge-12345';
  const mapPath = `${radicleDataPath}/github-bridge-map.json`;
  const fsMock = {
    existsSync: jest.fn((target) => {
      if (target === mapPath) return options.mapExists === true;
      if (target === tempDir) return options.tempDirExists !== false;
      if (target === `${radicleBinDir}/rad`) return options.radBinaryExists !== false;
      if (target === `${radicleBinDir}/git-remote-rad`) return options.gitRemoteRadExists !== false;
      return false;
    }),
    readFileSync: jest.fn((target) => {
      if (target === mapPath) {
        return options.mapFileContent || '{}';
      }
      return '';
    }),
    writeFileSync: jest.fn(),
    mkdtempSync: jest.fn(() => tempDir),
    rmSync: jest.fn(),
  };
  const httpsGet = options.httpsGet || createGetMock(options.httpsGetRoutes);
  const httpsRequest = options.httpsRequest || createRequestFactory(options.httpsRequestRoutes);
  const httpGet = options.httpGet || createGetMock(options.httpGetRoutes);
  const loadSettings = jest.fn(() => options.settings || { enableRadicleIntegration: true });
  const getRadicleBinaryPath = jest.fn((bin) => `${radicleBinDir}/${bin}`);
  const getRadicleDataPath = jest.fn(() => radicleDataPath);
  const getActivePort = jest.fn(() => options.activePort ?? null);

  const { mod } = loadMainModule(require.resolve('./github-bridge'), {
    ipcMain,
    extraMocks: {
      child_process: () => ({ execFile: jest.fn() }),
      fs: () => fsMock,
      http: () => ({ get: httpGet }),
      https: () => ({
        get: httpsGet,
        request: httpsRequest,
      }),
      os: () => ({
        tmpdir: jest.fn(() => '/tmp'),
      }),
      util: () => ({
        ...jest.requireActual('util'),
        promisify: jest.fn(() => execFileAsync),
      }),
      [require.resolve('./radicle-manager')]: () => ({
        getRadicleBinaryPath,
        getRadicleDataPath,
        getActivePort,
      }),
      [require.resolve('./settings-store')]: () => ({
        loadSettings,
      }),
    },
  });

  return {
    execFileAsync,
    fsMock,
    getActivePort,
    getRadicleBinaryPath,
    getRadicleDataPath,
    httpGet,
    httpsGet,
    httpsRequest,
    ipcMain,
    loadSettings,
    mapPath,
    mod,
    tempDir,
  };
}

describe('github-bridge', () => {
  beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('validateGitHubUrl', () => {
    test.each([
      ['https://github.com/solardev-xyz/freedom-browser', 'solardev-xyz', 'freedom-browser'],
      ['https://github.com/owner/repo.git', 'owner', 'repo'],
      ['github.com/owner/repo', 'owner', 'repo'],
      ['owner/repo', 'owner', 'repo'],
      ['https://github.com/owner/repo/', 'owner', 'repo'],
      ['https://www.github.com/owner/repo', 'owner', 'repo'],
      ['my-org.io/my-repo.js', 'my-org.io', 'my-repo.js'],
    ])('accepts %s', (url, owner, repo) => {
      const { mod } = loadGithubBridgeModule();

      expect(mod.validateGitHubUrl(url)).toEqual({
        ...success(),
        valid: true,
        owner,
        repo,
        cloneUrl: `https://github.com/${owner}/${repo}.git`,
      });
    });

    test('rejects empty input', () => {
      const { mod } = loadGithubBridgeModule();

      expect(mod.validateGitHubUrl('')).toEqual({
        valid: false,
        ...failure('INVALID_URL', 'Please enter a GitHub repository URL', { field: 'url' }),
      });
    });

    test.each([
      null,
      undefined,
      'https://gitlab.com/owner/repo',
      'https://github.com/owner/repo/tree/main',
      'https://github.com/owner',
    ])('rejects invalid value %p', (value) => {
      const { mod } = loadGithubBridgeModule();

      expect(mod.validateGitHubUrl(value).valid).toBe(false);
    });
  });

  describe('registerGithubBridgeIpc', () => {
    test('registers all GitHub bridge IPC handlers', () => {
      const ctx = loadGithubBridgeModule();

      ctx.mod.registerGithubBridgeIpc();

      expect([...ctx.ipcMain.handlers.keys()].sort()).toEqual([
        IPC.GITHUB_BRIDGE_IMPORT,
        IPC.GITHUB_BRIDGE_CHECK_GIT,
        IPC.GITHUB_BRIDGE_CHECK_PREREQUISITES,
        IPC.GITHUB_BRIDGE_VALIDATE_URL,
        IPC.GITHUB_BRIDGE_CHECK_EXISTING,
      ].sort());
    });

    test('gates bridge actions when Radicle integration is disabled', async () => {
      const ctx = loadGithubBridgeModule({
        settings: { enableRadicleIntegration: false },
      });

      ctx.mod.registerGithubBridgeIpc();

      await expect(ctx.ipcMain.invoke(IPC.GITHUB_BRIDGE_CHECK_PREREQUISITES)).resolves.toEqual(
        failure(
          'RADICLE_DISABLED',
          'Radicle integration is disabled. Enable it in Settings > Experimental'
        )
      );
      await expect(
        ctx.ipcMain.handlers.get(IPC.GITHUB_BRIDGE_IMPORT)({ sender: createSenderMock() }, 'owner/repo')
      ).resolves.toEqual(
        failure(
          'RADICLE_DISABLED',
          'Radicle integration is disabled. Enable it in Settings > Experimental'
        )
      );
      await expect(ctx.ipcMain.invoke(IPC.GITHUB_BRIDGE_CHECK_EXISTING, 'owner/repo')).resolves.toEqual(
        failure(
          'RADICLE_DISABLED',
          'Radicle integration is disabled. Enable it in Settings > Experimental'
        )
      );
    });

    test('rejects missing URLs before import or existing-bridge lookups', async () => {
      const ctx = loadGithubBridgeModule();

      ctx.mod.registerGithubBridgeIpc();

      await expect(ctx.ipcMain.handlers.get(IPC.GITHUB_BRIDGE_IMPORT)({}, '')).resolves.toEqual(
        failure('INVALID_URL', 'Missing GitHub URL', { field: 'url' })
      );
      await expect(ctx.ipcMain.invoke(IPC.GITHUB_BRIDGE_CHECK_EXISTING, '')).resolves.toEqual(
        failure('INVALID_URL', 'Missing GitHub URL', { field: 'url' })
      );
    });

    test('checks whether git is available', async () => {
      const successCtx = loadGithubBridgeModule({
        execFileAsync: jest.fn().mockResolvedValue({ stdout: 'git version 2.43.0\n' }),
      });

      successCtx.mod.registerGithubBridgeIpc();

      await expect(successCtx.ipcMain.invoke(IPC.GITHUB_BRIDGE_CHECK_GIT)).resolves.toEqual({
        available: true,
        version: 'git version 2.43.0',
      });

      const failureCtx = loadGithubBridgeModule({
        execFileAsync: jest.fn().mockRejectedValue(new Error('git missing')),
      });

      failureCtx.mod.registerGithubBridgeIpc();

      await expect(failureCtx.ipcMain.invoke(IPC.GITHUB_BRIDGE_CHECK_GIT)).resolves.toEqual({
        available: false,
        error: 'Git is not installed or not found in PATH',
      });
    });

    test('reports prerequisite failures for missing binaries and network timeout', async () => {
      const missingBinaryCtx = loadGithubBridgeModule({
        execFileAsync: jest.fn().mockResolvedValue({ stdout: 'git version 2.43.0\n' }),
        gitRemoteRadExists: false,
      });

      missingBinaryCtx.mod.registerGithubBridgeIpc();

      await expect(
        missingBinaryCtx.ipcMain.invoke(IPC.GITHUB_BRIDGE_CHECK_PREREQUISITES)
      ).resolves.toEqual({
        ...failure('GIT_REMOTE_RAD_MISSING', 'Radicle Git bridge (git-remote-rad) not found'),
        step: 'checking-radicle',
      });

      const networkCtx = loadGithubBridgeModule({
        execFileAsync: jest.fn().mockResolvedValue({ stdout: 'git version 2.43.0\n' }),
        httpsRequestRoutes: [{ url: 'https://github.com/', timeout: true }],
      });

      networkCtx.mod.registerGithubBridgeIpc();

      await expect(networkCtx.ipcMain.invoke(IPC.GITHUB_BRIDGE_CHECK_PREREQUISITES)).resolves.toEqual({
        ...failure(
          'NETWORK_UNAVAILABLE',
          'Network check timed out while reaching GitHub.'
        ),
        step: 'checking-network',
      });
    });

    test('returns bridge matches loaded from disk', async () => {
      const ctx = loadGithubBridgeModule({
        mapExists: true,
        mapFileContent: JSON.stringify({
          'openai/project': 'rad:z6mkt4existing123',
        }),
      });

      ctx.mod.registerGithubBridgeIpc();

      await expect(
        ctx.ipcMain.invoke(IPC.GITHUB_BRIDGE_CHECK_EXISTING, 'https://github.com/openai/project')
      ).resolves.toEqual(
        success({
          bridged: true,
          rid: 'z6mkt4existing123',
        })
      );
      expect(ctx.fsMock.readFileSync).toHaveBeenCalledWith(ctx.mapPath, 'utf8');
    });

    test('detects legacy bridges from repo descriptions and persists the mapping', async () => {
      const ctx = loadGithubBridgeModule({
        activePort: 8780,
        httpGetRoutes: [
          {
            match: /\/api\/v1\/repos\?show=all$/,
            body: [
              {
                rid: 'rad:z6mkt4description123',
                payloads: {
                  'xyz.radicle.project': {
                    data: {
                      description: 'Imported from github.com/OpenAI/Project',
                    },
                  },
                },
              },
            ],
          },
        ],
      });

      ctx.mod.registerGithubBridgeIpc();

      await expect(
        ctx.ipcMain.invoke(IPC.GITHUB_BRIDGE_CHECK_EXISTING, 'https://github.com/openai/project')
      ).resolves.toEqual(
        success({
          bridged: true,
          rid: 'z6mkt4description123',
        })
      );
      expect(ctx.fsMock.writeFileSync).toHaveBeenCalledWith(
        ctx.mapPath,
        JSON.stringify({ 'openai/project': 'z6mkt4description123' }, null, 2)
      );
    });

    test('detects legacy bridges by matching GitHub head SHAs', async () => {
      const ctx = loadGithubBridgeModule({
        activePort: 8780,
        httpGetRoutes: [
          {
            match: /\/api\/v1\/repos\?show=all$/,
            body: [
              {
                rid: 'rad:z6mkt4headmatch123',
                payloads: {
                  'xyz.radicle.project': {
                    data: {
                      name: 'project',
                    },
                  },
                },
              },
            ],
          },
          {
            match: /\/api\/v1\/repos\/rad:z6mkt4headmatch123\/remotes$/,
            body: [
              {
                heads: {
                  main: 'abc123',
                },
              },
            ],
          },
        ],
        httpsGetRoutes: [
          {
            url: 'https://api.github.com/repos/openai/project',
            body: {
              default_branch: 'main',
            },
          },
          {
            url: 'https://api.github.com/repos/openai/project/commits/main',
            body: {
              sha: 'abc123',
            },
          },
        ],
      });

      ctx.mod.registerGithubBridgeIpc();

      await expect(
        ctx.ipcMain.invoke(IPC.GITHUB_BRIDGE_CHECK_EXISTING, 'https://github.com/openai/project')
      ).resolves.toEqual(
        success({
          bridged: true,
          rid: 'z6mkt4headmatch123',
        })
      );
      expect(ctx.fsMock.writeFileSync).toHaveBeenCalledWith(
        ctx.mapPath,
        JSON.stringify({ 'openai/project': 'z6mkt4headmatch123' }, null, 2)
      );
    });

    test('surfaces import validation failures after emitting progress', async () => {
      const ctx = loadGithubBridgeModule();
      const sender = createSenderMock();

      ctx.mod.registerGithubBridgeIpc();

      await expect(
        ctx.ipcMain.handlers.get(IPC.GITHUB_BRIDGE_IMPORT)({ sender }, 'not a valid url')
      ).resolves.toEqual({
        ...failure(
          'INVALID_URL_FORMAT',
          'Invalid GitHub URL. Expected: https://github.com/owner/repo or owner/repo',
          { field: 'url', value: 'not a valid url' }
        ),
        step: 'validating',
      });
      expect(sender.send).toHaveBeenCalledWith(IPC.GITHUB_BRIDGE_PROGRESS, {
        step: 'validating',
        message: 'Validating GitHub URL...',
      });
    });

    test('imports a GitHub repository through the registered IPC handler', async () => {
      const execFileAsync = jest.fn()
        .mockResolvedValueOnce({ stdout: 'git version 2.43.0\n' })
        .mockResolvedValueOnce({ stdout: '', stderr: '' })
        .mockResolvedValueOnce({ stdout: 'develop\n' })
        .mockResolvedValueOnce({ stdout: 'initialized rad:z6mkt4import123\n', stderr: '' })
        .mockResolvedValueOnce({ stdout: '', stderr: '' })
        .mockResolvedValueOnce({ stdout: '', stderr: '' });
      const ctx = loadGithubBridgeModule({
        execFileAsync,
        httpsRequestRoutes: [{ url: 'https://github.com/', statusCode: 200 }],
        httpsGetRoutes: [
          {
            url: 'https://api.github.com/repos/openai/project',
            body: {
              description: 'Project description',
            },
          },
        ],
      });
      const sender = createSenderMock();

      ctx.mod.registerGithubBridgeIpc();

      await expect(
        ctx.ipcMain.handlers.get(IPC.GITHUB_BRIDGE_IMPORT)(
          { sender },
          'https://github.com/openai/project'
        )
      ).resolves.toEqual({
        ...success(),
        rid: 'z6mkt4import123',
        name: 'project',
        owner: 'openai',
        description: 'Project description',
      });

      expect(sender.send.mock.calls).toEqual([
        [IPC.GITHUB_BRIDGE_PROGRESS, { step: 'validating', message: 'Validating GitHub URL...' }],
        [IPC.GITHUB_BRIDGE_PROGRESS, { step: 'checking-prereqs', message: 'Checking prerequisites...' }],
        [IPC.GITHUB_BRIDGE_PROGRESS, { step: 'cloning', message: 'Cloning openai/project...' }],
        [IPC.GITHUB_BRIDGE_PROGRESS, { step: 'initializing', message: 'Initializing Radicle project...' }],
        [IPC.GITHUB_BRIDGE_PROGRESS, { step: 'pushing', message: 'Pushing to Radicle network...' }],
        [IPC.GITHUB_BRIDGE_PROGRESS, { step: 'success', message: 'Repository seeded successfully!' }],
      ]);
      expect(execFileAsync).toHaveBeenNthCalledWith(1, 'git', ['--version'], { timeout: 5000 });
      expect(execFileAsync).toHaveBeenNthCalledWith(2, 'git', [
        'clone',
        'https://github.com/openai/project.git',
        '/tmp/freedom-bridge-12345/project',
      ], {
        timeout: 300000,
      });
      expect(execFileAsync).toHaveBeenNthCalledWith(3, 'git', ['symbolic-ref', '--short', 'HEAD'], {
        cwd: '/tmp/freedom-bridge-12345/project',
        timeout: 5000,
      });
      expect(execFileAsync).toHaveBeenNthCalledWith(4, '/mock/radicle/bin/rad', [
        'init',
        '--name',
        'project',
        '--description',
        'Project description',
        '--default-branch',
        'develop',
        '--public',
        '--no-confirm',
      ], expect.objectContaining({
        cwd: '/tmp/freedom-bridge-12345/project',
        timeout: 60000,
        env: expect.objectContaining({
          RAD_HOME: '/mock/radicle-data',
          RAD_PASSPHRASE: '',
          PATH: expect.stringContaining('/mock/radicle/bin'),
        }),
      }));
      expect(ctx.fsMock.writeFileSync).toHaveBeenCalledWith(
        ctx.mapPath,
        JSON.stringify({ 'openai/project': 'z6mkt4import123' }, null, 2)
      );
      expect(ctx.fsMock.rmSync).toHaveBeenCalledWith(ctx.tempDir, {
        recursive: true,
        force: true,
      });
    });

    test('returns an already-bridged failure when rad init reports an existing project', async () => {
      const execFileAsync = jest.fn()
        .mockResolvedValueOnce({ stdout: 'git version 2.43.0\n' })
        .mockResolvedValueOnce({ stdout: '', stderr: '' })
        .mockResolvedValueOnce({ stdout: 'main\n' })
        .mockRejectedValueOnce(Object.assign(new Error('project exists'), {
          stderr: Buffer.from('\u001b[31mproject exists rad:z6mkt4already123\u001b[39m'),
        }));
      const ctx = loadGithubBridgeModule({
        execFileAsync,
        httpsRequestRoutes: [{ url: 'https://github.com/', statusCode: 200 }],
        httpsGetRoutes: [
          {
            url: 'https://api.github.com/repos/openai/project',
            body: {
              description: 'Existing project',
            },
          },
        ],
      });
      const sender = createSenderMock();

      ctx.mod.registerGithubBridgeIpc();

      await expect(
        ctx.ipcMain.handlers.get(IPC.GITHUB_BRIDGE_IMPORT)(
          { sender },
          'https://github.com/openai/project'
        )
      ).resolves.toEqual({
        ...failure(
          'ALREADY_BRIDGED',
          'This GitHub repository is already bridged to Radicle.',
          { rid: 'z6mkt4already123' }
        ),
        step: 'initializing',
        rid: 'z6mkt4already123',
      });
      expect(ctx.fsMock.writeFileSync).toHaveBeenCalledWith(
        ctx.mapPath,
        JSON.stringify({ 'openai/project': 'z6mkt4already123' }, null, 2)
      );
      expect(sender.send).not.toHaveBeenCalledWith(IPC.GITHUB_BRIDGE_PROGRESS, {
        step: 'error',
        message: expect.any(String),
      });
    });

    test('maps repository-not-found import failures to a friendly error and emits progress', async () => {
      const execFileAsync = jest.fn()
        .mockResolvedValueOnce({ stdout: 'git version 2.43.0\n' })
        .mockRejectedValueOnce(Object.assign(new Error('clone failed'), {
          stderr: Buffer.from('\u001b[31mrepository not found\u001b[39m'),
        }));
      const ctx = loadGithubBridgeModule({
        execFileAsync,
        httpsRequestRoutes: [{ url: 'https://github.com/', statusCode: 200 }],
      });
      const sender = createSenderMock();

      ctx.mod.registerGithubBridgeIpc();

      await expect(
        ctx.ipcMain.handlers.get(IPC.GITHUB_BRIDGE_IMPORT)(
          { sender },
          'https://github.com/openai/project'
        )
      ).resolves.toEqual(
        failure('REPOSITORY_NOT_FOUND', 'GitHub repository not found or not accessible.')
      );
      expect(sender.send).toHaveBeenLastCalledWith(IPC.GITHUB_BRIDGE_PROGRESS, {
        step: 'error',
        message: 'GitHub repository not found or not accessible.',
      });
      expect(ctx.fsMock.rmSync).toHaveBeenCalledWith(ctx.tempDir, {
        recursive: true,
        force: true,
      });
    });
  });
});
