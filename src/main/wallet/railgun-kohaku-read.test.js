// Surface semantics are tested against controlled read evidence here; real
// runner/journal identity and revocation are exercised by the Electron qualifier.
jest.mock('./railgun-wallet-runner', () => ({ isRailgunWalletRunner: (v) => v?.genuine === true }));
const { createRailgunKohakuRead } = require('./railgun-kohaku-read');
const asset = { __type: 'erc20', contract: '0x' + 'a'.repeat(40) };
function fixture() {
  let active = true;
  const received = [
    { id: '0:0', asset, amount: 12n, spentTxid: false, tag: 'unverified' },
    { id: '0:1', asset, amount: 8n, spentTxid: false, tag: 'unverified' },
    { id: '0:2', asset, amount: 5n, spentTxid: '0x' + '1'.repeat(64), tag: 'unverified' },
  ];
  const runner = {
    genuine: true,
    read: () => {
      if (!active) throw Error('stale');
      return {
        instanceId: 'fixture',
        received,
        readiness: { status: 'wallet-scanned-unverified', spendableGranted: false },
      };
    },
  };
  return {
    view: createRailgunKohakuRead({ runner, journal: {}, receipt: {} }),
    received,
    revoke: () => {
      active = false;
    },
  };
}
test('sums unspent observed amounts, tags them, filters case-insensitively and never exposes prepare methods', async () => {
  const { view } = fixture();
  expect(await view.balance()).toEqual([{ asset, amount: 20n, tag: 'unverified' }]);
  expect(await view.balance([{ ...asset, contract: '0x' + 'A'.repeat(40) }])).toHaveLength(1);
  expect(await view.balance([{ __type: 'native' }])).toEqual([]);
  expect(await view.balance([])).toEqual([]);
  expect(await view.notes()).toHaveLength(2);
  expect(await view.notes(undefined, true)).toHaveLength(3);
  expect(await view.status()).toMatchObject({ poi: 'unverified', spendableGranted: false });
  expect(view.prepareShield).toBeUndefined();
  expect(view.prepareTransfer).toBeUndefined();
  expect(view.prepareUnshield).toBeUndefined();
});
test('unsupported ERC1155 amounts cannot silently disappear from unfiltered balances', async () => {
  const { view, received } = fixture();
  received.push({
    asset: { __type: 'erc1155', contract: asset.contract, tokenId: 42n },
    amount: 1n,
    spentTxid: false,
  });
  await expect(view.balance()).rejects.toThrow('Unsupported');
  expect(await view.balance([asset])).toEqual([{ asset, amount: 20n, tag: 'unverified' }]);
  await expect(view.notes()).rejects.toThrow('Unsupported');
  expect(await view.notes([asset])).toHaveLength(2);
});
test('every read rechecks current evidence, including instance identity', async () => {
  const { view, revoke } = fixture();
  revoke();
  for (const method of ['instanceId', 'balance', 'notes', 'status'])
    await expect(view[method]()).rejects.toThrow('stale');
  expect(() => createRailgunKohakuRead({ runner: {} })).toThrow();
});
test('malformed asset filters and includeSpent are refused', async () => {
  const { view } = fixture();
  for (const assets of [
    null,
    [{}],
    [{ __type: 'native', contract: asset.contract }],
    [{ __type: 'erc721', contract: asset.contract, tokenId: '1' }],
  ]) {
    await expect(view.balance(assets)).rejects.toThrow();
    await expect(view.notes(assets)).rejects.toThrow();
  }
  await expect(view.notes(undefined, 'true')).rejects.toThrow();
});
