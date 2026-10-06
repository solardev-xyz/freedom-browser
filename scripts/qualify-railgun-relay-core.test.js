/** Structural runner tests only; no Electron or engine is executed. */
const subject = require('./qualify-railgun-relay-core');
const { createRailgunRelayUnsignedData } = require('./fixtures/railgun-relay-unsigned-data');
const { normalizeRailgunRelayDraftCapsule } = require('../src/main/wallet/railgun-relay-capsule');
const data = require('./fixtures/railgun-relay-core-data');
const { EXPECTED_GUARDS } = require('./qualify-railgun-relay-proof');
function values() {
  const f = createRailgunRelayUnsignedData();
  f.draft.selection.position = 0;
  f.draft.intent.context.inputAmount = '1000';
  f.draft.intent.context.selfAmount = '900';
  const draft = normalizeRailgunRelayDraftCapsule(f.draft);
  const draftText = JSON.stringify(draft.data);
  const made = {
    draftText,
    draftSha256: data.sha(draftText),
    syntheticQuoteUnsigned: true,
    guards: EXPECTED_GUARDS,
  };
  const history = data.capturedHistory(draftText);
  const checked = {
    draftSha256: made.draftSha256,
    draftDigest: draft.digest,
    originalRoot: draft.data.intent.expected.merkleRoot.slice(2),
    grownRoot: '9'.repeat(64),
    historicalRoot: history.proof.root,
    publicSignals: [
      ...Array(5).fill('0'.repeat(64)),
      history.proof.root,
      ...Array(2).fill('0'.repeat(64)),
    ],
    guards: EXPECTED_GUARDS,
  };
  for (const key of subject.TRUE_CHECKS) checked[key] = true;
  for (const key of subject.FALSE_CHECKS) checked[key] = false;
  return { made, checked };
}
test('import has no execution and pipeline serially forwards only canonical draft to recovery', async () => {
  const { made, checked } = values(),
    calls = [];
  const result = await subject.pipeline({
    archive: '/fixture.asar',
    current: jest.fn(),
    run: async (role, file, input, validate, ms) => {
      calls.push({ role, file, input, ms });
      const value = role === 'producer' ? made : checked;
      validate(value);
      return value;
    },
  });
  expect(calls).toEqual([
    {
      role: 'producer',
      file: './fixtures/railgun-relay-core-producer-job',
      input: { archive: '/fixture.asar' },
      ms: 30000,
    },
    {
      role: 'recovery-math',
      file: './fixtures/railgun-relay-core-recovery-job',
      input: { archive: '/fixture.asar', draftText: made.draftText },
      ms: 30000,
    },
  ]);
  expect(result).toEqual({
    producerGuards: EXPECTED_GUARDS,
    syntheticQuoteUnsigned: true,
    recovery: checked,
  });
  expect(JSON.stringify(result)).not.toContain('draftText');
});
test('pipeline waits original runner settlement and never starts recovery early', async () => {
  const { made, checked } = values();
  let release;
  const gate = new Promise((r) => {
    release = r;
  });
  const run = jest.fn(async (role) => (role === 'producer' ? gate : checked));
  const pending = subject.pipeline({ archive: '/fixture.asar', current: () => {}, run });
  await Promise.resolve();
  expect(run).toHaveBeenCalledTimes(1);
  release(made);
  await pending;
  expect(run).toHaveBeenCalledTimes(2);
});
test('original first job rejection prevents second job and preserves error', async () => {
  const error = Error('closed unknown');
  const run = jest.fn().mockRejectedValue(error);
  await expect(subject.pipeline({ archive: '/fixture.asar', current: () => {}, run })).rejects.toBe(
    error
  );
  expect(run).toHaveBeenCalledTimes(1);
});
test.each(['draftSha256', 'extraPrivate', 'guards', 'canonical'])(
  'producer rejects %s',
  (fault) => {
    const { made } = values();
    const bad = data.copy(made);
    if (fault === 'draftSha256') bad.draftSha256 = '0'.repeat(64);
    if (fault === 'extraPrivate') bad.witness = { nullifyingKey: 'secret' };
    if (fault === 'guards') bad.guards = { hooks: ['hook'], canaries: 1, attempts: 0 };
    if (fault === 'canonical') {
      bad.draftText = ' ' + bad.draftText;
      bad.draftSha256 = data.sha(bad.draftText);
    }
    expect(() => subject.producer(bad)).toThrow();
  }
);
test.each([...subject.TRUE_CHECKS, ...subject.FALSE_CHECKS])(
  'exact recovery contract rejects altered %s',
  (field) => {
    const { made, checked } = values();
    checked[field] = !checked[field];
    expect(() => subject.recovery(checked, made)).toThrow();
  }
);
test.each(['private', 'root', 'history', 'digest', 'signalCount', 'guards'])(
  'rejects changed recovery %s',
  (kind) => {
    const { made, checked } = values();
    if (kind === 'private') checked.prePoi = { randomsIn: ['secret'] };
    if (kind === 'root') checked.grownRoot = checked.originalRoot;
    if (kind === 'history') checked.historicalRoot = '0'.repeat(64);
    if (kind === 'digest') checked.draftDigest = '0'.repeat(64);
    if (kind === 'signalCount') checked.publicSignals.pop();
    if (kind === 'guards') checked.guards = { ...EXPECTED_GUARDS, attempts: 1 };
    expect(() => subject.recovery(checked, made)).toThrow();
  }
);
test('runner return cannot bypass callback validation', async () => {
  const { made, checked } = values();
  checked.proofVerified = true;
  await expect(
    subject.pipeline({
      archive: '/fixture.asar',
      current: () => {},
      run: async (role) => (role === 'producer' ? made : checked),
    })
  ).rejects.toThrow();
});
test('expired outer scope prevents job admission', async () => {
  const run = jest.fn();
  await expect(
    subject.pipeline({
      archive: '/fixture.asar',
      current: () => {
        throw Error('expired');
      },
      run,
    })
  ).rejects.toThrow('expired');
  expect(run).not.toHaveBeenCalled();
});
