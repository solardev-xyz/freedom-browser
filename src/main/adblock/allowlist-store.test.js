const fs = require('fs');
const path = require('path');
const {
  createTempUserDataDir,
  loadMainModule,
  removeTempUserDataDir,
} = require('../../../test/helpers/main-process-test-utils');

const setAllowlistedHosts = jest.fn();

function loadAllowlistStore(options = {}) {
  setAllowlistedHosts.mockClear();
  return loadMainModule(require.resolve('./allowlist-store'), {
    ...options,
    extraMocks: {
      ...(options.extraMocks || {}),
      [require.resolve('./service')]: () => ({ setAllowlistedHosts }),
    },
  });
}

describe('adblock allowlist-store', () => {
  let userDataDir;

  beforeEach(() => {
    userDataDir = createTempUserDataDir();
  });

  afterEach(() => {
    removeTempUserDataDir(userDataDir);
  });

  test('starts empty when no file exists', () => {
    const { mod } = loadAllowlistStore({ userDataDir });
    expect(mod.getAllowlistedHosts()).toEqual([]);
  });

  test('adds hosts normalized and persists them', () => {
    const { mod } = loadAllowlistStore({ userDataDir });

    expect(mod.addAllowlistedHost('WWW.Bild.DE.')).toBe(true);
    expect(mod.getAllowlistedHosts()).toEqual(['bild.de']);

    const persisted = JSON.parse(
      fs.readFileSync(path.join(userDataDir, 'adblock-allowlist.json'), 'utf-8')
    );
    expect(persisted).toEqual({ hosts: ['bild.de'] });
  });

  test('rejects empty input and dedupes existing hosts', () => {
    const { mod } = loadAllowlistStore({ userDataDir });

    expect(mod.addAllowlistedHost('')).toBe(false);
    expect(mod.addAllowlistedHost(null)).toBe(false);
    expect(mod.addAllowlistedHost('bild.de')).toBe(true);
    expect(mod.addAllowlistedHost('www.bild.de')).toBe(true);
    expect(mod.getAllowlistedHosts()).toEqual(['bild.de']);
  });

  test('removes hosts by any spelling that normalizes to the entry', () => {
    const { mod } = loadAllowlistStore({ userDataDir });
    mod.addAllowlistedHost('bild.de');

    expect(mod.removeAllowlistedHost('WWW.BILD.DE')).toBe(true);
    expect(mod.removeAllowlistedHost('bild.de')).toBe(false);
    expect(mod.getAllowlistedHosts()).toEqual([]);
  });

  test('mutations re-sync the live service themselves', () => {
    const { mod } = loadAllowlistStore({ userDataDir });

    mod.addAllowlistedHost('bild.de');
    expect(setAllowlistedHosts).toHaveBeenLastCalledWith(['bild.de']);

    mod.addAllowlistedHost('bild.de'); // no-op add: no extra sync
    expect(setAllowlistedHosts).toHaveBeenCalledTimes(1);

    mod.removeAllowlistedHost('bild.de');
    expect(setAllowlistedHosts).toHaveBeenLastCalledWith([]);
  });

  test('reloads persisted hosts across cache resets', () => {
    const { mod } = loadAllowlistStore({ userDataDir });
    mod.addAllowlistedHost('bild.de');
    mod._resetAllowlistForTests();

    expect(mod.getAllowlistedHosts()).toEqual(['bild.de']);
  });

  test('falls back to empty on a corrupt file', () => {
    fs.writeFileSync(path.join(userDataDir, 'adblock-allowlist.json'), '{nope', 'utf-8');
    const { mod } = loadAllowlistStore({ userDataDir });

    expect(mod.getAllowlistedHosts()).toEqual([]);
  });

  test('getAllowlistedHosts returns a copy, not the live cache', () => {
    const { mod } = loadAllowlistStore({ userDataDir });
    mod.addAllowlistedHost('bild.de');

    const hosts = mod.getAllowlistedHosts();
    hosts.push('injected.example');
    expect(mod.getAllowlistedHosts()).toEqual(['bild.de']);
  });
});
