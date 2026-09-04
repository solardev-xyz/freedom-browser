// Setup project for `packaged` (playwright.config.js `dependencies`).
//
// The packaged specs drive a built Freedom binary named by
// FREEDOM_E2E_EXECUTABLE. Without it the fixtures would fall back to a source
// launch and the suite would "pass" while testing nothing about the artifact,
// so check the variable once, up front — a failure here skips every packaged
// spec instead of running them against the wrong thing.
//
// Named `.setup.js` rather than `.spec.js` so the `packaged` project itself
// does not pick it up.

const fs = require('fs');

const { test } = require('@playwright/test');

const EXECUTABLE_VAR = 'FREEDOM_E2E_EXECUTABLE';

const USAGE = `Set ${EXECUTABLE_VAR} to a packaged Freedom binary, for example:

  npm run build -- --linux --x64
  ${EXECUTABLE_VAR}="$PWD/dist/linux-unpacked/freedom" \\
    FREEDOM_E2E_NO_SANDBOX=1 xvfb-run -a npm run test:e2e:packaged

Installed packages work too: /opt/Freedom/freedom from the .deb, or the
freedom binary inside an AppImage extracted with --appimage-extract.`;

test('FREEDOM_E2E_EXECUTABLE points at an executable packaged build', () => {
  // Trimmed for the same reason the fixture trims it: a trailing space from a
  // shell or a YAML `env:` value must not read as a valid path.
  const executable = (process.env[EXECUTABLE_VAR] || '').trim();

  if (!executable) {
    throw new Error(
      `The "packaged" project needs ${EXECUTABLE_VAR} and it is not set.\n\n${USAGE}`
    );
  }

  let stats;
  try {
    stats = fs.statSync(executable);
  } catch (error) {
    throw new Error(`${EXECUTABLE_VAR}="${executable}" cannot be read.\n\n${USAGE}`, {
      cause: error,
    });
  }

  if (!stats.isFile()) {
    throw new Error(`${EXECUTABLE_VAR}="${executable}" is not a file.\n\n${USAGE}`);
  }

  // On Windows fs.accessSync(X_OK) degrades to an existence check (no execute
  // bit), so this guard only means something on Linux/macOS.
  try {
    fs.accessSync(executable, fs.constants.X_OK);
  } catch {
    throw new Error(`${EXECUTABLE_VAR}="${executable}" is not executable.\n\n${USAGE}`);
  }

  console.log(`[packaged] driving ${executable}`);
});
