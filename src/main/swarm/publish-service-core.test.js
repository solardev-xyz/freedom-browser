/**
 * freedom://publish's IPC handlers on the core's backend (publish-service.js;
 * freedom-core design 0015, "Methods main calls", D3; the SWM-6 to SWM-9
 * plan's PR 8.3), with main's own calls (core/swarm-own-calls.js) as the
 * test's: what each handler asks the core's `swarm.publish` and
 * `swarm.upload_status` for, and what it answers from the core's result or
 * error. publish-service-core.integration.test.js plays the same handlers
 * against the real core, on both backends.
 *
 * - text, a picked file and a picked folder each go as one `swarm.publish`
 *   with `history`, so main writes no row of its own; bee-js is never
 *   asked;
 * - a failure answers the reference's text: `describePublishError`'s "try
 *   again shortly", `needsStorage` for no usable batch, a picked path by its
 *   basename only;
 * - a publish that fails before anything is sent has its row written
 *   through the core's `swarm.history`, as js writes it; so does a picked
 *   folder whose params pass one request frame, refused unsent with
 *   `FOLDER_TOO_LARGE_MESSAGE`;
 * - a row the core couldn't insert (`HistoryInsertError`) rejects the
 *   invoke, as js's `addEntry` throws before the handler's `try`; the same
 *   text from a later write is answered as a failure;
 * - the upload status within the reference's 10 s.
 */

const ipcHandlers = {};
jest.mock('electron', () => ({
  ipcMain: {
    handle: (channel, handler) => {
      ipcHandlers[channel] = handler;
    },
    removeHandler: () => {},
  },
  dialog: { showOpenDialog: (...args) => mockDialog.showOpenDialog(...args) },
  BrowserWindow: { getFocusedWindow: () => null, getAllWindows: () => [] },
}));
const mockDialog = { showOpenDialog: jest.fn() };
jest.mock('electron-log', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../service-registry', () => ({ getAntApiUrl: () => 'http://127.0.0.1:1633' }));
jest.mock('../private/private-windows', () => ({ isPrivateWebContents: jest.fn(() => false) }));
jest.mock('./page-upload', () => ({}));
jest.mock('./swarm-backend-kind', () => ({ swarmBackendKind: () => 'core' }));
// bee-js's paths are the JS backend's: never asked on core.
jest.mock('./swarm-service', () => ({
  getBee: jest.fn(() => {
    throw new Error('bee-js on core');
  }),
  selectBestBatch: jest.fn(async () => {
    throw new Error('bee-js on core');
  }),
  toHex: (value) => value,
}));
jest.mock('./publish-history', () => ({
  addEntry: jest.fn(),
  updateEntry: jest.fn(),
  coreOps: {
    addEntry: jest.fn(async (entry) => ({ id: 9, ...entry })),
    updateEntry: jest.fn(async () => ({ id: 9 })),
  },
}));
// The core's calls: the test's, the folder walk main's own.
const mockCalls = { publish: jest.fn(), uploadStatus: jest.fn() };
const mockWalk = { fn: null };
jest.mock('../core/swarm-own-calls', () => {
  const actual = jest.requireActual('../core/swarm-own-calls');
  return {
    ...actual,
    swarmOwnCalls: () => mockCalls,
    walkDirectory: (dir) => (mockWalk.fn ? mockWalk.fn(dir) : actual.walkDirectory(dir)),
  };
});

const fs = require('fs');
const os = require('os');
const path = require('path');
const { CoreError } = require('../core/core-client');
const { HISTORY_FAILED_MESSAGE, HistoryInsertError } = require('../core/swarm-own-calls');
const publishHistory = require('./publish-history');
const swarmService = require('./swarm-service');
const { isPrivateWebContents } = require('../private/private-windows');
const { registerPublishIpc, FOLDER_TOO_LARGE_MESSAGE, USER_ORIGIN } = require('./publish-service');

registerPublishIpc();

const SENDER = { id: 3, once: () => {} };
const REFERENCE = 'ab'.repeat(32);
const BATCH = 'c3'.repeat(32);
const PUBLISHED = { reference: REFERENCE, tag_uid: 42, batch: BATCH, bytes: 5 };
const NOT_YET_KNOWN =
  'Internal Server Error: {"code":500,"message":"pushsync: chunk rejected by 3 peer(s) as not found on-chain"}';
const SHORTLY = 'Your storage is still reaching the Swarm network. Try again in a minute.';

const invoke = (channel, ...args) => ipcHandlers[channel]({ sender: SENDER }, ...args);

async function pick(kind, chosen) {
  mockDialog.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [chosen] });
  const picked = await invoke(kind === 'file' ? 'swarm:pick-file' : 'swarm:pick-directory');
  return picked.token;
}

const serviceError = (message, members = {}) => Object.assign(new Error(message), members);

let dir;
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-core-unit-'));
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

beforeEach(() => {
  jest.clearAllMocks();
  mockWalk.fn = null;
});

afterEach(() => {
  // Main's own history and bee-js are the JS backend's.
  expect(publishHistory.addEntry).not.toHaveBeenCalled();
  expect(publishHistory.updateEntry).not.toHaveBeenCalled();
  expect(swarmService.getBee).not.toHaveBeenCalled();
  expect(swarmService.selectBestBatch).not.toHaveBeenCalled();
});

describe('swarm:publish-data', () => {
  test("text goes as one data part with its row's history; the answer is the reference's", async () => {
    mockCalls.publish.mockResolvedValueOnce(PUBLISHED);
    expect(await invoke('swarm:publish-data', 'hello')).toEqual({
      success: true,
      reference: REFERENCE,
      bzzUrl: `bzz://${REFERENCE}`,
      tagUid: 42,
    });
    expect(mockCalls.publish).toHaveBeenCalledWith({
      kind: 'data',
      parts: [{ bytes: Buffer.from('hello') }],
      deferred: false,
      history: { type: 'data', name: 'Text' },
    });
    expect(publishHistory.coreOps.addEntry).not.toHaveBeenCalled();
    // A tag of 0 or none is null, as normalizeUploadResult has it.
    mockCalls.publish.mockResolvedValueOnce({ ...PUBLISHED, tag_uid: null });
    expect((await invoke('swarm:publish-data', '')).tagUid).toBeNull();
    expect(mockCalls.publish.mock.calls[1][0].parts).toEqual([{ bytes: Buffer.alloc(0) }]);
  });

  test("a failure answers the reference's text: try again shortly, needsStorage, the message", async () => {
    mockCalls.publish.mockRejectedValueOnce(serviceError(NOT_YET_KNOWN, { status: 500 }));
    expect(await invoke('swarm:publish-data', 'hello')).toEqual({ success: false, error: SHORTLY });
    const capacity = { uploadBytes: 5, requiredBytes: 8, largestRemainingBytes: 0 };
    mockCalls.publish.mockRejectedValueOnce(
      serviceError('No usable postage batch is available.', {
        code: 'POSTAGE_UNAVAILABLE',
        capacity,
      })
    );
    expect(await invoke('swarm:publish-data', 'hello')).toEqual({
      success: false,
      error: 'No usable postage batch is available.',
      needsStorage: true,
    });
    mockCalls.publish.mockRejectedValueOnce(new CoreError('busy', 'busy'));
    expect(await invoke('swarm:publish-data', 'hello')).toEqual({ success: false, error: 'busy' });
    // U13's text comes as the core gives it.
    mockCalls.publish.mockRejectedValueOnce(serviceError('Internal error'));
    expect(await invoke('swarm:publish-data', 'hello')).toEqual({
      success: false,
      error: 'Internal error',
    });
    expect(publishHistory.coreOps.addEntry).not.toHaveBeenCalled();
  });

  test('bytes go as they are; a value that is neither fails unsent, its row written through the core', async () => {
    mockCalls.publish.mockResolvedValue(PUBLISHED);
    await invoke('swarm:publish-data', new Uint8Array([1, 2, 3]));
    expect(mockCalls.publish.mock.calls[0][0].parts).toEqual([
      { bytes: new Uint8Array([1, 2, 3]) },
    ]);
    mockCalls.publish.mockClear();
    const answer = await invoke('swarm:publish-data', 42);
    let thrown;
    try {
      Buffer.byteLength(42);
    } catch (err) {
      thrown = err;
    }
    expect(answer).toEqual({ success: false, error: thrown.message });
    expect(mockCalls.publish).not.toHaveBeenCalled();
    expect(publishHistory.coreOps.addEntry).toHaveBeenCalledWith({
      type: 'data',
      name: 'Text',
      status: 'uploading',
      origin: USER_ORIGIN,
    });
    expect(publishHistory.coreOps.updateEntry).toHaveBeenCalledWith(9, {
      status: 'failed',
      errorMessage: thrown.message,
    });
  });

  test('the private window guard and the empty input stay first', async () => {
    isPrivateWebContents.mockReturnValueOnce(true);
    expect(await invoke('swarm:publish-data', 'hello')).toEqual({
      success: false,
      error: 'Publishing is unavailable in private windows',
    });
    expect(await invoke('swarm:publish-data', null)).toEqual({
      success: false,
      error: 'Data is required',
    });
    expect(mockCalls.publish).not.toHaveBeenCalled();
  });
});

describe('swarm:publish-file', () => {
  test('a picked file goes as one part main streams from it, at the size it read, named by its basename', async () => {
    const file = path.join(dir, 'notes.txt');
    fs.writeFileSync(file, 'nine byte');
    mockCalls.publish.mockResolvedValueOnce({ ...PUBLISHED, bytes: 9 });
    const answer = await invoke('swarm:publish-file', await pick('file', file));
    expect(answer).toEqual({
      success: true,
      reference: REFERENCE,
      bzzUrl: `bzz://${REFERENCE}`,
      tagUid: 42,
    });
    expect(mockCalls.publish).toHaveBeenCalledWith({
      kind: 'file',
      parts: [{ file, size: 9 }],
      name: 'notes.txt',
      deferred: true,
      history: { type: 'file', name: 'notes.txt' },
    });
  });

  test("a failure names the file by its basename, and a batch the network doesn't know yet reads try again shortly", async () => {
    const file = path.join(dir, 'secret.txt');
    fs.writeFileSync(file, 'x');
    mockCalls.publish.mockRejectedValueOnce(serviceError('Could not read "secret.txt" (EACCES)'));
    expect(await invoke('swarm:publish-file', await pick('file', file))).toEqual({
      success: false,
      error: 'Could not read "secret.txt" (EACCES)',
    });
    mockCalls.publish.mockRejectedValueOnce(serviceError(`node said: ${file} refused`));
    const answer = await invoke('swarm:publish-file', await pick('file', file));
    expect(answer).toEqual({ success: false, error: 'node said: secret.txt refused' });
    mockCalls.publish.mockRejectedValueOnce(serviceError(NOT_YET_KNOWN));
    expect(await invoke('swarm:publish-file', await pick('file', file))).toEqual({
      success: false,
      error: SHORTLY,
    });
  });

  test("a file it can't read before the upload fails unsent, by its name and code, its row written through the core", async () => {
    const file = path.join(dir, 'gone.txt');
    fs.writeFileSync(file, 'x');
    const token = await pick('file', file);
    const enoent = Object.assign(new Error(`ENOENT: no such file or directory, stat '${file}'`), {
      code: 'ENOENT',
      syscall: 'stat',
      path: file,
    });
    const stat = jest.spyOn(fs, 'statSync').mockImplementationOnce(() => {
      throw enoent;
    });
    try {
      expect(await invoke('swarm:publish-file', token)).toEqual({
        success: false,
        error: 'Could not read "gone.txt" (ENOENT)',
      });
    } finally {
      stat.mockRestore();
    }
    expect(mockCalls.publish).not.toHaveBeenCalled();
    expect(publishHistory.coreOps.addEntry).toHaveBeenCalledWith({
      type: 'file',
      name: 'gone.txt',
      status: 'uploading',
      origin: USER_ORIGIN,
    });
    expect(publishHistory.coreOps.updateEntry).toHaveBeenCalledWith(9, {
      status: 'failed',
      errorMessage: 'Could not read "gone.txt" (ENOENT)',
    });
  });
});

describe('swarm:publish-directory', () => {
  test('a picked folder goes as a collection of its files as bee-js finds them, each streamed from its file', async () => {
    const folder = path.join(dir, 'site');
    fs.mkdirSync(path.join(folder, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(folder, 'index.html'), '<h1>hi</h1>');
    fs.writeFileSync(path.join(folder, 'assets', 'app.js'), 'run()');
    mockCalls.publish.mockResolvedValueOnce(PUBLISHED);
    const answer = await invoke('swarm:publish-directory', await pick('directory', folder));
    expect(answer).toEqual({
      success: true,
      reference: REFERENCE,
      bzzUrl: `bzz://${REFERENCE}`,
      tagUid: 42,
    });
    const [spec] = mockCalls.publish.mock.calls[0];
    expect(spec).toEqual({
      kind: 'collection',
      parts: expect.any(Array),
      deferred: true,
      history: { type: 'directory', name: 'site' },
    });
    expect(spec.parts.sort((a, b) => a.path.localeCompare(b.path))).toEqual([
      { path: 'assets/app.js', file: path.join(folder, 'assets', 'app.js'), size: 5 },
      { path: 'index.html', file: path.join(folder, 'index.html'), size: 11 },
    ]);
  });

  test("a folder it can't walk fails unsent, by the name of what it couldn't read, its row written through the core", async () => {
    const folder = path.join(dir, 'locked');
    fs.mkdirSync(folder);
    const token = await pick('directory', folder);
    const inner = path.join(folder, 'private');
    mockWalk.fn = async () => {
      throw Object.assign(new Error(`EACCES: permission denied, opendir '${inner}'`), {
        code: 'EACCES',
        syscall: 'opendir',
        path: inner,
      });
    };
    expect(await invoke('swarm:publish-directory', token)).toEqual({
      success: false,
      error: 'Could not read "private" (EACCES)',
    });
    expect(mockCalls.publish).not.toHaveBeenCalled();
    expect(publishHistory.coreOps.updateEntry).toHaveBeenCalledWith(9, {
      status: 'failed',
      errorMessage: 'Could not read "private" (EACCES)',
    });
  });
});

describe('a picked folder past one request frame', () => {
  test('is refused before anything is sent, with one fixed text, its row failed through the core', async () => {
    expect(FOLDER_TOO_LARGE_MESSAGE).toBe(
      'This folder has too many files to publish through the core'
    );
    const folder = path.join(dir, 'many');
    fs.mkdirSync(folder);
    const token = await pick('directory', folder);
    // Codex's case: 26,200 empty files f0 to f26199.
    mockWalk.fn = async (walked) =>
      Array.from({ length: 26_200 }, (_, i) => ({
        path: `f${i}`,
        file: path.join(walked, `f${i}`),
        size: 0,
      }));
    expect(await invoke('swarm:publish-directory', token)).toEqual({
      success: false,
      error: FOLDER_TOO_LARGE_MESSAGE,
    });
    expect(mockCalls.publish).not.toHaveBeenCalled();
    expect(publishHistory.coreOps.addEntry).toHaveBeenCalledWith({
      type: 'directory',
      name: 'many',
      status: 'uploading',
      origin: USER_ORIGIN,
    });
    expect(publishHistory.coreOps.updateEntry).toHaveBeenCalledWith(9, {
      status: 'failed',
      errorMessage: FOLDER_TOO_LARGE_MESSAGE,
    });
    // 20,000 of them fit, and go.
    jest.clearAllMocks();
    const all = await mockWalk.fn(folder);
    mockWalk.fn = async () => all.slice(0, 20_000);
    mockCalls.publish.mockResolvedValueOnce(PUBLISHED);
    expect((await invoke('swarm:publish-directory', await pick('directory', folder))).success).toBe(
      true
    );
    expect(mockCalls.publish.mock.calls[0][0].parts).toHaveLength(20_000);
    expect(publishHistory.coreOps.addEntry).not.toHaveBeenCalled();
  });
});

describe("a row the core couldn't insert", () => {
  async function eachHandler(error) {
    const file = path.join(dir, 'row.txt');
    fs.writeFileSync(file, 'row');
    const folder = path.join(dir, 'row-site');
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'index.html'), 'row');
    const out = [];
    for (const [channel, arg] of [
      ['swarm:publish-data', 'hello'],
      ['swarm:publish-file', await pick('file', file)],
      ['swarm:publish-directory', await pick('directory', folder)],
    ]) {
      mockCalls.publish.mockRejectedValueOnce(error());
      out.push(
        await invoke(channel, arg).then(
          (answer) => ({ channel, answer }),
          (thrown) => ({ channel, thrown })
        )
      );
    }
    return out;
  }

  test("rejects the invoke, as js's addEntry throws before the handler's try", async () => {
    const played = await eachHandler(() => new HistoryInsertError());
    for (const { channel, answer, thrown } of played) {
      expect({ channel, answer }).toEqual({ channel, answer: undefined });
      expect(thrown).toBeInstanceOf(HistoryInsertError);
      expect(thrown.message).toBe('The publish history could not be read or written');
    }
    expect(publishHistory.coreOps.addEntry).not.toHaveBeenCalled();
    expect(publishHistory.coreOps.updateEntry).not.toHaveBeenCalled();
  });

  test("the same text from a later write of the row (the core's retry) is answered as a failure", async () => {
    const played = await eachHandler(() => serviceError(HISTORY_FAILED_MESSAGE));
    for (const { channel, answer } of played) {
      expect({ channel, answer }).toEqual({
        channel,
        answer: { success: false, error: HISTORY_FAILED_MESSAGE },
      });
    }
  });
});

describe('swarm:get-upload-status', () => {
  test("the core's swarm.upload_status, within 10 s, in the reference's wrap", async () => {
    const status = {
      tagUid: 5,
      split: 10,
      seen: 0,
      stored: 10,
      sent: 5,
      synced: 10,
      progress: 50,
      done: true,
    };
    mockCalls.uploadStatus.mockResolvedValueOnce(status);
    expect(await invoke('swarm:get-upload-status', 5)).toEqual({ success: true, ...status });
    const [tagUid, { signal }] = mockCalls.uploadStatus.mock.calls[0];
    expect(tagUid).toBe(5);
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal.aborted).toBe(false);
    mockCalls.uploadStatus.mockRejectedValueOnce(
      serviceError('Not Found: {"code":404}', { status: 404 })
    );
    expect(await invoke('swarm:get-upload-status', 6)).toEqual({
      success: false,
      error: 'Not Found: {"code":404}',
    });
    expect(await invoke('swarm:get-upload-status', '6')).toEqual({
      success: false,
      error: 'Tag UID is required',
    });
    expect(mockCalls.uploadStatus).toHaveBeenCalledTimes(2);
  });
});
