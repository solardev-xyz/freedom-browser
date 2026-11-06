const {
  IPFS_CAR_ACCEPT,
  IPFS_CAR_PROBE_PATH,
  IPFS_GATEWAY_PROBE_PATH,
  IPFS_RAW_ACCEPT,
  IPFS_RAW_PROBE_PATH,
  hasIpfsGatewayHeader,
  isCarProbeResponse,
  isIpfsGatewayProbeResponse,
  isRawProbeResponse,
  parseMediaType,
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

// freedom-core design 0009, Modes: the two requests after the probe above.
describe('the trustless probe', () => {
  const CAR = 'application/vnd.ipld.car; version=1; order=dfs; dups=y';

  test('asks for the same identity CID, raw and as an entity CAR, with their Accept', () => {
    expect(IPFS_RAW_PROBE_PATH).toBe('/ipfs/bafkqaaa?format=raw');
    expect(IPFS_RAW_ACCEPT).toBe('application/vnd.ipld.raw');
    expect(IPFS_CAR_PROBE_PATH).toBe('/ipfs/bafkqaaa?format=car&dag-scope=entity');
    // The Accept the core's CAR requests carry (dweb-shell.js).
    expect(IPFS_CAR_ACCEPT).toBe(CAR);
  });

  test('raw blocks: a 200 of type application/vnd.ipld.raw, parameters and case aside', () => {
    for (const type of [
      'application/vnd.ipld.raw',
      'Application/VND.IPLD.RAW',
      'application/vnd.ipld.raw; charset=binary',
    ]) {
      expect(
        isRawProbeResponse({ status: 200, headers: new Headers({ 'content-type': type }) })
      ).toBe(true);
      expect(isRawProbeResponse({ status: 200, headers: { 'content-type': type } })).toBe(true);
    }
  });

  test('anything else is no raw blocks', () => {
    const cases = [
      { status: 200, headers: { 'content-type': 'text/plain' } },
      { status: 200, headers: { 'content-type': 'application/octet-stream' } },
      // The dev server's page, and a gateway that ignores `format`.
      { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } },
      { status: 200, headers: {} },
      { status: 200, headers: null },
      { status: 200, headers: { 'content-type': 'application/vnd.ipld.raw; x' } },
      { status: 301, headers: { 'content-type': 'application/vnd.ipld.raw' } },
      { status: 404, headers: { 'content-type': 'application/vnd.ipld.raw' } },
      { status: 406, headers: { 'content-type': 'application/vnd.ipld.raw' } },
    ];
    for (const response of cases) expect(isRawProbeResponse(response)).toBe(false);
  });

  test('ordered CARs: application/vnd.ipld.car with order=dfs and dups=y', () => {
    for (const type of [
      CAR,
      'application/vnd.ipld.car;order=dfs;dups=y',
      'application/vnd.ipld.car; dups=y; order=dfs; version=1',
      'application/vnd.ipld.car; version=1; order="dfs"; dups="y"',
      'APPLICATION/VND.IPLD.CAR; ORDER=DFS; DUPS=Y',
    ]) {
      expect(
        isCarProbeResponse({ status: 200, headers: new Headers({ 'content-type': type }) })
      ).toBe(true);
    }
  });

  test('a CAR without that order or those duplicates is not worth asking for', () => {
    for (const type of [
      'application/vnd.ipld.car',
      'application/vnd.ipld.car; version=1',
      'application/vnd.ipld.car; version=1; order=unk; dups=y',
      'application/vnd.ipld.car; version=1; order=dfs; dups=n',
      'application/vnd.ipld.car; version=1; order=dfs',
      'application/vnd.ipld.car; version=1; dups=y',
      // A parameter named twice can't be read.
      'application/vnd.ipld.car; order=dfs; dups=y; order=unk',
      'application/vnd.ipld.raw; order=dfs; dups=y',
      'text/html',
    ]) {
      expect(isCarProbeResponse({ status: 200, headers: { 'content-type': type } })).toBe(false);
    }
    expect(isCarProbeResponse({ status: 302, headers: { 'content-type': CAR } })).toBe(false);
    expect(isCarProbeResponse({ status: 200, headers: {} })).toBe(false);
  });

  test('a media type reads as its type and its parameters, lowercased', () => {
    const media = parseMediaType(' Application/VND.ipld.car ; Version=1 ;order="DFS"; ');
    expect(media.type).toBe('application/vnd.ipld.car');
    expect([...media.params]).toEqual([
      ['version', '1'],
      ['order', 'dfs'],
    ]);
    expect(parseMediaType(undefined)).toBeNull();
    expect(parseMediaType('a/b; novalue')).toBeNull();
    expect(parseMediaType('a/b; =x')).toBeNull();
  });
});
