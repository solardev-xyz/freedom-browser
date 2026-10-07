/** Offline actual Electron shield construction and public-vector decryption.
 * No enrolled identity, deployment preflight, signer, journal or submission.
 * electron script ARCHIVE NEW_OUTPUT
 */
const fs = require('fs'),
  path = require('path'),
  assert = require('assert/strict');
const { createHash } = require('crypto');
const { app } = require('electron');
async function main() {
  const [archive, output] = process.argv.slice(2);
  assert.equal(process.argv.length, 4);
  assert.ok([archive, output].every(path.isAbsolute) && !fs.existsSync(output));
  fs.mkdirSync(output, { mode: 0o700 });
  app.setPath('userData', path.join(output, 'electron'));
  app.dock?.hide();
  await app.whenReady();
  const names = [
    ...require('./fixtures/railgun-kohaku-adapter-sources').SOURCES,
    'scripts/qualify-railgun-shield-build.js',
    'scripts/fixtures/railgun-shield-receive-job.js',
    'scripts/fixtures/railgun-wallet-snapshot-job.js',
    'src/main/wallet/railgun-shield-pins.json',
    ...[
      'shield-job',
      'shield-policy',
      'shield-prepare',
      'engine-runtime',
      'process',
      'process-entry',
      'process-guards',
    ].map((n) => 'src/main/wallet/railgun-' + n + '.js'),
    'src/main/wallet/railgun-engine-manifest.json',
    'src/main/networks/privacy-context.js',
  ];
  const hashes = () =>
    Object.fromEntries(
      names.map((name) => [
        name,
        createHash('sha256')
          .update(fs.readFileSync(path.join(__dirname, '..', name)))
          .digest('hex'),
      ])
    );
  const report = {
    observedAt: new Date().toISOString(),
    sourceSha256: hashes(),
    accountsOpened: 0,
    networkRequests: 0,
    submissions: 0,
    enrolledPreparationQualified: false,
    deploymentVerified: false,
    signingEnabled: false,
    passed: false,
    builds: [],
    controls: [],
  };
  const scope = require('../src/main/networks/privacy-context').createPrivacyScope({
    profileId: 'public-shield-fixture',
    signal: new AbortController().signal,
  });
  const handle = scope.getContext({
    kind: 'private-account',
    principal: 'railgun:0',
    protocol: 'railgun',
    deployment: 'sepolia',
    chainId: 11155111,
    role: 'engine',
    operation: 'shield-prepare',
  });
  const recipient =
    '0zk1qy2ukgmgcks06peftlkz4csqyxgdsl79qucx5gufxga5p346duevlrv7j6fe3z53llk55mjaa43ds8l0lq3r5nnjcf4zfkzgwnugrxc9emu7v44nn3w4kxwxqa3';
  const amount = '100000000000000';
  async function run(filename, payload, negative = false) {
    let task,
      result,
      sequence = 0,
      supplied = false;
    try {
      task = require('../src/main/wallet/railgun-process').startRailgunProcess({
        handle,
        filename,
        input: JSON.stringify({ archive }),
        startupMs: 120000,
        lifetimeMs: 180000,
        broker: {
          signal: scope.signal,
          async dispatch(wire) {
            const message = JSON.parse(wire);
            assert.equal(message.id, ++sequence);
            assert.ok(!result);
            if (message.method === 'input') {
              assert.equal(supplied, false);
              supplied = true;
              return JSON.stringify({ id: message.id, value: payload });
            }
            assert.equal(negative, false);
            assert.equal(message.method, 'result');
            assert.equal(supplied, true);
            assert.equal(message.value.guards.attempts, 0);
            result = message.value;
            return JSON.stringify({ id: message.id, value: null });
          },
        },
      });
      if (negative) {
        await assert.rejects(task.ready);
        assert.equal(supplied, true);
      } else {
        await task.ready;
        assert.ok(result);
      }
      task.close();
      assert.equal(
        (await task.closed).code,
        negative ? 'RAILGUN_PROCESS_FAILED' : 'RAILGUN_PROCESS_CLOSED'
      );
      return result;
    } finally {
      task?.close();
      if (task) await task.closed;
    }
  }
  let stage = 'build';
  try {
    for (let n = 0; n < 2; n++) {
      const started = Date.now();
      const built = await run(require.resolve('../src/main/wallet/railgun-shield-job'), {
        amount,
        recipient,
      });
      const validated =
        require('../src/main/wallet/railgun-shield-policy').validateRailgunNativeShield(
          built.transaction,
          { amount, npk: built.npk }
        );
      assert.equal(validated.noteValue, built.noteValue);
      const received = await run(require.resolve('./fixtures/railgun-shield-receive-job'), {
        ...built,
        recipient,
      });
      report.builds.push({ ...built, received, elapsedMs: Date.now() - started });
    }
    assert.notEqual(report.builds[0].npk, report.builds[1].npk);
    assert.notEqual(report.builds[0].transaction.data, report.builds[1].transaction.data);
    stage = 'negative';
    for (const [kind, payload] of [
      ['zero', { amount: '0', recipient }],
      ['recipient', { amount, recipient: 'invalid' }],
    ]) {
      await run(require.resolve('../src/main/wallet/railgun-shield-job'), payload, true);
      report.controls.push({ kind, refused: true });
    }
    assert.deepEqual(hashes(), report.sourceSha256);
    report.passed = true;
  } catch (error) {
    report.failure = {
      stage,
      code: /^[A-Z0-9_]+$/.test(error.code ?? '') ? error.code : error.name,
    };
  } finally {
    scope.close();
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n', {
      flag: 'wx',
      mode: 0o600,
    });
  }
  console.log(
    JSON.stringify({ passed: report.passed, failure: report.failure, builds: report.builds.length })
  );
  return report.passed ? 0 : 1;
}
main().then(
  (code) => app.exit(code),
  () => app.exit(1)
);
