/**
 * Key format converters for node injection
 *
 * Converts derived keys to the specific formats each node expects:
 * - Bee: Ethereum JSON keystore
 * - IPFS: Protobuf + PeerID
 * - Radicle: OpenSSH format + DID
 */

import { Wallet } from 'ethers';
import { base58 } from '@scure/base';

// ============ BEE (Ethereum JSON Keystore) ============

/**
 * Create an Ethereum JSON keystore from a private key
 * @param {string} privateKey - 0x-prefixed hex private key
 * @param {string} password - Password to encrypt the keystore
 * @returns {Promise<string>} JSON keystore string
 */
export async function createBeeKeystore(privateKey, password) {
  const wallet = new Wallet(privateKey);
  // ethers.js Wallet.encrypt produces standard JSON keystore (scrypt + AES-128-CTR)
  const keystore = await wallet.encrypt(password);
  return keystore;
}

/**
 * Get Ethereum address from private key
 * @param {string} privateKey - 0x-prefixed hex private key
 * @returns {string} 0x-prefixed checksummed address
 */
export function getBeeAddress(privateKey) {
  const wallet = new Wallet(privateKey);
  return wallet.address;
}

// ============ IPFS (Protobuf + PeerID) ============

/**
 * Create IPFS identity config fields from Ed25519 key
 *
 * IPFS expects:
 * - PrivKey: Base64 of protobuf (Type=1, Data=64 bytes priv||pub)
 * - PeerID: Base58 of identity multihash (12D3KooW...)
 *
 * @param {Uint8Array} privateKey - 32-byte Ed25519 private key
 * @param {Uint8Array} publicKey - 32-byte Ed25519 public key
 * @returns {Object} { privKey, peerId }
 */
export function createIpfsIdentity(privateKey, publicKey) {
  // Build protobuf for private key
  // Protobuf: field 1 (Type) = varint 1 (Ed25519), field 2 (Data) = bytes (64 bytes)
  // Wire format: 0x08 0x01 (field 1, value 1), 0x12 0x40 (field 2, length 64), then data
  const keyData = new Uint8Array(64);
  keyData.set(privateKey, 0);
  keyData.set(publicKey, 32);

  const protobuf = new Uint8Array(68);
  protobuf[0] = 0x08; // field 1, wire type 0 (varint)
  protobuf[1] = 0x01; // value = 1 (Ed25519)
  protobuf[2] = 0x12; // field 2, wire type 2 (length-delimited)
  protobuf[3] = 0x40; // length = 64
  protobuf.set(keyData, 4);

  // Base64 encode for config
  const privKey = Buffer.from(protobuf).toString('base64');

  // Compute PeerID
  // For Ed25519 (32 bytes), IPFS inlines the key using identity multihash
  // PeerID = base58btc(multihash(identity, pubkey_protobuf))
  // pubkey_protobuf: 0x08 0x01 (type Ed25519) 0x12 0x20 (32 bytes) + pubkey
  const pubkeyProtobuf = new Uint8Array(36);
  pubkeyProtobuf[0] = 0x08;
  pubkeyProtobuf[1] = 0x01;
  pubkeyProtobuf[2] = 0x12;
  pubkeyProtobuf[3] = 0x20; // 32 bytes
  pubkeyProtobuf.set(publicKey, 4);

  // Identity multihash: 0x00 (identity code) + length + data
  const multihash = new Uint8Array(2 + pubkeyProtobuf.length);
  multihash[0] = 0x00; // identity hash code
  multihash[1] = pubkeyProtobuf.length; // 36 bytes
  multihash.set(pubkeyProtobuf, 2);

  const peerId = base58.encode(multihash);

  return { privKey, peerId };
}

// ============ RADICLE (OpenSSH + DID) ============

/**
 * Create Radicle identity files from Ed25519 key
 *
 * Radicle expects:
 * - Private key: OpenSSH v1 format (-----BEGIN OPENSSH PRIVATE KEY-----)
 * - Public key: ssh-ed25519 format
 * - DID: did:key:z6Mk...
 *
 * @param {Uint8Array} privateKey - 32-byte Ed25519 private key
 * @param {Uint8Array} publicKey - 32-byte Ed25519 public key
 * @param {string} comment - Comment for the SSH key (e.g., "FreedomBrowser")
 * @returns {Object} { privateKeyFile, publicKeyFile, did, nodeId }
 */
export function createRadicleIdentity(privateKey, publicKey, comment = 'FreedomBrowser') {
  // Create OpenSSH format using micro-key-producer
  // For now, let's implement the format directly since we need precise control

  // OpenSSH v1 format for Ed25519:
  // AUTH_MAGIC ("openssh-key-v1\0")
  // cipher (string) = "none"
  // kdfname (string) = "none"
  // kdfoptions (string) = ""
  // number of keys (uint32) = 1
  // public key (string)
  // private section (encrypted, but "none" means unencrypted):
  //   checkint (uint32) random
  //   checkint (uint32) same
  //   keytype (string) = "ssh-ed25519"
  //   pubkey (string)
  //   privkey (string) = 64 bytes (priv || pub)
  //   comment (string)
  //   padding (1, 2, 3, ... to block size)

  const sshPrivate = createOpenSSHPrivateKey(privateKey, publicKey, comment);
  const sshPublic = createOpenSSHPublicKey(publicKey, comment);

  // DID:key format for Ed25519
  // did:key:z + base58btc(0xED01 || pubkey)
  // 0xED01 is the multicodec for Ed25519 public key
  const didBytes = new Uint8Array(34);
  didBytes[0] = 0xed;
  didBytes[1] = 0x01;
  didBytes.set(publicKey, 2);
  const did = 'did:key:z' + base58.encode(didBytes);

  // Node ID is the same without "did:key:" prefix
  const nodeId = 'z' + base58.encode(didBytes);

  return {
    privateKeyFile: sshPrivate,
    publicKeyFile: sshPublic,
    did,
    nodeId,
  };
}

/**
 * Derive DID:key from Ed25519 public key (no private key needed)
 * Used to read Radicle identity without vault unlock
 * @param {Uint8Array} publicKey - 32-byte Ed25519 public key
 * @returns {string} DID in did:key format
 */
export function didFromPublicKey(publicKey) {
  // DID:key format for Ed25519
  // did:key:z + base58btc(0xED01 || pubkey)
  // 0xED01 is the multicodec for Ed25519 public key
  const didBytes = new Uint8Array(34);
  didBytes[0] = 0xed;
  didBytes[1] = 0x01;
  didBytes.set(publicKey, 2);
  return 'did:key:z' + base58.encode(didBytes);
}

/**
 * Create OpenSSH v1 private key format
 * @private
 */
function createOpenSSHPrivateKey(privateKey, publicKey, comment) {
  const AUTH_MAGIC = 'openssh-key-v1\0';

  // Helper to create SSH string (uint32 length + bytes)
  const sshString = (data) => {
    const bytes = typeof data === 'string' ? Buffer.from(data) : data;
    const buf = Buffer.alloc(4 + bytes.length);
    buf.writeUInt32BE(bytes.length, 0);
    buf.set(bytes, 4);
    return buf;
  };

  // Build public key blob: keytype + pubkey
  const pubkeyBlob = Buffer.concat([
    sshString('ssh-ed25519'),
    sshString(publicKey),
  ]);

  // Random check integers (both same for integrity check)
  const checkInt = Math.floor(Math.random() * 0xffffffff);
  const checkBuf = Buffer.alloc(8);
  checkBuf.writeUInt32BE(checkInt, 0);
  checkBuf.writeUInt32BE(checkInt, 4);

  // Private section (unencrypted):
  // checkint, checkint, keytype, pubkey, privkey (64 bytes), comment, padding
  const privkeyData = Buffer.alloc(64);
  privkeyData.set(privateKey, 0);
  privkeyData.set(publicKey, 32);

  let privateSection = Buffer.concat([
    checkBuf,
    sshString('ssh-ed25519'),
    sshString(publicKey),
    sshString(privkeyData),
    sshString(comment),
  ]);

  // Add padding (1, 2, 3, ...) to reach block size (8 for "none" cipher)
  const blockSize = 8;
  const padLen = blockSize - (privateSection.length % blockSize);
  const padding = Buffer.alloc(padLen);
  for (let i = 0; i < padLen; i++) {
    padding[i] = i + 1;
  }
  privateSection = Buffer.concat([privateSection, padding]);

  // Build full key
  const fullKey = Buffer.concat([
    Buffer.from(AUTH_MAGIC),
    sshString('none'),           // cipher
    sshString('none'),           // kdfname
    sshString(''),               // kdfoptions
    Buffer.from([0, 0, 0, 1]),   // number of keys
    sshString(pubkeyBlob),       // public key
    sshString(privateSection),   // private section
  ]);

  // Base64 encode with line wrapping
  const b64 = fullKey.toString('base64');
  const lines = [];
  for (let i = 0; i < b64.length; i += 70) {
    lines.push(b64.slice(i, i + 70));
  }

  return '-----BEGIN OPENSSH PRIVATE KEY-----\n' +
         lines.join('\n') + '\n' +
         '-----END OPENSSH PRIVATE KEY-----\n';
}

/**
 * Create OpenSSH public key format
 * @private
 */
function createOpenSSHPublicKey(publicKey, comment) {
  // Format: "ssh-ed25519 <base64> <comment>"
  const keytype = Buffer.from('ssh-ed25519');
  const keytypeLen = Buffer.alloc(4);
  keytypeLen.writeUInt32BE(keytype.length, 0);

  const pubkeyLen = Buffer.alloc(4);
  pubkeyLen.writeUInt32BE(publicKey.length, 0);

  const blob = Buffer.concat([keytypeLen, keytype, pubkeyLen, Buffer.from(publicKey)]);
  const b64 = blob.toString('base64');

  return `ssh-ed25519 ${b64} ${comment}\n`;
}
