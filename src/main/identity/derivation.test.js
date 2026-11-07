/**
 * Tests for unified key derivation
 */

const {
  createMnemonic,
  isValidMnemonic,
  deriveAllKeys,
  deriveEthereumKey,
  deriveEd25519Key,
  derivePublisherKey,
  deriveUserWallet,
  deriveWalletAtPath,
  normalizeWalletPath,
  getSeed,
  PATHS,
} = require('./derivation');
const { Mnemonic } = require('ethers');

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

  describe('derivePublisherKey', () => {
    test('derives valid Ethereum key at dedicated path', () => {
      const key = derivePublisherKey(TEST_MNEMONIC, 0);
      expect(key.privateKey).toMatch(/^0x[0-9a-f]{64}$/i);
      expect(key.address).toMatch(/^0x[0-9A-Fa-f]{40}$/);
      expect(key.path).toBe(`${PATHS.SWARM_PUBLISHER}/0'/0/0`);
      expect(key.originIndex).toBe(0);
    });

    test('different indices produce different keys', () => {
      const key0 = derivePublisherKey(TEST_MNEMONIC, 0);
      const key1 = derivePublisherKey(TEST_MNEMONIC, 1);
      const key2 = derivePublisherKey(TEST_MNEMONIC, 2);
      expect(key0.address).not.toBe(key1.address);
      expect(key1.address).not.toBe(key2.address);
      expect(key0.privateKey).not.toBe(key1.privateKey);
    });

    test('same index is deterministic', () => {
      const key1 = derivePublisherKey(TEST_MNEMONIC, 0);
      const key2 = derivePublisherKey(TEST_MNEMONIC, 0);
      expect(key1.address).toBe(key2.address);
      expect(key1.privateKey).toBe(key2.privateKey);
    });

    test('publisher keys are separate from user and Bee wallets', () => {
      const keys = deriveAllKeys(TEST_MNEMONIC);
      const pub0 = derivePublisherKey(TEST_MNEMONIC, 0);
      const pub1 = derivePublisherKey(TEST_MNEMONIC, 1);
      expect(pub0.address).not.toBe(keys.userWallet.address);
      expect(pub0.address).not.toBe(keys.beeWallet.address);
      expect(pub1.address).not.toBe(keys.userWallet.address);
      expect(pub1.address).not.toBe(keys.beeWallet.address);
    });

    test('throws on invalid mnemonic', () => {
      expect(() => derivePublisherKey('invalid', 0)).toThrow('Invalid mnemonic');
    });

    test('throws on negative index', () => {
      expect(() => derivePublisherKey(TEST_MNEMONIC, -1)).toThrow('non-negative integer');
    });

    test('throws on non-integer index', () => {
      expect(() => derivePublisherKey(TEST_MNEMONIC, 1.5)).toThrow('non-negative integer');
    });

    test('PATHS.SWARM_PUBLISHER is the expected base path', () => {
      expect(PATHS.SWARM_PUBLISHER).toBe("m/44'/73406'");
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

  describe('normalizeWalletPath', () => {
    test.each([
      ["m/44'/60'/0'/0/2", "m/44'/60'/0'/0/2"],
      ["44'/60'/0'/0/2", "m/44'/60'/0'/0/2"],
      ["  m/44'/60'/0'/2  ", "m/44'/60'/0'/2"],
      ["m/044'/060'/00'/0/02", "m/44'/60'/0'/0/2"],
      ['m/0', 'm/0'],
      ["m/2147483647'", "m/2147483647'"],
    ])('%s becomes %s', (input, expected) => {
      expect(normalizeWalletPath(input)).toBe(expected);
    });

    test.each([
      [''],
      ['m'],
      ['m/'],
      ['/44'],
      ['m//44'],
      ['m/44/'],
      ['m/-1'],
      ["m/44''"],
      ['m/44h'],
      ['m/1.5'],
      ['m/0x10'],
      ['n/44'],
      ['m/2147483648'],
      ['m/00000000000000000044'],
      ['m/1/2/3/4/5/6/7/8/9/10/11'],
      [null],
      [44],
    ])('rejects %j', (input) => {
      expect(() => normalizeWalletPath(input)).toThrow('Enter a path like');
    });
  });

  describe('deriveWalletAtPath', () => {
    // Hardhat's default seed: its published accounts are MetaMask's scheme,
    // so these pin the preset against addresses nothing here computed.
    const HARDHAT_MNEMONIC = 'test test test test test test test test test test test junk';

    test.each([
      [0, '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'],
      [2, '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC'],
      [3, '0x90F79bf6EB2c4f870365E785982E1f101E93b906'],
    ])('reaches MetaMask account index %i', (index, address) => {
      const wallet = deriveWalletAtPath(HARDHAT_MNEMONIC, `m/44'/60'/0'/0/${index}`);
      expect(wallet.address).toBe(address);
    });

    test("matches Freedom's own scheme at the same path", () => {
      expect(deriveWalletAtPath(HARDHAT_MNEMONIC, "m/44'/60'/4'/0/0").address).toBe(
        deriveUserWallet(HARDHAT_MNEMONIC, 4).address
      );
    });

    test('returns the canonical path and the key', () => {
      const wallet = deriveWalletAtPath(HARDHAT_MNEMONIC, "044'/60'/0'/0/2");
      expect(wallet.path).toBe("m/44'/60'/0'/0/2");
      expect(wallet.privateKey).toBe(deriveEthereumKey(HARDHAT_MNEMONIC, wallet.path).privateKey);
    });

    test.each([[PATHS.BEE_WALLET], ["44'/60'/0'/0/1"], ["m/044'/060'/00'/00/01"]])(
      'refuses the Swarm node wallet at %s',
      (path) => {
        expect(() => deriveWalletAtPath(HARDHAT_MNEMONIC, path)).toThrow('Swarm node');
      }
    );

    test.each([
      [PATHS.RADICLE],
      [PATHS.IPFS],
      [PATHS.SWARM_PUBLISHER],
      [derivePublisherKey(TEST_MNEMONIC, 0).path],
      ["m/44'/73406'/7'/0/0"],
      ["m/044'/073406'/7'/0/0"],
    ])('refuses the reserved path %s', (path) => {
      expect(() => deriveWalletAtPath(HARDHAT_MNEMONIC, path)).toThrow('reserved');
    });

    test('does not refuse a coin type that only starts with a reserved number', () => {
      expect(deriveWalletAtPath(HARDHAT_MNEMONIC, "m/44'/734060'/0'").path).toBe(
        "m/44'/734060'/0'"
      );
    });

    test('throws on an invalid mnemonic or path', () => {
      expect(() => deriveWalletAtPath('invalid', "m/44'/60'/0'/0/2")).toThrow('Invalid mnemonic');
      expect(() => deriveWalletAtPath(HARDHAT_MNEMONIC, 'nope')).toThrow('Enter a path like');
    });
  });

  describe('BIP-39 passphrase', () => {
    // The official BIP-39 vector (trezor/python-mnemonic vectors.json).
    const VECTOR_SEED =
      'c55257c360c07c72029aebc1b53c05ed0362ada38ead3e3e9efa3708e53495531f09a6987599d18264c1e1c92f2cf141630c7a3c4ab7c81b2f001698e7463b04';
    const MAIN_ADDRESS = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94';
    const MAIN_ADDRESS_TREZOR = '0x9c32F71D4DB8Fb9e1A58B0a80dF79935e7256FA6';
    const SECRET = { mnemonic: TEST_MNEMONIC, passphrase: 'TREZOR' };
    const hex = (bytes) => Buffer.from(bytes).toString('hex');

    test('the seed matches the official vector', () => {
      expect(hex(getSeed(SECRET))).toBe(VECTOR_SEED);
    });

    test('the two libraries in use give the same wallet', () => {
      expect(deriveEthereumKey(SECRET, PATHS.USER_WALLET).address).toBe(MAIN_ADDRESS_TREZOR);
      // ethers derives secp256k1 keys and scure the seed for Ed25519 ones.
      expect(hex(getSeed(SECRET))).toBe(
        Mnemonic.fromPhrase(TEST_MNEMONIC, 'TREZOR').computeSeed().slice(2)
      );
    });

    test('a bare string and an empty passphrase are the same seed', () => {
      const bare = deriveAllKeys(TEST_MNEMONIC);
      const empty = deriveAllKeys({ mnemonic: TEST_MNEMONIC, passphrase: '' });
      const missing = deriveAllKeys({ mnemonic: TEST_MNEMONIC });

      expect(bare.userWallet.address).toBe(MAIN_ADDRESS);
      expect(empty.userWallet.address).toBe(MAIN_ADDRESS);
      expect(missing.userWallet.address).toBe(MAIN_ADDRESS);
    });

    test('changes every key derived from the seed', () => {
      const without = deriveAllKeys(TEST_MNEMONIC);
      const withIt = deriveAllKeys(SECRET);

      expect(withIt.userWallet.address).toBe(MAIN_ADDRESS_TREZOR);
      expect(withIt.beeWallet.address).not.toBe(without.beeWallet.address);
      expect(hex(withIt.radicleKey.publicKey)).not.toBe(hex(without.radicleKey.publicKey));
      expect(hex(withIt.ipfsKey.publicKey)).not.toBe(hex(without.ipfsKey.publicKey));
      expect(deriveUserWallet(SECRET, 3).address).not.toBe(
        deriveUserWallet(TEST_MNEMONIC, 3).address
      );
      expect(derivePublisherKey(SECRET, 0).address).not.toBe(
        derivePublisherKey(TEST_MNEMONIC, 0).address
      );
      expect(deriveWalletAtPath(SECRET, "m/44'/60'/0'/0/2").address).not.toBe(
        deriveWalletAtPath(TEST_MNEMONIC, "m/44'/60'/0'/0/2").address
      );
    });

    test.each([
      ['a trailing space', 'TREZOR '],
      ['a leading space', ' TREZOR'],
      ['different case', 'trezor'],
    ])('%s gives a different wallet, so it must never be cleaned up', (_label, passphrase) => {
      expect(deriveUserWallet({ mnemonic: TEST_MNEMONIC, passphrase }, 0).address).not.toBe(
        MAIN_ADDRESS_TREZOR
      );
    });

    test('composed and decomposed Unicode give the same wallet', () => {
      const composed = deriveAllKeys({ mnemonic: TEST_MNEMONIC, passphrase: 'caf\u00e9' });
      const decomposed = deriveAllKeys({ mnemonic: TEST_MNEMONIC, passphrase: 'cafe\u0301' });

      expect(composed.userWallet.address).toBe(decomposed.userWallet.address);
      expect(hex(composed.radicleKey.publicKey)).toBe(hex(decomposed.radicleKey.publicKey));
    });

    test('still refuses reserved paths', () => {
      expect(() => deriveWalletAtPath(SECRET, PATHS.BEE_WALLET)).toThrow('Swarm node');
      expect(() => deriveWalletAtPath(SECRET, "m/44'/73406'/0'/0/0")).toThrow('reserved');
    });

    test('refuses an invalid seed or a passphrase that is not text', () => {
      expect(() => deriveAllKeys({ mnemonic: 'invalid', passphrase: 'x' })).toThrow(
        'Invalid mnemonic'
      );
      expect(() => deriveAllKeys(null)).toThrow('Invalid mnemonic');
      expect(() => deriveAllKeys({ mnemonic: TEST_MNEMONIC, passphrase: 1 })).toThrow(
        'Passphrase must be text'
      );
    });
  });
});
