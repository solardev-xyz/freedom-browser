jest.mock('../networks/direct-testnet-transport', () => ({ assertDirectTest: jest.fn() }));
const { runSepoliaTestStep, POLICY } = require('./ppv2-sepolia-test-step');
const { CANDIDATE } = require('./ppv2-sepolia-preflight');
const { transactionIntent } = require('./private-transaction-intent');
let args, session, signer, tx, records;
const owner = `0x${'ab'.repeat(20)}`;
beforeEach(() => {
  records = [];
  tx = {
    kind: 'ppv2-register-auth',
    chainId: 11155111,
    from: owner,
    to: CANDIDATE.keystore,
    value: 0n,
    data: '0x1234',
  };
  signer = {
    getAddress: async () => owner,
    signTransaction: jest.fn(async () => 'signed-test-fixture'),
  };
  session = {
    descriptor: { chainId: 11155111, relayerTransport: 'direct', identityMayBeIpLinked: true },
    listPublicSubmissions: async () => records,
    listRelayAttempts: async () => [],
    prepareRegisterKeystore: jest.fn(async () => ({ txs: [tx] })),
    submitPublicOperation: jest.fn(),
    resolvePublicSubmission: jest.fn(),
    prepareNativeDeposit: jest.fn(),
    prepareNativeWithdrawal: jest.fn(),
    submitNativeWithdrawal: jest.fn(),
    notes: jest.fn(async () => []),
  };
  args = {
    handle: {},
    session,
    signer,
    owner,
    action: 'register-auth',
    readBalance: async () => 50000000000000000n,
    estimateGas: jest.fn(async () => 320000n),
    verifyDeployment: jest.fn(async () => true),
  };
});
test('zero balance stops before preparation, review, signing or submission', async () => {
  args.readBalance = async () => 0n;
  expect(await runSepoliaTestStep(args)).toMatchObject({
    needsFunding: true,
    address: owner,
    action: 'register-auth',
  });
  expect(session.prepareRegisterKeystore).not.toHaveBeenCalled();
  expect(session.submitPublicOperation).not.toHaveBeenCalled();
  expect(signer.signTransaction).not.toHaveBeenCalled();
});
test('registration signs only the bound owner/intent/gas after a fresh deployment check', async () => {
  session.submitPublicOperation.mockImplementation(async (prepared, options) => {
    expect(prepared.txs[0]).toBe(tx);
    expect(options.step).toBe(0);
    expect(options.gasLimit).toBe(400000n);
    expect(options.maxGasFee).toBe(POLICY.gasFee);
    const review = {
      operation: tx.kind,
      intent: transactionIntent(tx.kind, tx),
      maxGasFee: POLICY.gasFee,
    };
    expect(await options.review(review)).toBe(true);
    await expect(options.review({ ...review, pendingRelayCancellation: true })).rejects.toThrow();
    const actual = { ...tx, gasLimit: 400000n, gasPrice: 1000000000n };
    await expect(options.signer.signTransaction({ ...actual, chainId: 1 })).rejects.toThrow();
    await expect(
      options.signer.signTransaction({ ...actual, gasPrice: 100000000000n })
    ).rejects.toThrow();
    await expect(options.signer.signTransaction({ ...actual, data: '0xabcd' })).rejects.toThrow();
    expect(await options.signer.signTransaction(actual)).toBe('signed-test-fixture');
    return { hash: 'public-fixture' };
  });
  expect(await runSepoliaTestStep(args)).toEqual({ hash: 'public-fixture' });
  expect(signer.signTransaction).toHaveBeenCalledTimes(1);
  expect(args.verifyDeployment).toHaveBeenCalledTimes(2);
});
test('rejects a different signer, unresolved history, repeat registration and viewing before auth', async () => {
  signer.getAddress = async () => `0x${'cd'.repeat(20)}`;
  await expect(runSepoliaTestStep(args)).rejects.toThrow();
  signer.getAddress = async () => owner;
  records = [{ intent: { kind: 'ppv2-register-auth' }, resolution: null }];
  await expect(runSepoliaTestStep(args)).rejects.toThrow();
  records[0].resolution = {};
  records[0].observation = { status: 'included' };
  await expect(runSepoliaTestStep(args)).rejects.toThrow();
  records = [];
  args.action = 'register-viewing';
  await expect(runSepoliaTestStep(args)).rejects.toThrow();
  expect(signer.signTransaction).not.toHaveBeenCalled();
  expect(session.submitPublicOperation).not.toHaveBeenCalled();
});
test('requires explicit successful inclusion review with twelve confirmations and never follows it with a send', async () => {
  const hash = `0x${'12'.repeat(32)}`;
  records = [{ hash }];
  args.action = 'resolve-public';
  args.reference = hash;
  session.resolvePublicSubmission.mockImplementation(async (actual, policy) => {
    expect(actual).toBe(hash);
    expect(policy.minimumConfirmations).toBe(12);
    await expect(
      policy.review({
        transactionHash: hash,
        observation: { status: 'reverted', confirmations: 99 },
      })
    ).rejects.toThrow();
    await expect(
      policy.review({
        transactionHash: hash,
        observation: { status: 'included', confirmations: 11 },
      })
    ).rejects.toThrow();
    return policy.review({
      transactionHash: hash,
      observation: { status: 'included', confirmations: 12 },
    });
  });
  expect(await runSepoliaTestStep(args)).toEqual({
    allowNextTransaction: true,
    acceptedEvidence: 'unverified-rpc',
  });
  expect(session.submitPublicOperation).not.toHaveBeenCalled();
});
test('limits deposits and refuses any uncertain send without retry', async () => {
  args.action = 'deposit';
  records = Array.from({ length: 2 }, () => ({
    resolution: {},
    intent: { kind: 'ppv2-native-deposit' },
  }));
  await expect(runSepoliaTestStep(args)).rejects.toThrow();
  expect(session.prepareNativeDeposit).not.toHaveBeenCalled();
  records = [];
  session.prepareNativeDeposit.mockResolvedValue({
    ...tx,
    kind: 'ppv2-native-deposit',
    to: CANDIDATE.entrypoint,
    amount: POLICY.deposit,
    value: POLICY.deposit,
  });
  session.submitPublicOperation.mockRejectedValue(new Error('uncertain'));
  await expect(runSepoliaTestStep(args)).rejects.toThrow('uncertain');
  expect(session.submitPublicOperation).toHaveBeenCalledTimes(1);
});
test('withdrawal uses a fixed amount, positive change and capped fee with explicit direct labels', async () => {
  args.action = 'withdraw';
  args.reference = `0x${'23'.repeat(32)}`;
  session.notes.mockResolvedValue([
    {
      commitment: args.reference,
      value: POLICY.deposit,
      status: 'active',
      asset: { __type: 'native' },
    },
  ]);
  const prepared = {
    recipient: owner,
    amount: POLICY.withdrawal.toString(),
    fee: POLICY.relayFee.toString(),
    proofVerified: true,
    quoteSignatureVerified: true,
    privacy: { relayerTransport: 'direct', identityMayBeIpLinked: true },
  };
  session.prepareNativeWithdrawal.mockResolvedValue(prepared);
  session.submitNativeWithdrawal.mockImplementation(async (summary, review) => {
    expect(summary).toBe(prepared);
    expect(typeof review).toBe('function');
    expect(await review(summary)).toBe(true);
    return { txHash: 'fixture' };
  });
  expect(await runSepoliaTestStep(args)).toEqual({ txHash: 'fixture' });
  expect(session.prepareNativeWithdrawal).toHaveBeenCalledWith({
    commitment: args.reference,
    recipient: owner,
    amount: POLICY.withdrawal,
    maxFee: POLICY.relayFee,
  });
  prepared.fee = (POLICY.relayFee + 1n).toString();
  await expect(runSepoliaTestStep(args)).rejects.toThrow();
});

test('check-only cannot prepare, sign or submit even when the wallet is already funded', async () => {
  args.checkOnly = true;
  expect(await runSepoliaTestStep(args)).toMatchObject({ needsFunding: false, checkOnly: true });
  expect(session.prepareRegisterKeystore).not.toHaveBeenCalled();
  expect(session.submitPublicOperation).not.toHaveBeenCalled();
  expect(signer.signTransaction).not.toHaveBeenCalled();
  expect(args.verifyDeployment).not.toHaveBeenCalled();
});
test('changed deployment pins refuse the final signature after preparation and review', async () => {
  args.verifyDeployment.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  session.submitPublicOperation.mockImplementation(async (_prepared, options) =>
    options.signer.signTransaction({
      ...tx,
      gasLimit: 400000n,
      gasPrice: 1000000000n,
    })
  );
  await expect(runSepoliaTestStep(args)).rejects.toThrow();
  expect(signer.signTransaction).not.toHaveBeenCalled();
});
test('an unresolved relay blocks public signing; relay resolution accepts only settled evidence', async () => {
  const id = `0x${'34'.repeat(32)}`;
  session.listRelayAttempts = async () => [{ id, resolution: null }];
  await expect(runSepoliaTestStep(args)).rejects.toThrow();
  expect(session.submitPublicOperation).not.toHaveBeenCalled();
  args.action = 'resolve-relay';
  args.reference = id;
  session.resolveRelayAttempt = jest.fn(async (_id, review) => {
    await expect(review({ id, observation: { status: 'unknown' } })).rejects.toThrow();
    return review({ id, observation: { status: 'included' } });
  });
  expect(await runSepoliaTestStep(args)).toEqual({
    allowNextOperation: true,
    acceptedEvidence: 'unverified-rpc',
  });
  expect(session.submitPublicOperation).not.toHaveBeenCalled();
  expect(signer.signTransaction).not.toHaveBeenCalled();
});

test('gas estimation must succeed within the bounded limit before public submission', async () => {
  args.estimateGas.mockResolvedValue(320001n);
  await expect(runSepoliaTestStep(args)).rejects.toThrow();
  args.estimateGas.mockRejectedValue(new Error('estimate unavailable'));
  await expect(runSepoliaTestStep(args)).rejects.toThrow('estimate unavailable');
  expect(session.submitPublicOperation).not.toHaveBeenCalled();
  expect(signer.signTransaction).not.toHaveBeenCalled();
});
test('failed public reconciliation is a separate explicit action and never submits', async () => {
  const hash = `0x${'45'.repeat(32)}`;
  records = [{ hash }];
  args.action = 'resolve-public-failed';
  args.reference = hash;
  session.resolvePublicSubmission.mockImplementation(async (_hash, policy) => {
    await expect(
      policy.review({
        transactionHash: hash,
        observation: { status: 'included', confirmations: 12 },
      })
    ).rejects.toThrow();
    return policy.review({
      transactionHash: hash,
      observation: { status: 'reverted', confirmations: 12 },
    });
  });
  expect(await runSepoliaTestStep(args)).toEqual({
    allowNextTransaction: true,
    acceptedEvidence: 'unverified-rpc',
  });
  expect(signer.signTransaction).not.toHaveBeenCalled();
  expect(session.submitPublicOperation).not.toHaveBeenCalled();
});
test('competing ragequit requires one matching unresolved relay and explicit cancellation review', async () => {
  const commitment = `0x${'7'.padStart(64, '0')}`;
  args.action = 'ragequit-cancel';
  args.reference = commitment;
  session.listRelayAttempts = async () => [{ commitment, resolution: null }];
  session.notes.mockResolvedValue([
    { commitment, value: POLICY.deposit, status: 'active', asset: { __type: 'native' } },
  ]);
  tx = {
    ...tx,
    kind: 'ppv2-native-ragequit',
    to: CANDIDATE.pool,
    commitment,
    data: new (require('ethers').Interface)([
      require('./ppv2-ragequit-policy').RAGEQUIT_ABI,
    ]).encodeFunctionData('ragequit', [
      [
        [1n, 2n],
        [
          [3n, 4n],
          [5n, 6n],
        ],
        [7n, 8n],
        [
          1n,
          BigInt(commitment),
          3n,
          BigInt(owner),
          POLICY.deposit,
          BigInt(require('./ppv2-deposit-policy').NATIVE),
          4n,
        ],
      ],
    ]),
  };
  session.prepareNativeRagequit = jest.fn(async () => tx);
  session.submitPublicOperation.mockImplementation(async (_prepared, options) => {
    const review = {
      operation: tx.kind,
      intent: transactionIntent(tx.kind, tx),
      maxGasFee: POLICY.gasFee,
      proofVerified: true,
      noteCommitment: commitment,
      pendingRelayCancellation: true,
      competingRelayMayWin: true,
    };
    expect(await options.review(review)).toBe(true);
    await expect(options.review({ ...review, competingRelayMayWin: false })).rejects.toThrow();
    await expect(
      options.review({ ...review, noteCommitment: `0x${'67'.repeat(32)}` })
    ).rejects.toThrow();
    return { hash: 'fixture' };
  });
  expect(await runSepoliaTestStep(args)).toEqual({ hash: 'fixture' });
  session.listRelayAttempts = async () => [
    { commitment: `0x${'67'.repeat(32)}`, resolution: null },
  ];
  await expect(runSepoliaTestStep(args)).rejects.toThrow();
  expect(session.submitPublicOperation).toHaveBeenCalledTimes(1);
});
