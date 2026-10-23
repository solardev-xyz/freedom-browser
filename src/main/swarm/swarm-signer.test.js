// swarm-signer: identities resolve to key references and owners, and every
// chunk signature from the identity core is checked with bee-js and ethers.
// The core is simulated with bee-js's own SOC construction on test keys,
// which the real core matches byte for byte (freedom-core vectors/signing.json).
const { Bee, PrivateKey } = require('@ethersphere/bee-js');

const mockKeys = {
  bee_wallet: '0x' + '11'.repeat(32),
  'publisher:3': '0x' + '22'.repeat(32),
  'account:2': '0x' + '33'.repeat(32),
};
const mockKeyId = (key) =>
  key.kind === 'bee_wallet'
    ? 'bee_wallet'
    : key.kind === 'publisher'
      ? `publisher:${key.origin_index}`
      : `account:${key.index}`;
const mockAddressOf = (id) => new (require('ethers').Wallet)(mockKeys[id]).address;

const mockBee = new Bee('http://127.0.0.1:1633');
const mockCore = { tamper: null, calls: [] };
jest.mock('../core/vault-backend', () => ({
  vaultBackend: {
    sign: {
      soc: async (key, { identifier, payload, span }) => {
        mockCore.calls.push(key);
        const cac = mockBee.makeContentAddressedChunk(payload, span || undefined);
        const { PrivateKey: Key } = require('@ethersphere/bee-js');
        const soc = cac.toSingleOwnerChunk(identifier, new Key(mockKeys[mockKeyId(key)].slice(2)));
        const result = {
          signature: '0x' + soc.signature.toHex(),
          owner: soc.owner.toChecksum(),
          chunk_address: '0x' + cac.address.toHex(),
          soc_address: '0x' + soc.address.toHex(),
          span: soc.span.toBigInt().toString(),
        };
        return mockCore.tamper ? mockCore.tamper(result) : result;
      },
    },
  },
}));

const mockState = { unlocked: true, records: {}, lookups: [] };
jest.mock('../identity-manager', () => ({
  WALLET_TYPES: { MNEMONIC: 'mnemonic', LEDGER: 'ledger', REMOTE: 'remote', SAFE: 'safe' },
  getWalletRecord: (index) => {
    mockState.lookups.push(['getWalletRecord', index]);
    return mockState.records[index] || null;
  },
  getBeeWalletAddress: async () => (mockState.unlocked ? mockAddressOf('bee_wallet') : null),
  getPublisherAddress: async (index) => {
    if (!mockState.unlocked) throw new Error('Vault must be unlocked to derive publisher keys');
    return mockAddressOf(`publisher:${index}`);
  },
  deriveAddresses: async ({ accounts = [] } = {}) => {
    mockState.lookups.push(['deriveAddresses', accounts]);
    return mockState.unlocked
      ? { user_wallets: accounts.map((account) => ({ account, address: mockAddressOf(`account:${account}`) })) }
      : null;
  },
}));
jest.mock('./swarm-service', () => ({ getBee: () => mockBee }));

const { resolveSwarmSigner } = require('./swarm-signer');

const IDENTIFIER = Buffer.alloc(32, 0x5a);
const PAYLOAD = Buffer.from('a single-owner chunk');

beforeEach(() => {
  mockState.unlocked = true;
  mockState.records = { 2: { index: 2, type: 'mnemonic' } };
  mockState.lookups = [];
  mockCore.tamper = null;
  mockCore.calls = [];
});

describe('resolveSwarmSigner', () => {
  test.each([
    ['bee-wallet', {}, { kind: 'bee_wallet' }, 'bee_wallet'],
    ['app-scoped', { publisherKeyIndex: 3 }, { kind: 'publisher', origin_index: 3 }, 'publisher:3'],
  ])('%s signs with its key reference, as bee-js would', async (mode, fields, key, id) => {
    const signer = await resolveSwarmSigner({ mode, ...fields });
    expect(signer.owner).toBe(mockAddressOf(id));
    const signed = await signer.signSoc({ identifier: IDENTIFIER, payload: PAYLOAD });
    expect(mockCore.calls).toEqual([key]);

    const soc = mockBee
      .makeContentAddressedChunk(PAYLOAD)
      .toSingleOwnerChunk(IDENTIFIER, new PrivateKey(mockKeys[id].slice(2)));
    expect(signed).toEqual({
      span: BigInt(PAYLOAD.length),
      chunkAddress: '0x' + mockBee.makeContentAddressedChunk(PAYLOAD).address.toHex(),
      signature: '0x' + soc.signature.toHex(),
      owner: mockAddressOf(id),
      socAddress: '0x' + soc.address.toHex(),
    });
  });

  test('a span of 0 is the payload length, as in bee-js', async () => {
    const signer = await resolveSwarmSigner({ mode: 'bee-wallet' });
    const signed = await signer.signSoc({ identifier: IDENTIFIER, payload: PAYLOAD, span: 0n });
    expect(signed.span).toBe(BigInt(PAYLOAD.length));
    const wrapped = await signer.signSoc({ identifier: IDENTIFIER, payload: PAYLOAD, span: 50000n });
    expect(wrapped.span).toBe(50000n);
  });

  test.each([
    ['bee-wallet', {}, 'Vault is locked'],
    ['app-scoped', { publisherKeyIndex: 3 }, 'Vault must be unlocked to derive publisher keys'],
  ])('a locked vault refuses %s before any signing', async (mode, fields, message) => {
    mockState.unlocked = false;
    await expect(resolveSwarmSigner({ mode, ...fields })).rejects.toThrow(message);
    expect(mockCore.calls).toEqual([]);
  });

  // #89: accounts don't own feeds. A stored ethereum-wallet identity fails
  // with a plain error, whatever its account, locked or not, before any
  // lookup or key: no signature with any key, and no fallback.
  test.each([
    ['a vault account', { 2: { index: 2, type: 'mnemonic' } }, true],
    ['a vault account, locked', { 2: { index: 2, type: 'mnemonic' } }, false],
    ['a Ledger account', { 2: { index: 2, type: 'ledger' } }, true],
    ['a phone account', { 2: { index: 2, type: 'remote' } }, true],
    ['a Safe account', { 2: { index: 2, type: 'safe' } }, true],
    ['a deleted account', {}, true],
  ])('an ethereum-wallet identity on %s fails, and nothing signs', async (_label, records, unlocked) => {
    mockState.records = records;
    mockState.unlocked = unlocked;
    for (const identity of [
      { mode: 'ethereum-wallet', walletIndex: 2 },
      { identityMode: 'ethereum-wallet', walletIndex: 2 },
      { mode: 'ethereum-wallet' },
    ]) {
      await expect(resolveSwarmSigner(identity)).rejects.toThrow(
        "Ethereum wallet publisher identities aren't available"
      );
    }
    expect(mockCore.calls).toEqual([]);
    expect(mockState.lookups).toEqual([]);
  });

  test('malformed identities are refused', async () => {
    await expect(resolveSwarmSigner({ mode: 'app-scoped' })).rejects.toThrow('missing a publisher key index');
    await expect(resolveSwarmSigner({ mode: 'other' })).rejects.toThrow('Unknown identity mode: other');
    expect(mockCore.calls).toEqual([]);
  });
});

describe('the core result is checked before use', () => {
  const wrongKeySignature = async () => {
    const other = mockBee
      .makeContentAddressedChunk(PAYLOAD)
      .toSingleOwnerChunk(IDENTIFIER, new PrivateKey('44'.repeat(32)));
    return '0x' + other.signature.toHex();
  };

  test.each([
    ['a signature from another key', async (r) => ({ ...r, signature: await wrongKeySignature() })],
    ['another chunk address', async (r) => ({ ...r, chunk_address: '0x' + '00'.repeat(32) })],
    ['another owner', async (r) => ({ ...r, owner: mockAddressOf('account:2') })],
    ['another SOC address', async (r) => ({ ...r, soc_address: '0x' + '00'.repeat(32) })],
    ['another span', async (r) => ({ ...r, span: '999' })],
    [
      'the same signature in 64-byte compact form',
      async (r) => ({ ...r, signature: require('ethers').Signature.from(r.signature).compactSerialized }),
    ],
    [
      'the same signature with v as 0/1',
      async (r) => {
        const bytes = Buffer.from(r.signature.slice(2), 'hex');
        bytes[64] -= 27;
        return { ...r, signature: '0x' + bytes.toString('hex') };
      },
    ],
  ])('%s is refused', async (_label, tamper) => {
    const signer = await resolveSwarmSigner({ mode: 'bee-wallet' });
    const original = mockCore.tamper;
    let tampered;
    mockCore.tamper = (result) => {
      tampered = result;
      return result;
    };
    await signer.signSoc({ identifier: IDENTIFIER, payload: PAYLOAD });
    const altered = await tamper(tampered);
    mockCore.tamper = () => altered;
    await expect(signer.signSoc({ identifier: IDENTIFIER, payload: PAYLOAD })).rejects.toThrow(
      'does not match'
    );
    mockCore.tamper = original;
  });
});
