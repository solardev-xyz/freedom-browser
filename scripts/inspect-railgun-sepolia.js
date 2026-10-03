/** Read-only, direct-HTTPS deployment research. Public contract data only.
 * Two agreeing RPCs are corroboration, not independently verified chain state.
 * This script has no wallet, signing, submission or runtime-enrollment path.
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const { createHash } = require('crypto');
const { Interface, id, toBeHex, keccak256 } = require('ethers');
const { assertRailgunFixture } = require('./railgun-fixture-integrity');
const endpoints = ['https://sepolia.rpc.sentio.xyz', 'https://gateway.tenderly.co/public/sepolia'];
const addresses = {
  proxy: '0xeCFCf3b4eC647c4Ca6D49108b311b7a7C9543fea',
  relayAdapt: '0x7e3d929EbD5bDC84d02Bd3205c777578f33A214D',
  wrappedNative: '0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14',
};
const quantity = (value) => typeof value === 'string' && /^0x(?:0|[1-9a-f][0-9a-f]*)$/.test(value);
async function batch(url, calls) {
  const response = await fetch(url, {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(20000),
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(
      calls.map(([method, params], n) => ({ jsonrpc: '2.0', id: n + 1, method, params }))
    ),
  });
  assert.equal(
    response.status,
    200,
    'RPC HTTP ' + response.status + ' at ' + new URL(url).hostname
  );
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    assert.ok(size <= 2 * 1024 * 1024, 'RPC body limit');
    chunks.push(chunk);
  }
  const result = JSON.parse(Buffer.concat(chunks).toString());
  assert.ok(Array.isArray(result) && result.length === calls.length);
  return calls.map((_, n) => {
    const matches = result.filter((item) => item?.id === n + 1);
    assert.equal(matches.length, 1);
    assert.equal(matches[0].jsonrpc, '2.0');
    assert.ok(!matches[0].error, 'RPC refused method ' + calls[n][0]);
    assert.ok(Object.hasOwn(matches[0], 'result'));
    return matches[0].result;
  });
}
async function rpc(url, calls) {
  const values = [];
  for (let offset = 0; offset < calls.length; offset += 4) {
    if (offset) await new Promise((resolve) => setTimeout(resolve, 1000));
    values.push(...(await batch(url, calls.slice(offset, offset + 4))));
  }
  return values;
}
async function main() {
  const output = process.argv[2];
  assert.ok(output && path.isAbsolute(output) && !fs.existsSync(output));
  const fixture = path.join(__dirname, 'fixtures/railgun-engine/node_modules');
  const inventory = assertRailgunFixture(fixture);
  const abiPath = path.join(
    fixture,
    '@railgun-community/engine/dist/abi/V2.1/RailgunSmartWallet.json'
  );
  const abi = new Interface(JSON.parse(fs.readFileSync(abiPath)));
  const heads = await Promise.all(
    endpoints.map((url) =>
      rpc(url, [
        ['eth_chainId', []],
        ['eth_getBlockByNumber', ['finalized', false]],
      ])
    )
  );
  for (const [chain, head] of heads) {
    assert.equal(chain, '0xaa36a7');
    assert.ok(quantity(head.number));
    assert.match(head.hash, /^0x[0-9a-f]{64}$/);
  }
  const block = heads.map(([, head]) => BigInt(head.number)).reduce((a, b) => (a < b ? a : b));
  const tag = toBeHex(block).replace(/^0x0([0-9a-f])/, '0x$1');
  const anchors = await Promise.all(
    endpoints.map((url) => rpc(url, [['eth_getBlockByNumber', [tag, false]]]))
  );
  for (const [head] of anchors) {
    assert.equal(head?.number, tag);
    assert.match(head.hash, /^0x[0-9a-f]{64}$/);
  }
  assert.equal(anchors[0][0].hash, anchors[1][0].hash);
  const anchor = { blockHash: anchors[0][0].hash, requireCanonical: true };
  const slots = Object.fromEntries(
    ['implementation', 'admin', 'paused'].map((name) => [
      name,
      toBeHex(BigInt(id('eip1967.proxy.' + name)) - 1n, 32),
    ])
  );
  const names = [
    'treeNumber',
    'nextLeafIndex',
    'merkleRoot',
    'shieldFee',
    'unshieldFee',
    'lastEventBlock',
    'owner',
    'treasury',
  ];
  const variants = [
    [1, 1],
    [1, 2],
    [1, 3],
    [2, 2],
    [2, 3],
  ];
  const calls = [
    ...Object.values(addresses).map((address) => ['eth_getCode', [address, anchor]]),
    ...Object.values(slots).map((slot) => ['eth_getStorageAt', [addresses.proxy, slot, anchor]]),
    ...names.map((name) => [
      'eth_call',
      [{ to: addresses.proxy, data: abi.encodeFunctionData(name) }, anchor],
    ]),
    ...variants.map((shape) => [
      'eth_call',
      [{ to: addresses.proxy, data: abi.encodeFunctionData('getVerificationKey', shape) }, anchor],
    ]),
  ];
  const results = await Promise.all(endpoints.map((url) => rpc(url, calls)));
  assert.deepEqual(results[0], results[1]);
  const values = [anchors[0][0], ...results[0]];
  const code = Object.fromEntries(
    Object.keys(addresses).map((name, n) => {
      assert.match(values[n + 1], /^0x[0-9a-f]+$/);
      assert.ok(values[n + 1].length > 2);
      return [
        name,
        {
          address: addresses[name],
          bytes: (values[n + 1].length - 2) / 2,
          keccak256: keccak256(values[n + 1]),
        },
      ];
    })
  );
  const proxy = Object.fromEntries(
    Object.keys(slots).map((name, n) => {
      assert.match(values[n + 4], /^0x[0-9a-f]{64}$/);
      return [name, values[n + 4]];
    })
  );
  assert.equal(BigInt(proxy.paused), 0n);
  assert.equal(proxy.implementation.slice(2, 26), '0'.repeat(24));
  assert.equal(proxy.admin.slice(2, 26), '0'.repeat(24));
  const implementation = '0x' + proxy.implementation.slice(-40);
  assert.notEqual(BigInt(implementation), 0n);
  const finalChecks = await Promise.all(
    endpoints.map((url) =>
      rpc(url, [
        ['eth_getCode', [implementation, anchor]],
        ['eth_getBlockByNumber', [tag, false]],
      ])
    )
  );
  assert.equal(finalChecks[0][0], finalChecks[1][0]);
  assert.ok(finalChecks[0][0].length > 2);
  for (const [, head] of finalChecks) {
    assert.equal(head?.number, tag);
    assert.equal(head.hash, anchor.blockHash);
  }
  const state = Object.fromEntries(
    names.map((name, n) => [name, abi.decodeFunctionResult(name, values[n + 7])[0].toString()])
  );
  const verificationKeys = variants.map((shape, n) => {
    const raw = values[n + 7 + names.length];
    const decoded = abi.decodeFunctionResult('getVerificationKey', raw)[0];
    assert.ok(decoded.ic.length > 0 && decoded.alpha1.x !== 0n);
    return {
      shape,
      encoded: raw,
      keccak256: keccak256(raw),
      artifactsIPFSHash: decoded.artifactsIPFSHash,
      icLength: decoded.ic.length,
    };
  });
  const report = {
    observedAt: new Date().toISOString(),
    chainId: 11155111,
    route: 'direct-https-public-contract-research',
    trust: 'two-rpc-agreement-unverified',
    endpoints,
    finalizedHeads: heads.map(([, head]) => ({ number: head.number, hash: head.hash })),
    anchor: { number: Number(block), hash: values[0].hash },
    engineInventory: inventory.sha256,
    sharedModelsCommit: 'b37e643ef38e3df554deffa33f40530b20ce9065',
    proxyLayoutSource:
      'https://github.com/Railgun-Privacy/contract/blob/36bcf5ed7cf94bfafb6e1a303e1832c769c16780/contracts/proxy/Proxy.sol',
    proxyLayoutSha256: '619709609e7030ee551072221e837a6b905dcb58e152478cd7ddcc3ebac88c9c',
    proxySlots: Object.fromEntries(
      Object.entries(slots).map(([name, slot]) => [
        name,
        { preimage: 'eip1967.proxy.' + name, slot },
      ])
    ),
    sourceSha256: createHash('sha256').update(fs.readFileSync(__filename)).digest('hex'),
    abiSha256: createHash('sha256').update(fs.readFileSync(abiPath)).digest('hex'),
    code,
    proxy,
    implementation: { address: implementation, keccak256: keccak256(finalChecks[0][0]) },
    state,
    verificationKeys,
    deploymentBlockCandidate: 5784866,
    signingEnabled: false,
    submissions: 0,
  };
  fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(
    JSON.stringify(
      {
        anchor: report.anchor,
        state,
        implementation: report.implementation,
        variants: verificationKeys.map(({ shape, icLength }) => ({ shape, icLength })),
      },
      null,
      2
    )
  );
}
if (require.main === module)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
