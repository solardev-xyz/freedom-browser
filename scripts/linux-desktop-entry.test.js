// Pins the Linux window ↔ desktop-entry association (issue #142).
//
// Electron fixes CHROME_DESKTOP at startup from package.json's `desktopName`,
// or, when that is unset, from `<package name>.desktop`, and derives the X11
// WM_CLASS and the Wayland app_id from it. Setting `app.name` later in
// index.js does not change it. Before #142 there was no desktopName, so the
// packaged window was `WM_CLASS "freedom-browser", "freedom-browser"` (checked
// with xprop). That *did* match the entry's hand-written
// `StartupWMClass=freedom-browser`, so X11 was fine. What didn't match was the
// Wayland app_id and CHROME_DESKTOP, `freedom-browser.desktop`: no entry by
// that name is installed. The real entry is `freedom.desktop`, and portals and
// xdg-activation resolve the app by that identity.
//
// With `desktopName` set and `linux.syncDesktopName: true`, electron-builder
// names the installed entry after desktopName and derives StartupWMClass from
// it, so both sides come from the one value checked here. Source-tree runs
// override it at runtime (src/main/linux-desktop-name.js) so `npm start` doesn't
// borrow the installed app's identity.

const pkg = require('../package.json');

const linux = pkg.build.linux;

describe('Linux desktop entry', () => {
  test('desktopName names the installed .desktop file, which keeps its pre-#142 name', () => {
    // electron-builder installs /usr/share/applications/<executableName>.desktop
    // without syncDesktopName. Keeping desktopName on that same basename means
    // an upgrade doesn't rename the entry out from under existing
    // `xdg-mime default freedom.desktop x-scheme-handler/ipfs` associations.
    expect(pkg.desktopName).toBe(`${linux.executableName}.desktop`);
    expect(linux.syncDesktopName).toBe(true);
  });

  test('StartupWMClass is left for electron-builder to derive from desktopName', () => {
    // A hand-written value is how the two drifted apart in the first place.
    expect(linux.desktop?.entry?.StartupWMClass).toBeUndefined();
    for (const target of ['deb', 'pacman', 'appImage', 'rpm', 'snap']) {
      expect(pkg.build[target]?.desktop?.entry?.StartupWMClass).toBeUndefined();
    }
  });
});
