/**
 * Linux window identity for source-tree runs (issue #142).
 *
 * Electron fixes `CHROME_DESKTOP` at startup from package.json's `desktopName`
 * (`freedom.desktop`), and derives every new window's X11 WM_CLASS and Wayland
 * app_id from it — not from `app.name`, which index.js changes later. Probed
 * with xprop under Xvfb, Electron 44: a source-tree run with `app.name =
 * 'Freedom Dev'` still got `WM_CLASS "freedom", "freedom"`; after
 * `app.setDesktopName('freedom-dev.desktop')` it got `"freedom-dev"`.
 *
 * Without this, `npm start` on a machine with the .deb installed would group
 * "Freedom Dev" windows under the installed Freedom launcher and icon, and
 * portals would attribute the dev build's requests to the installed app. The
 * dev build has no .desktop entry of its own; a name that matches nothing is
 * the honest answer. Packaged builds keep `freedom.desktop`, which is the
 * installed entry.
 */

const DEV_DESKTOP_NAME = 'freedom-dev.desktop';

function applyLinuxDesktopName(app, platform = process.platform) {
  if (platform !== 'linux' || app.isPackaged) return false;
  app.setDesktopName(DEV_DESKTOP_NAME);
  return true;
}

module.exports = { applyLinuxDesktopName, DEV_DESKTOP_NAME };
