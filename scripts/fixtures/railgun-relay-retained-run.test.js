// Filesystem and fake-job orchestration only: no real crypto/native job.
const fs = require('fs'),
  os = require('os'),
  path = require('path'),
  crypto = require('crypto');
const { execFileSync, spawnSync } = require('child_process');
const runner = require('./railgun-relay-retained-run');
const fixed = require('./railgun-relay-retained-inputs.json');
const basis = require('./railgun-relay-retained-basis.json');
const baseline = require('../qualify-railgun-relay-proof');
const engine = require('../../src/main/wallet/railgun-engine-manifest.json');
const { closedJob } = require('./railgun-relay-wire-run');
const { main } = require('../qualify-railgun-relay-retained');
const temp = () =>
  fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'railgun-retained-run-test-'));
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const write = (dir, name, bytes) => {
  const p = path.join(dir, name);
  fs.writeFileSync(p, bytes);
  return p;
};
const pin = (b) => ({ bytes: b.length, sha256: sha(b) });
function setup() {
  const config = {
    archive: '/input/engine.asar',
    proverArchive: '/input/prover.asar',
    artifactDirectory: '/input/artifacts',
    wireBuild: '/input/wire',
    gasBundle: '/input/gas.cjs',
  };
  const snapshot = Object.freeze({
    publicCaseText: 'PUBLIC_CASE',
    signedQuoteText: 'SIGNED_QUOTE',
    publicCase: Object.freeze({ marker: 'retained-only' }),
    publicCaseSha256: 'a'.repeat(64),
    signedQuoteSha256: 'b'.repeat(64),
    signedDataSha256: 'c'.repeat(64),
    historicalEvaluationAt: 1,
  });
  const quote = {
    publicCaseSha256: snapshot.publicCaseSha256,
    signedQuoteSha256: snapshot.signedQuoteSha256,
    publicKeyBasisSha256: basis.independentPublicKeyBasisSha256,
    signedDataSha256: snapshot.signedDataSha256,
    originalQuoteSignatureVerified: true,
    publicRecipientAndFeeCommitmentBound: true,
    historicalEvaluationAt: 1,
    historicalEvaluationDerivedFromExpiry: true,
    historicalWallClockEstablished: false,
    currentQuoteAdmission: false,
    uniqueQuoteCalldataCommitment: false,
    encryptionTranscriptReplayed: false,
    feeCiphertextDecryptableByBroadcaster: false,
    serviceAcceptanceQualified: false,
    authorityGranted: false,
    wireBuildSha256: fixed.wireBuildSha256,
    gasBundleSha256: fixed.gasBundleSha256,
    engineArchiveIdentity: { sha256: engine.sha256, bytes: engine.size },
    guards: baseline.EXPECTED_GUARDS,
  };
  const verification = {
    minGasPrice: 1,
    transactionVerified: true,
    prePoiVerified: true,
    feeAndSelfCommitmentsMatched: true,
    sameTransactionPrePoiRootMatched: true,
    syntheticListRootMatched: true,
    productionPolicyRefused: true,
    productionPayloadRefused: true,
    changedSignalsRefused: 13,
    authorityGranted: false,
    serviceAcceptanceQualified: false,
    guards: baseline.EXPECTED_GUARDS,
  };
  const calls = [];
  const current = jest.fn();
  const run = async (role, filename, input, validate, ms) => {
    calls.push({ role, filename, input, ms });
    const value = role === 'quote' ? quote : verification;
    validate(value);
    return value;
  };
  return { config, snapshot, quote, verification, calls, current, run };
}
test('fixed pipeline runs quote then unchanged proof verifier on retained snapshot, never producer', async () => {
  const f = setup(),
    result = await runner.pipeline(f);
  expect(f.calls.map((c) => c.role)).toEqual(['quote', 'verifier']);
  expect(f.calls.map((c) => c.filename)).toEqual([
    './railgun-relay-retained-job',
    './railgun-relay-verify-job',
  ]);
  expect(f.calls[1].input.publicCase).toBe(f.snapshot.publicCase);
  expect(f.calls[0].input.signedQuoteText).toBe(f.snapshot.signedQuoteText);
  expect(result.verification).toBe(f.verification);
});
test.each([
  'wireBuildSha256',
  'gasBundleSha256',
  'engineArchiveIdentity',
  'publicCaseSha256',
  'signedQuoteSha256',
  'publicKeyBasisSha256',
  'originalQuoteSignatureVerified',
  'publicRecipientAndFeeCommitmentBound',
  'feeCiphertextDecryptableByBroadcaster',
  'currentQuoteAdmission',
  'guards',
  'extra',
])('quote result exact contract refuses changed %s before proof', async (field) => {
  const f = setup();
  f.quote[field] =
    {
      engineArchiveIdentity: { sha256: '0'.repeat(64), bytes: engine.size },
      originalQuoteSignatureVerified: false,
      publicRecipientAndFeeCommitmentBound: false,
      feeCiphertextDecryptableByBroadcaster: true,
      currentQuoteAdmission: true,
      guards: { ...baseline.EXPECTED_GUARDS, attempts: 1 },
    }[field] ?? 'different';
  await expect(runner.pipeline(f)).rejects.toThrow();
  expect(f.calls.map((c) => c.role)).toEqual(['quote']);
});
test('even callback-skipping runner cannot smuggle failed quote into proof', async () => {
  const f = setup();
  f.run = jest.fn(async () => ({ ...f.quote, originalQuoteSignatureVerified: false }));
  await expect(runner.pipeline(f)).rejects.toThrow();
  expect(f.run).toHaveBeenCalledTimes(1);
});
test('oversized combined request refuses before child start', async () => {
  const f = setup();
  f.snapshot = { ...f.snapshot, publicCaseText: 'x'.repeat(65536) };
  f.run = jest.fn();
  await expect(runner.pipeline(f)).rejects.toThrow();
  expect(f.run).not.toHaveBeenCalled();
});
test.each(['changedSignalsRefused', 'productionPolicyRefused', 'authorityGranted'])(
  'unchanged proof result validator refuses %s',
  async (field) => {
    const f = setup();
    f.verification[field] = {
      changedSignalsRefused: 12,
      productionPolicyRefused: false,
      authorityGranted: true,
    }[field];
    await expect(runner.pipeline(f)).rejects.toThrow();
  }
);
test('failed quote closure cannot admit next stage', async () => {
  const f = setup();
  f.run = jest.fn(async () => {
    throw new Error('closed failed');
  });
  await expect(runner.pipeline(f)).rejects.toThrow('closed failed');
  expect(f.run).toHaveBeenCalledTimes(1);
});
test('actual closedJob holds result until original closure then observes exact role once', async () => {
  const signal = new AbortController().signal,
    rows = [];
  let closeResolve;
  const closed = new Promise((r) => {
    closeResolve = r;
  });
  const outcome = {
    code: 'RAILGUN_PROCESS_CLOSED',
    exitCode: 15,
    escalated: false,
    peerDisconnected: false,
    peakRssBytes: 1,
  };
  let finished = false;
  const pending = closedJob(
    (options) => ({
      ready: options.broker.dispatch(
        JSON.stringify({ id: 1, method: 'result', value: { ok: true } })
      ),
      closed,
      close: () => {},
    }),
    { signal, process: {} },
    (v) => expect(v).toEqual({ ok: true }),
    10000,
    rows,
    'quote'
  ).then((v) => {
    finished = true;
    return v;
  });
  await new Promise((r) => setImmediate(r));
  expect(finished).toBe(false);
  expect(rows).toEqual([]);
  closeResolve(outcome);
  await expect(pending).resolves.toEqual({ ok: true });
  expect(rows).toEqual([{ role: 'quote', ...outcome }]);
});
test.each([{ exitCode: 0 }, { escalated: true }, { peerDisconnected: true }])(
  'actual closedJob refuses altered original outcome %j',
  async (change) => {
    const outcome = {
      code: 'RAILGUN_PROCESS_CLOSED',
      exitCode: 15,
      escalated: false,
      peerDisconnected: false,
      ...change,
    };
    await expect(
      closedJob(
        (options) => ({
          ready: options.broker.dispatch(
            JSON.stringify({ id: 1, method: 'result', value: { ok: true } })
          ),
          closed: Promise.resolve(outcome),
          close: () => {},
        }),
        { signal: new AbortController().signal, process: {} },
        () => {},
        10000,
        [],
        'quote'
      )
    ).rejects.toThrow();
  }
);
test('bounded reader keeps exact bytes and refuses size/hash mismatch or symlink', () => {
  const dir = temp(),
    bytes = Buffer.from('public\n'),
    filename = write(dir, 'data', bytes);
  expect(runner.readBounded(filename, 7, pin(bytes))).toEqual(bytes);
  expect(() => runner.readBounded(filename, 6, pin(bytes))).toThrow();
  expect(() =>
    runner.readBounded(filename, 7, { ...pin(bytes), sha256: '0'.repeat(64) })
  ).toThrow();
  const link = path.join(dir, 'link');
  fs.symlinkSync(filename, link);
  expect(() => runner.readBounded(link, 7, pin(bytes))).toThrow();
});
test('bounded reader detects same-size mutation after descriptor snapshot', () => {
  const dir = temp(),
    filename = write(dir, 'data', Buffer.from('public\n')),
    original = fs.readSync;
  const spy = jest.spyOn(fs, 'readSync').mockImplementation((...args) => {
    const n = original(...args);
    fs.writeFileSync(filename, 'change\n');
    return n;
  });
  try {
    expect(() => runner.readBounded(filename, 7)).toThrow();
  } finally {
    spy.mockRestore();
  }
});
test('config permits locations only; duplicate/digest override are refused', () => {
  const dir = temp();
  const input = write(dir, 'input', 'x'),
    sub = path.join(dir, 'directory');
  fs.mkdirSync(sub);
  const config = {
    archive: input,
    proverArchive: input,
    artifactDirectory: sub,
    wireBuild: sub,
    gasBundle: input,
    publicCase: input,
    signedQuote: input,
  };
  const valid = write(dir, 'valid.json', JSON.stringify(config));
  expect(runner.readConfig(valid)).toEqual(config);
  const changed = write(
    dir,
    'changed.json',
    JSON.stringify({ ...config, wireBuildSha256: '0'.repeat(64) })
  );
  expect(() => runner.readConfig(changed)).toThrow();
  const duplicate = write(
    dir,
    'duplicate.json',
    JSON.stringify(config).replace('"archive":', '"archive":"duplicate","archive":')
  );
  expect(() => runner.readConfig(duplicate)).toThrow();
});
test('fresh directory refuses preexisting and all input overlaps', () => {
  const dir = temp(),
    input = path.join(dir, 'input');
  fs.mkdirSync(input);
  expect(() => runner.freshDirectory(input, { input })).toThrow();
  expect(() => runner.freshDirectory(path.join(input, 'nested'), { input })).toThrow();
  expect(fs.existsSync(path.join(input, 'nested'))).toBe(false);
  expect(runner.freshDirectory(path.join(dir, 'fresh'), { input })).toBe(path.join(dir, 'fresh'));
});
test('entry import starts no Electron/generated/prover/producer work and ordinary Node entry refuses', async () => {
  const entry = require.resolve('../qualify-railgun-relay-retained');
  expect(() =>
    execFileSync(process.execPath, [
      '-e',
      `require(${JSON.stringify(entry)});const bad=Object.keys(require.cache).filter(p=>/electron|upstream\\.cjs|serial-prover|railgun-relay-proof-job/.test(p));if(bad.length)throw new Error(JSON.stringify(bad));`,
    ])
  ).not.toThrow();
  await expect(main([])).rejects.toThrow('Usage');
  const child = spawnSync(process.execPath, [entry, 'config', 'output'], { encoding: 'utf8' });
  expect(child.status).toBe(1);
  expect(child.stderr).toContain('Retained public verification refused');
});
