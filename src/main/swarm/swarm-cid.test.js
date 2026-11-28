/**
 * swarm-cid.js against what bee-js 13.2.0's `Reference` did, recorded in
 * test/fixtures/swarm-cid/bee-js-13.2.0.json while bee-js was still in the
 * tree (freedom-core design 0015, SWM-8 PR 8.2), so they keep proving the
 * decoder after it is gone. `expected` is what gateway-offer.js's decoder
 * over bee-js returned for each label.
 */

const { SWARM_CID_LABEL, toSwarmCid, decodeSwarmCid } = require('./swarm-cid');
const FIXTURE = require('../../../test/fixtures/swarm-cid/bee-js-13.2.0.json');

test('the fixture is bee-js 13.2.0’s, and covers every form', () => {
  expect(FIXTURE.beeJs).toBe('13.2.0');
  expect(FIXTURE.references.length).toBeGreaterThanOrEqual(64);
  expect(FIXTURE.invalid.length).toBeGreaterThanOrEqual(30);
  // Some labels bee-js's Reference decoded (to another reference, or the
  // same one from a label that isn't its CID), and some it threw on.
  expect(FIXTURE.invalid.some((entry) => entry.beeJsReference.decodes)).toBe(true);
  expect(FIXTURE.invalid.some((entry) => !entry.beeJsReference.decodes)).toBe(true);
});

describe('a reference’s manifest and feed CIDs', () => {
  test.each(FIXTURE.references.map((entry) => [entry.name, entry]))(
    '%s: encodes as bee-js did, and decodes back',
    (_name, { hex, manifest, feed }) => {
      expect(toSwarmCid(hex, 'manifest')).toBe(manifest);
      expect(toSwarmCid(hex, 'feed')).toBe(feed);
      expect(decodeSwarmCid(manifest)).toBe(hex);
      expect(decodeSwarmCid(feed)).toBe(hex);
    }
  );

  test('every CID is 61 characters: bah5a for a manifest, bah5q for a feed', () => {
    for (const { manifest, feed } of FIXTURE.references) {
      expect(manifest).toMatch(/^bah5a[a-z2-7]{56}$/);
      expect(feed).toMatch(/^bah5q[a-z2-7]{56}$/);
      expect(SWARM_CID_LABEL.test(manifest) && SWARM_CID_LABEL.test(feed)).toBe(true);
    }
  });
});

describe('both forms of a reference', () => {
  test.each(FIXTURE.encodings.map((entry) => [entry.name, entry]))(
    '%s',
    (_name, { reference, manifest, feed }) => {
      for (const [type, recorded] of [
        ['manifest', manifest],
        ['feed', feed],
      ]) {
        if (recorded.cid) expect(toSwarmCid(reference, type)).toBe(recorded.cid);
        else expect(() => toSwarmCid(reference, type)).toThrow(/32-byte reference/);
      }
    }
  );

  test('the decoder hands back lower-case hex only', () => {
    for (const { hex, manifest } of FIXTURE.references) {
      expect(decodeSwarmCid(manifest)).toMatch(/^[0-9a-f]{64}$/);
      expect(decodeSwarmCid(manifest)).toBe(hex.toLowerCase());
    }
  });

  test('a CID is a manifest or a feed, nothing else', () => {
    expect(() => toSwarmCid('ab'.repeat(32), 'bytes')).toThrow(TypeError);
    expect(() => toSwarmCid('ab'.repeat(32))).toThrow(TypeError);
  });
});

describe('labels that are not a Swarm CID', () => {
  test.each(FIXTURE.invalid.map((entry) => [entry.name, entry]))(
    '%s: no reference',
    (_name, { label, expected }) => {
      expect(expected).toBeNull();
      expect(decodeSwarmCid(label)).toBeNull();
    }
  );

  test('a label bee-js decoded to the reference itself is still refused unless it is its CID', () => {
    const lax = FIXTURE.invalid.filter(
      (entry) =>
        entry.beeJsReference.decodes &&
        entry.beeJsReference.hex === FIXTURE.references[0].hex &&
        entry.label.startsWith('bah5')
    );
    expect(lax.length).toBeGreaterThan(0);
    for (const { label } of lax) expect(decodeSwarmCid(label)).toBeNull();
  });

  test('values that are not strings', () => {
    for (const value of [null, undefined, 42, {}, [], Buffer.from('bah5')]) {
      expect(decodeSwarmCid(value)).toBeNull();
    }
  });
});
