import { parseEthereumUri, parseWeiValue } from './ethereum-uri.js';

describe('parseWeiValue', () => {
  test('integer string', () => {
    expect(parseWeiValue('1000000000000000000')).toBe('1000000000000000000');
  });

  test('scientific notation with integer mantissa', () => {
    expect(parseWeiValue('1e18')).toBe('1000000000000000000');
    expect(parseWeiValue('1E18')).toBe('1000000000000000000');
  });

  test('scientific notation with decimal mantissa', () => {
    expect(parseWeiValue('1.5e18')).toBe('1500000000000000000');
    expect(parseWeiValue('1.5e17')).toBe('150000000000000000');
  });

  test('zero', () => {
    expect(parseWeiValue('0')).toBe('0');
  });

  test('rejects fractional wei (no exponent)', () => {
    expect(parseWeiValue('0.1')).toBeNull();
  });

  test('rejects fractional wei after exponent shift', () => {
    expect(parseWeiValue('1.5e0')).toBeNull();
  });

  test('rejects signs and garbage', () => {
    expect(parseWeiValue('-1')).toBeNull();
    expect(parseWeiValue('+1')).toBeNull();
    expect(parseWeiValue('1e')).toBeNull();
    expect(parseWeiValue('abc')).toBeNull();
    expect(parseWeiValue('')).toBeNull();
  });

  test('rejects non-string input', () => {
    expect(parseWeiValue(null)).toBeNull();
    expect(parseWeiValue(undefined)).toBeNull();
    expect(parseWeiValue(1)).toBeNull();
  });
});

describe('parseEthereumUri', () => {
  test('bare 0x address defaults to mainnet', () => {
    const result = parseEthereumUri('ethereum:0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045');
    expect(result).toEqual({
      ok: true,
      target: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045',
      chainId: 1,
      value: null,
      label: null,
    });
  });

  test('.eth name defaults to mainnet', () => {
    const result = parseEthereumUri('ethereum:vitalik.eth');
    expect(result).toEqual({
      ok: true,
      target: 'vitalik.eth',
      chainId: 1,
      value: null,
      label: null,
    });
  });

  test('.box name supported', () => {
    const result = parseEthereumUri('ethereum:author.box');
    expect(result.ok).toBe(true);
    expect(result.target).toBe('author.box');
  });

  test('.wei name supported', () => {
    const result = parseEthereumUri('ethereum:alice.wei');
    expect(result.ok).toBe(true);
    expect(result.target).toBe('alice.wei');
  });

  test('.gwei name supported', () => {
    const result = parseEthereumUri('ethereum:apoorv.gwei');
    expect(result.ok).toBe(true);
    expect(result.target).toBe('apoorv.gwei');
  });

  test('subdomain ENS name supported', () => {
    const result = parseEthereumUri('ethereum:tips.author.eth@100?value=1e18');
    expect(result.ok).toBe(true);
    expect(result.target).toBe('tips.author.eth');
    expect(result.chainId).toBe(100);
    expect(result.value).toBe('1000000000000000000');
  });

  test('explicit chainId', () => {
    const result = parseEthereumUri('ethereum:0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045@100');
    expect(result.ok).toBe(true);
    expect(result.chainId).toBe(100);
  });

  test('value in wei (integer)', () => {
    const result = parseEthereumUri(
      'ethereum:0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045?value=1000000000000000000'
    );
    expect(result.value).toBe('1000000000000000000');
  });

  test('value in scientific notation', () => {
    const result = parseEthereumUri('ethereum:vitalik.eth?value=1e16');
    expect(result.value).toBe('10000000000000000');
  });

  test('label param captured', () => {
    const result = parseEthereumUri('ethereum:vitalik.eth?value=1e18&label=Tip%20Jar');
    expect(result.label).toBe('Tip Jar');
  });

  test('rejects ERC-20 transfer function-call variant', () => {
    const result = parseEthereumUri(
      'ethereum:0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48@1/transfer?address=0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045&uint256=1000000'
    );
    expect(result).toEqual({ ok: false, reason: 'UNSUPPORTED_FUNCTION' });
  });

  test('rejects any function-call path', () => {
    const result = parseEthereumUri('ethereum:0xAbC0000000000000000000000000000000000000@1/pay-foo');
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('UNSUPPORTED_FUNCTION');
  });

  test('rejects non-ethereum scheme', () => {
    expect(parseEthereumUri('bzz://abc123')).toEqual({
      ok: false,
      reason: 'NOT_ETHEREUM_URI',
    });
    expect(parseEthereumUri('https://example.com')).toEqual({
      ok: false,
      reason: 'NOT_ETHEREUM_URI',
    });
  });

  test('rejects empty target', () => {
    expect(parseEthereumUri('ethereum:').ok).toBe(false);
    expect(parseEthereumUri('ethereum:@1').ok).toBe(false);
  });

  test('rejects non-decimal chainId', () => {
    expect(parseEthereumUri('ethereum:vitalik.eth@0x1').ok).toBe(false);
    expect(parseEthereumUri('ethereum:vitalik.eth@abc').ok).toBe(false);
    expect(parseEthereumUri('ethereum:vitalik.eth@0').ok).toBe(false);
  });

  test('accepts DNS names and rejects malformed targets', () => {
    expect(parseEthereumUri('ethereum:example.com').ok).toBe(true);
    expect(parseEthereumUri('ethereum:not_a_name').ok).toBe(false);
    expect(parseEthereumUri('ethereum:0x1234').ok).toBe(false); // too short
  });

  test('rejects malformed value param', () => {
    expect(parseEthereumUri('ethereum:vitalik.eth?value=abc').ok).toBe(false);
    expect(parseEthereumUri('ethereum:vitalik.eth?value=0.1').ok).toBe(false);
  });

  test('rejects non-string input', () => {
    expect(parseEthereumUri(null).ok).toBe(false);
    expect(parseEthereumUri(undefined).ok).toBe(false);
    expect(parseEthereumUri(42).ok).toBe(false);
  });

  test('scheme match is case-insensitive', () => {
    expect(parseEthereumUri('Ethereum:vitalik.eth').ok).toBe(true);
    expect(parseEthereumUri('ETHEREUM:vitalik.eth').ok).toBe(true);
  });

  test('trims whitespace', () => {
    expect(parseEthereumUri('  ethereum:vitalik.eth  ').ok).toBe(true);
  });
});
