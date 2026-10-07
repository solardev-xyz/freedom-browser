/** Actual Electron check of the pinned authentication error classifier. */
const { app } = require('electron');
const fs = require('fs'),
  path = require('path'),
  assert = require('assert/strict'),
  { createHash } = require('crypto');
async function main() {
  const directory = process.argv[2];
  assert.ok(directory && path.isAbsolute(directory) && !fs.existsSync(directory));
  fs.mkdirSync(directory, { mode: 0o700 });
  app.setPath('userData', path.join(directory, 'electron'));
  app.dock?.hide();
  await app.whenReady();
  const { createPrivacyScope } = require('../src/main/networks/privacy-context');
  const scope = createPrivacyScope({
    profileId: 'public-aes-fixture',
    signal: new AbortController().signal,
  });
  const handle = scope.getContext({
    kind: 'private-account',
    principal: 'fixture',
    protocol: 'railgun',
    deployment: 'offline',
    chainId: 11155111,
    role: 'engine',
  });
  let result;
  const task = require('../src/main/wallet/railgun-process').startRailgunProcess({
    handle,
    filename: require.resolve('./fixtures/railgun-wallet-aes-job'),
    input: '{}',
    broker: {
      signal: scope.signal,
      dispatch: async (wire) => {
        assert.equal(result, undefined);
        const message = JSON.parse(wire);
        assert.deepEqual(Object.keys(message).sort(), ['id', 'method', 'value']);
        assert.equal(message.id, 1);
        assert.equal(message.method, 'result');
        result = message.value;
        return JSON.stringify({ id: 1, value: null });
      },
    },
  });
  try {
    await task.ready;
    task.close();
    const closed = await task.closed;
    assert.equal(closed.code, 'RAILGUN_PROCESS_CLOSED');
    assert.ok(result);
    const sources = [
      ...require('./fixtures/railgun-kohaku-adapter-sources').SOURCES,
      'scripts/qualify-railgun-wallet-aes.js',
      'scripts/fixtures/railgun-wallet-aes-job.js',
      'scripts/railgun-fixture-integrity.js',
      'src/main/wallet/railgun-process.js',
      'src/main/wallet/railgun-process-entry.js',
      'src/main/wallet/railgun-process-guards.js',
    ];
    fs.writeFileSync(
      path.join(directory, 'report.json'),
      JSON.stringify(
        {
          observedAt: new Date().toISOString(),
          platform: process.platform,
          architecture: process.arch,
          ...result,
          closed,
          sourceSha256: Object.fromEntries(
            sources.map((file) => [
              file,
              createHash('sha256')
                .update(fs.readFileSync(path.join(__dirname, '..', file)))
                .digest('hex'),
            ])
          ),
        },
        null,
        2
      ) + '\n',
      { flag: 'wx', mode: 0o600 }
    );
  } finally {
    task.close();
    await task.closed;
    scope.close();
  }
}
main().then(
  () => app.exit(0),
  (error) => {
    console.error(error.stack);
    app.exit(1);
  }
);
