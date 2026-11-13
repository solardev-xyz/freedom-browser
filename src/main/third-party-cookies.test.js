const IPC = require('../shared/ipc-channels');

// Chromium's command line keeps one value per switch; a later append replaces it.
const fakeApp = (initial = {}) => {
  const values = new Map(Object.entries(initial));
  const switches = [];
  return {
    switches,
    values,
    commandLine: {
      appendSwitch: (name, value = '') => {
        switches.push(value === '' ? [name] : [name, value]);
        values.set(name, value);
      },
      getSwitchValue: (name) => values.get(name) ?? '',
      removeSwitch: (name) => values.delete(name),
    },
  };
};

// Fresh module per test: the launch state is module-level, as it is per launch.
const load = () => {
  let mod;
  jest.isolateModules(() => {
    mod = require('./third-party-cookies');
  });
  return mod;
};

describe('third-party cookies (#474)', () => {
  test('blocked unless the setting is exactly false', () => {
    const { blocksThirdPartyCookies } = load();
    expect(blocksThirdPartyCookies({ blockThirdPartyCookies: true })).toBe(true);
    expect(blocksThirdPartyCookies({ blockThirdPartyCookies: false })).toBe(false);
    // Missing or hand-edited values keep the default, never "allow".
    for (const settings of [
      {},
      null,
      undefined,
      { blockThirdPartyCookies: 'false' },
      { blockThirdPartyCookies: 0 },
    ]) {
      expect(blocksThirdPartyCookies(settings)).toBe(true);
    }
  });

  test('blocking appends the phase-out switch and records the launch', () => {
    const mod = load();
    const app = fakeApp();
    const logger = { info: jest.fn() };
    expect(mod.thirdPartyCookiesBlockedAtLaunch()).toBeNull();
    expect(
      mod.applyThirdPartyCookieBlocking(app, { blockThirdPartyCookies: true }, { logger })
    ).toBe(true);
    expect(app.switches).toEqual([['test-third-party-cookie-phaseout']]);
    expect(mod.BLOCK_THIRD_PARTY_COOKIES_SWITCH).toBe('test-third-party-cookie-phaseout');
    expect(mod.thirdPartyCookiesBlockedAtLaunch()).toBe(true);
    expect(logger.info).toHaveBeenCalledWith(
      '[cookies] third-party cookies blocked for this launch'
    );
  });

  // The switch blocks nothing while storage partitioning is disabled, as
  // Playwright's Electron launcher disables it.
  test('blocking takes storage partitioning out of a launcher-disabled feature list', () => {
    const mod = load();
    const logger = { info: jest.fn(), warn: jest.fn() };
    const app = fakeApp({
      'disable-features': 'PaintHolding,ThirdPartyStoragePartitioning,Translate',
    });
    mod.applyThirdPartyCookieBlocking(app, {}, { logger });
    expect(app.values.get('disable-features')).toBe('PaintHolding,Translate');
    expect(logger.warn).toHaveBeenCalledTimes(1);

    // Chromium reads `Name<Trial` and `*Name` as the same feature.
    const trial = fakeApp({
      'disable-features': 'PaintHolding,ThirdPartyStoragePartitioning<Study',
    });
    mod.applyThirdPartyCookieBlocking(trial, {});
    expect(trial.values.get('disable-features')).toBe('PaintHolding');
    const starred = fakeApp({ 'disable-features': '*ThirdPartyStoragePartitioning,Translate' });
    mod.applyThirdPartyCookieBlocking(starred, {});
    expect(starred.values.get('disable-features')).toBe('Translate');

    const only = fakeApp({ 'disable-features': 'ThirdPartyStoragePartitioning' });
    mod.applyThirdPartyCookieBlocking(only, {});
    expect(only.values.has('disable-features')).toBe(false);

    // Nothing to take out: the list stays as the launcher passed it.
    const other = fakeApp({ 'disable-features': 'PaintHolding' });
    mod.applyThirdPartyCookieBlocking(other, {}, { logger });
    expect(other.values.get('disable-features')).toBe('PaintHolding');
    expect(other.switches).toEqual([['test-third-party-cookie-phaseout']]);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  test('allowing leaves the feature list alone', () => {
    const mod = load();
    const app = fakeApp({ 'disable-features': 'ThirdPartyStoragePartitioning' });
    mod.applyThirdPartyCookieBlocking(app, { blockThirdPartyCookies: false });
    expect(app.values.get('disable-features')).toBe('ThirdPartyStoragePartitioning');
  });

  test('allowing appends nothing and records that too', () => {
    const mod = load();
    const app = fakeApp();
    expect(mod.applyThirdPartyCookieBlocking(app, { blockThirdPartyCookies: false })).toBe(false);
    expect(app.switches).toEqual([]);
    expect(mod.thirdPartyCookiesBlockedAtLaunch()).toBe(false);
  });

  test('Settings reads the launch state over IPC, not the stored setting', async () => {
    const mod = load();
    const handlers = new Map();
    mod.registerThirdPartyCookiesIpc({ handle: (channel, fn) => handlers.set(channel, fn) });
    const handler = handlers.get(IPC.THIRD_PARTY_COOKIES_LAUNCH_STATE);
    expect(IPC.THIRD_PARTY_COOKIES_LAUNCH_STATE).toBe('cookies:third-party:launch-state');
    expect(await handler()).toEqual({ blockedAtLaunch: null });
    mod.applyThirdPartyCookieBlocking(fakeApp(), {});
    expect(await handler()).toEqual({ blockedAtLaunch: true });
  });
});
