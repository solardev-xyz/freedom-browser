jest.mock('./railgun-native-assertions', () => ({
  assert: require('assert/strict'),
}));
const { create } = require('./railgun-combined-poi-second-signature-stop');
const capsule = { version: 1, selection: { kind: 'railgun-token-unshield' } };
const message = { id: 3, method: 'private-intent', value: { capsule } };
const reply = JSON.stringify({
  id: 3,
  value: { status: 'signed', signature: ['original'] },
});
const stores = () => ({
  reservations: { inspect: jest.fn(async () => ({ signing: 2 })) },
  capsules: {
    inspect: jest.fn(async () => ({ records: 2, signatures: 2, proofs: 1 })),
  },
});
test('only exact second original committed reply is replaced; retained bytes still checked', async () => {
  const stop = create(),
    s = stores();
  expect(await stop.after('railgun-private-operate-job.js', 'first-prove', message, reply, s)).toBe(
    reply
  );
  expect(s.capsules.inspect).not.toHaveBeenCalled();
  expect(
    await stop.after('railgun-private-operate-job.js', 'second-prove', message, reply, s)
  ).toBe(JSON.stringify({ id: 3, value: { status: 'refused' } }));
  stop.assertStopped({
    capsule,
    signature: ['original'],
    provedTransaction: null,
  });
  expect(() =>
    stop.assertStopped({
      capsule,
      signature: ['different'],
      provedTransaction: null,
    })
  ).toThrow();
  await expect(
    stop.after('railgun-private-operate-job.js', 'second-prove', message, reply, s)
  ).rejects.toThrow();
});
test.each(['unsigned', 'proof-present', 'one-record', 'wrong-id', 'wrong-kind'])(
  'does not fake commit for %s',
  async (fault) => {
    const stop = create(),
      s = stores(),
      m = JSON.parse(JSON.stringify(message));
    let r = reply;
    if (fault === 'unsigned') r = JSON.stringify({ id: 3, value: { status: 'refused' } });
    if (fault === 'proof-present')
      s.capsules.inspect.mockResolvedValue({
        records: 2,
        signatures: 2,
        proofs: 2,
      });
    if (fault === 'one-record') s.reservations.inspect.mockResolvedValue({ signing: 1 });
    if (fault === 'wrong-id') r = JSON.stringify({ id: 4, value: { status: 'signed' } });
    if (fault === 'wrong-kind') m.value.capsule.selection.kind = 'railgun-private-transfer';
    await expect(
      stop.after('railgun-private-operate-job.js', 'second-prove', m, r, s)
    ).rejects.toThrow();
    expect(stop.report().interceptedCommittedSignatureReplies).toBe(0);
  }
);
test('held genuine post-dispatch storage observation must drain before delivering refusal', async () => {
  const stop = create(),
    s = stores();
  let resolve,
    settled = false;
  s.capsules.inspect.mockImplementation(
    () =>
      new Promise((r) => {
        resolve = r;
      })
  );
  const work = stop
    .after('railgun-private-operate-job.js', 'second-prove', message, reply, s)
    .then((v) => {
      settled = true;
      return v;
    });
  await new Promise((r) => setImmediate(r));
  expect(settled).toBe(false);
  resolve({ records: 2, signatures: 2, proofs: 1 });
  await work;
  expect(stop.report().interceptedCommittedSignatureReplies).toBe(1);
});
