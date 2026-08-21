/**
 * seed-status tests — drive the tracker with a stub `rad` executable and a
 * real temp RAD_HOME so storage checks, process spawning, kill timers, and
 * log parsing run for real.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

jest.mock('../logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const seedStatus = require('./seed-status');

const RID = 'rad:z371PVmDHdjJucejRoRYJcDEvD5pp';

let radHome;

/** Write an executable stub that plays the role of `rad`. */
function stubRad(script) {
  const bin = path.join(radHome, 'rad-stub');
  fs.writeFileSync(bin, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  return bin;
}

/** Stub whose sync attempt "lands" the repo in storage. */
function fetchingStub(extra = '') {
  // $5 is the RID argument (sync --fetch --timeout <n>sec <rid>).
  return stubRad(
    'echo "Fetching $5 from the network, found 7 potential seed(s)."\n' +
      `${extra}mkdir -p "$RAD_HOME/storage/$(echo "$5" | sed 's/^rad://')"`
  );
}

/** Stub whose sync attempt never lands the repo. */
function failingStub() {
  return stubRad('echo "Fetching $5 from the network, found 2 potential seed(s)."');
}

beforeEach(() => {
  radHome = fs.mkdtempSync(path.join(os.tmpdir(), 'seed-status-'));
  fs.mkdirSync(path.join(radHome, 'storage'));
});

afterEach(() => {
  seedStatus._reset();
  fs.rmSync(radHome, { recursive: true, force: true });
});

test('unknown repo reports idle', () => {
  expect(seedStatus.getStatus(RID, radHome)).toMatchObject({
    state: 'idle',
    inStorage: false,
    seedersKnown: null,
  });
});

test('repo already in storage reports fetched without any tracking', () => {
  fs.mkdirSync(path.join(radHome, 'storage', RID.replace('rad:', '')));
  expect(seedStatus.getStatus(RID, radHome)).toMatchObject({
    state: 'fetched',
    inStorage: true,
  });
});

test('fresh leftover .tmp without a record reports fetching (node background fetch)', () => {
  fs.mkdirSync(path.join(radHome, 'storage', `${RID.replace('rad:', '')}.tmp`));
  expect(seedStatus.getStatus(RID, radHome)).toMatchObject({
    state: 'fetching',
    inStorage: false,
  });
});

test('stale .tmp (crashed fetch debris) reports idle, not perpetual fetching', () => {
  const tmpDir = path.join(radHome, 'storage', `${RID.replace('rad:', '')}.tmp`);
  fs.mkdirSync(tmpDir);
  const old = new Date(Date.now() - 60 * 60 * 1000);
  fs.utimesSync(tmpDir, old, old);
  expect(seedStatus.getStatus(RID, radHome).state).toBe('idle');
});

test('successful fetch: parses seeder count and transitions to fetched', async () => {
  const record = seedStatus.startFetch(RID, { radBin: fetchingStub(), radHome });
  expect(seedStatus.getStatus(RID, radHome).state).toBe('fetching');
  await record.done;
  expect(seedStatus.getStatus(RID, radHome)).toMatchObject({
    state: 'fetched',
    inStorage: true,
    seedersKnown: 7,
  });
});

test('failed fetch: exhausts retries, surfaces node-log per-seed error', async () => {
  const record = seedStatus.startFetch(RID, {
    radBin: failingStub(),
    radHome,
    maxAttempts: 2,
    retryDelayMs: 10,
  });
  seedStatus.noteNodeOutput(
    `2026-07-07T13:40:06 WARN service Fetch failed for ${RID} from z6MkAbc: ` +
      'gix fetch error: Failed to consume the pack sent by the remote\n'
  );
  await record.done;
  const status = seedStatus.getStatus(RID, radHome);
  expect(status.state).toBe('failed');
  expect(status.seedersKnown).toBe(2);
  expect(status.lastError).toContain('Failed to consume the pack');
  expect(status.recentAttempts).toEqual([expect.objectContaining({ nid: 'z6MkAbc', ok: false })]);
});

test('isolated node ("no candidate seeds" on stderr) reports zero seeders', async () => {
  const record = seedStatus.startFetch(RID, {
    radBin: stubRad('echo "Error: no candidate seeds were found to fetch from" >&2\nexit 1'),
    radHome,
    maxAttempts: 1,
  });
  await record.done;
  const status = seedStatus.getStatus(RID, radHome);
  expect(status.state).toBe('failed');
  expect(status.seedersKnown).toBe(0);
  expect(status.lastError).toContain('No seeds');
});

test('failed fetch without node-log detail gets a generic reason', async () => {
  const record = seedStatus.startFetch(RID, {
    radBin: failingStub(),
    radHome,
    maxAttempts: 1,
  });
  await record.done;
  expect(seedStatus.getStatus(RID, radHome).lastError).toContain('retry budget');
});

test('node background success promotes a failed record once storage appears', async () => {
  const record = seedStatus.startFetch(RID, {
    radBin: failingStub(),
    radHome,
    maxAttempts: 1,
  });
  await record.done;
  expect(seedStatus.getStatus(RID, radHome).state).toBe('failed');

  seedStatus.noteNodeOutput(`INFO service Fetched ${RID} from z6MkDef successfully\n`);
  fs.mkdirSync(path.join(radHome, 'storage', RID.replace('rad:', '')));
  expect(seedStatus.getStatus(RID, radHome)).toMatchObject({
    state: 'fetched',
    inStorage: true,
  });
});

test('"peer fetched from us" log lines are ignored', () => {
  seedStatus.startFetch(RID, { radBin: failingStub(), radHome, maxAttempts: 1 });
  seedStatus.noteNodeOutput(`INFO wire Peer z6MkGhi fetched ${RID} from us successfully\n`);
  expect(seedStatus.getStatus(RID, radHome).attemptCount).toBe(0);
});

test('untracked repos in log lines are ignored', () => {
  seedStatus.noteNodeOutput(
    'WARN service Fetch failed for rad:zUntracked111 from z6MkJkl: some error\n'
  );
  expect(seedStatus.getStatus('rad:zUntracked111', radHome).state).toBe('idle');
});

test('cancelFetch kills the driver and clears tracking', async () => {
  const record = seedStatus.startFetch(RID, { radBin: stubRad('exec sleep 30'), radHome });
  seedStatus.cancelFetch(RID);
  await record.done;
  expect(seedStatus.getStatus(RID, radHome).state).toBe('idle');
});

test('hanging sync attempt is hard-killed and counts as failed', async () => {
  const record = seedStatus.startFetch(RID, {
    radBin: stubRad('exec sleep 30'),
    radHome,
    maxAttempts: 1,
    killMs: 150,
  });
  await record.done;
  expect(seedStatus.getStatus(RID, radHome).state).toBe('failed');
}, 10000);

// A spawn failure emits 'error' and never 'exit'. If the attempt promise
// doesn't settle there, the record is wedged at 'fetching' forever and
// startFetch's idempotency guard blocks the retry path permanently.
test('unspawnable rad binary fails the fetch instead of hanging at fetching', async () => {
  const record = seedStatus.startFetch(RID, {
    radBin: path.join(radHome, 'does-not-exist'),
    radHome,
    maxAttempts: 2,
    retryDelayMs: 10,
  });
  await record.done;
  const status = seedStatus.getStatus(RID, radHome);
  expect(status.state).toBe('failed');
  expect(status.lastError).toContain('ENOENT');

  // ...and the failed record is retryable, unlike a wedged 'fetching' one.
  const retry = seedStatus.startFetch(RID, { radBin: fetchingStub(), radHome });
  expect(retry).not.toBe(record);
  await retry.done;
  expect(seedStatus.getStatus(RID, radHome).state).toBe('fetched');
}, 10000);

test('startFetch is idempotent while fetching, restarts after failure', async () => {
  const slow = stubRad('sleep 1');
  const first = seedStatus.startFetch(RID, { radBin: slow, radHome, maxAttempts: 1, killMs: 200 });
  const second = seedStatus.startFetch(RID, { radBin: slow, radHome });
  expect(second).toBe(first);
  await first.done;
  expect(seedStatus.getStatus(RID, radHome).state).toBe('failed');

  const third = seedStatus.startFetch(RID, { radBin: fetchingStub(), radHome });
  expect(third).not.toBe(first);
  await third.done;
  expect(seedStatus.getStatus(RID, radHome).state).toBe('fetched');
}, 10000);
