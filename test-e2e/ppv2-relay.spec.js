const { test, expect } = require('./fixtures');
const artifact = process.env.FREEDOM_PP_V2_PROCESS_ASAR;
test('real PPv2 relay wire format is reviewed and journaled before an uncertain handoff and survives restart', async ({
  electronApp,
  relaunchApp,
}, testInfo) => {
  test.skip(!artifact, 'Build the pinned SDK fixture with --exit-circuits');
  test.setTimeout(120000);
  const exercise = async ({ app }, { artifact, restart }) => {
    const req = process.mainModule
      .require('module')
      .createRequire(`${app.getAppPath()}/package.json`);
    const fs = req('fs'),
      path = req('path');
    const vault = req('./src/main/identity/vault');
    const directory = path.join(app.getPath('userData'), 'relay-vault');
    if (!restart)
      await vault.importVault(
        directory,
        'fixture-password',
        'test test test test test test test test test test test junk'
      );
    await vault.unlockVault(directory, 'fixture-password', 0);
    const scope = req('./src/main/wallet/privacy-session').openPrivacySession();
    const subject = {
      kind: 'private-account',
      principal: 'ppv2:0',
      protocol: 'privacy-pools-v2',
      deployment: 'sepolia',
      chainId: 11155111,
    };
    const handle = (role) => scope.getContext({ ...subject, role });
    const journal = req('./src/main/wallet/ppv2-relay-journal').getPPv2RelayJournal(
      handle('storage'),
      0
    );
    try {
      if (restart) {
        const records = await journal.list();
        return {
          records: records.length,
          acknowledgedHash: records[0]?.acknowledgedHash,
          blocked: await journal.assertCanSubmit().then(
            () => null,
            (e) => e.code
          ),
          packaged: app.isPackaged,
        };
      }
      const { AbiCoder, keccak256, Wallet } = req('ethers'),
        coder = AbiCoder.defaultAbiCoder();
      const { FIELD, NATIVE } = req('./src/main/wallet/ppv2-deposit-policy');
      const { ROUTING } = req('./src/main/wallet/ppv2-relay-policy');
      const word = (v) => `0x${BigInt(v).toString(16).padStart(64, '0')}`;
      const recipient = `0x${'11'.repeat(20)}`,
        relayer = `0x${'22'.repeat(20)}`,
        processor = `0x${'33'.repeat(20)}`;
      const signer = req('viem/accounts').privateKeyToAccount(Wallet.createRandom().privateKey);
      const routing = coder.encode([ROUTING], [[recipient, relayer, 100n, 0n]]);
      const noteData = [{ hint: word(3), data: '0xabcd' }];
      const relayContext = word(
        BigInt(
          keccak256(
            coder.encode(
              ['tuple(address processor,bytes data)', 'tuple(bytes32 hint,bytes data)[]'],
              [[processor, routing], noteData]
            )
          )
        ) % FIELD
      );
      const manifest = JSON.parse(fs.readFileSync(`${artifact}/exit-manifest.json`)).filter(
        (e) => e.circuit === 'transact_1x1'
      );
      const artifactDir = fs.mkdtempSync(path.join(app.getPath('userData'), 'relay-artifacts-'));
      for (const entry of manifest)
        fs.writeFileSync(
          path.join(artifactDir, entry.name),
          fs.readFileSync(`${artifact}/artifacts/${entry.name}`)
        );
      const loader = req('./src/main/wallet/privacy-artifacts').createPrivacyArtifactLoader({
        handle: handle('artifacts'),
        directory: artifactDir,
        manifest,
      });
      const artifacts = {};
      for (const entry of manifest) artifacts[entry.kind] = await loader.load(entry.name);
      const run = req('./src/main/wallet/privacy-process').runPrivacyProcess;
      const { result: generated } = await run({
        handle: handle('prover'),
        filename: `${artifact}/exit-job.cjs`,
        input: {
          sdkEntry: `${artifact}/sdk.cjs`,
          artifacts,
          circuit: 'transact_1x1',
          singleThread: true,
          relayContext,
        },
        validateResult: (v) =>
          v?.verified === true && v?.publicSignalsBound === true && !!v?.publicFixture,
      });
      const { proof, commitment } = generated.publicFixture;
      const sdk = req(`${artifact}/sdk.cjs`),
        { KohakuHttpClient } = req(`${artifact}/http.cjs`);
      const info = {
        url: 'https://relay.example.test',
        name: 'Controlled fixture',
        chainType: 'evm',
        chainId: 11155111,
        status: 'active',
        address: relayer,
        processorAddress: processor,
      };
      const params = {
        proof,
        noteData,
        signedFeeCommitment: {
          data: routing,
          asset: NATIVE,
          expiration: Date.now() + 300000,
          feeAmount: '100',
          signedRelayerCommitment: `0x${'ab'.repeat(65)}`,
          recipient,
          amountSent: '6000',
          amountReceived: '5900',
          extraGas: false,
        },
        inputNullifierNumber: 1,
        outputCommitmentNumber: 1,
      };
      params.signedFeeCommitment.signedRelayerCommitment = await signer.signTypedData({
        domain: {
          name: 'Privacy Pools Relayer',
          version: '1',
          chainId: 11155111,
          verifyingContract: processor,
        },
        primaryType: 'RelayWithdrawalCommitment',
        types: {
          RelayWithdrawalCommitment: [
            { name: 'data', type: 'bytes' },
            { name: 'asset', type: 'address' },
            { name: 'expiration', type: 'uint256' },
            { name: 'amountSent', type: 'uint256' },
            { name: 'amountReceived', type: 'uint256' },
          ],
        },
        message: params.signedFeeCommitment,
      });
      const invoke = (network) =>
        new sdk.RelayerInteractor({
          relayers: [info],
          httpClient: new KohakuHttpClient(network),
        }).relayWithdrawal(info, params);
      // Capture the SDK's FINAL serialization with no transport authority. This
      // does not use the candidate broadcaster's quote-only preparation.
      let captured, captureError;
      await invoke({
        fetch: async (endpoint, init) => {
          captured = { endpoint, body: init.body };
          throw new Error('Capture only');
        },
      }).catch((error) => {
        captureError = error.message;
      });
      if (!captured) throw new Error(`Synthetic SDK request not captured: ${captureError}`);
      let sent = 0,
        reviewed = 0,
        durableBeforeSend = false;
      const verifierPeaks = [];
      const gate = req('./src/main/wallet/ppv2-relay-handoff').createPPv2RelayHandoff({
        handle: handle('relayer'),
        journal,
        verifyProof: async (value) => {
          try {
            const verification = await req('./src/main/wallet/ppv2-proof-verifier').verifyPPv2Proof(
              {
                handle: handle('prover'),
                sdkEntry: `${artifact}/sdk.cjs`,
                proverEntry: `${artifact}/serial-prover.cjs`,
                circuit: 'transact_1x1',
                vkey: artifacts.verificationKey,
                proof: value,
              }
            );
            verifierPeaks.push(verification.peakRssBytes);
            return true;
          } catch {
            return false;
          }
        },
        network: {
          fetch: async () => {
            sent++;
            durableBeforeSend = (await journal.list()).length === 1;
            throw new Error('Controlled lost response');
          },
        },
      });
      const request = {
        ...captured,
        intent: {
          kind: 'ppv2-native-withdrawal',
          chainId: 11155111,
          owner: `0x${'55'.repeat(20)}`,
          inputValue: '10000',
          pool: `0x${'44'.repeat(20)}`,
          processor,
          relayer,
          quoteSigner: signer.address.toLowerCase(),
          recipient,
          amount: '5900',
          maxFee: '100',
          commitment: word(commitment),
          publicSignals: proof.publicSignals.map(word),
        },
      };
      // A changed curve point with identical intended public signals must fail
      // real verification, not merely the amount/context shape checks.
      const altered = JSON.parse(request.body);
      altered.proof.pi_a[0] = '0x0';
      const tamperRejected = await gate.prepare({ ...request, body: JSON.stringify(altered) }).then(
        () => false,
        () => true
      );
      const badQuote = JSON.parse(request.body);
      badQuote.signedFeeCommitment.expiration++;
      const quoteTamperRejected = await gate
        .prepare({ ...request, body: JSON.stringify(badQuote) })
        .then(
          () => false,
          () => true
        );
      const wrongKey = Uint8Array.from(artifacts.verificationKey);
      wrongKey[0] ^= 1;
      const wrongKeyRefused = await req('./src/main/wallet/ppv2-proof-verifier')
        .verifyPPv2Proof({
          handle: handle('prover'),
          sdkEntry: `${artifact}/sdk.cjs`,
          proverEntry: `${artifact}/serial-prover.cjs`,
          circuit: 'transact_1x1',
          vkey: wrongKey,
          proof,
        })
        .then(
          () => false,
          () => true
        );
      const prepared = await gate.prepare(request);
      const outcome = await gate
        .submit(prepared, {
          invoke,
          review: async (summary) => {
            if (
              summary.amount !== '5900' ||
              summary.fee !== '100' ||
              summary.recipient !== recipient
            )
              throw new Error('Wrong review');
            reviewed++;
            return true;
          },
        })
        .then(
          () => null,
          (e) => e.code
        );
      const records = await journal.list();
      return {
        sent,
        reviewed,
        durableBeforeSend,
        outcome,
        tamperRejected,
        wrongKeyRefused,
        verifierPeaks,
        quoteTamperRejected,
        realProofVerified: prepared.proofVerified,
        chainStateVerified: prepared.chainStateVerified,
        quoteSignatureVerified: prepared.quoteSignatureVerified,
        nullifierBound: records[0]?.nullifier === word(proof.publicSignals[0]),
        commitmentBound: records[0]?.commitment === word(commitment),
        recordedWithoutPayload: !JSON.stringify(records).includes('pi_a'),
        acknowledgedHash: records[0]?.acknowledgedHash,
        productionGate: req('./src/main/settings-store').isWalletTorExperimentAvailable(),
        packaged: app.isPackaged,
        liveTransactionSubmitted: false,
      };
    } finally {
      vault.lockVault();
    }
  };
  const report = await electronApp.evaluate(exercise, { artifact, restart: false });
  await electronApp.close();
  const restarted = await relaunchApp();
  report.restart = await restarted.evaluate(exercise, { artifact, restart: true });
  await testInfo.attach('ppv2-relay-report', {
    body: JSON.stringify(report, null, 2),
    contentType: 'application/json',
  });
  expect(report).toMatchObject({
    sent: 1,
    reviewed: 1,
    durableBeforeSend: true,
    tamperRejected: true,
    wrongKeyRefused: true,
    verifierPeaks: [expect.any(Number)],
    quoteTamperRejected: true,
    realProofVerified: true,
    chainStateVerified: false,
    quoteSignatureVerified: true,
    nullifierBound: true,
    commitmentBound: true,
    recordedWithoutPayload: true,
    acknowledgedHash: null,
    outcome: 'PRIVATE_PPV2_RELAY_UNCERTAIN',
    productionGate: false,
    liveTransactionSubmitted: false,
  });
  expect(report.restart).toMatchObject({
    records: 1,
    acknowledgedHash: null,
    blocked: 'PRIVATE_PPV2_RELAY_UNRESOLVED',
  });
});
