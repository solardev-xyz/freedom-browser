const {
  IPFS_GATEWAY_PROBE_PATH,
  hasIpfsGatewayHeader,
  isIpfsGatewayProbeResponse,
} = require('./ipfs-gateway-probe');

describe('ipfs gateway probe', () => {
  test('probes the identity CID of the empty file', () => {
    expect(IPFS_GATEWAY_PROBE_PATH).toBe('/ipfs/bafkqaaa');
  });

  test('reads gateway headers from both a fetch Headers and a node headers bag', () => {
    expect(hasIpfsGatewayHeader(new Headers({ 'X-Ipfs-Path': '/ipfs/bafkqaaa' }))).toBe(true);
    expect(hasIpfsGatewayHeader(new Headers({ 'x-ipfs-roots': 'bafkqaaa' }))).toBe(true);
    expect(hasIpfsGatewayHeader({ 'x-ipfs-path': '/ipfs/bafkqaaa' })).toBe(true);
    expect(hasIpfsGatewayHeader({ 'content-type': 'text/html' })).toBe(false);
    expect(hasIpfsGatewayHeader({ 'x-ipfs-path': '  ' })).toBe(false);
    expect(hasIpfsGatewayHeader(null)).toBe(false);
  });

  test('a plain 200 with a body is not a gateway', () => {
    // The dev-server false positive: 200 + index.html for every path.
    expect(
      isIpfsGatewayProbeResponse({
        status: 200,
        headers: { 'content-type': 'text/html' },
        bodyBytes: 512,
      })
    ).toBe(false);
  });

  test('an exactly-empty 200, or any IPFS header, is a gateway', () => {
    expect(isIpfsGatewayProbeResponse({ status: 200, headers: {}, bodyBytes: 0 })).toBe(true);
    expect(
      isIpfsGatewayProbeResponse({
        status: 200,
        headers: { 'x-ipfs-path': '/ipfs/bafkqaaa' },
        bodyBytes: 512,
      })
    ).toBe(true);
  });

  test('a non-200 never qualifies, redirects included', () => {
    for (const status of [204, 301, 302, 404, 500]) {
      expect(
        isIpfsGatewayProbeResponse({
          status,
          headers: { 'x-ipfs-path': '/ipfs/bafkqaaa' },
          bodyBytes: 0,
        })
      ).toBe(false);
    }
  });

  test('an unread body (null byte count) never reads as empty', () => {
    expect(isIpfsGatewayProbeResponse({ status: 200, headers: {}, bodyBytes: null })).toBe(false);
  });
});
