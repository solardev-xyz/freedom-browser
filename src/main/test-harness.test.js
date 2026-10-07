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
