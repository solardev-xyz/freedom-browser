const fs = require('fs');
const os = require('os');
const path = require('path');
const { createPrivacyScope } = require('../networks/privacy-context');
const { runPrivacyWorker } = require('./privacy-worker');
let scope, handle, filename;
beforeEach(() => {
  scope = createPrivacyScope({ profileId: 'worker-fixture', signal: new AbortController().signal });
  handle = scope.getContext({ kind: 'private-account', principal: 'fixture', protocol: 'ppv2-fixture', deployment: 'sepolia-fixture', role: 'prover', chainId: 11155111 });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'privacy-worker-fixture-'));
  filename = path.join(directory, 'worker.cjs');
  fs.writeFileSync(filename, `
    const { parentPort, workerData } = require('worker_threads');
    if (workerData.mode === 'throw') throw new Error('sensitive fixture data');
    if (workerData.mode === 'exit') process.exit(0);
    if (workerData.mode === 'busy') {
      const state = new Int32Array(workerData.shared);
      Atomics.store(state, 0, 1);
      while (true) Atomics.add(state, 1, 1);
    }
    parentPort.postMessage({ value: 42, environmentKeys: Object.keys(process.env) });
  `);
});
afterEach(() => scope.close());

test('a real worker returns a result, receives no inherited environment and terminates', async () => {
  await expect(runPrivacyWorker({ handle, filename, workerData: { mode: 'result' } }))
    .resolves.toEqual({ value: 42, environmentKeys: [] });
});

test.each(['throw', 'exit'])('worker %s is a fixed diagnostic with no runtime details', async (mode) => {
  await expect(runPrivacyWorker({ handle, filename, workerData: { mode } })).rejects.toMatchObject({ code: 'PRIVATE_WORKER_FAILED' });
});

test.each(['lock', 'caller', 'deadline'])('%s terminates a CPU-bound worker that ignores cooperative abort', async (mode) => {
  const shared = new SharedArrayBuffer(8);
  const state = new Int32Array(shared);
  const controller = new AbortController();
  const task = runPrivacyWorker({ handle, filename, workerData: { mode: 'busy', shared }, signal: controller.signal,
    timeoutMs: mode === 'deadline' ? 300 : 3000 });
  const checked = expect(task).rejects.toMatchObject({ code: mode === 'lock' ? 'PRIVACY_CONTEXT_REVOKED' : 'PRIVACY_REQUEST_ABORTED' });
  const start = Date.now();
  while (Atomics.load(state, 0) === 0 && Date.now() - start < 2500) await new Promise((resolve) => setTimeout(resolve, 5));
  expect(Atomics.load(state, 0)).toBe(1);
  if (mode === 'lock') scope.close();
  if (mode === 'caller') controller.abort();
  await checked;
  const after = Atomics.load(state, 1);
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(Atomics.load(state, 1)).toBe(after);
});

test('capacity and lifetime checks happen before more workers can start', async () => {
  const controller = new AbortController();
  const args = { handle, filename, workerData: { mode: 'busy', shared: new SharedArrayBuffer(8) }, signal: controller.signal };
  const running = [runPrivacyWorker(args), runPrivacyWorker(args)];
  const settled = Promise.allSettled(running);
  expect(() => runPrivacyWorker(args)).toThrow(expect.objectContaining({ code: 'PRIVATE_WORKER_BUSY' }));
  controller.abort();
  expect((await settled).every((result) => result.status === 'rejected')).toBe(true);
  await expect(runPrivacyWorker({ handle, filename, workerData: { mode: 'result' } })).resolves.toMatchObject({ value: 42 });
});
