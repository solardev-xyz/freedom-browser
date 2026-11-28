/**
 * Main's own Swarm node methods on the core's backend
 * (core/swarm-own-calls.js; freedom-core design 0015, "Methods main
 * calls", "Main's own node methods' params", D5 and D13; the SWM-6 to SWM-9
 * plan's PR 8.3):
 * - **the params** `swarm.publish` goes with, in the vectors' wire form: a
 *   `data` part of at most 64 KiB inline, every other part streamed from
 *   main's held bytes or a picked file, `pin: true`, `deferred`, `history`;
 * - **a picked folder** walked as bee-js's `makeCollectionFromFS` walks
 *   it, its paths joined with `/`;
 * - **the answer** read strictly: the result, the service's error as an
 *   Error with its members, anything else `internal`;
 * - **the request:** its watchdog, its pool, its parent opened in the
 *   executor from `onSent` (row, params, backend, signal, deadline,
 *   parts) and closed at its end, the result's charge released once read.
 */

jest.mock('../logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

const fs = require('fs');
const os = require('os');
const path = require('path');
const { CoreError } = require('./core-client');
const { writeTyped } = require('./swarm-typed');
const {
  createSwarmOwnCalls,
  publishParams,
  readOwnAnswer,
  walkDirectory,
} = require('./swarm-own-calls');

/**
 * bee-js 13.2.0's `makeCollectionFromFS` (`dist/cjs/utils/collection.node.js`),
 * copied as it walks a folder for `collection.uploadFromDirectory`: the
 * JS backend's freedom://publish walk, the order and sizes main's own walk
 * keeps.
 */
async function referenceCollectionFromFS(dir) {
  async function buildCollectionRelative(relativePath) {
    const dirname = path.join(dir, relativePath);
    const entries = await fs.promises.opendir(dirname);
    let collection = [];
    for await (const entry of entries) {
      const fullPath = path.join(dir, relativePath, entry.name);
      const entryPath = path.join(relativePath, entry.name);
      if (entry.isFile()) {
        collection.push({
          path: entryPath,
          size: (await fs.promises.stat(fullPath)).size,
          fsPath: fullPath,
        });
      } else if (entry.isDirectory()) {
        collection = [...(await buildCollectionRelative(entryPath)), ...collection];
      }
    }
    return collection;
  }
  return buildCollectionRelative('');
}

const KIB = 1024;
const REFERENCE = 'ab'.repeat(32);
const BATCH = 'c3'.repeat(32);

/** A typed answer as the core writes it (D5). */
const typed = (value) => writeTyped(value);
const resultOf = (value) => ({ result_typed: typed(value) });
const errorOf = (value) => ({ error_typed: typed(value) });

describe("swarm.publish's params", () => {
  test('text of at most 64 KiB goes inline; past it, as a part main holds', () => {
    const text = Buffer.from('hello');
    expect(publishParams({ kind: 'data', parts: [{ bytes: text }], deferred: false })).toEqual({
      params: {
        kind: 'data',
        parts: [{ bytes: 5, base64: 'aGVsbG8=' }],
        pin: true,
        deferred: false,
      },
      sources: new Map(),
    });
    const at = Buffer.alloc(64 * KIB, 1);
    expect(
      publishParams({ kind: 'data', parts: [{ bytes: at }], deferred: false }).params.parts
    ).toEqual([{ bytes: 64 * KIB, base64: at.toString('base64') }]);
    const past = new Uint8Array(64 * KIB + 1);
    const { params, sources } = publishParams({
      kind: 'data',
      parts: [{ bytes: past }],
      name: 'draft.md',
      contentType: 'text/markdown',
      encrypt: true,
      batch: BATCH,
      deferred: false,
      history: { type: 'data', name: 'Text' },
    });
    expect(params).toEqual({
      kind: 'data',
      parts: [{ bytes: 64 * KIB + 1, part: 0 }],
      name: 'draft.md',
      content_type: 'text/markdown',
      encrypt: true,
      batch: BATCH,
      pin: true,
      deferred: false,
      history: { type: 'data', name: 'Text' },
    });
    // The held bytes themselves, never a copy.
    expect(sources.get(0)).toBe(past);
  });

  test("a picked file streams from its path, at the size main gave it; a collection's every part streams, numbered in order", () => {
    const file = path.join(os.tmpdir(), 'notes.txt');
    expect(
      publishParams({
        kind: 'file',
        parts: [{ file, size: 9 }],
        name: 'notes.txt',
        deferred: true,
        history: { type: 'file', name: 'notes.txt' },
      })
    ).toEqual({
      params: {
        kind: 'file',
        parts: [{ bytes: 9, part: 0 }],
        name: 'notes.txt',
        pin: true,
        deferred: true,
        history: { type: 'file', name: 'notes.txt' },
      },
      sources: new Map([[0, { path: file, bytes: 9 }]]),
    });
    const held = Buffer.from('x');
    const { params, sources } = publishParams({
      kind: 'collection',
      parts: [
        { path: 'index.html', file, size: 13 },
        { path: 'a/b.txt', bytes: held },
      ],
      deferred: true,
      history: { type: 'directory', name: 'site' },
    });
    expect(params).toEqual({
      kind: 'collection',
      parts: [
        { path: 'index.html', bytes: 13, part: 0 },
        { path: 'a/b.txt', bytes: 1, part: 1 },
      ],
      pin: true,
      deferred: true,
      history: { type: 'directory', name: 'site' },
    });
    expect(sources).toEqual(
      new Map([
        [0, { path: file, bytes: 13 }],
        [1, held],
      ])
    );
  });

  test("encrypt goes only when true; a part that is neither held nor a picked file is main's bug", () => {
    expect(
      publishParams({
        kind: 'data',
        parts: [{ bytes: Buffer.alloc(1) }],
        encrypt: false,
        deferred: false,
      }).params
    ).not.toHaveProperty('encrypt');
    for (const part of [
      {},
      { file: 'relative.txt', size: 1 },
      { file: '/a', size: -1 },
      { bytes: 'text' },
    ]) {
      expect(() =>
        publishParams({ kind: 'file', parts: [part], name: 'x', deferred: true })
      ).toThrow(TypeError);
    }
    expect(() => publishParams({ kind: 'tar', parts: [], deferred: true })).toThrow(TypeError);
    expect(() => publishParams({ kind: 'data', parts: [] })).toThrow(TypeError);
  });
});

describe('a picked folder, walked as bee-js walks it', () => {
  let dir;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walk-'));
    const write = (rel, text) => {
      const file = path.join(dir, ...rel.split('/'));
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text);
    };
    write('index.html', '<h1>site</h1>');
    write('style.css', 'body{}');
    write('assets/app.js', 'run()');
    write('assets/img/logo.svg', '<svg/>');
    write('docs/a.txt', 'a');
    write('z.txt', 'zz');
    fs.mkdirSync(path.join(dir, 'empty'));
    if (process.platform !== 'win32')
      fs.symlinkSync(path.join(dir, 'z.txt'), path.join(dir, 'link.txt'));
  });

  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  test("its files in bee-js's order with bee-js's sizes, each path joined with '/', a symlink left out", async () => {
    const walked = await walkDirectory(dir);
    const reference = await referenceCollectionFromFS(dir);
    expect(walked.map(({ path: p, size }) => ({ path: p, size }))).toEqual(
      reference.map(({ path: p, size }) => ({ path: p.split(path.sep).join('/'), size }))
    );
    expect(walked.map((entry) => entry.file)).toEqual(reference.map((entry) => entry.fsPath));
    expect(walked.map((entry) => entry.path).sort()).toEqual(
      [
        'assets/app.js',
        'assets/img/logo.svg',
        'docs/a.txt',
        'index.html',
        'style.css',
        'z.txt',
      ].sort()
    );
  });

  test("a folder it can't read throws the fs error, naming the path", async () => {
    await expect(walkDirectory(path.join(dir, 'missing'))).rejects.toMatchObject({
      code: 'ENOENT',
      syscall: 'opendir',
    });
  });
});

describe('the answer, read strictly', () => {
  test("a result is the service's; swarm.publish's is exactly { reference, tag_uid, batch, bytes }", () => {
    const published = { reference: REFERENCE, tag_uid: 7, batch: BATCH, bytes: 5 };
    expect(readOwnAnswer('swarm.publish', resultOf(published))).toEqual(published);
    expect(readOwnAnswer('swarm.publish', resultOf({ ...published, tag_uid: null }))).toEqual({
      ...published,
      tag_uid: null,
    });
    expect(readOwnAnswer('swarm.stamps', resultOf([{ batchID: BATCH }]))).toEqual([
      { batchID: BATCH },
    ]);
    for (const odd of [
      { ...published, reference: 'AB'.repeat(32) },
      { ...published, reference: 'ab' },
      { ...published, extra: 1 },
      { ...published, bytes: -1 },
      { ...published, tag_uid: '7' },
    ]) {
      expect(() => readOwnAnswer('swarm.publish', resultOf(odd))).toThrow(
        expect.objectContaining({ name: 'CoreError', code: 'internal' })
      );
    }
  });

  test("an error is the service's, with the members its callers read", () => {
    const capacity = { uploadBytes: 5, requiredBytes: 8, largestRemainingBytes: 0 };
    let thrown;
    try {
      readOwnAnswer(
        'swarm.publish',
        errorOf({ message: 'No usable postage batch', code: 'POSTAGE_UNAVAILABLE', capacity })
      );
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBeInstanceOf(CoreError);
    expect(thrown).toMatchObject({
      message: 'No usable postage batch',
      code: 'POSTAGE_UNAVAILABLE',
      capacity,
    });
    expect(() =>
      readOwnAnswer('swarm.upload_status', errorOf({ message: 'Not Found', status: 404 }))
    ).toThrow(expect.objectContaining({ message: 'Not Found', status: 404 }));
  });

  test("anything else is the core's fault: internal", () => {
    for (const odd of [
      null,
      [],
      {},
      { result: {} },
      { result_typed: typed(1), error_typed: typed({ message: 'x' }) },
      { result_typed: { nonsense: true } },
      errorOf({ text: 'x' }),
      errorOf({ message: 1 }),
      errorOf({ message: 'x', code: 1 }),
      errorOf({ message: 'x', status: 1.5 }),
      errorOf({ message: 'x', capacity: 3 }),
      errorOf('x'),
    ]) {
      expect(() => readOwnAnswer('swarm.stamps', odd)).toThrow(
        expect.objectContaining({ name: 'CoreError', code: 'internal' })
      );
    }
  });
});

describe('the request and its parent', () => {
  function harness({
    answer = resultOf({ reference: REFERENCE, tag_uid: 1, batch: BATCH, bytes: 5 }),
    open,
  } = {}) {
    const seen = { requests: [], opened: [], closed: 0, released: 0 };
    const client = {
      request: jest.fn(async (method, params, context, options) => {
        seen.requests.push({ method, params, context, options });
        options.onSent(41, 3);
        if (options.signal.aborted) throw new CoreError('cancelled', 'cancelled');
        return {
          result: typeof answer === 'function' ? answer() : answer,
          release: () => {
            seen.released += 1;
          },
        };
      }),
    };
    const shell = {
      open: jest.fn((sent, capture) => {
        if (open) open(sent, capture);
        seen.opened.push({ sent, capture });
        return {
          close: () => {
            seen.closed += 1;
          },
        };
      }),
    };
    const backend = { url: 'http://127.0.0.1:1633', request: jest.fn() };
    const pool = { take: jest.fn(), release: jest.fn() };
    const calls = createSwarmOwnCalls({
      coreClient: () => client,
      swarmShell: () => shell,
      nodeBackend: () => backend,
      pool,
      now: () => 1_000,
    });
    return { calls, seen, backend, pool };
  }

  test('swarm.publish: shell, its idle watchdog, the pool; its parent with its row, params, backend, signal, no deadline and its parts; closed and released at its end', async () => {
    const { calls, seen, backend, pool } = harness();
    const file = path.join(os.tmpdir(), 'notes.txt');
    const signal = new AbortController().signal;
    const result = await calls.publish(
      { kind: 'file', parts: [{ file, size: 9 }], name: 'notes.txt', deferred: true },
      { signal }
    );
    expect(result).toEqual({ reference: REFERENCE, tag_uid: 1, batch: BATCH, bytes: 5 });
    const [request] = seen.requests;
    expect(request.method).toBe('swarm.publish');
    expect(request.context).toEqual({ caller: 'shell' });
    expect(request.options).toMatchObject({ idleWatchdogMs: 75_000, pool });
    expect(request.options).not.toHaveProperty('watchdogMs');
    const [{ sent, capture }] = seen.opened;
    expect(sent).toEqual({ generation: 3, id: 41 });
    expect(capture).toEqual({
      row: 'swarm.publish:data,file',
      params: request.params,
      backend,
      signal: request.options.signal,
      deadlineAt: null,
      parts: new Map([[0, { path: file, bytes: 9 }]]),
    });
    expect(seen.closed).toBe(1);
    expect(seen.released).toBe(1);
  });

  test('swarm.stamps and swarm.upload_status: their hang watchdog, and the parent their 300 s deadline', async () => {
    const { calls, seen } = harness({ answer: resultOf([]) });
    expect(await calls.stamps()).toEqual([]);
    expect(seen.requests[0]).toMatchObject({ method: 'swarm.stamps', params: {} });
    expect(seen.requests[0].options).toMatchObject({ watchdogMs: 315_000 });
    expect(seen.opened[0].capture).toMatchObject({
      row: 'swarm.stamps',
      deadlineAt: 301_000,
      parts: null,
    });
    await calls.stamps({ id: BATCH });
    expect(seen.requests[1].params).toEqual({ id: BATCH });
    await calls.uploadStatus(9);
    expect(seen.requests[2]).toMatchObject({
      method: 'swarm.upload_status',
      params: { tag_uid: 9 },
    });
    expect(seen.opened[2].capture.row).toBe('swarm.upload_status');
    expect(seen.closed).toBe(3);
    expect(seen.released).toBe(3);
  });

  test("a parent that can't be opened ends the request, which throws internal", async () => {
    const { calls, seen } = harness({
      open: () => {
        throw new TypeError('part 0 has no source of its length');
      },
    });
    await expect(calls.stamps()).rejects.toMatchObject({ name: 'CoreError', code: 'internal' });
    expect(seen.requests[0].options.signal.aborted).toBe(true);
  });

  test("the service's error is thrown, released once read; no core is core_unavailable", async () => {
    const { calls, seen } = harness({ answer: errorOf({ message: 'Not Found', status: 404 }) });
    await expect(calls.uploadStatus(104)).rejects.toMatchObject({
      message: 'Not Found',
      status: 404,
    });
    expect(seen.released).toBe(1);
    const none = createSwarmOwnCalls({ coreClient: () => null, swarmShell: () => null });
    await expect(none.stamps()).rejects.toMatchObject({ code: 'core_unavailable' });
    await expect(none.call('swarm.nothing', {})).rejects.toThrow(TypeError);
  });
});
