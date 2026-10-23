/**
 * Tests for key format converters
 */

const {
  createBeeKeystore,
  getBeeAddress,
  createIpfsIdentity,
  createRadicleIdentity,
} = require('./formats');
const { deriveAllKeys } = require('./derivation');
const { Wallet } = require('ethers');

// Test mnemonic - same as in derivation tests
const TEST_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

describe('formats', () => {
  let keys;

  beforeAll(() => {
    keys = deriveAllKeys(TEST_MNEMONIC);
  });

  describe('Bee (Ethereum JSON Keystore)', () => {
    test('creates valid JSON keystore', async () => {
      const keystore = await createBeeKeystore(keys.beeWallet.privateKey, 'test-password');

      // Should be valid JSON
      const parsed = JSON.parse(keystore);
      expect(parsed.version).toBe(3);
      // ethers.js uses capital 'C' for Crypto
      expect(parsed.Crypto).toBeDefined();
      expect(parsed.Crypto.cipher).toBe('aes-128-ctr');
    });

    test('keystore can be decrypted back to same key', async () => {
      const password = 'test-password-123';
      const keystore = await createBeeKeystore(keys.beeWallet.privateKey, password);

      // Decrypt and verify
      const decrypted = await Wallet.fromEncryptedJson(keystore, password);
      expect(decrypted.privateKey).toBe(keys.beeWallet.privateKey);
      expect(decrypted.address).toBe(keys.beeWallet.address);
    });

    test('getBeeAddress returns correct address', () => {
      const address = getBeeAddress(keys.beeWallet.privateKey);
      expect(address).toBe(keys.beeWallet.address);
    });

    test('keystore address matches derived address', async () => {
      const keystore = await createBeeKeystore(keys.beeWallet.privateKey, 'password');
      const parsed = JSON.parse(keystore);

      // Keystore stores lowercase address without 0x prefix
      expect('0x' + parsed.address).toBe(keys.beeWallet.address.toLowerCase());
    });
  });

  describe('IPFS (Protobuf + PeerID)', () => {
    test('creates privKey in base64 format', () => {
      const identity = createIpfsIdentity(keys.ipfsKey.privateKey, keys.ipfsKey.publicKey);

      expect(identity.privKey).toBeDefined();
      expect(typeof identity.privKey).toBe('string');

      // Should be valid base64
      const decoded = Buffer.from(identity.privKey, 'base64');
      expect(decoded.length).toBe(68); // 4 bytes header + 64 bytes key data
    });

    test('privKey contains correct protobuf structure', () => {
      const identity = createIpfsIdentity(keys.ipfsKey.privateKey, keys.ipfsKey.publicKey);
      const decoded = Buffer.from(identity.privKey, 'base64');

      // Check protobuf header
      expect(decoded[0]).toBe(0x08); // field 1, wire type 0
      expect(decoded[1]).toBe(0x01); // value = 1 (Ed25519)
      expect(decoded[2]).toBe(0x12); // field 2, wire type 2
      expect(decoded[3]).toBe(0x40); // length = 64

      // Check that key data is present
      const keyData = decoded.slice(4);
      expect(keyData.length).toBe(64);

      // First 32 bytes should be private key
      expect(Buffer.from(keys.ipfsKey.privateKey).equals(keyData.slice(0, 32))).toBe(true);
      // Last 32 bytes should be public key
      expect(Buffer.from(keys.ipfsKey.publicKey).equals(keyData.slice(32))).toBe(true);
    });

    test('creates peerId starting with 12D3KooW', () => {
      const identity = createIpfsIdentity(keys.ipfsKey.privateKey, keys.ipfsKey.publicKey);

      expect(identity.peerId).toBeDefined();
      expect(identity.peerId.startsWith('12D3KooW')).toBe(true);
    });

    test('peerId is deterministic', () => {
      const identity1 = createIpfsIdentity(keys.ipfsKey.privateKey, keys.ipfsKey.publicKey);
      const identity2 = createIpfsIdentity(keys.ipfsKey.privateKey, keys.ipfsKey.publicKey);

      expect(identity1.peerId).toBe(identity2.peerId);
    });

    test('different keys produce different peerIds', () => {
      const ipfsIdentity = createIpfsIdentity(keys.ipfsKey.privateKey, keys.ipfsKey.publicKey);
      const radicleAsIpfs = createIpfsIdentity(keys.radicleKey.privateKey, keys.radicleKey.publicKey);

      expect(ipfsIdentity.peerId).not.toBe(radicleAsIpfs.peerId);
    });
  });

  describe('Radicle (OpenSSH + DID)', () => {
    /** The private section of an unencrypted OpenSSH v1 key file. */
    function privateSection(privateKeyFile) {
      const body = privateKeyFile
        .split('\n')
        .filter((line) => line && !line.startsWith('-----'))
        .join('');
      const bytes = Buffer.from(body, 'base64');
      let at = 'openssh-key-v1\0'.length;
      const string = () => {
        const len = bytes.readUInt32BE(at);
        const value = bytes.subarray(at + 4, at + 4 + len);
        at += 4 + len;
        return value;
      };
      string(); // cipher
      string(); // kdf
      string(); // kdf options
      at += 4; // key count
      string(); // public key
      return string();
    }

    test('pads the private section to a block, never by a whole block (#77)', () => {
      // The section is 131 bytes plus the alias, so lengths 5, 13 and 21 are
      // already aligned.
      for (let len = 0; len <= 24; len++) {
        const comment = 'a'.repeat(len);
        const identity = createRadicleIdentity(
          keys.radicleKey.privateKey,
          keys.radicleKey.publicKey,
          comment
        );
        const section = privateSection(identity.privateKeyFile);
        expect(section.length % 8).toBe(0);
        // checkints, then four strings: key type, public key, private key, comment.
        let at = 8;
        for (let i = 0; i < 4; i++) at += 4 + section.readUInt32BE(at);
        const padding = section.subarray(at);
        expect(padding.length).toBeLessThan(8);
        expect([...padding]).toEqual([...padding].map((_, i) => i + 1));
        expect(at - 8).toBe(4 + 11 + 4 + 32 + 4 + 64 + 4 + len);
      }
    });

    test('creates valid OpenSSH private key format', () => {
      const identity = createRadicleIdentity(
        keys.radicleKey.privateKey,
        keys.radicleKey.publicKey,
        'TestComment'
      );

      expect(identity.privateKeyFile).toContain('-----BEGIN OPENSSH PRIVATE KEY-----');
      expect(identity.privateKeyFile).toContain('-----END OPENSSH PRIVATE KEY-----');
    });

    test('creates valid ssh-ed25519 public key format', () => {
      const identity = createRadicleIdentity(
        keys.radicleKey.privateKey,
        keys.radicleKey.publicKey,
        'TestComment'
      );

      expect(identity.publicKeyFile).toMatch(/^ssh-ed25519 [A-Za-z0-9+/=]+ TestComment\n$/);
    });

    test('creates valid DID:key format', () => {
      const identity = createRadicleIdentity(
        keys.radicleKey.privateKey,
        keys.radicleKey.publicKey
      );

      // DID:key for Ed25519 starts with did:key:z6Mk
      expect(identity.did).toMatch(/^did:key:z[A-Za-z0-9]+$/);
      expect(identity.did.startsWith('did:key:z6Mk')).toBe(true);
    });

    test('nodeId matches DID without prefix', () => {
      const identity = createRadicleIdentity(
        keys.radicleKey.privateKey,
        keys.radicleKey.publicKey
      );

      expect(identity.did).toBe('did:key:' + identity.nodeId);
    });

    test('identity is deterministic', () => {
      const identity1 = createRadicleIdentity(
        keys.radicleKey.privateKey,
        keys.radicleKey.publicKey,
        'Test'
      );
      const identity2 = createRadicleIdentity(
        keys.radicleKey.privateKey,
        keys.radicleKey.publicKey,
        'Test'
      );

      expect(identity1.did).toBe(identity2.did);
      expect(identity1.publicKeyFile).toBe(identity2.publicKeyFile);
      // Private key file has random check int, so we check structure not exact match
      expect(identity1.privateKeyFile).toContain('-----BEGIN OPENSSH PRIVATE KEY-----');
    });

    test('different keys produce different DIDs', () => {
      const radicleIdentity = createRadicleIdentity(
        keys.radicleKey.privateKey,
        keys.radicleKey.publicKey
      );
      const ipfsAsRadicle = createRadicleIdentity(
        keys.ipfsKey.privateKey,
        keys.ipfsKey.publicKey
      );

      expect(radicleIdentity.did).not.toBe(ipfsAsRadicle.did);
    });

    test('public key base64 decodes to valid structure', () => {
      const identity = createRadicleIdentity(
        keys.radicleKey.privateKey,
        keys.radicleKey.publicKey,
        'Test'
      );

      // Extract base64 part
      const parts = identity.publicKeyFile.trim().split(' ');
      expect(parts[0]).toBe('ssh-ed25519');

      const decoded = Buffer.from(parts[1], 'base64');
      // Should contain: uint32 length of "ssh-ed25519" (11) + "ssh-ed25519" + uint32 length of pubkey (32) + pubkey
      expect(decoded.length).toBe(4 + 11 + 4 + 32);

      // Check key type string
      const keyTypeLen = decoded.readUInt32BE(0);
      expect(keyTypeLen).toBe(11);
      expect(decoded.slice(4, 15).toString()).toBe('ssh-ed25519');

      // Check public key
      const pubkeyLen = decoded.readUInt32BE(15);
      expect(pubkeyLen).toBe(32);
      expect(Buffer.from(keys.radicleKey.publicKey).equals(decoded.slice(19))).toBe(true);
    });
  });
});
