const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  createTempUserDataDir,
  loadMainModule,
  removeTempUserDataDir,
} = require('../../../test/helpers/main-process-test-utils');

// File System Access (#671). Electron answers every File System Access
// operation from the session's permission CHECK handler (per path, origin
// only, webContents null) and raises a REQUEST only after a directory
// picker — the shapes below are the ones Electron 44.7.0 actually sends,
// recorded from a probe page driven through a stub file-chooser portal.

const SITE = 'bzz://ontodag.gwei/';
const SITE_URL = 'bzz://ontodag.gwei/index.html';
// SITE's permission key, as Settings' site list names it.
const SITE_KEY = 'ontodag.gwei';
const OTHER_SITE = 'https://other.example/';
const PARTITION = 'private-fsa-partition';

function makeFakeSession() {
  const session = {
    requestHandler: null,
    checkHandler: null,
    listeners: new Map(),
    setPermissionRequestHandler: jest.fn((handler) => {
      session.requestHandler = handler;
    }),
    setPermissionCheckHandler: jest.fn((handler) => {
      session.checkHandler = handler;
    }),
    on: jest.fn((event, listener) => {
      session.listeners.set(event, listener);
    }),
  };
  return session;
}

function makeGuest(url) {
  const { EventEmitter } = require('events');
  const guest = new EventEmitter();
  guest.id = 4242;
  guest.getURL = () => url;
  guest.isDestroyed = () => false;
  return guest;
}

describe('file System Access grants', () => {
  let userDataDir;
  let filesDir;
  let ctx;
  let normalSession;
  let privateSession;
  let renderer;

  const load = () => {
    renderer = { send: jest.fn() };
    ctx = loadMainModule(require.resolve('./permissions-manager'), {
      userDataDir,
      webContentsList: [renderer],
      electronOverrides: {
        systemPreferences: { askForMediaAccess: jest.fn(() => Promise.resolve(true)) },
      },
    });
    normalSession = makeFakeSession();
    privateSession = makeFakeSession();
    ctx.mod.installPermissionHandlers(normalSession);
    ctx.mod.installPermissionHandlers(privateSession, { privatePartition: PARTITION });
    ctx.mod.registerPermissionsIpc();
  };

  // A permission check as Electron sends it for fileSystem.
  const check = (
    filePath,
    fileAccessType,
    { isDirectory = false, origin = SITE, session = normalSession } = {}
  ) =>
    session.checkHandler(null, 'fileSystem', origin, {
      fileAccessType,
      filePath,
      isDirectory,
      isMainFrame: false,
    });

  // A permission request as Electron sends it after a directory picker.
  const request = (
    filePath,
    fileAccessType,
    { isDirectory = true, url = SITE_URL, session = normalSession } = {}
  ) => {
    const callback = jest.fn();
    session.requestHandler(makeGuest(url), 'fileSystem', callback, {
      fileAccessType,
      filePath,
      isDirectory,
      isMainFrame: true,
      requestingUrl: url,
    });
    return callback;
  };

  const write = (name, content) => {
    const file = path.join(filesDir, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    return file;
  };

  // What Chromium's save picker leaves behind: the picked file, emptied.
  const savePick = (name) => write(name, '');

  const age = (file, ms) => {
    const at = new Date(Date.now() - ms);
    fs.utimesSync(file, at, at);
  };

  beforeEach(() => {
    userDataDir = createTempUserDataDir('freedom-fsa-');
    filesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-fsa-files-'));
    load();
  });

  afterEach(() => {
    removeTempUserDataDir(userDataDir);
    fs.rmSync(filesDir, { recursive: true, force: true });
  });

  describe('open file picker', () => {
    test('the picked file is readable', () => {
      const file = write('store.od', 'ontology');
      expect(check(file, 'readable')).toBe(true);
    });

    test('but not writable: Chrome asks before writing to an opened file', () => {
      const file = write('store.od', 'ontology');
      expect(check(file, 'readable')).toBe(true);
      expect(check(file, 'writable')).toBe(false);
      // requestPermission({mode: 'readwrite'}) is a check pair; still no.
      expect(check(file, 'readable')).toBe(true);
      expect(check(file, 'writable')).toBe(false);
    });

    test('an empty file the user opened long ago is not mistaken for a save', () => {
      const file = write('empty.od', '');
      age(file, 10 * 60 * 1000);
      expect(check(file, 'readable')).toBe(true);
      expect(check(file, 'writable')).toBe(false);
    });
  });

  describe('save file picker', () => {
    test('the picked file is writable and readable', () => {
      const file = savePick('saved.od');
      expect(check(file, 'writable')).toBe(true);
      expect(check(file, 'readable')).toBe(true);
    });

    test('stays writable once the site has written to it', () => {
      const file = savePick('saved.od');
      expect(check(file, 'writable')).toBe(true);
      fs.writeFileSync(file, 'saved content');
      age(file, 10 * 60 * 1000);
      expect(check(file, 'writable')).toBe(true);
    });

    test('saving over a file the site had only opened makes it writable', () => {
      const file = write('store.od', 'ontology');
      expect(check(file, 'readable')).toBe(true);
      expect(check(file, 'writable')).toBe(false);
      fs.writeFileSync(file, ''); // the save picker truncates it
      expect(check(file, 'writable')).toBe(true);
    });

    test('a save whose first write comes too late is refused', () => {
      const file = savePick('saved.od');
      age(file, 2 * 60 * 1000);
      expect(check(file, 'writable')).toBe(false);
    });

    test('a late first write is refused, and picking the file again recovers', () => {
      // Chromium runs no check when the save picker returns, so a page that
      // renders for longer than the window before createWritable() misses it.
      const file = savePick('export.od');
      age(file, 61 * 1000);
      expect(check(file, 'writable')).toBe(false);
      // A second save pick truncates the file again.
      savePick('export.od');
      expect(check(file, 'writable')).toBe(true);
    });

    test('known edge: an empty file emptied moments ago and then opened is writable too', () => {
      // `touch notes.md`, then the open picker: the same on-disk state a
      // save picker leaves, which nothing in Electron tells apart. Pinned
      // so the documented limit can't widen silently.
      const file = write('notes.md', '');
      expect(check(file, 'readable')).toBe(true);
      expect(check(file, 'writable')).toBe(true);
    });

    test('a non-empty or missing file is never taken for a save', () => {
      expect(check(write('full.od', 'x'), 'writable')).toBe(false);
      expect(check(path.join(filesDir, 'missing.od'), 'writable')).toBe(false);
    });
  });

  describe('directory picker', () => {
    test("readwrite: the picker's two requests grant the folder and everything in it", () => {
      const dir = path.join(filesDir, 'store');
      fs.mkdirSync(dir);
      // Before the picker answered, a folder is nothing.
      expect(check(dir, 'readable', { isDirectory: true })).toBe(false);

      const w = request(dir, 'writable');
      const r = request(dir, 'readable');
      expect(w).toHaveBeenCalledWith(true);
      expect(r).toHaveBeenCalledWith(true);

      expect(check(dir, 'readable', { isDirectory: true })).toBe(true);
      expect(check(dir, 'writable', { isDirectory: true })).toBe(true);
      // Children share the folder's grant; a file picked inside it too.
      const child = write('store/x.od', 'x');
      expect(check(child, 'writable')).toBe(true);
      expect(check(path.join(dir, 'sub'), 'writable', { isDirectory: true })).toBe(true);
    });

    test('read-only: the folder can be listed but not written', () => {
      const dir = path.join(filesDir, 'store');
      fs.mkdirSync(dir);
      expect(request(dir, 'readable')).toHaveBeenCalledWith(true);
      expect(check(dir, 'readable', { isDirectory: true })).toBe(true);
      expect(check(dir, 'writable', { isDirectory: true })).toBe(false);
      expect(check(write('store/x.od', 'x'), 'writable')).toBe(false);
    });

    test('a grant on one folder does not reach its parent or a sibling with a shared prefix', () => {
      const dir = path.join(filesDir, 'store');
      fs.mkdirSync(dir);
      request(dir, 'writable');
      expect(check(filesDir, 'writable', { isDirectory: true })).toBe(false);
      expect(check(`${dir}-other`, 'writable', { isDirectory: true })).toBe(false);
    });

    test('a child whose name starts with ".." is inside the folder', () => {
      const dir = path.join(filesDir, 'store');
      fs.mkdirSync(dir);
      request(dir, 'writable');
      expect(check(write('store/..notes', 'x'), 'writable')).toBe(true);
      expect(check(path.join(dir, '..cache'), 'writable', { isDirectory: true })).toBe(true);
      // A real `..` segment still climbs out.
      expect(check(path.join(dir, '..', 'outside.od'), 'writable')).toBe(false);
    });

    test('a folder handle the site restored from storage is refused', () => {
      const dir = path.join(filesDir, 'store');
      fs.mkdirSync(dir);
      expect(check(dir, 'readable', { isDirectory: true })).toBe(false);
      expect(check(dir, 'writable', { isDirectory: true })).toBe(false);
    });
  });

  test('grants are per origin', () => {
    const dir = path.join(filesDir, 'store');
    fs.mkdirSync(dir);
    request(dir, 'writable');
    const file = savePick('saved.od');
    expect(check(file, 'writable')).toBe(true);
    age(file, 10 * 60 * 1000);
    expect(check(dir, 'writable', { isDirectory: true, origin: OTHER_SITE })).toBe(false);
    expect(check(file, 'writable', { origin: OTHER_SITE })).toBe(false);
  });

  test('a request that is not a folder picker, or carries no usable path, is refused', () => {
    const file = write('store.od', 'x');
    expect(request(file, 'writable', { isDirectory: false })).toHaveBeenCalledWith(false);
    expect(request('relative/dir', 'writable')).toHaveBeenCalledWith(false);
    expect(request(filesDir, 'execute')).toHaveBeenCalledWith(false);
    expect(check(file, 'writable')).toBe(false);
    expect(check('relative.od', 'readable')).toBe(false);
  });

  test('internal pages and unusable origins get nothing', () => {
    const dir = path.join(filesDir, 'store');
    fs.mkdirSync(dir);
    expect(request(dir, 'writable', { url: 'file:///app/pages/home.html' })).toHaveBeenCalledWith(
      false
    );
    expect(check(write('a.od', 'x'), 'readable', { origin: 'file:///' })).toBe(false);
    expect(check(write('b.od', 'x'), 'readable', { origin: '' })).toBe(false);
  });

  describe('private windows', () => {
    test("a private window's grants stay in it and close with it", () => {
      const dir = path.join(filesDir, 'store');
      fs.mkdirSync(dir);
      expect(request(dir, 'writable', { session: privateSession })).toHaveBeenCalledWith(true);
      const opts = { isDirectory: true, session: privateSession };
      expect(check(dir, 'writable', opts)).toBe(true);
      // Not in the normal profile.
      expect(check(dir, 'writable', { isDirectory: true })).toBe(false);

      ctx.mod.clearPrivateDecisions(PARTITION);
      expect(check(dir, 'writable', opts)).toBe(false);
    });

    test("the normal profile's grants do not reach a private window", () => {
      const dir = path.join(filesDir, 'store');
      fs.mkdirSync(dir);
      request(dir, 'writable');
      expect(check(dir, 'writable', { isDirectory: true, session: privateSession })).toBe(false);
    });
  });

  test('revoke all drops every grant', () => {
    const dir = path.join(filesDir, 'store');
    fs.mkdirSync(dir);
    request(dir, 'writable');
    request(dir, 'writable', { session: privateSession });
    ctx.mod.revokeAll();
    expect(check(dir, 'writable', { isDirectory: true })).toBe(false);
    expect(check(dir, 'writable', { isDirectory: true, session: privateSession })).toBe(false);
  });

  describe("removing a site's permissions", () => {
    const grantFolder = (session) => {
      const dir = path.join(filesDir, 'store');
      fs.mkdirSync(dir, { recursive: true });
      request(dir, 'writable', { session });
      return dir;
    };
    const canWrite = (dir, opts = {}) => check(dir, 'writable', { isDirectory: true, ...opts });

    test("Settings' per-site Remove drops that origin's grants everywhere, and only its", () => {
      const dir = grantFolder(normalSession);
      request(dir, 'writable', { session: privateSession });
      request(dir, 'writable', { url: 'https://other.example/x' });
      expect(ctx.mod.revokeOrigin(SITE)).toBe(true);
      expect(canWrite(dir)).toBe(false);
      expect(canWrite(dir, { session: privateSession })).toBe(false);
      expect(canWrite(dir, { origin: OTHER_SITE })).toBe(true);
    });

    test("the address-bar Remove drops only the asking window's scope", () => {
      const dir = grantFolder(normalSession);
      request(dir, 'writable', { session: privateSession });

      ctx.mod.revokeOrigin(SITE, { windowScoped: true, privatePartition: PARTITION });
      expect(canWrite(dir, { session: privateSession })).toBe(false);
      expect(canWrite(dir)).toBe(true);

      request(dir, 'writable', { session: privateSession });
      ctx.mod.revokeOrigin(SITE, { windowScoped: true, privatePartition: null });
      expect(canWrite(dir)).toBe(false);
      expect(canWrite(dir, { session: privateSession })).toBe(true);
    });

    test('removing a single permission leaves file grants alone', () => {
      const dir = grantFolder(normalSession);
      ctx.mod.revokeDecision(SITE, 'camera');
      expect(canWrite(dir)).toBe(true);
    });
  });

  test('a sensitive path Electron flags is refused, in every session', () => {
    for (const session of [normalSession, privateSession]) {
      const listener = session.listeners.get('file-system-access-restricted');
      expect(typeof listener).toBe('function');
      const callback = jest.fn();
      listener({}, { origin: SITE, path: os.homedir(), isDirectory: true }, callback);
      expect(callback).toHaveBeenCalledWith('deny');
    }
  });

  test('fileSystem stays out of the per-origin decision store', () => {
    expect(ctx.mod.permissionKeysForRequest('fileSystem', {})).toBeNull();
    const dir = path.join(filesDir, 'store');
    fs.mkdirSync(dir);
    request(dir, 'writable');
    // Nothing written to permissions.json for it.
    expect(fs.existsSync(path.join(userDataDir, 'permissions.json'))).toBe(false);
  });

  // A site whose only grants are files/folders must still be listed
  // somewhere the user can take them back (R2-M1): Settings' site list
  // and the address-bar indicator/popover.
  describe('listing grants', () => {
    const grantFolder = (opts) => {
      const dir = path.join(filesDir, 'store');
      fs.mkdirSync(dir, { recursive: true });
      request(dir, 'writable', opts);
      return dir;
    };
    const canWrite = (dir, opts = {}) => check(dir, 'writable', { isDirectory: true, ...opts });
    const settingsList = () => ctx.ipcMain.invoke('permissions:get-all');

    test('Settings lists a site holding only file grants, so Remove site and Revoke all reach it', async () => {
      expect(await settingsList()).toEqual({});
      const dir = grantFolder();
      expect(await settingsList()).toEqual({ [SITE_KEY]: { fileSystem: 'allow' } });

      ctx.mod.revokeOrigin(SITE);
      expect(canWrite(dir)).toBe(false);
      expect(await settingsList()).toEqual({});
    });

    test("an opened file lists its site too, beside the site's stored decisions", async () => {
      expect(ctx.mod.allowSitePermission(SITE, 'popups')).toBe(true);
      const file = write('notes.txt', 'hello');
      expect(check(file, 'readable')).toBe(true);
      expect(await settingsList()).toEqual({
        [SITE_KEY]: { popups: 'allow', fileSystem: 'allow' },
      });
      // Removing the file row leaves the stored decision.
      ctx.mod.revokeDecision(SITE, 'fileSystem');
      expect(await settingsList()).toEqual({ [SITE_KEY]: { popups: 'allow' } });
    });

    test("Settings never lists a private window's grants", async () => {
      grantFolder({ session: privateSession });
      expect(await settingsList()).toEqual({});
    });

    test("the popover lists the asking window's own grants as a session allow", () => {
      grantFolder({ session: privateSession });
      expect(ctx.mod.getDecisionsForOrigin(SITE)).toEqual({});
      expect(ctx.mod.getDecisionsForOrigin(SITE, PARTITION)).toEqual({
        fileSystem: { decision: 'allow', remembered: false },
      });
      grantFolder();
      expect(ctx.mod.getDecisionsForOrigin(SITE)).toEqual({
        fileSystem: { decision: 'allow', remembered: false },
      });
    });

    test("removing the fileSystem row takes the grants back, in the row's scope", async () => {
      const dir = grantFolder();
      request(dir, 'writable', { session: privateSession });

      // The popover's Remove in the private window.
      expect(
        ctx.mod.revokeDecision(SITE, 'fileSystem', {
          windowScoped: true,
          privatePartition: PARTITION,
        })
      ).toBe(true);
      expect(canWrite(dir, { session: privateSession })).toBe(false);
      expect(canWrite(dir)).toBe(true);

      // Settings' row Remove, profile-wide.
      request(dir, 'writable', { session: privateSession });
      expect(ctx.mod.revokeDecision(SITE, 'fileSystem')).toBe(true);
      expect(canWrite(dir)).toBe(false);
      expect(canWrite(dir, { session: privateSession })).toBe(false);
      expect(await settingsList()).toEqual({});
    });

    test('a site gaining its first grant tells the listings to refresh, once', () => {
      const changed = () =>
        renderer.send.mock.calls.filter(([channel]) => channel === 'permissions:changed').length;
      const file = write('notes.txt', 'hello');
      expect(check(file, 'readable')).toBe(true);
      expect(changed()).toBe(1);
      // Later checks and further paths for the same site add no noise.
      check(file, 'readable');
      check(write('other.txt', 'x'), 'readable');
      expect(changed()).toBe(1);
      // A grant in another scope is a new listing there.
      check(file, 'readable', { session: privateSession });
      expect(changed()).toBe(2);
      for (const call of renderer.send.mock.calls) expect(call[1]).toEqual({});
    });
  });
});
