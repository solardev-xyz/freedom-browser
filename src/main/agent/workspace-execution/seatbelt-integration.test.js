'use strict';

const { detectSeatbeltCapabilities } = require('./seatbelt-backend');

const requiredTest =
  process.platform === 'darwin' && process.env.FREEDOM_REQUIRE_SEATBELT === '1' ? test : test.skip;

describe('macOS Seatbelt qualification probes', () => {
  requiredTest('initializes Seatbelt and confirms the descendant session escape blocker', async () => {
    const capabilities = await detectSeatbeltCapabilities();
    expect(capabilities).toMatchObject({
      backend: 'macos-seatbelt',
      available: false,
      denial: { code: 'DESCENDANT_CANCELLATION_UNAVAILABLE' },
      diagnostics: {
        platform: 'darwin',
        architecture: 'arm64',
        version: '15.6',
        build: '24G84',
        profileInitialization: 'passed',
        setsidEscape: 'confirmed',
      },
      enforcement: { cancellation: false },
    });
  });
});
