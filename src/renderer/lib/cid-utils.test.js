import { cidV0ToV1Base32 } from './cid-utils.js';

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
