import { presetWalletPath } from './wallet-path-presets.js';

describe('presetWalletPath', () => {
  test.each([
    ['live', '3', "m/44'/60'/3'/0/0"],
    ['metamask', '3', "m/44'/60'/0'/0/3"],
    ['legacy', '3', "m/44'/60'/0'/3"],
  ])('%s at index %s', (scheme, index, expected) => {
    expect(presetWalletPath(scheme, index)).toBe(expected);
  });

  test('accepts the largest non-hardened index and drops leading zeros', () => {
    expect(presetWalletPath('metamask', '2147483647')).toBe("m/44'/60'/0'/0/2147483647");
    expect(presetWalletPath('metamask', '007')).toBe("m/44'/60'/0'/0/7");
  });

  test.each([[''], ['-1'], ['1.5'], ['1e3'], ['abc'], ['2147483648']])(
    'returns nothing for the account index %j',
    (index) => {
      expect(presetWalletPath('metamask', index)).toBe('');
    }
  );

  test('returns nothing for a scheme that is not a preset', () => {
    expect(presetWalletPath('custom', '1')).toBe('');
    expect(presetWalletPath('constructor', '1')).toBe('');
  });
});
