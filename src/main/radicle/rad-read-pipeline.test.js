/**
 * A `rad:` read end to end in main (R-3, #948 round 1): the protocol
 * handler, its admission, the real serving pipeline (radicle-api-protocol)
 * and radicle-embedded, over a scripted add-on. A read that has ended for
 * its page (navigated away, or past its run time) keeps its slot until the
 * add-on call it is in returns, and then starts no further call.
 */
jest.mock('../logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../radicle-manager', () => ({ isDisabledForProfile: jest.fn(() => false) }));

const fs = require('fs');
const os = require('os');
const path = require('path');

const RID = 'z3gqcJUoA1n9HaHKufZs5FCSGazv5';
const REVISION = '0123456789abcdef0123456789abcdef01234567';
const BLOB_URL = `rad://${RID}/blob/${REVISION}/big.bin`;

const deferred = () => {
  let resolve;
  const promise = new Promise((res) => {
    resolve = res;
  });
  return { promise, resolve };
};
const flush = async () => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
};

let dir;
let rad;
let fake;

beforeEach(() => {
  // The add-on's reads come from `global.__radicleFake`.
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rad-pipeline-'));
  const addon = path.join(dir, 'libradicle.node.js');
  const { RADICLE_ADDON_REQUIRED_EXPORTS } = require('../../shared/radicle-addon-version');
  fs.writeFileSync(
    addon,
    `module.exports = {${RADICLE_ADDON_REQUIRED_EXPORTS.map(
      (name) => `${name}: (...args) => global.__radicleFake.${name}(...args),`
    ).join('')}};`
  );
  process.env.FREEDOM_RADICLE_ADDON = addon;
  fake = Object.fromEntries(
    RADICLE_ADDON_REQUIRED_EXPORTS.map((name) => [name, jest.fn(async () => '{}')])
  );
  global.__radicleFake = fake;
});

// Loaded per test, after any fake timers: the admission takes its timers
// when it is made.
function load() {
  jest.isolateModules(() => {
    rad = require('./rad-protocol');
  });
}

afterEach(() => {
  jest.useRealTimers();
  delete global.__radicleFake;
  delete process.env.FREEDOM_RADICLE_ADDON;
  fs.rmSync(dir, { recursive: true, force: true });
});

// A tagged request, as onBeforeSendHeaders hands it to the handler.
function read(webSession, id, url = BLOB_URL) {
  const { requestHeaders } = rad.tagRadRequest(
    { id, url, webContentsId: 7, requestHeaders: {} },
    { session: webSession }
  );
  return rad.handleRadRequest(
    { url, method: 'GET', headers: new Headers(requestHeaders) },
    { webSession }
  );
}

// The visibility read is held, so the read is running when it ends.
function holdRepoInfo() {
  const visibility = deferred();
  fake.repoInfo.mockImplementation(() => visibility.promise);
  fake.blobAt.mockImplementation(async () => '{"content":"x"}');
  return () => visibility.resolve(JSON.stringify({ visibility: { type: 'public' } }));
}

test('a read whose page went away starts no further add-on call', async () => {
  load();
  const webSession = {};
  const release = holdRepoInfo();
  const reading = read(webSession, 1);
  await flush();
  expect(fake.repoInfo).toHaveBeenCalledTimes(1);

  rad.endRadRequest({ id: 1, url: BLOB_URL, error: 'net::ERR_ABORTED' }, { session: webSession });
  expect((await reading).status).toBe(503);

  release();
  await flush();
  expect(fake.blobAt).not.toHaveBeenCalled();
});

test('a read past its run time starts no further add-on call', async () => {
  jest.useFakeTimers();
  load();
  const webSession = {};
  const release = holdRepoInfo();
  const reading = read(webSession, 2);
  await flush();
  expect(fake.repoInfo).toHaveBeenCalledTimes(1);

  jest.advanceTimersByTime(30_000);
  expect((await reading).status).toBe(504);

  release();
  await flush();
  expect(fake.blobAt).not.toHaveBeenCalled();
});

test('an ended read keeps its slot until its add-on call returns, then frees it', async () => {
  load();
  const webSession = {};
  const visibility = [deferred(), deferred(), deferred()];
  let calls = 0;
  fake.repoInfo.mockImplementation(() => visibility[calls++].promise);
  const first = read(webSession, 10);
  const second = read(webSession, 11);
  const third = read(webSession, 12, `rad://${RID}`);
  await flush();
  // Two run; the third waits for a slot.
  expect(fake.repoInfo).toHaveBeenCalledTimes(2);

  rad.endRadRequest({ id: 10, url: BLOB_URL, error: 'net::ERR_ABORTED' }, { session: webSession });
  expect((await first).status).toBe(503);
  await flush();
  // The ended read's add-on call is still running: its slot is still taken.
  expect(fake.repoInfo).toHaveBeenCalledTimes(2);

  visibility[0].resolve(JSON.stringify({ visibility: { type: 'public' } }));
  await flush();
  // Its call returned: the slot goes to the third read, and the ended read
  // started nothing more.
  expect(fake.repoInfo).toHaveBeenCalledTimes(3);
  expect(fake.blobAt).not.toHaveBeenCalled();
  rad.endRadRequest({ id: 11, url: BLOB_URL, error: 'net::ERR_ABORTED' }, { session: webSession });
  rad.endRadRequest({ id: 12, url: `rad://${RID}`, error: 'net::ERR_ABORTED' }, { session: webSession });
  await Promise.all([second, third]);
  visibility[1].resolve(JSON.stringify({ visibility: { type: 'public' } }));
  visibility[2].resolve(JSON.stringify({ visibility: { type: 'public' } }));
  await flush();
  expect(fake.blobAt).not.toHaveBeenCalled();
});

test('an add-on reply over the cap is refused before main parses it', async () => {
  load();
  fake.repoInfo.mockImplementation(async () => JSON.stringify({ visibility: { type: 'public' } }));
  const reply = `[${'{"title":"x"},'.repeat(10)}{"title":"y"}]`;
  fake.issues.mockImplementation(async () => reply);
  const { serveRepoApi } = require('../radicle-api-protocol');
  const parse = jest.spyOn(JSON, 'parse');
  try {
    const response = await serveRepoApi(`rad:${RID}`, '/issues', {
      maxResponseChars: reply.length - 1,
    });
    expect(response.status).toBe(502);
    expect(parse.mock.calls.some(([text]) => text === reply)).toBe(false);
  } finally {
    parse.mockRestore();
  }
});
