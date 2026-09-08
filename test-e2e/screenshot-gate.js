// Whether a screenshot comparison run can mean anything, and if not, why.
//
// `renderer-screenshots.spec.js` lives in `test-e2e/`, so the `harness` project
// matches it and a bare `npm run test:e2e` would run it too. Two conditions
// have to hold for the committed baselines to be comparable at all; when
// either fails the spec skips itself with the reason rather than reporting a
// screen of font-rasterisation diffs against the change under test.
//
// Kept out of the spec so it can be unit-tested (see
// `renderer-screenshots-gate.test.js`) — jest never loads `*.spec.js`.

const STABLE_TEXT_VAR = 'FREEDOM_E2E_STABLE_TEXT';
const PLATFORM_OVERRIDE_VAR = 'FREEDOM_SCREENSHOTS';

/**
 * @param {NodeJS.ProcessEnv} env
 * @param {string} platform `process.platform`
 * @returns {{ enabled: boolean, reason: string }} `reason` is empty when enabled.
 */
function screenshotGate(env = process.env, platform = process.platform) {
  // Baselines are rendered and compared on Linux; font rasterisation differs
  // enough elsewhere that a macOS or Windows run disagrees with every file.
  // The override opts such a machine in, knowing it will rewrite them.
  if (platform !== 'linux' && (env[PLATFORM_OVERRIDE_VAR] || '').trim() !== '1') {
    return {
      enabled: false,
      reason: `baselines are rendered on Linux; set ${PLATFORM_OVERRIDE_VAR}=1 to override`,
    };
  }

  // The baselines were rendered with LCD text off, which is what
  // `FREEDOM_E2E_STABLE_TEXT=1` turns into launch flags in
  // `packaged-launch.js`. Without it Chromium flips surfaces between subpixel
  // and greyscale antialiasing and the glyph fringes alone fail most of these
  // tests. Trimmed like every other flag this repo reads, so a Windows
  // `set X=1 && npm run ...` still counts.
  if ((env[STABLE_TEXT_VAR] || '').trim() !== '1') {
    return {
      enabled: false,
      reason: `run \`npm run test:e2e:screenshots\`: the baselines need ${STABLE_TEXT_VAR}=1`,
    };
  }

  return { enabled: true, reason: '' };
}

module.exports = { screenshotGate, STABLE_TEXT_VAR, PLATFORM_OVERRIDE_VAR };
