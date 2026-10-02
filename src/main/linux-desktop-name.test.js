const { applyLinuxDesktopName, DEV_DESKTOP_NAME } = require('./linux-desktop-name');
const pkg = require('../../package.json');

function fakeApp(isPackaged) {
  return { isPackaged, setDesktopName: jest.fn() };
}

describe('applyLinuxDesktopName', () => {
  test('source-tree Linux run gets its own identity, not the installed one', () => {
    const app = fakeApp(false);
    expect(applyLinuxDesktopName(app, 'linux')).toBe(true);
    expect(app.setDesktopName).toHaveBeenCalledWith(DEV_DESKTOP_NAME);
    expect(DEV_DESKTOP_NAME).not.toBe(pkg.desktopName);
  });

  test('packaged Linux build keeps desktopName from package.json', () => {
    const app = fakeApp(true);
    expect(applyLinuxDesktopName(app, 'linux')).toBe(false);
    expect(app.setDesktopName).not.toHaveBeenCalled();
  });

  test.each(['darwin', 'win32'])('%s is left alone', (platform) => {
    const app = fakeApp(false);
    expect(applyLinuxDesktopName(app, platform)).toBe(false);
    expect(app.setDesktopName).not.toHaveBeenCalled();
  });
});
