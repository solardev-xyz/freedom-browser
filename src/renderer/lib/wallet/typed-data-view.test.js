// The approval screen's text for the core's view of typed data
// (freedom-core #88): every value whole, structs and arrays nested.
const { simulatedView } = require('../../../../test/helpers/simulated-vault-core.js');

describe('typed-data-view', () => {
  let mod;
  beforeAll(async () => {
    mod = await import('./typed-data-view.js');
  });

  test('nested arrays, empty arrays and empty structs, with the domain first', () => {
    const view = simulatedView({
      domain: { name: 'Arr', chainId: '0x64', salt: '0x' + '11'.repeat(32) },
      types: {
        Item: [{ name: 'id', type: 'uint32' }, { name: 'tags', type: 'string[]' }],
        E: [],
        M: [
          { name: 'items', type: 'Item[]' },
          { name: 'nested', type: 'uint256[][]' },
          { name: 'none', type: 'address[]' },
          { name: 'empty', type: 'E' },
          { name: 'flag', type: 'bool' },
          { name: 'raw', type: 'bytes' },
        ],
      },
      message: {
        items: [{ id: 1, tags: ['a', 'b'] }, { id: 2, tags: [] }],
        nested: [['1'], [], ['2', '3']],
        none: [],
        empty: {},
        flag: false,
        raw: '0xABCD',
      },
    });
    expect(mod.formatTypedDataView(view)).toBe(
      [
        'Domain:',
        '  name: Arr',
        '  chainId: 100',
        `  salt: 0x${'11'.repeat(32)}`,
        '',
        'M:',
        '  items (Item[]):',
        '    [0]:',
        '      id: 1',
        '      tags (string[]):',
        '        [0]: a',
        '        [1]: b',
        '    [1]:',
        '      id: 2',
        '      tags (string[]): (empty)',
        '  nested (uint256[][]):',
        '    [0]:',
        '      [0]: 1',
        '    [1]: (empty)',
        '    [2]:',
        '      [0]: 2',
        '      [1]: 3',
        '  none (address[]): (empty)',
        '  empty (E):',
        '    (no fields)',
        '  flag: false',
        '  raw: 0xabcd',
      ].join('\n')
    );
  });

  test('an empty domain, and the chain labels', () => {
    const view = simulatedView({ domain: {}, types: { M: [] }, message: {} });
    expect(mod.formatTypedDataView(view)).toBe('Domain:\n  (empty)\n\nM:\n  (no fields)');
    expect(mod.chainLabel('1', { 1: { name: 'Ethereum' } })).toBe('Ethereum (chain 1)');
    expect(mod.chainLabel('9', {})).toBe('chain 9');
    expect(mod.chainIdText('0x20000000000000')).toBe('9007199254740992');
    expect(mod.ignoredText({ ignored: ['x'] })).toBe("The site also sent this field, which isn't signed: x");
    expect(mod.ignoredText({ ignored: [] })).toBeNull();
  });
});
