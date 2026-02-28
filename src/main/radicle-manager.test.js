const mockUpdateService = jest.fn();
const mockSetStatusMessage = jest.fn();
const mockSetErrorState = jest.fn();
const mockClearErrorState = jest.fn();
const mockClearService = jest.fn();

jest.mock('./logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

jest.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: jest.fn(() => '/tmp/freedom-user-data'),
  },
  ipcMain: { handle: jest.fn() },
  BrowserWindow: {
    getAllWindows: jest.fn(() => []),
  },
}));

jest.mock('./service-registry', () => ({
  MODE: {
    BUNDLED: 'bundled',
    REUSED: 'reused',
    EXTERNAL: 'external',
    NONE: 'none',
  },
  DEFAULTS: {
    radicle: {
      httpPort: 8780,
      p2pPort: 8776,
      fallbackRange: 10,
    },
  },
  updateService: mockUpdateService,
  setStatusMessage: mockSetStatusMessage,
  setErrorState: mockSetErrorState,
  clearErrorState: mockClearErrorState,
  clearService: mockClearService,
}));

const mockExistsSync = jest.fn((filePath) => {
  if (filePath.includes('/.radicle/node/control.sock')) return false; // no system node
  if (filePath.endsWith('/node/control.sock')) return true; // bundled node socket appears
  if (filePath.includes('radicle-bin')) return true; // binaries exist
  if (filePath.endsWith('/config.json')) return false;
  return true;
});

jest.mock('fs', () => ({
  existsSync: (filePath) => mockExistsSync(filePath),
  mkdirSync: jest.fn(),
  unlinkSync: jest.fn(),
  readdirSync: jest.fn(() => ['key']),
  readFileSync: jest.fn(() => '{}'),
  writeFileSync: jest.fn(),
}));

const mockSpawnedProcesses = [];
const mockSpawn = jest.fn((name) => {
  const handlers = {};
  const onceHandlers = {};
  const proc = {
    bin: name,
    kills: [],
    stdout: {
      on: jest.fn(),
    },
    stderr: {
      on: jest.fn(),
    },
    on: jest.fn((event, handler) => {
      handlers[event] = handler;
    }),
    once: jest.fn((event, handler) => {
      onceHandlers[event] = handler;
    }),
    kill: jest.fn((signal) => {
      proc.kills.push(signal);
      setTimeout(() => {
        if (onceHandlers.close) onceHandlers.close(0);
        if (handlers.close) handlers.close(0);
      }, 0);
      return true;
    }),
  };
  mockSpawnedProcesses.push(proc);
  return proc;
});

jest.mock('child_process', () => ({
  spawn: (...args) => mockSpawn(...args),
  execFileSync: jest.fn(),
  execFile: jest.fn((_file, _args, _opts, cb) => cb(null, '', '')),
}));

jest.mock('net', () => ({
  Socket: class MockSocket {
    constructor() {
      this.handlers = {};
    }
    setTimeout() {}
    on(event, handler) {
      this.handlers[event] = handler;
    }
    destroy() {}
    connect() {
      setTimeout(() => {
        if (this.handlers.error) this.handlers.error(new Error('closed'));
      }, 0);
    }
  },
}));

jest.mock('http', () => ({
  get: jest.fn((_url, _opts, callback) => {
    const res = {
      statusCode: 200,
      resume: jest.fn(),
      on: jest.fn((event, handler) => {
        if (event === 'data') {
          setTimeout(() => handler('{}'), 0);
        }
        if (event === 'end') {
          setTimeout(() => handler(), 0);
        }
      }),
    };

    setTimeout(() => callback(res), 0);

    return {
      on: jest.fn(),
      end: jest.fn(),
      destroy: jest.fn(),
    };
  }),
}));

jest.mock('os', () => ({
  homedir: jest.fn(() => '/home/test'),
}));

const { startRadicle, stopRadicle } = require('./radicle-manager');

describe('radicle-manager lifecycle integration', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSpawnedProcesses.length = 0;
  });

  afterEach(async () => {
    await stopRadicle();
  });

  test('starts bundled node/httpd and shuts them down cleanly', async () => {
    await startRadicle();
    await new Promise((resolve) => setTimeout(resolve, 1200));

    expect(mockSpawn).toHaveBeenCalledTimes(2);
    expect(mockSpawnedProcesses[0].bin).toContain('radicle-node');
    expect(mockSpawnedProcesses[1].bin).toContain('radicle-httpd');
    expect(mockUpdateService).toHaveBeenCalledWith('radicle', {
      api: 'http://127.0.0.1:8780',
      gateway: 'http://127.0.0.1:8780',
      mode: 'bundled',
    });

    const stopPromise = stopRadicle();
    await new Promise((resolve) => setTimeout(resolve, 600));
    await stopPromise;

    expect(mockSpawnedProcesses[1].kills).toContain('SIGTERM');
    expect(mockSpawnedProcesses[0].kills).toContain('SIGTERM');
    expect(mockClearService).toHaveBeenCalledWith('radicle');
  });
});
