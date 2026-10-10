const { AbiCoder, Interface, keccak256 } = require('ethers');
const {
  CANDIDATE,
  ABI,
  checkQuote,
  inspectSepoliaDeployment,
} = require('./ppv2-sepolia-preflight');
const { NATIVE } = require('./ppv2-deposit-policy');
const now = 1790632782568;
// Public synthetic-recipient quote retrieved from the staging service on Sep 28.
// Its signature is expired and cannot spend anything; there is no proof or key.
function quote() {
  const feeAmount = '888718557700000',
    amountReceived = '1000000000000000',
    amountSent = '1888718557700000';
  return {
    feeAmount,
    gasPrice: '1365720858',
    txCost: '650000',
    amountSent,
    amountReceived,
    feeCommitment: {
      feeAmount,
      asset: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE',
      recipient: `0x${'11'.repeat(20)}`,
      amountSent,
      amountReceived,
      data: AbiCoder.defaultAbiCoder().encode(
        ['tuple(address,address,uint256,uint256)'],
        [[`0x${'11'.repeat(20)}`, CANDIDATE.quoteSigner, feeAmount, 0]]
      ),
      expiration: 1790632791568,
      signedRelayerCommitment:
        '0xfed2e061e1ab04de43f5b69c69537725be8348ffd2c712029552454bb08632c32dd24275795cee0d10afab67ee4b352da761549c2ad22aadf2fcc14c51ef53e91c',
    },
  };
}
function fixture(change = {}) {
  Date.now.mockReturnValue(now - 40000); // Public signed fixture has 49 seconds left.
  const code = '0x63ace973426001600055';
  const pin = (address) => ({
    address,
    codeHash: keccak256(code),
    codeBytes: (code.length - 2) / 2,
  });
  const expected = {
    contracts: Object.fromEntries(
      ['pool', 'entrypoint', 'keystore', 'aspRegistry', 'processor'].map((name) => [
        name,
        {
          ...pin(CANDIDATE[name]),
          ...(name === 'processor' ? {} : { implementation: pin(`0x${'22'.repeat(20)}`) }),
        },
      ])
    ),
    verifiers: {
      deposit: pin(`0x${'33'.repeat(20)}`),
      ragequit: pin(`0x${'44'.repeat(20)}`),
      transact_1x1: pin(`0x${'55'.repeat(20)}`),
    },
  };
  const block = {
    number: '0xc00000',
    hash: `0x${'ab'.repeat(32)}`,
    timestamp: `0x${Math.floor(now / 1000).toString(16)}`,
  };
  const controller = new AbortController();
  const rpc = jest.fn(async (method, params) => {
    if (change.rpc) {
      const result = change.rpc(method, params, block);
      if (result !== undefined) return result;
    }
    if (method === 'eth_chainId') return '0xaa36a7';
    if (method === 'eth_getBlockByNumber') return block;
    if (method === 'eth_getCode') return code;
    if (method === 'eth_getStorageAt') return `0x${'0'.repeat(24)}${'22'.repeat(20)}`;
    expect([block.number, 'latest']).toContain(params[1]);
    const call = ABI.parseTransaction(params[0]);
    const name = call.name;
    const addressValues = {
      poolVault: CANDIDATE.pool,
      POOL: CANDIDATE.pool,
      ENTRYPOINT: CANDIDATE.entrypoint,
      keystore: CANDIDATE.keystore,
      aspRegistry: CANDIDATE.aspRegistry,
      depositVerifier: `0x${'33'.repeat(20)}`,
      ragequitVerifier: `0x${'44'.repeat(20)}`,
    };
    let value = addressValues[name];
    if (name === 'paused') value = false;
    if (name === 'MAX_BATCH') value = 10n;
    if (name === 'ANNOUNCER') value = `0x${'66'.repeat(20)}`;
    if (name === 'keystoreRootLiveness') value = 1200n;
    if (name === 'latestASPRoot') value = 123n;
    if (name === 'assets') value = [true, 1, 0, 1000000000000000000n];
    if (name === 'verifiers')
      value = [
        `0x${'55'.repeat(20)}`,
        new Interface([
          'function verifyProof(uint256[2],uint256[2][2],uint256[2],uint256[8]) returns (bool)',
        ]).getFunction('verifyProof').selector,
      ];
    if (change.call) value = change.call(name, value);
    return ABI.encodeFunctionResult(name, [value]);
  });
  const getJson = jest.fn(async (role, pathname) => {
    if (change.getJson) {
      const result = change.getJson(role, pathname);
      if (result !== undefined) return result;
    }
    if (pathname === '/public-key') return { publicKey: CANDIDATE.aspKey };
    if (pathname.startsWith('/association-set/root')) return { root: '123' };
    if (role === 'asp')
      return {
        pools: [
          {
            chainId: '11155111',
            poolVault: CANDIDATE.pool,
            entrypoint: CANDIDATE.entrypoint,
            fromBlock: 10994884,
          },
        ],
      };
    return {
      chains: [
        {
          id: 11155111,
          type: 'evm',
          contracts: {
            poolVault: CANDIDATE.pool,
            entrypoint: CANDIDATE.entrypoint,
            relay: CANDIDATE.processor,
          },
          assets: [{ address: NATIVE }],
        },
      ],
    };
  });
  return {
    rpc,
    getJson,
    postJson: jest.fn(async () => quote()),
    signal: controller.signal,
    controller,
    expected,
  };
}
beforeEach(() => jest.spyOn(Date, 'now').mockReturnValue(now));
afterEach(() => jest.restoreAllMocks());
test('authenticates the actual staging quote against the independently pinned signer and new processor', () => {
  expect(checkQuote(quote())).toMatchObject({
    signatureVerified: true,
    signer: CANDIDATE.quoteSigner,
    remainingMs: 9000,
  });
});
test.each(['signature', 'recipient', 'fee', 'expiry', 'routing', 'gas'])(
  'refuses altered %s without accepting a signer learned from the response',
  (kind) => {
    const value = quote();
    if (kind === 'signature') value.feeCommitment.signedRelayerCommitment = `0x${'ab'.repeat(65)}`;
    if (kind === 'recipient') value.feeCommitment.recipient = CANDIDATE.pool;
    if (kind === 'fee') value.feeCommitment.feeAmount = '1';
    if (kind === 'expiry') value.feeCommitment.expiration = now;
    if (kind === 'routing') value.feeCommitment.data = '0x';
    if (kind === 'gas') value.feeCommitment.extraGas = true;
    expect(() => checkQuote(value)).toThrow(
      expect.objectContaining({ code: 'PRIVATE_PPV2_PREFLIGHT_REFUSED' })
    );
  }
);
test('records consistent observations without granting signing or claiming verified chain state', async () => {
  const client = fixture();
  const result = await inspectSepoliaDeployment(client);
  expect(result).toMatchObject({
    observationsConsistent: true,
    chainStateVerified: false,
    signingEnabled: false,
    broadcastEnabled: false,
  });
  expect(result.verifiers.transact_1x1.codeHash).toMatch(/^0x[0-9a-f]{64}$/);
  expect(client.rpc.mock.calls.every(([method]) => !method.startsWith('eth_send'))).toBe(true);
});
test('wrong chain stops before reading contracts or contacting ASP/relayer', async () => {
  const client = fixture({ rpc: (method) => (method === 'eth_chainId' ? '0x1' : undefined) });
  expect((await inspectSepoliaDeployment(client)).observationsConsistent).toBe(false);
  expect(client.rpc).toHaveBeenCalledTimes(1);
  expect(client.getJson).not.toHaveBeenCalled();
  expect(client.postJson).not.toHaveBeenCalled();
});
test.each(['pool-link', 'paused', 'empty-code', 'wrong-processor', 'wrong-asp-key', 'reorg'])(
  'reports %s as a failure and never qualifies the environment',
  async (kind) => {
    const client = fixture({
      rpc: (method, params, block) =>
        kind === 'empty-code' && method === 'eth_getCode'
          ? '0x'
          : kind === 'reorg' && method === 'eth_getBlockByNumber' && params[0] !== 'finalized'
            ? { ...block, hash: `0x${'cd'.repeat(32)}` }
            : undefined,
      call: (name, value) =>
        kind === 'pool-link' && name === 'POOL'
          ? CANDIDATE.keystore
          : kind === 'paused' && name === 'paused'
            ? true
            : value,
      getJson: (role, pathname) =>
        kind === 'wrong-processor' && role === 'relayer'
          ? {
              chains: [
                {
                  id: 11155111,
                  type: 'evm',
                  contracts: {
                    poolVault: CANDIDATE.pool,
                    entrypoint: CANDIDATE.entrypoint,
                    relay: CANDIDATE.pool,
                  },
                },
              ],
            }
          : kind === 'wrong-asp-key' && pathname === '/public-key'
            ? { publicKey: `0x${'ff'.repeat(32)}` }
            : undefined,
    });
    const result = await inspectSepoliaDeployment(client);
    expect(result.observationsConsistent).toBe(false);
    expect(result.checks.some((c) => !c.passed)).toBe(true);
  }
);
test('cancellation after an RPC prevents further requests', async () => {
  const client = fixture();
  client.rpc.mockImplementationOnce(async () => {
    client.controller.abort();
    return '0xaa36a7';
  });
  await expect(inspectSepoliaDeployment(client)).rejects.toMatchObject({
    code: 'PRIVATE_PPV2_PREFLIGHT_REFUSED',
  });
  expect(client.rpc).toHaveBeenCalledTimes(1);
});
test('a real but short-lived quote fails the proving and handoff diagnostic', async () => {
  const client = fixture();
  Date.now.mockReturnValue(now);
  const result = await inspectSepoliaDeployment(client);
  expect(result.checks).toContainEqual({ name: 'signed-native-quote', passed: true });
  expect(result.checks).toContainEqual(
    expect.objectContaining({ name: 'quote-allows-proving-and-handoff', passed: false })
  );
  expect(result.fundingReady).toBe(false);
});
test.each(['implementation', 'verifier', 'code', 'relay-type'])(
  'refuses drift in %s even when the endpoints respond successfully',
  async (kind) => {
    const client = fixture({
      rpc: (method) =>
        kind === 'implementation' && method === 'eth_getStorageAt'
          ? `0x${'0'.repeat(24)}${'77'.repeat(20)}`
          : kind === 'code' && method === 'eth_getCode'
            ? '0x63ace973426002'
            : undefined,
      call: (name, value) =>
        kind === 'relay-type' && name === 'MAX_BATCH'
          ? 9n
          : kind === 'verifier' && name === 'depositVerifier'
            ? CANDIDATE.pool
            : value,
    });
    expect((await inspectSepoliaDeployment(client)).observationsConsistent).toBe(false);
  }
);
test('reports service-root disagreement without confusing it with leaves validation or funding readiness', async () => {
  const result = await inspectSepoliaDeployment(
    fixture({ call: (name, value) => (name === 'latestASPRoot' ? 124n : value) })
  );
  expect(result.aspRoot).toMatchObject({ serviceMatchesLatest: false, leavesQualified: false });
  expect(result.fundingReady).toBe(false);
});

test('exit readiness does not contact ASP or relayer, or require deposit eligibility', async () => {
  const client = fixture({
    call: (name, value) => (name === 'assets' ? [false, 0n, 0n, 0n] : value),
  });
  client.getJson.mockRejectedValue(new Error('ASP and relayer unavailable'));
  client.postJson.mockRejectedValue(new Error('Relayer unavailable'));
  const result = await inspectSepoliaDeployment({ ...client, purpose: 'exit' });
  expect(result).toMatchObject({
    purpose: 'exit',
    observationsConsistent: true,
    signingEnabled: false,
    chainStateVerified: false,
  });
  expect(client.getJson).not.toHaveBeenCalled();
  expect(client.postJson).not.toHaveBeenCalled();
  expect(result.checks.filter((c) => c.notApplicable).map((c) => c.name)).toEqual([
    'native-asset',
    'asp-pool-feed',
    'asp-public-key',
    'asp-root-observations',
    'relayer-deployment',
    'signed-native-quote',
    'quote-allows-proving-and-handoff',
  ]);
  for (const name of [
    'verifier-ragequit',
    'reviewed-deployment-pins',
    'keystore-root-liveness',
    'finalized-anchor-still-canonical',
  ]) {
    expect(result.checks).toContainEqual({ name, passed: true });
  }
});

test.each(['chain', 'code', 'verifier', 'canonical', 'paused'])(
  'exit readiness still refuses %s drift',
  async (kind) => {
    const client = fixture({
      rpc: (method, params, block) =>
        kind === 'chain' && method === 'eth_chainId'
          ? '0x1'
          : kind === 'code' && method === 'eth_getCode'
            ? '0x'
            : kind === 'canonical' && method === 'eth_getBlockByNumber' && params[0] !== 'finalized'
              ? { ...block, hash: `0x${'cd'.repeat(32)}` }
              : undefined,
      call: (name, value) =>
        kind === 'verifier' && name === 'ragequitVerifier'
          ? CANDIDATE.pool
          : kind === 'paused' && name === 'paused'
            ? true
            : value,
    });
    expect(
      (await inspectSepoliaDeployment({ ...client, purpose: 'exit' })).observationsConsistent
    ).toBe(false);
  }
);

test('full readiness remains the default, and an unknown purpose cannot weaken checks', async () => {
  const client = fixture();
  client.getJson.mockRejectedValue(new Error('unavailable'));
  expect(await inspectSepoliaDeployment(client)).toMatchObject({
    purpose: 'full',
    observationsConsistent: false,
  });
  client.rpc.mockClear();
  await expect(inspectSepoliaDeployment({ ...client, purpose: 'unknown' })).rejects.toThrow();
  expect(client.rpc).not.toHaveBeenCalled();
});
