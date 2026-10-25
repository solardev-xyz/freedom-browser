'use strict';

jest.mock('../logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { TaskWorkerUnavailable, TaskWorkerTimeout } = require('../task-worker-host');
const { preparePublication } = require('./publication-scan');
const { preparePublicationOffThread, scanWorker } = require('./publication-scan-host');

const join = (...parts) => parts.join('');
const STRIPE = join('sk_live_', '51HqLyjWDarjtT1zdp7dc9a');

// A JPEG with an EXIF segment, so the worker's stripped bytes differ from the input.
function jpegWithExif() {
  const exif = Buffer.concat([Buffer.from([0xff, 0xe1, 0x00, 0x10]), Buffer.from('Exif\0\0GPSDATA!!', 'latin1')]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), exif, Buffer.from([0xff, 0xd9])]);
}

function folder() {
  return {
    kind: 'folder',
    name: 'site',
    sourceType: 'workspace',
    excluded: [{ path: 'node_modules', reason: 'Dependency folder' }],
    files: [
      { path: 'index.html', bytes: Buffer.from('<p>hello</p>') },
      { path: 'app.js', bytes: Buffer.from(`const k = "${STRIPE}";\n//# sourceMappingURL=app.js.map\n`) },
      { path: 'photo.jpg', bytes: jpegWithExif() },
      { path: '.DS_Store', bytes: Buffer.from('x') },
    ],
  };
}

afterEach(() => scanWorker.resetForTest());
afterAll(() => scanWorker.stop());

describe('preparePublicationOffThread', () => {
  test('a scan run in the worker matches one run in place: same findings, Buffers, frozen', async () => {
    const run = jest.spyOn(scanWorker, 'run');
    const scan = await preparePublicationOffThread(folder());
    const local = preparePublication(folder());
    expect(run).toHaveBeenCalledTimes(1);
    run.mockRestore();
    expect(scan.findings).toEqual(local.findings);
    expect(scan.excluded).toEqual(local.excluded);
    expect(scan.stripped).toEqual(local.stripped);
    expect(scan.source.files.map(file => file.path)).toEqual(local.source.files.map(file => file.path));
    for (const [index, file] of scan.source.files.entries()) {
      expect(Buffer.isBuffer(file.bytes)).toBe(true);
      expect(file.bytes.equals(local.source.files[index].bytes)).toBe(true);
      expect(Object.isFrozen(file)).toBe(true);
    }
    expect(scan.source.bytes).toBe(local.source.bytes);
    for (const value of [scan, scan.source, scan.source.files, scan.findings, scan.findings[0], scan.excluded, scan.stripped]) {
      expect(Object.isFrozen(value)).toBe(true);
    }

    const file = await preparePublicationOffThread({ kind: 'file', name: 'photo.jpg', data: jpegWithExif() });
    expect(Buffer.isBuffer(file.source.data)).toBe(true);
    expect(file.source.data.equals(preparePublication({ kind: 'file', name: 'photo.jpg', data: jpegWithExif() }).source.data)).toBe(true);

    const text = await preparePublicationOffThread({ kind: 'text', name: 'Text', text: `key ${STRIPE}` });
    expect(text.findings.map(finding => finding.rule)).toEqual(['stripe-secret-key']);
  });

  test('coded refusals keep their code across the thread', async () => {
    await expect(preparePublicationOffThread({ kind: 'folder', name: 'x', files: [{ path: '.DS_Store', bytes: Buffer.from('x') }] }))
      .rejects.toMatchObject({ code: 'PUBLICATION_EMPTY' });
  });

  test('the main thread stays free while a large publication is scanned', async () => {
    // ~24 MiB of text with a credential at the very end.
    const big = Buffer.concat([Buffer.alloc(24 * 1024 * 1024, 'lorem ipsum DE89 dolor\n'), Buffer.from(`\nk = "${STRIPE}"\n`)]);
    await preparePublicationOffThread({ kind: 'text', name: 'warm', text: 'warm up' }); // worker start is not the point
    let ticks = 0;
    let longestGap = 0;
    let last = Date.now();
    const timer = setInterval(() => {
      const now = Date.now();
      longestGap = Math.max(longestGap, now - last);
      last = now;
      ticks++;
    }, 10);
    const started = Date.now();
    const scan = await preparePublicationOffThread({ kind: 'file', name: 'big.txt', data: big });
    const elapsed = Date.now() - started;
    clearInterval(timer);
    expect(scan.findings.map(finding => finding.rule)).toContain('stripe-secret-key');
    // On the main thread the timer could not fire at all until the scan ended.
    expect(ticks).toBeGreaterThan(3);
    expect(longestGap).toBeLessThan(elapsed);
  }, 60_000);

  test('a worker that cannot run falls back to the main thread', async () => {
    const worker = { run: jest.fn().mockRejectedValue(new TaskWorkerUnavailable('worker disabled')) };
    const scan = await preparePublicationOffThread({ kind: 'text', name: 'Text', text: `key ${STRIPE}` }, { worker });
    expect(scan.findings.map(finding => finding.rule)).toEqual(['stripe-secret-key']);
    await expect(preparePublicationOffThread({ kind: 'folder', name: 'x', files: [{ path: 'Thumbs.db', bytes: Buffer.from('x') }] }, { worker }))
      .rejects.toMatchObject({ code: 'PUBLICATION_EMPTY' });
  });

  test('a scan that times out fails instead of rerunning on the main thread', async () => {
    const worker = { run: jest.fn().mockRejectedValue(new TaskWorkerTimeout('PublicationScan prepare timed out')) };
    await expect(preparePublicationOffThread({ kind: 'text', name: 'Text', text: 'hello' }, { worker }))
      .rejects.toThrow(/did not finish in time/);
  });

  test('the caller signal reaches the worker', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(preparePublicationOffThread({ kind: 'text', name: 'Text', text: 'hello' }, { signal: controller.signal }))
      .rejects.toMatchObject({ name: 'AbortError' });
  });
});
