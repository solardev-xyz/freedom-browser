import { cidV0ToV1Base32, ipnsMhToCidV1Base36 } from './cid-utils.js';

describe('cidV0ToV1Base32', () => {
  // Expected values cross-checked against multiformats CID.parse(v0).toV1().toString().
  test('converts canonical CIDv0 examples to CIDv1 base32', () => {
    expect(cidV0ToV1Base32('QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG')).toBe(
      'bafybeie5nqv6kd3qnfjupgvz34woh3oksc3iau6abmyajn7qvtf6d2ho34'
    );
    expect(cidV0ToV1Base32('Qmbnp5ufs7kauPzwnu5boMjbXM97TvmuiNd5F7F2ex8ThC')).toBe(
      'bafybeigh3oq6pwrkspwgj4jcguizd7muxw4zdyq6cckqi5vl72yixnzpvm'
    );
    expect(cidV0ToV1Base32('QmT78zSuBmuS4z925WZfrqQ1qHaJ56DQaTfyMUF7F8ff5o')).toBe(
      'bafybeicg2rebjoofv4kbyovkw7af3rpiitvnl6i7ckcywaq6xjcxnc2mby'
    );
  });

  test('returns null for non-CIDv0 input', () => {
    expect(cidV0ToV1Base32(null)).toBeNull();
    expect(cidV0ToV1Base32(undefined)).toBeNull();
    expect(cidV0ToV1Base32('')).toBeNull();
    expect(cidV0ToV1Base32('bafybeigh3oq6pwrkspwgj4jcguizd7muxw4zdyq6cckqi5vl72yixnzpvm')).toBeNull();
    expect(cidV0ToV1Base32('Qmshort')).toBeNull();
    expect(cidV0ToV1Base32('QmContainsInvalidChar!abcdefghijklmnopqrstuvwxyz0123')).toBeNull();
  });
});

describe('ipnsMhToCidV1Base36', () => {
  // Expected values cross-checked against multiformats:
  //   CID.createV1(0x72, Multihash(base58btc.decode('z' + peerId))).toString(base36)
  test('converts Ed25519 identity-multihash peer IDs to base36 CIDv1 libp2p-key', () => {
    expect(ipnsMhToCidV1Base36('12D3KooWAsDaZWCkCEUN3myg49NoCMmrYYivmJVwjg7DVJBvWdaX')).toBe(
      'k51qzi5uqu5dgkkr5wjh0m796f9u3tou74wn2q2u3shgh6yn52ce4hitig3if4'
    );
    expect(ipnsMhToCidV1Base36('12D3KooWRBy97UB4aJeyegkr4DvfjShtp5g83Gd1zQ77gNeYvbnc')).toBe(
      'k51qzi5uqu5dlvj2baxnohg4sf7y8vid1gtqsm1k7bkvrjsnzjz1tiexq761bp'
    );
  });

  test('converts sha2-256 peer IDs (RSA-style "Qm..." names) to base36 CIDv1 libp2p-key', () => {
    expect(ipnsMhToCidV1Base36('QmNYWqRg2uVWKpwpQ4Q4tu4xrE8kTVNG4aiEvX2wzLgPbh')).toBe(
      'k2k4r8jhqpcrorgyes4mlic3t752f7oigcsb9tmxnly54cu2f6ijjzks'
    );
  });

  test('returns null for malformed input', () => {
    expect(ipnsMhToCidV1Base36(null)).toBeNull();
    expect(ipnsMhToCidV1Base36(undefined)).toBeNull();
    expect(ipnsMhToCidV1Base36('')).toBeNull();
    expect(ipnsMhToCidV1Base36('12')).toBeNull();
    expect(ipnsMhToCidV1Base36('12D3!invalid')).toBeNull();
    // Non-base58 chars (contains '0' and 'O' and 'I' and 'l').
    expect(ipnsMhToCidV1Base36('0OIl')).toBeNull();
  });
});
