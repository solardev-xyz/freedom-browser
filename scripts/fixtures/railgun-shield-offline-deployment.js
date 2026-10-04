/** Offline protocol-RPC replies for the real Shield deployment preflight.
 * Bytecode must match the production pins. Headers, slots and getter replies
 * are synthetic: executing the checks is not evidence of live deployment state.
 */
const assert = require('assert/strict');
const fs = require('fs');
const { createHash } = require('crypto');
const { Interface, id, toBeHex, keccak256 } = require('ethers');
const pins = require('../../src/main/wallet/railgun-shield-pins.json');
const names = ['proxy', 'relayAdapt', 'wrappedNative', 'implementation'];
const abi = new Interface([
  'function railgun() view returns (address)',
  'function wBase() view returns (address)',
  'function shieldFee() view returns (uint120)',
  'function tokenBlocklist(address) view returns (bool)',
]);
function createOfflineShieldDeployment(filename) {
  assert.ok(typeof filename === 'string' && require('path').isAbsolute(filename));
  const stat = fs.statSync(filename);
  assert.ok(stat.isFile() && stat.size > 0 && stat.size <= 256000);
  const bytes = fs.readFileSync(filename);
  assert.ok(bytes.length > 0 && bytes.length <= 256000);
  const fixture = JSON.parse(bytes.toString());
  assert.equal(fixture.schema, 'railgun-public-contract-bytecodes-v1');
  assert.equal(fixture.chainId, pins.chainId);
  assert.deepEqual(Object.keys(fixture.code).sort(), [...names].sort());
  for (const name of names) {
    assert.match(fixture.code[name], /^0x(?:[0-9a-f]{2})+$/);
    assert.ok(fixture.code[name].length <= 131074);
    assert.equal(keccak256(fixture.code[name]), pins.codeHashes[name]);
  }
  const methods = Object.create(null);
  let generation = 0,
    anchor;
  function request(call) {
    methods[call.method] = (methods[call.method] ?? 0) + 1;
    assert.equal(call.jsonrpc, '2.0');
    assert.ok(Array.isArray(call.params));
    if (call.method === 'eth_chainId') {
      assert.deepEqual(call.params, []);
      return '0xaa36a7';
    }
    if (call.method === 'eth_getBlockByNumber') {
      assert.equal(call.params.length, 2);
      assert.equal(call.params[1], false);
      if (call.params[0] === 'latest') {
        generation++;
        anchor = Object.freeze({
          number: toBeHex(11834513),
          hash:
            '0x' +
            createHash('sha256')
              .update('offline-shield-block-' + generation)
              .digest('hex'),
          timestamp: toBeHex(Math.floor(Date.now() / 1000)),
        });
      } else assert.equal(call.params[0], anchor?.number);
      assert.ok(anchor);
      return anchor;
    }
    assert.ok(anchor);
    assert.deepEqual(call.params.at(-1), { blockHash: anchor.hash, requireCanonical: true });
    if (call.method === 'eth_getCode') {
      assert.equal(call.params.length, 2);
      const name = names.find((name) => pins[name] === call.params[0]);
      assert.ok(name);
      return fixture.code[name];
    }
    if (call.method === 'eth_getStorageAt') {
      assert.equal(call.params.length, 3);
      assert.equal(call.params[0], pins.proxy);
      const slot = call.params[1];
      if (slot === toBeHex(BigInt(id('eip1967.proxy.implementation')) - 1n, 32))
        return '0x' + pins.implementation.slice(2).padStart(64, '0');
      assert.equal(slot, toBeHex(BigInt(id('eip1967.proxy.paused')) - 1n, 32));
      return '0x' + '0'.repeat(64);
    }
    assert.equal(call.method, 'eth_call');
    assert.equal(call.params.length, 2);
    assert.deepEqual(Object.keys(call.params[0]).sort(), ['data', 'to']);
    const parsed = abi.parseTransaction(call.params[0]);
    const replies = {
      railgun: [pins.relayAdapt, [], pins.proxy],
      wBase: [pins.relayAdapt, [], pins.wrappedNative],
      shieldFee: [pins.proxy, [], BigInt(pins.shieldFeeBps)],
      tokenBlocklist: [pins.proxy, [pins.wrappedNative], false],
    };
    const reply = replies[parsed.name];
    assert.ok(reply);
    assert.equal(call.params[0].to, reply[0]);
    assert.equal(call.params[0].data, abi.encodeFunctionData(parsed.name, reply[1]));
    return abi.encodeFunctionResult(parsed.name, [reply[2]]).toLowerCase();
  }
  return Object.freeze({
    request,
    report: () => ({
      inputSha256: createHash('sha256').update(bytes).digest('hex'),
      publicBytecodeMatchesPins: true,
      syntheticHeadersSlotsAndGetters: true,
      liveDeploymentQualified: false,
      methods: { ...methods },
    }),
  });
}
module.exports = { createOfflineShieldDeployment };
