/** Mock-owner instrumentation controls; no native authority qualification. */
const wallet = '../../src/main/wallet/';
const hash = '0x' + 'ab'.repeat(32);
afterEach(() => {
  jest.resetModules();
  jest.dontMock(wallet + 'railgun-account-wallet');
});
function readSetup({ alias = false, work = false, wrongOwner = false, frozen = false } = {}) {
  jest.resetModules();
  const helper = require('./railgun-kohaku-public-integration');
  const asset = { __type: 'erc20', contract: '0x' + 'ab'.repeat(20) };
  const received = [0, 1, 2].map((i) => ({
    id: `0:${i}`,
    asset: { ...asset },
    amount: BigInt(i + 1),
    spentTxid: i === 2 ? hash : false,
    tag: 'unverified',
  }));
  const baseline = { read: { instanceId: 'fixture', received } },
    account = {};
  const owners = { identity: { descriptor: { instanceId: wrongOwner ? 'other' : 'fixture' } } };
  const current = jest.fn((a, o) => {
    expect(a).toBe(account);
    expect(o).toBe(owners);
    return baseline;
  });
  jest.doMock(wallet + 'railgun-account-wallet', () => ({ readRailgunAccountOwnedNotes: current }));
  let activity = 0;
  const selected = (filter, spent = false) =>
    received.filter(
      (n) =>
        (spent || !n.spentTxid) &&
        (filter === undefined ||
          filter.some((a) => a.__type === 'erc20' && a.contract.toLowerCase() === asset.contract))
    );
  const returned = (values) =>
    frozen
      ? Object.freeze(
          values.map((v) => Object.freeze({ ...v, asset: Object.freeze({ ...v.asset }) }))
        )
      : values;
  const adapter = Object.freeze({
    provenance: 'host-supplied',
    signal: new AbortController().signal,
    closed: Promise.resolve(),
    close() {},
    prepareShield() {},
    async instanceId() {
      if (work) activity++;
      return 'fixture';
    },
    async balance(filter) {
      const notes = selected(filter);
      return returned(
        notes.length
          ? [
              {
                asset: alias ? received[0].asset : { ...asset },
                amount: notes.reduce((n, v) => n + v.amount, 0n),
                tag: 'unverified',
              },
            ]
          : []
      );
    },
    async notes(filter, spent) {
      const notes = selected(filter, spent);
      return returned(alias ? notes : notes.map((note) => ({ ...note, asset: { ...note.asset } })));
    },
  });
  return { helper, adapter, account, owners, measure: () => ({ activity }), current };
}
test('13 read vectors join owners and test detached mutation without added work', async () => {
  const s = readSetup();
  expect(await s.helper.qualifyPublicAdapterReads(s)).toMatchObject({
    calls: 13,
    detachedMutationIsolation: true,
  });
  expect(s.current).toHaveBeenCalledTimes(14);
});
test.each([{ alias: true }, { work: true }, { wrongOwner: true }, { frozen: true }])(
  'rejects alias, work or owner drift %j',
  async (options) => {
    const s = readSetup(options);
    await expect(s.helper.qualifyPublicAdapterReads(s)).rejects.toThrow();
  }
);
test('three refused reads must remain refused and cause zero added activity', async () => {
  jest.resetModules();
  const helper = require('./railgun-kohaku-public-integration');
  let calls = 0;
  const denied = () => {
    calls++;
    return Promise.reject(
      Object.assign(Error('refused'), { code: 'RAILGUN_KOHAKU_PUBLIC_ADAPTER_REFUSED' })
    );
  };
  const adapter = { instanceId: denied, balance: denied, notes: denied };
  expect(await helper.assertPublicAdapterReadRefusals(adapter, () => ({ jobs: 0 }))).toEqual({
    calls: 3,
    noAdditionalMeasuredWork: true,
  });
  expect(calls).toBe(3);
  await expect(
    helper.assertPublicAdapterReadRefusals(adapter, () => ({ calls }))
  ).rejects.toThrow();
});
