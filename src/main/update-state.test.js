const {
  STATUS,
  UNSUPPORTED_REASON,
  initialState,
  reduceUpdateState,
  describeUpdateState,
  canCheckForUpdates,
  classifyUpdaterError,
} = require('./update-state');

const NOW = 1_760_000_000_000;
const now = () => NOW;

function run(
  events,
  start = reduceUpdateState(initialState({ currentVersion: '0.8.7' }), { type: 'supported' })
) {
  return events.reduce((state, event) => reduceUpdateState(state, event, { now }), start);
}

describe('update state machine (#87)', () => {
  test('starts unsupported/inactive until the updater says otherwise', () => {
    const state = initialState({ currentVersion: '0.8.7' });
    expect(state).toMatchObject({
      status: STATUS.UNSUPPORTED,
      reason: UNSUPPORTED_REASON.INACTIVE,
      currentVersion: '0.8.7',
      lastChecked: null,
    });
    expect(canCheckForUpdates(state)).toBe(false);
    expect(reduceUpdateState(state, { type: 'supported' })).toMatchObject({
      status: STATUS.IDLE,
      reason: null,
    });
  });

  test('a check that finds nothing ends up-to-date and stamps lastChecked', () => {
    const checking = run([{ type: 'checking' }]);
    expect(checking.status).toBe(STATUS.CHECKING);
    expect(canCheckForUpdates(checking)).toBe(false);

    const done = run([{ type: 'checking' }, { type: 'not-available' }]);
    expect(done).toMatchObject({ status: STATUS.UP_TO_DATE, lastChecked: NOW });
    expect(canCheckForUpdates(done)).toBe(true);
  });

  test('available → progress → downloaded walks to ready', () => {
    const available = run([{ type: 'checking' }, { type: 'available', version: '0.9.0' }]);
    expect(available).toMatchObject({
      status: STATUS.DOWNLOADING,
      version: '0.9.0',
      percent: 0,
      lastChecked: NOW,
    });

    const progress = reduceUpdateState(available, {
      type: 'progress',
      percent: 42.4,
      bytesPerSecond: 2048,
      transferred: 4200,
      total: 10000,
    });
    expect(progress).toMatchObject({
      status: STATUS.DOWNLOADING,
      version: '0.9.0',
      percent: 42.4,
      bytesPerSecond: 2048,
      transferred: 4200,
      total: 10000,
    });
    expect(describeUpdateState(progress)).toBe('Downloading Freedom 0.9.0… 42%');

    const ready = reduceUpdateState(progress, { type: 'downloaded', version: '0.9.0' });
    expect(ready).toMatchObject({
      status: STATUS.READY,
      version: '0.9.0',
      percent: 100,
      bytesPerSecond: null,
    });
    expect(canCheckForUpdates(ready)).toBe(false);
    expect(describeUpdateState(ready)).toBe('Freedom 0.9.0 is ready to install.');
  });

  test('the idle line follows the auto-update switch', () => {
    const idle = { ...initialState(), status: STATUS.IDLE, reason: null };
    expect(describeUpdateState(idle)).toBe('Freedom checks for updates automatically.');
    expect(describeUpdateState(idle, { autoCheck: true })).toBe(
      'Freedom checks for updates automatically.'
    );
    expect(describeUpdateState(idle, { autoCheck: false })).toBe(
      'Automatic update checks are off.'
    );
  });

  test('progress is clamped and non-numeric fields are dropped', () => {
    const state = run([
      { type: 'available', version: '0.9.0' },
      { type: 'progress', percent: 140, bytesPerSecond: 'fast', total: -1 },
    ]);
    expect(state).toMatchObject({ percent: 100, bytesPerSecond: null, total: null });
    expect(run([{ type: 'progress', percent: Number.NaN }]).percent).toBe(0);
  });

  test('checking-for-update during a running download keeps the progress', () => {
    const downloading = run([
      { type: 'available', version: '0.9.0' },
      { type: 'progress', percent: 30 },
    ]);
    expect(reduceUpdateState(downloading, { type: 'checking' })).toBe(downloading);
  });

  test('ready is sticky against later checks, "no update" answers and errors', () => {
    const ready = run([
      { type: 'available', version: '0.9.0' },
      { type: 'downloaded', version: '0.9.0' },
    ]);
    for (const event of [
      { type: 'checking' },
      { type: 'not-available' },
      { type: 'error', kind: 'network' },
      { type: 'progress', percent: 10 },
      { type: 'available', version: '0.9.0' },
      { type: 'unsupported', reason: UNSUPPORTED_REASON.NOT_OWNER },
    ]) {
      expect(reduceUpdateState(ready, event, { now })).toBe(ready);
    }
  });

  test('a newer release than the staged one downloads again', () => {
    const ready = run([
      { type: 'available', version: '0.9.0' },
      { type: 'downloaded', version: '0.9.0' },
    ]);
    const newer = reduceUpdateState(ready, { type: 'available', version: '0.9.1' }, { now });
    expect(newer).toMatchObject({ status: STATUS.DOWNLOADING, version: '0.9.1', percent: 0 });
  });

  test('status sentences never name a surface-specific control', () => {
    // main's sentence is shown both in Settings → Updates ("Check now") and as
    // the hamburger row's tooltip ("Check for Updates…"), so it must name
    // neither button.
    const states = [
      run([]),
      run([{ type: 'checking' }, { type: 'error', kind: 'network' }]),
      run([{ type: 'checking' }, { type: 'error', kind: 'other' }]),
      run([
        { type: 'available', version: '0.9.0' },
        { type: 'error', kind: 'other' },
      ]),
      run([{ type: 'not-available' }]),
    ];
    for (const state of states) {
      for (const autoCheck of [true, false]) {
        const message = describeUpdateState(state, { autoCheck });
        expect(message).not.toMatch(/check now|check for updates/i);
      }
    }
  });

  test('errors carry a fixed kind, never the raw message', () => {
    const network = run([{ type: 'checking' }, { type: 'error', kind: 'network' }]);
    expect(network).toMatchObject({ status: STATUS.ERROR, error: 'network' });
    expect(describeUpdateState(network)).toBe(
      "Couldn't reach the update server. Freedom will try again later."
    );
    // With background checks off nothing retries on its own.
    expect(describeUpdateState(network, { autoCheck: false })).toBe(
      "Couldn't reach the update server. Automatic checks are off, so Freedom won't retry on its own."
    );
    expect(canCheckForUpdates(network)).toBe(true);

    const download = run([
      { type: 'available', version: '0.9.0' },
      { type: 'progress', percent: 50 },
      { type: 'error', kind: 'other', message: '/home/me/secret path' },
    ]);
    expect(download).toMatchObject({ status: STATUS.ERROR, error: 'download', percent: null });
    expect(JSON.stringify(download)).not.toContain('secret');

    // A failed check keeps the last successful check's time.
    const checked = run([{ type: 'not-available' }]);
    const failed = reduceUpdateState(checked, { type: 'error', kind: 'other' });
    expect(failed).toMatchObject({ error: 'check', lastChecked: NOW });
  });

  test('unsupported swallows check events and names its reason', () => {
    const state = run([{ type: 'unsupported', reason: UNSUPPORTED_REASON.DEVELOPMENT }]);
    expect(state).toMatchObject({ status: STATUS.UNSUPPORTED, reason: 'development' });
    for (const event of [
      { type: 'checking' },
      { type: 'available', version: '1.0.0' },
      { type: 'progress', percent: 5 },
      { type: 'not-available' },
      { type: 'error', kind: 'network' },
    ]) {
      expect(reduceUpdateState(state, event, { now })).toBe(state);
    }
    expect(describeUpdateState(state)).toBe('Updates are off in development builds.');
    // An unknown reason falls back to the generic build reason.
    expect(run([{ type: 'unsupported', reason: 'bogus' }]).reason).toBe(UNSUPPORTED_REASON.BUILD);
  });

  test('every unsupported reason has its own copy', () => {
    const messages = Object.values(UNSUPPORTED_REASON).map((reason) =>
      describeUpdateState({ status: STATUS.UNSUPPORTED, reason })
    );
    expect(new Set(messages).size).toBe(messages.length);
  });

  test('unknown events leave the state untouched', () => {
    const state = run([]);
    expect(reduceUpdateState(state, { type: 'nope' })).toBe(state);
    expect(reduceUpdateState(state, null)).toBe(state);
  });

  test('classifyUpdaterError maps the updater errors updater.js used to swallow', () => {
    expect(
      classifyUpdaterError(new Error('ENOENT: no such file, open /x/resources/app-update.yml'))
    ).toEqual({ type: 'unsupported', reason: UNSUPPORTED_REASON.BUILD });
    expect(classifyUpdaterError(new Error('net::ERR_INTERNET_DISCONNECTED'))).toEqual({
      type: 'error',
      kind: 'network',
    });
    expect(classifyUpdaterError(new Error('getaddrinfo ENOTFOUND freedom.baby'))).toEqual({
      type: 'error',
      kind: 'network',
    });
    expect(classifyUpdaterError(new Error('sha512 checksum mismatch'))).toEqual({
      type: 'error',
      kind: 'other',
    });
  });
});
