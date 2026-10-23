const { Reference } = require('@ethersphere/bee-js');

jest.mock('./logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const {
  parseGatewayUrl,
  decodeSwarmCid,
  buildNativeUrl,
  resolveGatewayOffer,
  makeGatewayOfferHandler,
} = require('./gateway-offer');

const HEX = 'ab'.repeat(32);
const MANIFEST_CID = new Reference(HEX).toCid('manifest');
const FEED_CID = new Reference(HEX).toCid('feed');

// Re-encode a CID's bytes with one header byte changed, so a test can hand
// the decoder a well-formed `bah5…`-looking label with a wrong header.
const B32 = 'abcdefghijklmnopqrstuvwxyz234567';
const base32Decode = (s) => {
  let bits = 0;
  let value = 0;
  const out = [];
  for (const c of s) {
    value = (value << 5) | B32.indexOf(c);
    bits += 5;
    if (bits >= 8) {
      out.push((value >> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Uint8Array.from(out);
};
const base32Encode = (bytes) => {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of bytes) {
    value = ((value & 0xff) << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
};
const withHeaderByte = (cid, index, byte) => {
  const bytes = base32Decode(cid.slice(1));
  bytes[index] = byte;
  return `b${base32Encode(bytes)}`;
};

describe('decodeSwarmCid', () => {
  test('decodes a manifest CID and a feed CID to the hex reference', () => {
    expect(MANIFEST_CID.startsWith('bah5')).toBe(true);
    expect(decodeSwarmCid(MANIFEST_CID)).toBe(HEX);
    expect(decodeSwarmCid(FEED_CID)).toBe(HEX);
  });

  test('rejects a CID one character short or long (bee-js alone would accept both)', () => {
    // The premise: Reference decodes these to a *different* reference.
    expect(() => new Reference(MANIFEST_CID.slice(0, -1))).not.toThrow();
    expect(() => new Reference(`${MANIFEST_CID}a`)).not.toThrow();
    expect(decodeSwarmCid(MANIFEST_CID.slice(0, -1))).toBeNull();
    expect(decodeSwarmCid(`${MANIFEST_CID}a`)).toBeNull();
    expect(decodeSwarmCid(`${MANIFEST_CID}aaaaaaaa`)).toBeNull();
  });

  test('rejects a CID with another multihash header', () => {
    // Header: [version 1, codec, 1, 27, 32]. Version and codec can't change
    // without leaving the `bah5` prefix (only the manifest and feed codecs,
    // 0xfa/0xfb, encode to it), which the shape test below covers; bytes 2-4
    // are the multihash header.
    expect(decodeSwarmCid(withHeaderByte(MANIFEST_CID, 2, 0x12))).toBeNull();
    expect(decodeSwarmCid(withHeaderByte(MANIFEST_CID, 3, 0x12))).toBeNull();
    expect(decodeSwarmCid(withHeaderByte(MANIFEST_CID, 4, 0x20 + 1))).toBeNull();
  });

  test('rejects anything that is not a bah5 base32 label', () => {
    expect(decodeSwarmCid('')).toBeNull();
    expect(decodeSwarmCid(null)).toBeNull();
    expect(decodeSwarmCid(HEX)).toBeNull();
    expect(decodeSwarmCid(MANIFEST_CID.toUpperCase())).toBeNull();
    expect(decodeSwarmCid('bah5')).toBeNull();
    expect(decodeSwarmCid('bah5zzzz')).toBeNull();
    expect(decodeSwarmCid(`${MANIFEST_CID.slice(0, -1)}1`)).toBeNull(); // '1' is not base32
    // An IPFS CID is a CID, but not a Swarm one.
    expect(
      decodeSwarmCid('bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi')
    ).toBeNull();
  });
});

describe('parseGatewayUrl', () => {
  test.each([
    ['https://vitalik.eth.limo/', 'eth.limo', 'vitalik.eth'],
    ['https://vitalik.eth.link/', 'eth.link', 'vitalik.eth'],
    ['http://vitalik.eth.limo/', 'eth.limo', 'vitalik.eth'],
    ['https://app.uniswap.eth.limo/swap', 'eth.limo', 'app.uniswap.eth'],
    ['https://VITALIK.ETH.LIMO/', 'eth.limo', 'vitalik.eth'],
    ['https://vitalik.eth.limo./', 'eth.limo', 'vitalik.eth'],
  ])('%s is the ENS name on %s', (url, gateway, ensName) => {
    expect(parseGatewayUrl(url)).toEqual(expect.objectContaining({ gateway, ensName }));
    expect(parseGatewayUrl(url).requireProtocol).toBeUndefined();
  });

  test('a punycode host is looked up under its Unicode name', () => {
    // Chromium hands the ASCII form; namehashing that would be another name.
    expect(parseGatewayUrl('https://xn--mnchen-3ya.eth.limo/').ensName).toBe('münchen.eth');
  });

  test('<name>.bzz.link is <name>.eth, and only as Swarm content', () => {
    expect(parseGatewayUrl('https://vitalik.bzz.link/')).toEqual({
      gateway: 'bzz.link',
      host: 'vitalik.bzz.link',
      suffix: '.bzz.link',
      ensName: 'vitalik.eth',
      requireProtocol: 'bzz',
    });
    expect(parseGatewayUrl('https://app.swarm.bzz.link/').ensName).toBe('app.swarm.eth');
  });

  test('the gateway appends .eth itself, so <name>.eth.bzz.link is <name>.eth.eth', () => {
    expect(parseGatewayUrl('https://vitalik.eth.bzz.link/').ensName).toBe('vitalik.eth.eth');
  });

  test('<cid>.bzz.link carries the reference, for a manifest and a feed CID', () => {
    expect(parseGatewayUrl(`https://${MANIFEST_CID}.bzz.link/`)).toEqual({
      gateway: 'bzz.link',
      host: `${MANIFEST_CID}.bzz.link`,
      suffix: '.bzz.link',
      reference: HEX,
    });
    expect(parseGatewayUrl(`https://${FEED_CID}.bzz.link/`).reference).toBe(HEX);
  });

  test('an invalid bah5 label is no offer, never an ENS name bah5….eth', () => {
    expect(parseGatewayUrl(`https://${MANIFEST_CID.slice(0, -1)}.bzz.link/`)).toBeNull();
    expect(parseGatewayUrl('https://bah5abc.bzz.link/')).toBeNull();
  });

  test('a 64-hex reference label is not taken (it can not be a DNS label)', () => {
    expect(parseGatewayUrl(`https://${HEX}.bzz.link/`)).toBeNull();
  });

  test.each([
    'https://eth.limo/',
    'https://eth.link/',
    'https://bzz.link/',
    'https://limo/',
    'https://example.com/',
    'https://vitalik.eth/',
    'https://vitaliketh.limo/',
    'https://vitalik-eth.limo/',
    'https://vitalik.eth.limo.evil.example/',
    'https://vitalik.eth.limo.example/',
    'https://vitalik.eth.lime/',
    'https://vitalik.eth.limo:8443/',
    'https://user:pw@vitalik.eth.limo/',
    'ftp://vitalik.eth.limo/',
    'ipfs://vitalik.eth/',
    'bzz://vitalik.eth/',
    'vitalik.eth.limo',
    'not a url',
    '',
    null,
    undefined,
    42,
  ])('%s is not a gateway URL', (url) => {
    expect(parseGatewayUrl(url)).toBeNull();
  });
});

describe('buildNativeUrl', () => {
  test('keeps path, query and fragment', () => {
    expect(
      buildNativeUrl('ipfs', 'vitalik.eth', 'https://vitalik.eth.limo/a/b.html?x=1&y=2#top')
    ).toBe('ipfs://vitalik.eth/a/b.html?x=1&y=2#top');
  });

  test('a bare host gets the root path', () => {
    expect(buildNativeUrl('bzz', 'vitalik.eth', 'https://vitalik.bzz.link')).toBe(
      'bzz://vitalik.eth/'
    );
  });
});

describe('resolveGatewayOffer', () => {
  const okResult = (protocol) => ({
    type: 'ok',
    name: 'vitalik.eth',
    protocol,
    uri: `${protocol}://x`,
  });

  test.each(['ipfs', 'ipns', 'bzz'])(
    'an eth.limo name with a %s contenthash is offered on that transport',
    async (protocol) => {
      const resolveContent = jest.fn().mockResolvedValue(okResult(protocol));
      await expect(
        resolveGatewayOffer('https://vitalik.eth.limo/blog/?p=1#c', { resolveContent })
      ).resolves.toEqual({
        gateway: 'eth.limo',
        gatewayHost: 'vitalik.eth.limo',
        protocol,
        target: `${protocol}://vitalik.eth`,
        destination: `${protocol}://vitalik.eth/blog/?p=1#c`,
      });
      expect(resolveContent).toHaveBeenCalledWith('vitalik.eth');
    }
  );

  test.each([
    ['no contenthash', { type: 'not_found', reason: 'NO_CONTENTHASH' }],
    ['a resolution error', { type: 'error', reason: 'RESOLUTION_ERROR' }],
    ['an unsupported contenthash', { type: 'unsupported' }],
    ['a provider conflict', { type: 'conflict' }],
    ['an http contenthash', { type: 'ok', protocol: 'https' }],
    ['no answer', null],
  ])('no offer for %s', async (_label, result) => {
    const resolveContent = jest.fn().mockResolvedValue(result);
    await expect(
      resolveGatewayOffer('https://vitalik.eth.limo/', { resolveContent })
    ).resolves.toBeNull();
  });

  test('no offer when the lookup throws (RPC unreachable)', async () => {
    const resolveContent = jest.fn().mockRejectedValue(new Error('network down'));
    await expect(
      resolveGatewayOffer('https://vitalik.eth.link/', { resolveContent })
    ).resolves.toBeNull();
  });

  test('<name>.bzz.link is offered as bzz://<name>.eth only for Swarm content', async () => {
    const bzz = jest.fn().mockResolvedValue(okResult('bzz'));
    await expect(
      resolveGatewayOffer('https://vitalik.bzz.link/x', { resolveContent: bzz })
    ).resolves.toEqual(
      expect.objectContaining({ protocol: 'bzz', destination: 'bzz://vitalik.eth/x' })
    );
    expect(bzz).toHaveBeenCalledWith('vitalik.eth');

    const ipfs = jest.fn().mockResolvedValue(okResult('ipfs'));
    await expect(
      resolveGatewayOffer('https://vitalik.bzz.link/x', { resolveContent: ipfs })
    ).resolves.toBeNull();
  });

  test('<cid>.bzz.link needs no lookup', async () => {
    const resolveContent = jest.fn();
    await expect(
      resolveGatewayOffer(`https://${MANIFEST_CID}.bzz.link/index.html?q#f`, { resolveContent })
    ).resolves.toEqual({
      gateway: 'bzz.link',
      gatewayHost: `${MANIFEST_CID}.bzz.link`,
      protocol: 'bzz',
      target: `bzz://${HEX}`,
      destination: `bzz://${HEX}/index.html?q#f`,
    });
    expect(resolveContent).not.toHaveBeenCalled();
  });

  test('a non-gateway URL is never looked up', async () => {
    const resolveContent = jest.fn();
    await expect(
      resolveGatewayOffer('https://example.com/', { resolveContent })
    ).resolves.toBeNull();
    expect(resolveContent).not.toHaveBeenCalled();
  });
});

describe('makeGatewayOfferHandler', () => {
  test('answers the IPC payload, and null for a malformed one', async () => {
    const resolveContent = jest.fn().mockResolvedValue({ type: 'ok', protocol: 'ipfs' });
    const handler = makeGatewayOfferHandler({ resolveContent });
    await expect(handler({}, { url: 'https://vitalik.eth.limo/' })).resolves.toEqual(
      expect.objectContaining({ destination: 'ipfs://vitalik.eth/' })
    );
    await expect(handler({}, { url: 42 })).resolves.toBeNull();
    await expect(handler({}, undefined)).resolves.toBeNull();
    await expect(handler({}, null)).resolves.toBeNull();
  });

  test('runs a private sender under the private log context', async () => {
    const { isPrivateLogContext } = require('./private/private-log-context');
    let seen = null;
    const handler = makeGatewayOfferHandler({
      resolveContent: async () => {
        seen = isPrivateLogContext();
        return null;
      },
      isPrivateSender: (sender) => sender === 'private',
    });
    await handler({ sender: 'private' }, { url: 'https://vitalik.eth.limo/' });
    expect(seen).toBe(true);
    await handler({ sender: 'normal' }, { url: 'https://vitalik.eth.limo/' });
    expect(seen).toBe(false);
  });
});
