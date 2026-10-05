const {
  normalizeRailgunKohakuReadFilter: normalize,
  projectRailgunKohakuBalance: balance,
  projectRailgunKohakuNotes: notes,
} = require('./railgun-kohaku-read-data');
const erc20 = { __type: 'erc20', contract: '0x' + 'a'.repeat(40) };
const erc721 = { __type: 'erc721', contract: '0x' + 'b'.repeat(40), tokenId: 9n };
const native = { __type: 'native' };
const note = (asset, amount, spentTxid = false) => Object.freeze({ asset, amount, spentTxid });

test('projects sorted unspent totals without changing supplied notes or asset references', () => {
  const duplicate = { ...erc20, contract: erc20.contract.toUpperCase().replace('0X', '0x') };
  const received = Object.freeze([
    note(native, 7n),
    note(erc721, 1n),
    note(erc20, 11n),
    note(duplicate, 13n),
    note(erc20, 99n, 'spent'),
  ]);
  const result = balance(received, normalize(undefined));
  expect(result).toEqual([
    { asset: duplicate, amount: 24n, tag: 'unverified' },
    { asset: erc721, amount: 1n, tag: 'unverified' },
    { asset: native, amount: 7n, tag: 'unverified' },
  ]);
  expect(result[0].asset).toBe(duplicate);
  expect(result[1].asset).toBe(erc721);
  expect(Object.isFrozen(result)).toBe(true);
  expect(result.every(Object.isFrozen)).toBe(true);
  const selected = notes(received, normalize([erc20]), true);
  expect(selected).toEqual(received.slice(2));
  selected.forEach((value, index) => expect(value).toBe(received[index + 2]));
  expect(Object.isFrozen(selected)).toBe(true);
  expect(notes(received, normalize([erc20]), false)).toEqual(received.slice(2, 4));
});

test('detaches canonical deduplicated filters and distinguishes absent from empty', () => {
  const input = [{ ...erc20 }, { ...erc20, contract: '0x' + 'A'.repeat(40) }];
  const filter = normalize(input);
  expect(filter).toEqual(['erc20:' + erc20.contract]);
  expect(Object.isFrozen(filter)).toBe(true);
  input[0].contract = '0x' + 'c'.repeat(40);
  expect(balance([note(erc20, 3n)], filter)).toHaveLength(1);
  expect(normalize(undefined)).toBe(null);
  expect(balance([note(erc20, 3n)], normalize([]))).toEqual([]);
});

test.each([
  null,
  {},
  [null],
  [{}],
  [{ __type: 'native', extra: 1 }],
  [{ ...erc20, extra: 1 }],
  [{ ...erc20, contract: '0X' + 'a'.repeat(40) }],
  [{ ...erc721, tokenId: '9' }],
  [{ ...erc721, tokenId: -1n }],
  [{ ...erc721, tokenId: 1n << 256n }],
  [{ ...erc721, __type: 'erc1155' }],
  Array(1001).fill(native),
])('refuses malformed or out-of-contract filter %#', (input) => {
  expect(() => normalize(input)).toThrow();
});

test('retains filter count and NFT integer boundary acceptance', () => {
  expect(normalize(Array(1000).fill(native))).toEqual(['native']);
  expect(
    normalize([
      { ...erc721, tokenId: 0n },
      { ...erc721, tokenId: (1n << 256n) - 1n },
    ])
  ).toHaveLength(2);
});

test('unfiltered unsupported live assets refuse, supported filters exclude them, spent-only assets stay excluded', () => {
  const unsupported = note({ __type: 'erc1155', contract: erc20.contract, tokenId: 1n }, 4n);
  const received = [note(erc20, 2n), unsupported];
  expect(() => balance(received, null)).toThrow('Unsupported Kohaku balance asset');
  expect(() => notes(received, null, false)).toThrow('Unsupported Kohaku note asset');
  expect(balance(received, normalize([erc20]))).toEqual([
    { asset: erc20, amount: 2n, tag: 'unverified' },
  ]);
  expect(notes(received, normalize([erc20]), true)).toEqual([received[0]]);
  const spent = [note(unsupported.asset, 4n, 'spent')];
  expect(balance(spent, null)).toEqual([]);
  expect(notes(spent, null, false)).toEqual([]);
  expect(() => notes(spent, null, true)).toThrow('Unsupported');
});

test.each([undefined, {}, [], ['native'], Object.freeze([1]), Object.freeze([null])])(
  'projectors refuse a filter outside null or a frozen string array %#',
  (filter) => {
    expect(() => balance([], filter)).toThrow();
    expect(() => notes([], filter, false)).toThrow();
  }
);

test.each([undefined, null, 0, 'false', {}])(
  'notes projector requires a boolean %#',
  (includeSpent) => {
    expect(() => notes([], null, includeSpent)).toThrow();
  }
);

test('normalization refuses non-string custom map outputs but preserves string iterable filters', () => {
  const filters = [];
  filters.map = () => [1];
  expect(() => normalize(filters)).toThrow();
  filters.map = () => ['native'];
  expect(normalize(filters)).toEqual(['native']);
  expect(balance([note(native, 4n)], normalize(filters))).toEqual([
    { asset: native, amount: 4n, tag: 'unverified' },
  ]);
});
