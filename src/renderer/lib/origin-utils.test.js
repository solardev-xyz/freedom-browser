/**
 * Cross-consistency test: renderer origin-utils vs shared origin-utils.
 *
 * The renderer (ESM) maintains its own copy of getPermissionKey and
 * normalizeOrigin because it cannot require() the CommonJS shared module.
 * These tests mechanically assert that both copies produce identical output
 * for a broad battery of inputs, so drift is caught in CI before it causes
 * permissions to go missing between renderer and main.
 *
 * If this test fails, update BOTH files together.
 */

import * as renderer from './origin-utils.js';
const shared = require('../../shared/origin-utils');

// Inputs span every code path + realistic edge cases.
const INPUTS = [
  // ENS bare names
  'vitalik.eth',
  'vitalik.eth/blog',
  '1inch.eth/path/to/page',
  'myapp.box',
  'myapp.box/docs',
  'VITALIK.ETH',
  'Vitalik.ETH/Blog',
  'sub.example.eth',

  // ens:// scheme
  'ens://vitalik.eth',
  'ens://vitalik.eth/#/swap',
  'ens://MyApp.ETH/#/PATH',
  'ens://sub.example.eth',

  // Swarm
  'bzz://abc123def',
  'bzz://abc123def/page/index.html',
  'bzz://ABC123/mixed-case-ref',
  'bzz://a1b2c3d4e5f6/deep/path?query=1#hash',

  // IPFS / IPNS
  'ipfs://QmHash',
  'ipfs://QmHash/docs/page.html',
  'ipfs://bafybeigdyrzt/page',
  'ipns://docs.ipfs.tech',
  'ipns://docs.ipfs.tech/guide',

  // Transport URLs with ENS hosts (issue #16): both copies must collapse to
  // the bare ENS name so permissions stay consistent across forms.
  'bzz://meinhard.eth',
  'bzz://meinhard.eth/page',
  'ipfs://vitalik.eth/docs',
  'ipns://app.eth/guide',
  'bzz://Meinhard.ETH',
  'ipfs://myapp.box/path',

  // Radicle
  'rad://z3gqcJUoA1n9HaHKufZs5FCSGazv5',
  'rad://z3gqcJUoA1n9HaHKufZs5FCSGazv5/tree',

  // HTTP(S)
  'https://app.uniswap.org',
  'https://app.uniswap.org/swap',
  'https://app.uniswap.org:8443/swap',
  'http://localhost:3000',
  'http://localhost:3000/path?a=1#fragment',
  'https://sub.domain.example.com/page',

  // Edge cases
  null,
  undefined,
  '',
  '   ',
  '\t\n',
  'not a url',
  'ftp://example.com',
  'data:text/plain,hello',
  'javascript:alert(1)',
  'about:blank',
];

describe('renderer origin-utils vs shared origin-utils', () => {
  describe('getPermissionKey', () => {
    test.each(INPUTS.map((i) => [JSON.stringify(i), i]))(
      'produces identical output for %s',
      (_label, input) => {
        expect(renderer.getPermissionKey(input)).toBe(shared.getPermissionKey(input));
      }
    );
  });

  describe('normalizeOrigin', () => {
    test.each(INPUTS.map((i) => [JSON.stringify(i), i]))(
      'produces identical output for %s',
      (_label, input) => {
        expect(renderer.normalizeOrigin(input)).toBe(shared.normalizeOrigin(input));
      }
    );
  });

  describe('public API surface matches', () => {
    test('renderer exports getPermissionKey', () => {
      expect(typeof renderer.getPermissionKey).toBe('function');
    });

    test('renderer exports normalizeOrigin', () => {
      expect(typeof renderer.normalizeOrigin).toBe('function');
    });

    test('shared exports getPermissionKey', () => {
      expect(typeof shared.getPermissionKey).toBe('function');
    });

    test('shared exports normalizeOrigin', () => {
      expect(typeof shared.normalizeOrigin).toBe('function');
    });
  });
});
