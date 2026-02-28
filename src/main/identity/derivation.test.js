/**
 * Tests for unified key derivation
 */

import {
  createMnemonic,
  isValidMnemonic,
  deriveAllKeys,
  deriveEthereumKey,
  deriveEd25519Key,
  getSeed,
  PATHS,
} from './derivation.js';

// Well-known test mnemonic (DO NOT use in production!)
// This is the standard "abandon" test vector used across the ecosystem
const TEST_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

// 24-word version
const TEST_MNEMONIC_24 =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art';

describe('derivation', () => {
  describe('createMnemonic', () => {
    test('generates 24-word mnemonic by default (256 bits)', () => {
      const mnemonic = createMnemonic();
      const words = mnemonic.split(' ');
      expect(words.length).toBe(24);
      expect(isValidMnemonic(mnemonic)).toBe(true);
    });

    test('generates 12-word mnemonic with 128 bits', () => {
      const mnemonic = createMnemonic(128);
      const words = mnemonic.split(' ');
      expect(words.length).toBe(12);
      expect(isValidMnemonic(mnemonic)).toBe(true);
    });

    test('generates different mnemonics each time', () => {
      const m1 = createMnemonic();
      const m2 = createMnemonic();
      expect(m1).not.toBe(m2);
    });
  });

  describe('isValidMnemonic', () => {
    test('accepts valid 12-word mnemonic', () => {
      expect(isValidMnemonic(TEST_MNEMONIC)).toBe(true);
    });

    test('accepts valid 24-word mnemonic', () => {
      expect(isValidMnemonic(TEST_MNEMONIC_24)).toBe(true);
    });

    test('rejects invalid mnemonic', () => {
      expect(isValidMnemonic('invalid mnemonic words here')).toBe(false);
    });

    test('rejects empty input', () => {
      expect(isValidMnemonic('')).toBe(false);
      expect(isValidMnemonic(null)).toBe(false);
      expect(isValidMnemonic(undefined)).toBe(false);
    });

    test('rejects wrong word count', () => {
      expect(isValidMnemonic('abandon abandon abandon')).toBe(false);
    });
  });

  describe('deriveEthereumKey', () => {
    test('derives user wallet at standard BIP-44 path', () => {
      const key = deriveEthereumKey(TEST_MNEMONIC, PATHS.USER_WALLET);

      expect(key.path).toBe(PATHS.USER_WALLET);
      expect(key.privateKey).toMatch(/^0x[a-fA-F0-9]{64}$/);
      expect(key.publicKey).toMatch(/^0x[a-fA-F0-9]+$/);
      expect(key.address).toMatch(/^0x[a-fA-F0-9]{40}$/);
    });

    test('derives Bee wallet at account index 1', () => {
      const key = deriveEthereumKey(TEST_MNEMONIC, PATHS.BEE_WALLET);

      expect(key.path).toBe(PATHS.BEE_WALLET);
      expect(key.address).toMatch(/^0x[a-fA-F0-9]{40}$/);
    });

    test('user and Bee wallets have different addresses', () => {
      const userKey = deriveEthereumKey(TEST_MNEMONIC, PATHS.USER_WALLET);
      const beeKey = deriveEthereumKey(TEST_MNEMONIC, PATHS.BEE_WALLET);

      expect(userKey.address).not.toBe(beeKey.address);
      expect(userKey.privateKey).not.toBe(beeKey.privateKey);
    });

    test('is deterministic - same mnemonic gives same keys', () => {
      const key1 = deriveEthereumKey(TEST_MNEMONIC, PATHS.USER_WALLET);
      const key2 = deriveEthereumKey(TEST_MNEMONIC, PATHS.USER_WALLET);

      expect(key1.privateKey).toBe(key2.privateKey);
      expect(key1.address).toBe(key2.address);
    });

    // Known test vector: "abandon...about" at m/44'/60'/0'/0/0
    // This is a well-documented value
    test('matches known test vector for user wallet', () => {
      const key = deriveEthereumKey(TEST_MNEMONIC, PATHS.USER_WALLET);

      // Standard Ethereum derivation for this mnemonic
      // Verified against ethers.js and other implementations
      expect(key.address.toLowerCase()).toBe('0x9858effd232b4033e47d90003d41ec34ecaeda94');
    });
  });

  describe('deriveEd25519Key', () => {
    let seed;

    beforeAll(() => {
      seed = getSeed(TEST_MNEMONIC);
    });

    test('derives Radicle key at SLIP-0010 path', () => {
      const key = deriveEd25519Key(seed, PATHS.RADICLE);

      expect(key.path).toBe(PATHS.RADICLE);
      expect(key.privateKey).toBeInstanceOf(Uint8Array);
      expect(key.publicKey).toBeInstanceOf(Uint8Array);
      expect(key.privateKey.length).toBe(32);
      expect(key.publicKey.length).toBe(32);
    });

    test('derives IPFS key at SLIP-0010 path', () => {
      const key = deriveEd25519Key(seed, PATHS.IPFS);

      expect(key.path).toBe(PATHS.IPFS);
      expect(key.privateKey.length).toBe(32);
      expect(key.publicKey.length).toBe(32);
    });

    test('Radicle and IPFS keys are different', () => {
      const radicleKey = deriveEd25519Key(seed, PATHS.RADICLE);
      const ipfsKey = deriveEd25519Key(seed, PATHS.IPFS);

      // Convert to hex for comparison
      const radiclePrivHex = Buffer.from(radicleKey.privateKey).toString('hex');
      const ipfsPrivHex = Buffer.from(ipfsKey.privateKey).toString('hex');

      expect(radiclePrivHex).not.toBe(ipfsPrivHex);
    });

    test('is deterministic - same seed gives same keys', () => {
      const key1 = deriveEd25519Key(seed, PATHS.RADICLE);
      const key2 = deriveEd25519Key(seed, PATHS.RADICLE);

      const hex1 = Buffer.from(key1.privateKey).toString('hex');
      const hex2 = Buffer.from(key2.privateKey).toString('hex');

      expect(hex1).toBe(hex2);
    });
  });

  describe('deriveAllKeys', () => {
    test('derives all keys from mnemonic', () => {
      const keys = deriveAllKeys(TEST_MNEMONIC);

      expect(keys.userWallet).toBeDefined();
      expect(keys.beeWallet).toBeDefined();
      expect(keys.radicleKey).toBeDefined();
      expect(keys.ipfsKey).toBeDefined();
    });

    test('all keys have correct structure', () => {
      const keys = deriveAllKeys(TEST_MNEMONIC);

      // Ethereum keys
      expect(keys.userWallet.address).toMatch(/^0x/);
      expect(keys.beeWallet.address).toMatch(/^0x/);

      // Ed25519 keys
      expect(keys.radicleKey.privateKey.length).toBe(32);
      expect(keys.ipfsKey.privateKey.length).toBe(32);
    });

    test('throws on invalid mnemonic', () => {
      expect(() => deriveAllKeys('invalid mnemonic')).toThrow('Invalid mnemonic');
    });

    test('is fully deterministic', () => {
      const keys1 = deriveAllKeys(TEST_MNEMONIC);
      const keys2 = deriveAllKeys(TEST_MNEMONIC);

      expect(keys1.userWallet.address).toBe(keys2.userWallet.address);
      expect(keys1.beeWallet.address).toBe(keys2.beeWallet.address);

      const rad1 = Buffer.from(keys1.radicleKey.publicKey).toString('hex');
      const rad2 = Buffer.from(keys2.radicleKey.publicKey).toString('hex');
      expect(rad1).toBe(rad2);
    });
  });

  describe('getSeed', () => {
    test('returns 64-byte seed', () => {
      const seed = getSeed(TEST_MNEMONIC);
      expect(seed).toBeInstanceOf(Uint8Array);
      expect(seed.length).toBe(64);
    });

    test('is deterministic', () => {
      const seed1 = getSeed(TEST_MNEMONIC);
      const seed2 = getSeed(TEST_MNEMONIC);
      expect(Buffer.from(seed1).toString('hex')).toBe(Buffer.from(seed2).toString('hex'));
    });

    test('throws on invalid mnemonic', () => {
      expect(() => getSeed('invalid')).toThrow('Invalid mnemonic');
    });
  });
});
