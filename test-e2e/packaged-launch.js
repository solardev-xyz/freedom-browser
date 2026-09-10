// Where an E2E launch points: the repo checkout, or a packaged artifact.
//
// Both fixture files have to answer that question the same way before they do
// anything else, and they answer nothing else the same way (`fixtures.js`
// launches with FREEDOM_TEST_MODE and harness stubs, `live-fixtures.js`
// deliberately without). Keeping just the target decision here is what lets
// the live-style launch drive a package too — that is the `packaged-live`
// project (test-e2e/packaged-live/), which starts the real node managers
// inside a built artifact.
//
// With FREEDOM_E2E_EXECUTABLE unset this reproduces what both fixtures did
// before: `args: ['.']`, no executablePath, no --no-sandbox.

const EXECUTABLE_VAR = 'FREEDOM_E2E_EXECUTABLE';
const NO_SANDBOX_VAR = 'FREEDOM_E2E_NO_SANDBOX';
// Set by `npm run test:e2e:screenshots` (#261 item 1c). Chromium promotes a
// composited layer to greyscale text antialiasing and demotes it back to
// subpixel (LCD) as layers come and go, which repaints every glyph on the
// surface with different colour fringes — ~1% of the frame, on a page nothing
// changed on. That is bistable rather than random, so it does not settle with
// a longer wait; turning LCD text off makes the rasterisation deterministic.
// Only the screenshot spec sets it, so nothing else changes how it renders.
const STABLE_TEXT_VAR = 'FREEDOM_E2E_STABLE_TEXT';

// Trimmed, because shells (and YAML `env:` blocks) capture stray whitespace
// into a value and `executablePath: '/opt/Freedom/freedom '` would fail with
// a confusing ENOENT. `preflight.setup.js` trims the same way.
function packagedExecutable() {
  return (process.env[EXECUTABLE_VAR] || '').trim();
}

// True when this run drives a built artifact rather than the source tree.
function isPackagedRun() {
  return packagedExecutable() !== '';
}

// The electron.launch() options that differ between the two targets. A source
// run passes `.` so Electron loads the repo as its app directory; a packaged
// binary already embeds its app, so it gets no positional argument at all.
function packagedLaunchTarget() {
  const executable = packagedExecutable();
  const args = [];

  if (!executable) {
    args.push('.');
  } else if ((process.env[NO_SANDBOX_VAR] || '').trim() === '1') {
    // Headless CI runners generally cannot use Chromium's setuid/namespace
    // sandbox. Only ever passed in packaged mode — a source run under
    // `npm run test:e2e` / `npm run test:e2e:live` keeps the sandbox on.
    args.push('--no-sandbox');
  }

  if ((process.env[STABLE_TEXT_VAR] || '').trim() === '1') {
    args.push('--disable-lcd-text', '--disable-font-subpixel-positioning');
  }

  return {
    ...(executable ? { executablePath: executable } : {}),
    args,
  };
}

module.exports = {
  EXECUTABLE_VAR,
  NO_SANDBOX_VAR,
  STABLE_TEXT_VAR,
  packagedExecutable,
  isPackagedRun,
  packagedLaunchTarget,
};
