jest.mock('../logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

jest.mock('../networks/chain-data-router', () => ({
  request: jest.fn(),
}));

jest.mock('../networks/network-registry', () => ({
  getNetwork: jest.fn((chainId) => ({ name: chainId === 1 ? 'Ethereum' : 'Gnosis Chain' })),
}));

const { ethers } = require('ethers');
const chainData = require('../networks/chain-data-router');
const log = require('../logger');
const {
  HTML_SELECTOR,
  MAX_HTML_BYTES,
  ONCHAIN_APP_CSP,
  PROVENANCE_HEADER,
  decodeOnchainProvenance,
  handleOnchainAppRequest,
  parseOnchainAppUrl,
  registerOnchainAppProtocol,
} = require('./onchain-app-protocol');

const ADDRESS = '0x00000095643CFfA7D9fae407a84dfCB6406456c6';
const CANONICAL_ADDRESS = ethers.getAddress(ADDRESS);
const ABI = new ethers.Interface(['function html() view returns (string)']);
const appUrl = (chainId = 1, path = '/') =>
  `web3://${ADDRESS.toLowerCase()}.eip155-${chainId}${path}`;

function request(url, method = 'GET', signal = undefined) {
  return { url, method, signal };
}

function encodedHtml(html) {
  return ABI.encodeFunctionResult('html', [html]);
}

describe('parseOnchainAppUrl', () => {
  test('parses the contract and explicit chain', () => {
    expect(parseOnchainAppUrl(appUrl(1, '/swap'))).toEqual({
      address: CANONICAL_ADDRESS,
      chainId: 1,
    });
  });

  test('defaults an omitted chain to Ethereum mainnet', () => {
    expect(parseOnchainAppUrl(`web3://${ADDRESS}/`)).toEqual({
      address: CANONICAL_ADDRESS,
      chainId: 1,
    });
  });

  test.each([
    'https://example.com',
    'web3://not-an-address:1/',
    `web3://${ADDRESS}:0/`,
    `web3://user@${ADDRESS}:1/`,
  ])('rejects malformed authority %s', (url) => {
    expect(parseOnchainAppUrl(url)).toBeNull();
  });
});

describe('handleOnchainAppRequest', () => {
  beforeEach(() => jest.clearAllMocks());

  test('calls ERC-8244 html() and returns the unmodified document', async () => {
    const html = '<!doctype html><title>zSwap</title><script>window.ok = true</script>';
    const chainRequest = jest.fn(async () => ({
      result: encodedHtml(html),
      source: 'myotis',
      verified: true,
      trust: {
        level: 'verified',
        method: 'myotis',
        finality: 'optimistic',
        block: 123,
      },
    }));

    const response = await handleOnchainAppRequest(
      request(appUrl()),
      { chainRequest }
    );

    expect(chainRequest).toHaveBeenCalledWith(
      1,
      'eth_call',
      [{ to: CANONICAL_ADDRESS, data: HTML_SELECTOR }, 'latest'],
      { includeTrust: true }
    );
    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe(html);
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(response.headers.get('content-security-policy')).toBe(ONCHAIN_APP_CSP);
    expect(response.headers.get('content-security-policy')).toContain("connect-src 'none'");
    expect(response.headers.get('content-security-policy')).toContain('sandbox allow-scripts');
    expect(response.headers.get('x-freedom-onchain-app-chain-id')).toBe('1');
    expect(response.headers.get('x-freedom-onchain-app-contract')).toBe(CANONICAL_ADDRESS);
    expect(response.headers.get('x-freedom-onchain-app-verified')).toBe('true');
    expect(decodeOnchainProvenance(response.headers.get(PROVENANCE_HEADER))).toEqual({
      version: 1,
      chainId: 1,
      network: 'Ethereum',
      contract: CANONICAL_ADDRESS,
      htmlHash: ethers.keccak256(ethers.toUtf8Bytes(html)),
      trust: {
        level: 'verified',
        method: 'myotis',
        finality: 'optimistic',
        block: 123,
      },
    });
  });

  test('uses the canonical html() selector', () => {
    expect(HTML_SELECTOR).toBe(ABI.getFunction('html').selector);
  });

  test('HEAD validates the contract but returns no body', async () => {
    const chainRequest = jest.fn(async () => ({
      result: encodedHtml('<h1>app</h1>'),
      source: 'quorum',
      verified: true,
    }));
    const response = await handleOnchainAppRequest(
      request(appUrl(100), 'HEAD'),
      { chainRequest }
    );
    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe('');
    expect(chainRequest).toHaveBeenCalledWith(
      100,
      'eth_call',
      expect.any(Array),
      { includeTrust: true }
    );
  });

  test('rejects non-read methods without touching chain data', async () => {
    const chainRequest = jest.fn();
    const response = await handleOnchainAppRequest(
      request(appUrl(), 'POST'),
      { chainRequest }
    );
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('GET, HEAD');
    expect(chainRequest).not.toHaveBeenCalled();
  });

  test('returns 400 for a malformed contract URL', async () => {
    const chainRequest = jest.fn();
    const response = await handleOnchainAppRequest(request('web3://invalid:1/'), {
      chainRequest,
    });
    expect(response.status).toBe(400);
    expect(chainRequest).not.toHaveBeenCalled();
  });

  test('returns 502 when the contract does not implement html()', async () => {
    const response = await handleOnchainAppRequest(request(appUrl()), {
      chainRequest: jest.fn(async () => ({ result: '0x', source: 'direct', verified: false })),
    });
    expect(response.status).toBe(502);
    await expect(response.text()).resolves.toContain('did not return a valid ERC-8244');
  });

  test('rejects an oversized ABI response before decoding it', async () => {
    const result = `0x${'00'.repeat(MAX_HTML_BYTES + 96)}`;
    const response = await handleOnchainAppRequest(request(appUrl()), {
      chainRequest: jest.fn(async () => ({ result, source: 'direct', verified: false })),
    });
    expect(response.status).toBe(413);
  });

  test('bounds a stalled chain read', async () => {
    const response = await handleOnchainAppRequest(request(appUrl()), {
      chainRequest: jest.fn(() => new Promise(() => {})),
      timeoutMs: 5,
    });
    expect(response.status).toBe(504);
  });
});

describe('registerOnchainAppProtocol private sessions', () => {
  beforeEach(() => jest.clearAllMocks());

  test('registers web3 and redacts a private contract URL from logs', async () => {
    const handlers = new Map();
    const targetSession = {
      protocol: { handle: (scheme, handler) => handlers.set(scheme, handler) },
    };
    chainData.request.mockRejectedValue(new Error('unavailable'));

    registerOnchainAppProtocol(targetSession, { privatePartition: 'private-test' });
    await handlers.get('web3')(request(appUrl(1, '/private/path')));

    const logged = [log.info, log.warn, log.error]
      .flatMap((fn) => fn.mock.calls)
      .map((call) => call.join(' '))
      .join('\n');
    expect(logged).not.toContain(ADDRESS.toLowerCase());
    expect(logged).not.toContain('private/path');
    expect(logged).toContain('web3://<private>');
  });
});
