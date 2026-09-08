const originalWindow = global.window;

const loadNavigationUtils = async () => {
  jest.resetModules();
  global.window = {
    location: { href: 'file:///app/index.html' },
    internalPages: { routable: {} },
  };

  return import('./navigation-utils.js');
};

describe('navigation-utils', () => {
  afterEach(() => {
    global.window = originalWindow;
  });

  describe('resolveProtocolIconType', () => {
    test('defaults to http and handles dweb protocols', async () => {
      const { resolveProtocolIconType } = await loadNavigationUtils();

      expect(resolveProtocolIconType({ value: '' })).toBe('http');
      expect(resolveProtocolIconType({ value: 'bzz://hash' })).toBe('swarm');
      expect(resolveProtocolIconType({ value: 'ipfs://cid' })).toBe('ipfs');
      expect(resolveProtocolIconType({ value: 'ipns://name' })).toBe('ipns');
      expect(
        resolveProtocolIconType({
          value: 'web3://0x0000000000000000000000000000000000000000.eip155-1/',
        })
      ).toBe('onchain');
      expect(resolveProtocolIconType({ value: 'https://example.com' })).toBe('https');
    });

    test('maps ens names through resolved protocols', async () => {
      const { resolveProtocolIconType } = await loadNavigationUtils();

      expect(
        resolveProtocolIconType({
          value: 'ens://vitalik.eth',
          ensProtocols: new Map([['vitalik.eth', 'ipfs']]),
        })
      ).toBe('ipfs');
      expect(
        resolveProtocolIconType({
          value: 'vitalik.eth/docs',
          ensProtocols: new Map(),
        })
      ).toBe('http');
      expect(
        resolveProtocolIconType({
          value: 'vitalik.eth/docs',
          ensProtocols: new Map([['vitalik.eth', 'ipfs']]),
        })
      ).toBe('ipfs');
    });

    test('transport scheme wins over ens lookup for transport-prefixed display urls', async () => {
      const { resolveProtocolIconType } = await loadNavigationUtils();

      // After ENS resolution the address bar shows `bzz://name.eth`,
      // `ipfs://name.eth`, or `ipns://name.eth`. The icon must follow the
      // transport scheme even when the host is an ENS name (and even when
      // there's no path / trailing slash to distinguish it).
      expect(
        resolveProtocolIconType({
          value: 'bzz://meinhard.eth',
          ensProtocols: new Map([['meinhard.eth', 'bzz']]),
        })
      ).toBe('swarm');
      expect(
        resolveProtocolIconType({
          value: 'ipfs://vitalik.eth',
          ensProtocols: new Map([['vitalik.eth', 'ipfs']]),
        })
      ).toBe('ipfs');
      expect(
        resolveProtocolIconType({
          value: 'ipns://app.uniswap.eth/swap',
          ensProtocols: new Map(),
        })
      ).toBe('ipns');
      expect(resolveProtocolIconType({ value: 'bzz://meinhard.eth/path' })).toBe('swarm');
    });

    test('uses the neutral globe for internal pages and identifies Radicle URLs', async () => {
      const { resolveProtocolIconType } = await loadNavigationUtils();

      // Internal pages reuse the neutral http globe so the address bar
      // always shows *something* — and never falls back to a stale ENS
      // trust shield left behind by a previous navigation.
      expect(resolveProtocolIconType({ value: 'freedom://history' })).toBe('http');
      expect(resolveProtocolIconType({ value: 'freedom://settings' })).toBe('http');
      expect(resolveProtocolIconType({ value: 'rad://rid' })).toBe('radicle');
    });

    test('prefers secure icon when the page is marked secure', async () => {
      const { resolveProtocolIconType } = await loadNavigationUtils();

      expect(
        resolveProtocolIconType({
          value: 'example.com',
          currentPageSecure: true,
        })
      ).toBe('https');
    });
  });

  describe('buildRadicleDisabledUrl', () => {
    test('creates a rad-browser disabled url and preserves input', async () => {
      const { buildRadicleDisabledUrl } = await loadNavigationUtils();

      expect(buildRadicleDisabledUrl('file:///app/index.html')).toBe(
        'file:///app/pages/rad-browser.html?error=disabled'
      );
      expect(buildRadicleDisabledUrl('file:///app/index.html', 'rad://zabc')).toBe(
        'file:///app/pages/rad-browser.html?error=disabled&input=rad%3A%2F%2Fzabc'
      );
    });
  });

  describe('resolveTrustBadge', () => {
    const verifiedTrust = { level: 'verified', agreed: ['a', 'b'], queried: ['a', 'b', 'c'] };
    const conflictTrust = { level: 'conflict', agreed: [], dissented: ['a', 'b'] };

    test('returns null for non-ENS URLs', async () => {
      const { resolveTrustBadge } = await loadNavigationUtils();
      const ensTrustByName = new Map([['vitalik.eth', verifiedTrust]]);

      expect(resolveTrustBadge({ value: 'https://example.com', ensTrustByName })).toBeNull();
      expect(resolveTrustBadge({ value: 'bzz://hash', ensTrustByName })).toBeNull();
      expect(resolveTrustBadge({ value: 'freedom://history', ensTrustByName })).toBeNull();
      expect(resolveTrustBadge({ value: '', ensTrustByName })).toBeNull();
    });

    test('returns null when the ENS name has no trust entry', async () => {
      const { resolveTrustBadge } = await loadNavigationUtils();
      const ensTrustByName = new Map([['other.eth', verifiedTrust]]);

      expect(resolveTrustBadge({ value: 'ens://vitalik.eth', ensTrustByName })).toBeNull();
    });

    test('returns badge for ens:// URLs with trust entry', async () => {
      const { resolveTrustBadge } = await loadNavigationUtils();
      const ensTrustByName = new Map([['vitalik.eth', verifiedTrust]]);

      const badge = resolveTrustBadge({ value: 'ens://vitalik.eth', ensTrustByName });

      expect(badge).toEqual({
        level: 'verified',
        name: 'vitalik.eth',
        trust: verifiedTrust,
      });
    });

    test('returns badge for bare .eth, .box, .wei, and .gwei URLs', async () => {
      const { resolveTrustBadge } = await loadNavigationUtils();
      const ensTrustByName = new Map([
        ['vitalik.eth', verifiedTrust],
        ['example.box', conflictTrust],
        ['alice.wei', { ...verifiedTrust, system: 'wns' }],
        ['apoorv.gwei', { ...verifiedTrust, system: 'gns' }],
      ]);

      expect(resolveTrustBadge({ value: 'vitalik.eth', ensTrustByName }).level).toBe('verified');
      expect(resolveTrustBadge({ value: 'example.box', ensTrustByName }).level).toBe('conflict');
      expect(resolveTrustBadge({ value: 'alice.wei', ensTrustByName }).trust.system).toBe('wns');
      expect(resolveTrustBadge({ value: 'apoorv.gwei', ensTrustByName }).trust.system).toBe('gns');
    });

    test('strips path and is case-insensitive', async () => {
      const { resolveTrustBadge } = await loadNavigationUtils();
      const ensTrustByName = new Map([['vitalik.eth', verifiedTrust]]);

      expect(resolveTrustBadge({ value: 'ens://vitalik.eth/profile', ensTrustByName }).level).toBe(
        'verified'
      );
      expect(resolveTrustBadge({ value: 'VITALIK.ETH', ensTrustByName }).level).toBe('verified');
      expect(resolveTrustBadge({ value: 'ENS://Vitalik.ETH/x', ensTrustByName }).level).toBe(
        'verified'
      );
      expect(
        resolveTrustBadge({ value: 'vitalik.eth/path?q=1#frag', ensTrustByName }).level
      ).toBe('verified');
    });

    test('returns badge for transport-prefixed ENS hosts', async () => {
      const { resolveTrustBadge } = await loadNavigationUtils();
      const ensTrustByName = new Map([
        ['meinhard.eth', verifiedTrust],
        ['vitalik.eth', conflictTrust],
      ]);

      expect(resolveTrustBadge({ value: 'bzz://meinhard.eth', ensTrustByName }).level).toBe(
        'verified'
      );
      expect(resolveTrustBadge({ value: 'bzz://meinhard.eth/path', ensTrustByName }).level).toBe(
        'verified'
      );
      expect(resolveTrustBadge({ value: 'ipfs://vitalik.eth', ensTrustByName }).level).toBe(
        'conflict'
      );
      expect(resolveTrustBadge({ value: 'ipns://vitalik.eth/x', ensTrustByName }).level).toBe(
        'conflict'
      );
    });

    test('returns an onchain badge only when provenance matches the URL identity', async () => {
      const { resolveTrustBadge } = await loadNavigationUtils();
      const contract = '0x00000095643cffa7d9fae407a84dfcb6406456c6';
      const provenance = {
        chainId: 1,
        contract,
        trust: { level: 'verified', method: 'myotis' },
      };

      expect(resolveTrustBadge({
        value: `web3://${contract}/swap`,
        onchainProvenance: provenance,
      })).toEqual({
        kind: 'onchain',
        level: 'verified',
        name: 'web3://0x0000009564…b6406456c6',
        trust: provenance.trust,
        provenance,
      });
      expect(resolveTrustBadge({
        value: `web3://${contract}:100/`,
        onchainProvenance: provenance,
      })).toBeNull();
    });

    test('tolerates missing / empty arguments', async () => {
      const { resolveTrustBadge } = await loadNavigationUtils();

      expect(resolveTrustBadge()).toBeNull();
      expect(resolveTrustBadge({})).toBeNull();
      expect(resolveTrustBadge({ value: 'ens://x.eth' })).toBeNull();
    });

    test('returns null when trust has no level (defensive)', async () => {
      const { resolveTrustBadge } = await loadNavigationUtils();
      const ensTrustByName = new Map([['vitalik.eth', { agreed: ['a'] }]]);

      expect(resolveTrustBadge({ value: 'ens://vitalik.eth', ensTrustByName })).toBeNull();
    });
  });

  describe('buildTrustRows', () => {
    // The fixtures below mirror the four user-visible levels surfaced by
    // the ENS resolver. Each test pins the exact row sequence so a future
    // copy / ordering regression in this security-relevant surface is
    // caught here rather than at review time.

    test('verified with full quorum: lists shared summary, block, RPCs, network, hash', async () => {
      const { buildTrustRows } = await loadNavigationUtils();

      const result = buildTrustRows({
        level: 'verified',
        trust: {
          agreed: ['ethereum.publicnode.com', 'eth.drpc.org', 'cloudflare-eth.com'],
          queried: ['ethereum.publicnode.com', 'eth.drpc.org', 'cloudflare-eth.com'],
          block: { number: 25030249 },
        },
        uri: 'ipfs://QmPSYsfe8CVrBMrbh3q8qjzQYnAmDX8H4xkERzvFBaYkMS',
      });

      expect(result.status).toBe('ENS resolution verified');
      expect(result.trustRows).toEqual([
        { label: 'Verified by', display: '3 of 3 public RPCs', copy: '' },
        { label: 'Evidence', display: 'Matching RPC responses', copy: '' },
        { label: 'Block', display: '25030249', copy: '25030249' },
        {
          label: 'RPC 1',
          display: 'ethereum.publicnode.com',
          copy: 'ethereum.publicnode.com',
          autoFit: 'ethereum.publicnode.com',
        },
        {
          label: 'RPC 2',
          display: 'eth.drpc.org',
          copy: 'eth.drpc.org',
          autoFit: 'eth.drpc.org',
        },
        {
          label: 'RPC 3',
          display: 'cloudflare-eth.com',
          copy: 'cloudflare-eth.com',
          autoFit: 'cloudflare-eth.com',
        },
      ]);
      expect(result.contentRows).toEqual([
        { label: 'Network', display: 'IPFS', copy: '' },
        {
          label: 'CID',
          display: 'QmPSYsfe8CVrBMrbh3q8qjzQYnAmDX8H4xkERzvFBaYkMS',
          copy: 'QmPSYsfe8CVrBMrbh3q8qjzQYnAmDX8H4xkERzvFBaYkMS',
          autoFit: 'QmPSYsfe8CVrBMrbh3q8qjzQYnAmDX8H4xkERzvFBaYkMS',
        },
      ]);
    });

    test('onchain provenance reuses verification rows and identifies the loaded document', async () => {
      const { buildTrustRows } = await loadNavigationUtils();
      const contract = '0x00000095643CFfA7D9fae407a84dfCB6406456c6';
      const htmlHash = `0x${'ab'.repeat(32)}`;

      const result = buildTrustRows({
        level: 'verified',
        trust: {
          level: 'verified',
          method: 'myotis',
          finality: 'optimistic',
          block: 25_684_159,
        },
        onchainProvenance: {
          chainId: 1,
          network: 'Ethereum',
          contract,
          htmlHash,
        },
      });

      expect(result.status).toBe('Onchain application retrieval verified');
      expect(result.trustRows).toEqual([
        { label: 'Verified by', display: 'Myotis light client', copy: '' },
        { label: 'Evidence', display: 'Optimistic beacon proof (not finalized)', copy: '' },
        { label: 'Block', display: '25684159', copy: '25684159' },
      ]);
      expect(result.contentRows).toEqual([
        { label: 'Network', display: 'Ethereum', copy: '' },
        { label: 'Contract', display: contract, copy: contract, autoFit: contract },
        { label: 'HTML hash', display: htmlHash, copy: htmlHash, autoFit: htmlHash },
      ]);
    });

    test('verified with partial quorum: only lists RPCs that responded', async () => {
      // 3 queried, 2 agreed — quorum still met, but the third RPC dropped
      // out and shouldn't be rendered as a numbered row alongside the
      // responders.
      const { buildTrustRows } = await loadNavigationUtils();

      const result = buildTrustRows({
        level: 'verified',
        trust: {
          agreed: ['ethereum.publicnode.com', 'eth.drpc.org'],
          queried: ['ethereum.publicnode.com', 'eth.drpc.org', 'down.example'],
          block: { number: 25038025 },
        },
        uri: 'ipfs://QmHash',
      });

      expect(result.status).toBe('ENS resolution verified');
      expect(result.trustRows.map((r) => r.label)).toEqual([
        'Verified by',
        'Evidence',
        'Block',
        'RPC 1',
        'RPC 2',
      ]);
      expect(result.trustRows[0]).toEqual({
        label: 'Verified by',
        display: '2 of 3 public RPCs',
        copy: '',
      });
    });

    test('WNS trust uses WNS-specific status copy', async () => {
      const { buildTrustRows } = await loadNavigationUtils();

      const result = buildTrustRows({
        level: 'verified',
        trust: {
          system: 'wns',
          agreed: ['ethereum.publicnode.com', 'eth.drpc.org'],
          queried: ['ethereum.publicnode.com', 'eth.drpc.org'],
          block: { number: 25038025 },
        },
        uri: 'ipfs://QmHash',
      });

      expect(result.status).toBe('WNS resolution verified');
    });

    test('GNS trust uses GNS-specific status copy', async () => {
      const { buildTrustRows } = await loadNavigationUtils();

      const result = buildTrustRows({
        level: 'verified',
        trust: {
          system: 'gns',
          agreed: ['ethereum.publicnode.com', 'eth.drpc.org'],
          queried: ['ethereum.publicnode.com', 'eth.drpc.org'],
          block: { number: 25038025 },
        },
        uri: 'ipfs://QmHash',
      });

      expect(result.status).toBe('GNS resolution verified');
    });

    test('user-configured: uses the shared resolution summary and identifies its server', async () => {
      const { buildTrustRows } = await loadNavigationUtils();

      const result = buildTrustRows({
        level: 'user-configured',
        trust: {
          agreed: ['rpc.mycompany.com'],
          queried: ['rpc.mycompany.com'],
          block: { number: 25030249 },
        },
        uri: 'ipfs://QmHash',
      });

      expect(result.status).toBe('Resolved with your configured RPC');
      expect(result.trustRows.map((r) => r.label)).toEqual([
        'Resolved by',
        'Evidence',
        'Block',
        'Server',
      ]);
      expect(result.trustRows[0]).toEqual({
        label: 'Resolved by',
        display: 'Your configured RPC',
        copy: '',
      });
      expect(result.trustRows[3]).toEqual({
        label: 'Server',
        display: 'rpc.mycompany.com',
        copy: 'rpc.mycompany.com',
        autoFit: 'rpc.mycompany.com',
      });
    });

    test('unverified: explains the single-source evidence without claiming verification', async () => {
      const { buildTrustRows } = await loadNavigationUtils();

      const result = buildTrustRows({
        level: 'unverified',
        trust: {
          agreed: ['ethereum.publicnode.com'],
          queried: ['ethereum.publicnode.com'],
          block: { number: 25030249 },
        },
        uri: 'ipfs://QmHash',
      });

      expect(result.status).toBe('ENS resolution not verified');
      expect(result.trustRows.map((r) => r.label)).toEqual([
        'Resolved by',
        'Evidence',
        'Block',
        'RPC 1',
      ]);
    });

    test('conflict with one dissenter: uses singular "Dissenting RPC" label', async () => {
      const { buildTrustRows } = await loadNavigationUtils();

      const result = buildTrustRows({
        level: 'conflict',
        trust: {
          agreed: ['ethereum.publicnode.com'],
          queried: ['ethereum.publicnode.com', 'eth.drpc.org'],
          dissented: ['eth.drpc.org'],
          block: { number: 25030249 },
        },
        uri: 'ipfs://QmHash',
      });

      expect(result.status).toBe('Verification failed: RPCs disagree');
      expect(result.trustRows.map((r) => r.label)).toEqual([
        'Checked by',
        'Evidence',
        'Block',
        'RPC 1',
        'Dissenting RPC',
      ]);
    });

    test('conflict with multiple dissenters: numbers each "Dissenting RPC N"', async () => {
      const { buildTrustRows } = await loadNavigationUtils();

      const result = buildTrustRows({
        level: 'conflict',
        trust: {
          agreed: [],
          queried: ['a.example', 'b.example', 'c.example'],
          dissented: ['b.example', 'c.example'],
        },
        uri: 'ipfs://QmHash',
      });

      expect(result.trustRows.map((r) => r.label)).toEqual([
        'Checked by',
        'Evidence',
        'Dissenting RPC 1',
        'Dissenting RPC 2',
      ]);
    });

    test('myotis-verified: uses the shared verification summary without a server row', async () => {
      const { buildTrustRows } = await loadNavigationUtils();

      const result = buildTrustRows({
        level: 'verified',
        trust: {
          method: 'myotis',
          finality: 'finalized',
          proof: 'P2P light client (beacon-finalized, sync-committee proof)',
          block: 25633314,
          agreed: ['myotis-p2p'],
          queried: ['myotis-p2p'],
        },
        uri: 'ipfs://QmPSYsfe8CVrBMrbh3q8qjzQYnAmDX8H4xkERzvFBaYkMS',
      });

      expect(result.status).toBe('ENS resolution verified');
      expect(result.trustRows).toEqual([
        { label: 'Verified by', display: 'Myotis light client', copy: '' },
        { label: 'Evidence', display: 'Beacon-finalized proof', copy: '' },
        { label: 'Block', display: '25633314', copy: '25633314' },
      ]);
      expect(result.contentRows[0]).toEqual({ label: 'Network', display: 'IPFS', copy: '' });
    });

    test('myotis optimistic: shows verified evidence while disclosing non-finality', async () => {
      const { buildTrustRows } = await loadNavigationUtils();

      const result = buildTrustRows({
        level: 'verified',
        trust: {
          method: 'myotis',
          finality: 'optimistic',
          proof: 'P2P light client (optimistic beacon root — attested, not finalized)',
          block: 25633315,
          agreed: ['myotis-p2p'],
          queried: ['myotis-p2p'],
        },
        uri: 'bzz://abc123',
      });

      expect(result.status).toBe('ENS resolution verified');
      expect(result.trustRows).toEqual([
        { label: 'Verified by', display: 'Myotis light client', copy: '' },
        {
          label: 'Evidence',
          display: 'Optimistic beacon proof (not finalized)',
          copy: '',
        },
        { label: 'Block', display: '25633315', copy: '25633315' },
      ]);
    });

    test('colibri-verified: uses the shared verification summary and identifies its server', async () => {
      const { buildTrustRows } = await loadNavigationUtils();

      const result = buildTrustRows({
        level: 'verified',
        trust: {
          method: 'colibri',
          proof: 'ZK sync-committee proof',
          prover: 'mainnet1.colibri-proof.tech',
          agreed: ['mainnet1.colibri-proof.tech'],
          queried: ['mainnet1.colibri-proof.tech'],
        },
        uri: 'ipfs://QmPSYsfe8CVrBMrbh3q8qjzQYnAmDX8H4xkERzvFBaYkMS',
      });

      expect(result.status).toBe('ENS resolution verified');
      expect(result.trustRows).toEqual([
        { label: 'Verified by', display: 'Colibri', copy: '' },
        { label: 'Evidence', display: 'ZK sync-committee proof', copy: '' },
        {
          label: 'Server',
          display: 'mainnet1.colibri-proof.tech',
          copy: 'mainnet1.colibri-proof.tech',
          autoFit: 'mainnet1.colibri-proof.tech',
        },
      ]);
      // Content rows are independent of the verification method.
      expect(result.contentRows).toEqual([
        { label: 'Network', display: 'IPFS', copy: '' },
        {
          label: 'CID',
          display: 'QmPSYsfe8CVrBMrbh3q8qjzQYnAmDX8H4xkERzvFBaYkMS',
          copy: 'QmPSYsfe8CVrBMrbh3q8qjzQYnAmDX8H4xkERzvFBaYkMS',
          autoFit: 'QmPSYsfe8CVrBMrbh3q8qjzQYnAmDX8H4xkERzvFBaYkMS',
        },
      ]);
    });

    test('colibri-verified without prover or proof still uses the shared summary', async () => {
      const { buildTrustRows } = await loadNavigationUtils();

      const result = buildTrustRows({
        level: 'verified',
        trust: { method: 'colibri' },
        uri: 'bzz://abc123',
      });

      expect(result.status).toBe('ENS resolution verified');
      expect(result.trustRows).toEqual([
        { label: 'Verified by', display: 'Colibri', copy: '' },
        { label: 'Evidence', display: 'Cryptographic proof', copy: '' },
      ]);
    });

    test('returns null status for an unknown trust level', async () => {
      const { buildTrustRows } = await loadNavigationUtils();

      // Caller (toggleTrustPopover) decides what to do — current behaviour
      // is to log a warning and clear the status row rather than render
      // a confusing fallback sentence.
      const result = buildTrustRows({ level: 'mystery', trust: {}, uri: '' });
      expect(result.status).toBeNull();
    });

    test('Network falls back to uppercased scheme for unmapped URI schemes', async () => {
      const { buildTrustRows } = await loadNavigationUtils();

      const result = buildTrustRows({
        level: 'verified',
        trust: { agreed: [], queried: [] },
        uri: 'arweave://abcd',
      });

      // No entry in TRUST_NETWORK_NAME for 'arweave' — fall back to
      // 'ARWEAVE' rather than dropping the row entirely.
      expect(result.contentRows[0]).toEqual({
        label: 'Network',
        display: 'ARWEAVE',
        copy: '',
      });
      // No entry in TRUST_HASH_LABEL either — the hash row uses the
      // generic 'Content Hash' label.
      expect(result.contentRows[1]).toEqual({
        label: 'Content Hash',
        display: 'abcd',
        copy: 'abcd',
        autoFit: 'abcd',
      });
    });

    test('Swarm via cached protocol (URI missing) normalizes "swarm" → "bzz"', async () => {
      const { buildTrustRows } = await loadNavigationUtils();

      // state.ensProtocols stores 'swarm' (the resolver's friendly name),
      // but the lookup tables are keyed on URI schemes ('bzz'). When the
      // URI is missing we fall back to the cached protocol — and must
      // map 'swarm' to 'bzz' or the network row would render 'SWARM'
      // (uppercase fallback) instead of the friendly 'Swarm'.
      const result = buildTrustRows({
        level: 'verified',
        trust: { agreed: [], queried: [] },
        uri: '',
        proto: 'swarm',
      });

      expect(result.contentRows).toEqual([
        { label: 'Network', display: 'Swarm', copy: '' },
      ]);
    });

    test('IPNS URIs fall through to the uppercase network fallback', async () => {
      const { buildTrustRows } = await loadNavigationUtils();

      // 'ipns' isn't an explicit entry in TRUST_NETWORK_NAME but the
      // uppercase fallback yields 'IPNS', which is the user-facing
      // string we want anyway.
      const result = buildTrustRows({
        level: 'verified',
        trust: { agreed: [], queried: [] },
        uri: 'ipns://k51qzi5/',
      });

      expect(result.contentRows[0]).toEqual({
        label: 'Network',
        display: 'IPNS',
        copy: '',
      });
    });

    test('omits the Network row when there is no URI and no cached protocol', async () => {
      const { buildTrustRows } = await loadNavigationUtils();

      const result = buildTrustRows({
        level: 'verified',
        trust: { agreed: [], queried: [] },
      });

      expect(result.contentRows).toEqual([]);
    });

    test('omits the Block row when no block.number is available', async () => {
      const { buildTrustRows } = await loadNavigationUtils();

      const result = buildTrustRows({
        level: 'verified',
        trust: {
          agreed: ['a'],
          queried: ['a'],
          // No `block` field at all.
        },
        uri: 'ipfs://QmHash',
      });

      expect(result.trustRows.map((r) => r.label)).toEqual([
        'Verified by',
        'Evidence',
        'RPC 1',
      ]);
    });

    test('tolerates missing arrays and missing arguments', async () => {
      const { buildTrustRows } = await loadNavigationUtils();

      // No trust object, no level, no uri, no proto — should still
      // produce a well-formed shape rather than throwing.
      const result = buildTrustRows();
      expect(result.status).toBeNull();
      expect(result.trustRows).toEqual([]);
      expect(result.contentRows).toEqual([]);
    });
  });

  describe('extractEnsResolutionMetadata', () => {
    // The CIDv0→CIDv1 (base32) and IPNS multihash→CIDv1 (base36) dual
    // records that previously lived here existed solely so the address bar
    // could collapse the Kubo subdomain-gateway form (`<cidv1>.ipfs.localhost`,
    // `<base36>.ipns.localhost`) back to the ENS name. With `ipfs:`/`ipns:`
    // promoted to standard schemes the protocol handler in
    // `src/main/ipfs/ipfs-protocol.js` follows Kubo's redirect internally
    // and Chromium never sees the subdomain form, so the dual records had
    // no live consumer. Single-form records suffice.
    test('records the IPFS CID for IPFS contenthashes', async () => {
      const { extractEnsResolutionMetadata } = await loadNavigationUtils();

      const { knownEnsPairs, resolvedProtocol } = extractEnsResolutionMetadata(
        'ipfs://QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG/',
        'evmnow.eth'
      );

      expect(resolvedProtocol).toBe('ipfs');
      expect(knownEnsPairs).toEqual([
        ['QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG', 'evmnow.eth'],
      ]);
    });

    test('records Ed25519 IPNS peer IDs (12D3Koo...) as-is', async () => {
      const { extractEnsResolutionMetadata } = await loadNavigationUtils();

      const { knownEnsPairs, resolvedProtocol } = extractEnsResolutionMetadata(
        'ipns://12D3KooWAsDaZWCkCEUN3myg49NoCMmrYYivmJVwjg7DVJBvWdaX',
        'jalil.eth'
      );

      expect(resolvedProtocol).toBe('ipns');
      expect(knownEnsPairs).toEqual([
        ['12D3KooWAsDaZWCkCEUN3myg49NoCMmrYYivmJVwjg7DVJBvWdaX', 'jalil.eth'],
      ]);
    });

    test('records secp256k1 IPNS peer IDs (16Uiu2H...) as-is', async () => {
      // Coverage for the third common libp2p peer-ID shape. The vector
      // is derived from the canonical secp256k1 public key in
      // libp2p/specs peer-ids.md
      // (08021221037777e994e452c21604f91de093ce415f5432f701dd8cd1a7a6fea0e630bfca99).
      const { extractEnsResolutionMetadata } = await loadNavigationUtils();

      const { knownEnsPairs, resolvedProtocol } = extractEnsResolutionMetadata(
        'ipns://16Uiu2HAmLhLvBoYaoZfaMUKuibM6ac163GwKY74c5kiSLg5KvLpY',
        'secp.eth'
      );

      expect(resolvedProtocol).toBe('ipns');
      expect(knownEnsPairs).toEqual([
        ['16Uiu2HAmLhLvBoYaoZfaMUKuibM6ac163GwKY74c5kiSLg5KvLpY', 'secp.eth'],
      ]);
    });

    test('records IPNS base36 CIDv1 names verbatim', async () => {
      const { extractEnsResolutionMetadata } = await loadNavigationUtils();

      const { knownEnsPairs, resolvedProtocol } = extractEnsResolutionMetadata(
        'ipns://k51qzi5uqu5dgkkr5wjh0m796f9u3tou74wn2q2u3shgh6yn52ce4hitig3if4',
        'jalil.eth'
      );

      expect(resolvedProtocol).toBe('ipns');
      expect(knownEnsPairs).toEqual([
        ['k51qzi5uqu5dgkkr5wjh0m796f9u3tou74wn2q2u3shgh6yn52ce4hitig3if4', 'jalil.eth'],
      ]);
    });
  });

  describe('getRadicleDisplayUrl', () => {
    test('reconstructs rad urls from rad-browser pages', async () => {
      const { getRadicleDisplayUrl } = await loadNavigationUtils();

      expect(
        getRadicleDisplayUrl('file:///app/pages/rad-browser.html?rid=zabc123&path=/tree/main')
      ).toBe('rad://zabc123/tree/main');
      expect(getRadicleDisplayUrl('file:///app/pages/rad-browser.html?path=/tree/main')).toBeNull();
      expect(getRadicleDisplayUrl('https://example.com')).toBeNull();
      expect(getRadicleDisplayUrl('not-a-url')).toBeNull();
    });
  });
});
