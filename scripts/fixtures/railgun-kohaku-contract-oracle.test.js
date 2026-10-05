// Pure external-contract counterexamples. These fixtures are DATA, not genuine
// accounts, plugin registries, owner receipts, or native qualification evidence.
const {
  assertSurface,
  assertReadProjection,
  assertOpaqueOperationShape,
  assertForwardedSettlement,
} = require('./railgun-kohaku-contract-oracle');
const pin = require('./railgun-kohaku-contract-pin.json');
const token = { __type: 'erc20', contract: '0x' + 'ab'.repeat(20) };
const nft = { __type: 'erc721', contract: token.contract, tokenId: 9007199254740993n };
const hash = '0x' + '1'.repeat(64);
const note = (id, amount, spentTxid = false, asset = token) => ({
  id,
  asset,
  amount,
  spentTxid,
  tag: 'unverified',
});
const expected = {
  instanceId: 'public-fixture-instance',
  received: [note('0:0', 12n), note('0:1', 8n), note('0:2', 5n, hash), note('0:3', 1n, false, nft)],
};
const balances = [
  { asset: token, amount: 20n, tag: 'unverified' },
  { asset: nft, amount: 1n, tag: 'unverified' },
];
const projection = (method, value, args = [], promiseReturned = true, read = expected) =>
  assertReadProjection(read, { method, value, args, promiseReturned });
test('external balance/notes filtering laws conserve only unspent amounts and bigint token IDs', () => {
  projection('instanceId', expected.instanceId);
  projection('balance', balances);
  projection(
    'notes',
    expected.received.filter((n) => n.spentTxid === false)
  );
  projection('notes', expected.received, [undefined, true]);
  projection('balance', [], [[]]);
  projection('notes', [], [[], true]);
  projection('balance', [balances[0]], [[{ ...token, contract: '0x' + 'AB'.repeat(20) }]]);
  projection('notes', expected.received.slice(0, 3), [[token], true]);
  projection('balance', [], [[{ __type: 'native' }]]);
});
test.each([
  ['numeric amount loses bigint contract', () => [{ ...balances[0], amount: 20 }, balances[1]]],
  ['spent input included in balance', () => [{ ...balances[0], amount: 25n }, balances[1]]],
  ['unverified upgraded to spendable', () => [{ ...balances[0], tag: 'verified' }, balances[1]]],
  ['WETH relabeled native', () => [{ ...balances[0], asset: { __type: 'native' } }, balances[1]]],
  [
    'precision-losing NFT ID',
    () => [balances[0], { ...balances[1], asset: { ...nft, tokenId: Number(nft.tokenId) } }],
  ],
  ['duplicate asset balance', () => [balances[0], balances[0]]],
  ['omitted nonzero asset', () => [balances[0]]],
])('refuses externally meaningful violation: %s', (_name, value) => {
  expect(() => projection('balance', value())).toThrow();
});
test.each([
  ['spent note returned by default', expected.received, []],
  [
    'includeSpent silently ignored',
    expected.received.filter((n) => n.spentTxid === false),
    [undefined, true],
  ],
  ['explicit empty filter ignored', expected.received, [[], true]],
  [
    'duplicate note substituted',
    [expected.received[0], expected.received[0], expected.received[3]],
    [],
  ],
])('refuses note-selection violation: %s', (_name, notes, args) => {
  expect(() => projection('notes', notes, args)).toThrow();
});
test('same values returned synchronously still violate the external async signature', () => {
  expect(() => projection('balance', balances, [], false)).toThrow();
  expect(() => projection('instanceId', expected.instanceId, [], false)).toThrow();
});
test('ERC1155 may neither vanish from unfiltered reads nor be relabeled; explicit supported filter still works', () => {
  const unsupported = note('0:4', 2n, false, { ...nft, __type: 'erc1155' });
  const read = { ...expected, received: [...expected.received, unsupported] };
  expect(() => projection('balance', balances, [], true, read)).toThrow();
  expect(() =>
    projection(
      'notes',
      [...expected.received, { ...unsupported, asset: nft }],
      [undefined, true],
      true,
      read
    )
  ).toThrow();
  projection('balance', [balances[0]], [[token]], true, read);
});
function surface(mode) {
  return {
    instanceId() {},
    balance() {},
    notes() {},
    status() {},
    ...(mode === 'view'
      ? {}
      : { close() {}, signal: new AbortController().signal, closed: Promise.resolve() }),
    ...Object.fromEntries((pin.freedomModes[mode] || []).map((m) => [m, () => {}])),
  };
}
test.each(['view', 'read', 'private', 'public'])(
  'surface checker has a closed %s feature set, not generic full Kohaku features',
  (mode) => {
    const dataOnlyShape = surface(mode);
    assertSurface(dataOnlyShape, mode);
    dataOnlyShape.prepareTransferMulti = () => {};
    expect(() => assertSurface(dataOnlyShape, mode)).toThrow();
  }
);
test('public Shield cannot advertise private preparation and private mode cannot advertise Shield', () => {
  expect(() => assertSurface({ ...surface('public'), prepareUnshield() {} }, 'public')).toThrow();
  expect(() => assertSurface({ ...surface('private'), prepareShield() {} }, 'private')).toThrow();
});
test.each(['private', 'public'])(
  'operation shape is opaque for %s; shape match makes no genuineness claim',
  (lane) => {
    assertOpaqueOperationShape(Object.freeze({ __type: pin.operations[lane] }), lane);
    expect(() =>
      assertOpaqueOperationShape(
        Object.freeze({ __type: pin.operations[lane], rawTransaction: '0x' }),
        lane
      )
    ).toThrow();
    expect(() =>
      assertOpaqueOperationShape(
        Object.freeze({ __type: pin.operations[lane === 'private' ? 'public' : 'private'] }),
        lane
      )
    ).toThrow();
  }
);
const fulfilled = (value) => ({ status: 'fulfilled', value, promiseReturned: true });
const rejected = (reason) => ({ status: 'rejected', reason, promiseReturned: true });
test.each(['private', 'public'])(
  'specialized %s acknowledgment is forwarded without void or value reconstruction',
  (lane) => {
    const delegated = fulfilled(Object.freeze({ hash }));
    assertForwardedSettlement(delegated, delegated, { lane, outcome: 'acknowledged', hash });
    for (const altered of [
      fulfilled(undefined),
      fulfilled(true),
      fulfilled({ hash }),
      fulfilled({ status: 'success' }),
    ])
      expect(() =>
        assertForwardedSettlement(altered, delegated, { lane, outcome: 'acknowledged', hash })
      ).toThrow();
  }
);
test('uncertainty differs by lane: private structured value, public original rejected journal error', () => {
  const value = { transactionHash: hash, submissionStatus: 'unknown' };
  const privateResult = fulfilled(value);
  const publicResult = rejected(
    Object.assign(Error('public synthetic uncertainty'), value, {
      code: 'PRIVATE_BROADCAST_UNCERTAIN',
    })
  );
  assertForwardedSettlement(privateResult, privateResult, {
    lane: 'private',
    outcome: 'uncertain',
    hash,
  });
  assertForwardedSettlement(publicResult, publicResult, {
    lane: 'public',
    outcome: 'uncertain',
    hash,
  });
  expect(() =>
    assertForwardedSettlement(fulfilled(publicResult.reason), publicResult, {
      lane: 'public',
      outcome: 'uncertain',
      hash,
    })
  ).toThrow();
  expect(() =>
    assertForwardedSettlement(rejected(value), privateResult, {
      lane: 'private',
      outcome: 'uncertain',
      hash,
    })
  ).toThrow();
});
test('refusal/recovery-required is not a private success and a public denial remains rejected', () => {
  const refusal = fulfilled(Object.freeze({ status: 'recovery-required', stage: 'completion' }));
  assertForwardedSettlement(refusal, refusal, { lane: 'private', outcome: 'refused' });
  expect(() =>
    assertForwardedSettlement(fulfilled(undefined), refusal, {
      lane: 'private',
      outcome: 'refused',
    })
  ).toThrow();
  const error = rejected(Object.assign(Error('unavailable'), { code: 'RAILGUN_KOHAKU_REFUSED' }));
  assertForwardedSettlement(error, error, { lane: 'public', outcome: 'refused' });
  expect(() =>
    assertForwardedSettlement(refusal, refusal, { lane: 'public', outcome: 'refused' })
  ).toThrow();
});

test('public prior unresolved journal error stays rejected and retains identity', () => {
  const error = rejected(
    Object.assign(Error('public prior record'), { code: 'PRIVATE_SUBMISSION_UNRESOLVED' })
  );
  assertForwardedSettlement(error, error, { lane: 'public', outcome: 'unresolved' });
  expect(() =>
    assertForwardedSettlement(fulfilled(error.reason), error, {
      lane: 'public',
      outcome: 'unresolved',
    })
  ).toThrow();
});
test('correct result values do not excuse a synchronous submitter signature', () => {
  const delegated = fulfilled({ hash });
  expect(() =>
    assertForwardedSettlement({ ...delegated, promiseReturned: false }, delegated, {
      lane: 'private',
      outcome: 'acknowledged',
      hash,
    })
  ).toThrow();
});
