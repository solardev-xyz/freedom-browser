const { appFacts } = require('./test-harness');

describe('test harness appFacts', () => {
  test('reports the build facts the packaged smoke tests assert on, and nothing callable', () => {
    const app = {
      isPackaged: true,
      getAppPath: () => '/opt/Freedom/resources/app.asar',
      getVersion: () => '9.9.9',
      getName: () => 'freedom',
    };
    const BrowserWindow = {
      getAllWindows: () => [{ getTitle: () => 'Freedom', isDestroyed: () => false }],
    };

    const facts = appFacts({ app, BrowserWindow });

    expect(facts).toEqual({
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      packaged: true,
      execPath: process.execPath,
      appImage: null,
      resourcesPath: process.resourcesPath,
      appPath: '/opt/Freedom/resources/app.asar',
      version: '9.9.9',
      name: 'freedom',
      windows: [{ title: 'Freedom', destroyed: false }],
    });
    // Crosses IPC as plain data: structured-clone safe, no functions.
    expect(JSON.parse(JSON.stringify(facts))).toEqual(
      JSON.parse(JSON.stringify(structuredClone(facts)))
    );
  });

  test('reports the mounted .AppImage when running from one', () => {
    const app = {
      isPackaged: true,
      getAppPath: () => '/tmp/.mount_FreedoAbc123/resources/app.asar',
      getVersion: () => '9.9.9',
      getName: () => 'freedom',
    };
    const BrowserWindow = { getAllWindows: () => [] };
    const previous = process.env.APPIMAGE;
    process.env.APPIMAGE = '/home/user/Freedom.AppImage';
    try {
      expect(appFacts({ app, BrowserWindow }).appImage).toBe('/home/user/Freedom.AppImage');
    } finally {
      if (previous === undefined) delete process.env.APPIMAGE;
      else process.env.APPIMAGE = previous;
    }
  });
});

describe('Linux mock credential store (#815)', () => {
  const { installLinuxMockCredentialStore } = require('./test-harness');
  const basicTextStorage = () => ({
    isEncryptionAvailable: () => false,
    getSelectedStorageBackend: () => 'basic_text',
    encryptString: () => {
      throw new Error('Encryption is not available.');
    },
    decryptString: () => {
      throw new Error('Encryption is not available.');
    },
  });
  const switches = (values) => ({ getSwitchValue: (name) => values[name] || '' });

  test("stands in for macOS's mock keychain under Playwright's --password-store=basic on Linux", () => {
    const storage = basicTextStorage();
    expect(
      installLinuxMockCredentialStore(storage, {
        platform: 'linux',
        commandLine: switches({ 'password-store': 'basic' }),
      })
    ).toBe(true);
    expect(storage.isEncryptionAvailable()).toBe(true);
    expect(storage.getSelectedStorageBackend()).not.toBe('basic_text');
    const sealed = storage.encryptString('sk-test');
    expect(Buffer.isBuffer(sealed)).toBe(true);
    expect(sealed.toString('utf8')).not.toBe('sk-test');
    expect(storage.decryptString(sealed)).toBe('sk-test');
    expect(() => storage.decryptString(Buffer.from('sk-test'))).toThrow();
  });

  test.each([
    ['macOS (already has the mock keychain)', 'darwin', { 'password-store': 'basic' }],
    ['Windows', 'win32', { 'password-store': 'basic' }],
    ['Linux without the Playwright switch (packaged launch, real keyring)', 'linux', {}],
    ['Linux with a real keyring selected', 'linux', { 'password-store': 'gnome-libsecret' }],
  ])('leaves real safeStorage alone on %s', (_label, platform, values) => {
    const storage = basicTextStorage();
    const before = { ...storage };
    expect(
      installLinuxMockCredentialStore(storage, { platform, commandLine: switches(values) })
    ).toBe(false);
    expect(storage).toEqual(before);
    expect(storage.isEncryptionAvailable()).toBe(false);
  });
});

describe('agent node lifecycle test options', () => {
  function loadInTestMode() {
    let mod;
    const previous = process.env.FREEDOM_TEST_MODE;
    process.env.FREEDOM_TEST_MODE = '1';
    try {
      jest.isolateModules(() => {
        // The real managers must never be reached in test mode.
        jest.doMock('./ant-manager', () => {
          const real = () => {
            throw new Error('real ant-manager reached');
          };
          return { startAnt: real, stopAnt: real, restartAnt: real };
        });
        mod = {
          harness: require('./test-harness'),
          controller: require('./node-lifecycle-controller'),
        };
      });
    } finally {
      if (previous === undefined) delete process.env.FREEDOM_TEST_MODE;
      else process.env.FREEDOM_TEST_MODE = previous;
    }
    return mod;
  }

  test('fakes every lifecycle dependency the controller would otherwise default', () => {
    const { harness, controller } = loadInTestMode();
    const options = harness.createAgentNodeLifecycleTestOptions();
    expect(Object.keys(options.dependencies).sort()).toEqual(
      Object.keys(controller.defaultDependencies()).sort()
    );
  });

  test('an Ant restart drives the fake lifecycle, not the real ant-manager (#988)', async () => {
    const { harness, controller } = loadInTestMode();
    const options = harness.createAgentNodeLifecycleTestOptions();
    const lifecycle = new controller.NodeLifecycleController(options);
    const antState = async () =>
      (await options.nodeStatusController.status()).nodes.find((node) => node.id === 'ant').state;
    options.dependencies.stopAnt();
    expect(await antState()).toBe('stopped');
    // The merged dependency the controller's restart calls; the mocked real
    // ant-manager throws if it is reached instead.
    await lifecycle.dependencies.restartAnt();
    expect(await antState()).toBe('running');
  });
});
