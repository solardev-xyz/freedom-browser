const { test, expect } = require('./fixtures');
const artifact = process.env.FREEDOM_KOHAKU_SPIKE_ASAR;
test('isolated Kohaku bundle initializes WASM from ASAR and reconstructs its synthetic address', async ({
  electronApp,
}, testInfo) => {
  test.skip(!artifact, 'Set FREEDOM_KOHAKU_SPIKE_ASAR to the isolated runtime fixture');
  const report = await electronApp.evaluate(async (_electron, file) => {
    return process.mainModule.require(`${file}/loader.cjs`).probe();
  }, artifact);
  expect(report.initialized).toBe(true);
  expect(report.restoredAddressMatches).toBe(true);
  expect(report.ambientFetchCalls).toBe(0);
  expect(report.address).toMatch(/^0zk/);
  await testInfo.attach('runtime-report', {
    body: JSON.stringify(report, null, 2),
    contentType: 'application/json',
  });
});
