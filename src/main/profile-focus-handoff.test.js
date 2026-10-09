const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const {
  getProfileFocusPaths,
  readProfileFocusAck,
  requestProfileFocusAsyncAwait,
  requestProfileFocusSync,
  startProfileFocusRequestWatcher,
} = require('./profile-focus-handoff');

function makeTempProfile(id = 'default') {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-profile-focus-'));
  return {
    id,
    displayName: id === 'default' ? 'Default' : id,
    userDataDir,
  };
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

async function waitFor(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const result = predicate();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Timed out waiting for condition');
}

describe('profile focus handoff', () => {
  let tempDirs = [];
  let watchers = [];

  afterEach(() => {
    watchers.forEach((watcher) => watcher.stop());
    watchers = [];
    tempDirs.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true }));
    tempDirs = [];
  });

  function trackProfile(profile) {
    tempDirs.push(profile.userDataDir);
    return profile;
  }

  function trackWatcher(watcher) {
    watchers.push(watcher);
    return watcher;
  }

  test('writes a focus request and reports no acknowledgement when no process responds', () => {
    const profile = trackProfile(makeTempProfile('work'));
    const paths = getProfileFocusPaths(profile);

    const result = requestProfileFocusSync(profile, {
      nonce: 'focus-1',
      timeoutMs: 20,
      pollIntervalMs: 5,
    });

    expect(result).toEqual({
      ok: false,
      requestWritten: true,
      error: 'The running profile did not respond',
      nonce: 'focus-1',
    });
    expect(readJson(paths.requestPath)).toMatchObject({
      type: 'focus-window',
      nonce: 'focus-1',
      profileId: 'work',
    });
  });

  test('a focus request carries the URLs a second launch was given (#597)', () => {
    const profile = trackProfile(makeTempProfile('work'));
    const paths = getProfileFocusPaths(profile);

    requestProfileFocusSync(profile, {
      nonce: 'focus-urls',
      timeoutMs: 20,
      pollIntervalMs: 5,
      urls: ['freedom://settings', 'https://freedombrowser.eth.limo/'],
    });

    expect(readJson(paths.requestPath)).toMatchObject({
      type: 'focus-window',
      nonce: 'focus-urls',
      urls: ['freedom://settings', 'https://freedombrowser.eth.limo/'],
    });
  });

  test('a focus request without URLs carries no urls field', () => {
    const profile = trackProfile(makeTempProfile('work'));
    const paths = getProfileFocusPaths(profile);

    requestProfileFocusSync(profile, {
      nonce: 'focus-no-urls',
      timeoutMs: 20,
      pollIntervalMs: 5,
      urls: [],
    });

    expect(readJson(paths.requestPath)).not.toHaveProperty('urls');
  });

  test('focus watcher passes the request, URLs included, to its handler (#597)', async () => {
    const profile = trackProfile(makeTempProfile('work'));
    const paths = getProfileFocusPaths(profile);
    const onFocusWindow = jest.fn().mockResolvedValue(undefined);
    trackWatcher(startProfileFocusRequestWatcher(profile, onFocusWindow, { pollIntervalMs: 10 }));

    fs.writeFileSync(
      paths.requestPath,
      JSON.stringify({
        type: 'focus-window',
        nonce: 'focus-urls-watch',
        profileId: 'work',
        requestedAtMs: Date.now(),
        urls: ['bzz://ab12cd34/'],
      }),
      'utf-8'
    );

    await waitFor(() => fs.existsSync(paths.ackPath));

    expect(onFocusWindow).toHaveBeenCalledWith(
      expect.objectContaining({ nonce: 'focus-urls-watch', urls: ['bzz://ab12cd34/'] })
    );
  });

  test('async-await focus request resolves ok once the watcher acks', async () => {
    const profile = trackProfile(makeTempProfile('work'));
    const onFocusWindow = jest.fn().mockResolvedValue(undefined);
    trackWatcher(startProfileFocusRequestWatcher(profile, onFocusWindow, { pollIntervalMs: 10 }));

    const result = await requestProfileFocusAsyncAwait(profile, {
      nonce: 'focus-await-1',
      pollIntervalMs: 10,
      timeoutMs: 1000,
    });

    expect(result).toEqual({
      ok: true,
      requestWritten: true,
      error: null,
      nonce: 'focus-await-1',
    });
    expect(onFocusWindow).toHaveBeenCalledTimes(1);
  });

  test('async-await focus request reports timedOut when no process responds', async () => {
    const profile = trackProfile(makeTempProfile('work'));

    const result = await requestProfileFocusAsyncAwait(profile, {
      nonce: 'focus-await-2',
      pollIntervalMs: 5,
      timeoutMs: 20,
    });

    expect(result).toEqual({
      ok: false,
      requestWritten: true,
      timedOut: true,
      error: 'The running profile did not respond',
      nonce: 'focus-await-2',
    });
  });

  test('readProfileFocusAck returns the latest ack and null when none exists', () => {
    const profile = trackProfile(makeTempProfile('work'));
    const paths = getProfileFocusPaths(profile);

    expect(readProfileFocusAck(profile)).toBeNull();

    fs.writeFileSync(paths.ackPath, JSON.stringify({ nonce: 'n', ok: true, pid: 1234 }), 'utf-8');
    expect(readProfileFocusAck(profile)).toMatchObject({ nonce: 'n', ok: true, pid: 1234 });
  });

  test('focus watcher handles a fresh request and writes an acknowledgement', async () => {
    const profile = trackProfile(makeTempProfile('work'));
    const paths = getProfileFocusPaths(profile);
    const onFocusWindow = jest.fn().mockResolvedValue(undefined);
    trackWatcher(
      startProfileFocusRequestWatcher(profile, onFocusWindow, {
        pollIntervalMs: 10,
      })
    );

    fs.writeFileSync(
      paths.requestPath,
      JSON.stringify({
        type: 'focus-window',
        nonce: 'focus-2',
        profileId: 'work',
        requestedAtMs: Date.now(),
      }),
      'utf-8'
    );

    await waitFor(() => fs.existsSync(paths.ackPath));

    expect(onFocusWindow).toHaveBeenCalledTimes(1);
    expect(readJson(paths.ackPath)).toMatchObject({
      nonce: 'focus-2',
      ok: true,
      error: null,
    });
  });

  test('focus watcher ignores stale requests', async () => {
    const profile = trackProfile(makeTempProfile('work'));
    const paths = getProfileFocusPaths(profile);
    const onFocusWindow = jest.fn().mockResolvedValue(undefined);

    fs.writeFileSync(
      paths.requestPath,
      JSON.stringify({
        type: 'focus-window',
        nonce: 'old-focus',
        profileId: 'work',
        requestedAtMs: Date.now() - 2000,
      }),
      'utf-8'
    );

    trackWatcher(
      startProfileFocusRequestWatcher(profile, onFocusWindow, {
        pollIntervalMs: 10,
        maxRequestAgeMs: 100,
      })
    );

    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(onFocusWindow).not.toHaveBeenCalled();
    expect(fs.existsSync(paths.ackPath)).toBe(false);
  });

  // R1-F1 (#630): two launches of a running profile racing each other must each
  // get their own request handled and their own ack, not overwrite one another.
  function runRequester(profile, nonce, urls) {
    const script = `
      const { requestProfileFocusSync } = require(${JSON.stringify(require.resolve('./profile-focus-handoff'))});
      const result = requestProfileFocusSync(${JSON.stringify(profile)}, {
        nonce: ${JSON.stringify(nonce)},
        urls: ${JSON.stringify(urls)},
      });
      process.stdout.write(JSON.stringify(result));
    `;
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['-e', script], {
        stdio: ['ignore', 'pipe', 'inherit'],
      });
      let out = '';
      child.stdout.on('data', (chunk) => (out += chunk));
      child.on('error', reject);
      child.on('close', () => {
        try {
          resolve(JSON.parse(out));
        } catch (error) {
          reject(error);
        }
      });
    });
  }

  test('concurrent second launches each get their URLs opened and their own ack', async () => {
    const profile = trackProfile(makeTempProfile('work'));
    const seen = [];
    const onFocusWindow = jest.fn(async (request) => {
      seen.push(...(request.urls || []));
    });
    // Default (production) poll interval, so both requests land between polls.
    trackWatcher(startProfileFocusRequestWatcher(profile, onFocusWindow));

    const results = await Promise.all([
      runRequester(profile, 'launch-a', ['https://a.example/']),
      runRequester(profile, 'launch-b', ['https://b.example/']),
      runRequester(profile, 'launch-c', ['https://c.example/']),
    ]);

    expect(results.map((result) => result.ok)).toEqual([true, true, true]);
    expect(seen.sort()).toEqual(['https://a.example/', 'https://b.example/', 'https://c.example/']);
    expect(onFocusWindow).toHaveBeenCalledTimes(3);
    // Each requester collected its own request and ack.
    const paths = getProfileFocusPaths(profile);
    expect(fs.readdirSync(paths.requestDir)).toEqual([]);
    expect(fs.readdirSync(paths.ackDir)).toEqual([]);
  }, 15000);

  test('concurrent in-process requests are all acknowledged', async () => {
    const profile = trackProfile(makeTempProfile('work'));
    const onFocusWindow = jest.fn().mockResolvedValue(undefined);
    trackWatcher(startProfileFocusRequestWatcher(profile, onFocusWindow, { pollIntervalMs: 100 }));

    const results = await Promise.all(
      ['n1', 'n2', 'n3', 'n4'].map((nonce) =>
        requestProfileFocusAsyncAwait(profile, { nonce, pollIntervalMs: 10, timeoutMs: 2000 })
      )
    );

    expect(results.map((result) => result.ok)).toEqual([true, true, true, true]);
    expect(onFocusWindow).toHaveBeenCalledTimes(4);
  });

  test('a request seen both in its own file and the shared file is handled once', async () => {
    const profile = trackProfile(makeTempProfile('work'));
    const onFocusWindow = jest.fn().mockResolvedValue(undefined);

    const result = requestProfileFocusSync(profile, { nonce: 'dup', timeoutMs: 0 });
    expect(result.requestWritten).toBe(true);
    trackWatcher(startProfileFocusRequestWatcher(profile, onFocusWindow, { pollIntervalMs: 10 }));

    await waitFor(() => readProfileFocusAck(profile, 'dup'));
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(onFocusWindow).toHaveBeenCalledTimes(1);
  });

  test("readProfileFocusAck by nonce finds that request's own ack even after a newer one", () => {
    const profile = trackProfile(makeTempProfile('work'));
    const paths = getProfileFocusPaths(profile);
    fs.mkdirSync(paths.ackDir, { recursive: true });
    fs.writeFileSync(
      path.join(paths.ackDir, 'quit-1.json'),
      JSON.stringify({ nonce: 'quit-1', ok: true, pid: 77 })
    );
    fs.writeFileSync(paths.ackPath, JSON.stringify({ nonce: 'focus-9', ok: true, pid: 77 }));

    expect(readProfileFocusAck(profile, 'quit-1')).toMatchObject({ nonce: 'quit-1', pid: 77 });
    expect(readProfileFocusAck(profile, 'focus-9')).toMatchObject({ nonce: 'focus-9' });
    expect(readProfileFocusAck(profile, 'missing')).toBeNull();
    expect(readProfileFocusAck(profile, '../profile-focus-ack')).toBeNull();
  });

  test('a request whose nonce could escape the request directory is ignored', async () => {
    const profile = trackProfile(makeTempProfile('work'));
    const paths = getProfileFocusPaths(profile);
    const onFocusWindow = jest.fn().mockResolvedValue(undefined);
    fs.mkdirSync(paths.requestDir, { recursive: true });
    fs.writeFileSync(
      path.join(paths.requestDir, 'evil.json'),
      JSON.stringify({ type: 'focus-window', nonce: '../../evil', requestedAtMs: Date.now() })
    );
    trackWatcher(startProfileFocusRequestWatcher(profile, onFocusWindow, { pollIntervalMs: 10 }));

    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(onFocusWindow).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(profile.userDataDir, '..', 'evil.json'))).toBe(false);
  });

  test('stale request files are swept', async () => {
    const profile = trackProfile(makeTempProfile('work'));
    const paths = getProfileFocusPaths(profile);
    const onFocusWindow = jest.fn().mockResolvedValue(undefined);
    fs.mkdirSync(paths.requestDir, { recursive: true });
    const stale = path.join(paths.requestDir, 'old.json');
    fs.writeFileSync(
      stale,
      JSON.stringify({ type: 'focus-window', nonce: 'old', requestedAtMs: Date.now() - 5000 })
    );
    const past = new Date(Date.now() - 5000);
    fs.utimesSync(stale, past, past);
    trackWatcher(
      startProfileFocusRequestWatcher(profile, onFocusWindow, {
        pollIntervalMs: 10,
        maxRequestAgeMs: 100,
      })
    );

    await waitFor(() => !fs.existsSync(stale));
    expect(onFocusWindow).not.toHaveBeenCalled();
  });
});
