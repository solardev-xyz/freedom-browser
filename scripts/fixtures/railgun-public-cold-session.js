/** Genuine enrolled owners; only setup may create public-vector vault metadata. */
const fs = require('fs'),
  path = require('path');
const sticky = require('./railgun-native-assertions');
const { assert } = sticky;
async function bounded(work, label, ms = 180000) {
  let timer;
  try {
    return await Promise.race([
      work,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const e = Error('Public cold fixture timeout: ' + label);
          sticky.record(e, label + '.timeout');
          reject(e);
        }, ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function steps(entries) {
  let failed = false;
  for (const [label, use] of entries)
    try {
      await bounded(Promise.resolve().then(use), label);
    } catch (error) {
      failed = true;
      sticky.record(error, label);
    }
  if (failed) sticky.assertEmpty();
}
async function open({ directory, archive, phase, transport }) {
  const state = {
    plugins: [],
    accounts: [],
    previews: [],
    signal: new AbortController(),
    signs: 0,
    addresses: 0,
    bootstrapAddresses: 0,
  };
  const vault = require('../../src/main/identity/vault');
  const identities = require('../../src/main/wallet/railgun-identity');
  const signer = require('../../src/main/wallet/signers');
  const originalSigner = signer.getSigner;
  state.close = () =>
    steps([
      [
        'plugin drains',
        async () => {
          await steps(
            state.plugins.map((p, i) => [
              'plugin ' + i,
              async () => {
                try {
                  p.close();
                } finally {
                  await p.closed;
                }
              },
            ])
          );
        },
      ],
      [
        'wallet drains',
        () => steps(state.accounts.map((a, i) => ['account ' + i, () => a.close()])),
      ],
      [
        'recovery drain',
        async () => {
          if (state.recovery)
            try {
              state.recovery.close();
            } finally {
              await state.recovery.closed;
            }
        },
      ],
      ['preview close', () => steps(state.previews.map((p, i) => ['preview ' + i, () => p()]))],
      ['public owner', () => state.publicAccount?.close()],
      ['enrollment', () => state.enrollment?.close()],
      ['identity', () => state.identity?.close()],
      ['vault', () => vault.lockVault()],
      [
        'signer observer restore',
        () => {
          signer.getSigner = originalSigner;
        },
      ],
    ]);
  try {
    const vaultDirectory = path.join(directory, 'profile', 'identity');
    if (phase === 'setup')
      await vault.importVault(
        vaultDirectory,
        'public-fixture-password-not-a-user-credential',
        'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
      );
    else assert.ok(fs.existsSync(path.join(vaultDirectory, 'identity-vault.json')));
    await vault.unlockVault(vaultDirectory, 'public-fixture-password-not-a-user-credential', 0);
    state.bootstrapAddresses++;
    state.owner = (await originalSigner(0).getAddress()).toLowerCase();
    transport.setOwner(state.owner);
    const metadata = path.join(vaultDirectory, 'vault-meta.json');
    if (phase === 'setup')
      fs.writeFileSync(
        metadata,
        JSON.stringify({
          userKnowsPassword: true,
          addresses: { userWallet: state.owner },
          derivedWallets: [
            { index: 0, name: 'Offline public vector', type: 'mnemonic', address: state.owner },
          ],
        }) + '\n',
        { flag: 'wx', mode: 0o600 }
      );
    const record = require('../../src/main/identity-manager').getWalletRecord(0);
    assert.equal(record.index, 0);
    assert.equal(record.type, 'mnemonic');
    assert.equal(record.address.toLowerCase(), state.owner);
    signer.getSigner = (index) => {
      assert.equal(index, 0);
      assert.equal(phase, 'setup');
      const delegate = originalSigner(index);
      return {
        async getAddress() {
          state.addresses++;
          return delegate.getAddress();
        },
        async signTransaction(tx) {
          state.signs++;
          assert.equal(state.signs, 1);
          assert.equal(state.reviewed, true);
          return delegate.signTransaction(tx);
        },
      };
    };
    state.identity = await identities.openRailgunIdentity({ archive });
    state.enrollment =
      await require('../../src/main/wallet/railgun-account-enrollment').openRailgunAccountEnrollment(
        { identity: state.identity, create: phase === 'setup' }
      );
    state.publicAccount =
      await require('../../src/main/wallet/railgun-account-public').openRailgunAccountPublic({
        enrollment: state.enrollment,
        archive,
        create: phase === 'setup',
      });
    state.owners = {
      identity: state.identity,
      enrollment: state.enrollment,
      coordinator: state.publicAccount.coordinator,
    };
    return state;
  } catch (error) {
    try {
      await state.close();
    } catch (cleanup) {
      sticky.record(cleanup, 'failed open cleanup');
    }
    throw error;
  }
}
function preview(state) {
  const {
    createPrivacyScope,
    getPrivacyContext,
  } = require('../../src/main/networks/privacy-context');
  const parent = require('../../src/main/wallet/privacy-session').openPrivacySession();
  const subject = {
    kind: 'public-address',
    principal: state.owner,
    chainId: 11155111,
    role: 'transaction-rpc',
  };
  const handle = parent.getContext(subject),
    scope = createPrivacyScope({
      profileId: getPrivacyContext(handle).profileId,
      signal: state.signal.signal,
      isCurrent: () => {
        getPrivacyContext(handle);
        return true;
      },
    });
  const rpc = require('../../src/main/networks/private-rpc'),
    child = scope.getContext(subject),
    client = rpc.createPrivateRpc(child, 'transaction-rpc');
  const observation = rpc.getPrivateRpcDestination(client, child);
  assert.equal(
    rpc.getPrivateRpcDestinationDetails(observation).url,
    require('./railgun-public-cold-chain').URL
  );
  const guard = rpc.createPrivateRpcDestinationConstraint({
    observation,
    signal: scope.signal,
    deadline: performance.now() + 180000,
  });
  state.previews.push(() => {
    try {
      guard.close();
    } finally {
      try {
        client.release();
      } finally {
        scope.close();
      }
    }
  });
  return guard.constraint;
}
module.exports = { open, preview, bounded, steps };
