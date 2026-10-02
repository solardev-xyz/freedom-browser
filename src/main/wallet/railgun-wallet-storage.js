/** Main-owned separation of public reads and derived-wallet writes. Each channel
 * has its own ordered broker stream; keys never move between the two databases.
 * The caller retains lifetime ownership and must observe the utility job exit.
 */
const assert = require('assert/strict');
const { paths } = require('./railgun-frontier');
const reads = new Set(['get', 'getMany', 'open', 'next', 'nextMany', 'seek', 'end']);
const segment = (text) => text.padStart(64, '0');
function createRailgunWalletStorage({ publicSnapshot, walletSession, walletId }) {
  assert.match(walletId, /^[0-9a-f]{64}$/);
  assert.ok(typeof publicSnapshot.dispatch === 'function');
  const walletGrant = walletSession.claimDispatch();
  const controller = new AbortController();
  const signal = AbortSignal.any([publicSnapshot.signal, walletSession.signal, controller.signal]);
  const walletRoot = segment(Buffer.from('wallet').toString('hex'));
  const network = segment('aa36a7');
  const channels = {
    public: {
      dispatch: publicSnapshot.dispatch,
      prefixes: [paths.metadata().toString()],
      cursors: new Map(),
    },
    wallet: {
      dispatch: walletGrant.dispatch,
      prefixes: [walletId, `${walletId}-spent`.slice(-64)].map(
        (id) => `${walletRoot}:${id}:${network}`
      ),
      cursors: new Map(),
    },
  };
  let sequence = 0,
    pending = 0;
  const close = () => controller.abort();
  const decode = (value) => {
    assert.ok(typeof value === 'string' && value.length <= 5500);
    const bytes = Buffer.from(value, 'base64');
    assert.equal(bytes.toString('base64'), value);
    const text = bytes.toString();
    assert.ok(Buffer.from(text).equals(bytes));
    return text;
  };
  const contains = (prefix, key) => key === prefix || key.startsWith(prefix + ':');
  async function dispatch(wire) {
    try {
      assert.ok(
        !signal.aborted && typeof wire === 'string' && Buffer.byteLength(wire) <= 2 * 1024 * 1024
      );
      const message = JSON.parse(wire);
      assert.deepEqual(Object.keys(message).sort(), ['channel', 'id', 'wire']);
      assert.equal(message.id, ++sequence);
      assert.ok(pending < 8);
      const channel = channels[message.channel];
      assert.ok(channel && Object.hasOwn(channels, message.channel));
      assert.ok(typeof message.wire === 'string');
      const call = JSON.parse(message.wire),
        args = call.args;
      assert.ok(
        reads.has(call.method) || (message.channel === 'wallet' && call.method === 'batch')
      );
      const allowed = (key) => channel.prefixes.some((prefix) => contains(prefix, decode(key)));
      if (call.method === 'get') assert.ok(allowed(args.key));
      if (call.method === 'getMany')
        assert.ok(Array.isArray(args.keys) && args.keys.every(allowed));
      if (call.method === 'batch')
        assert.ok(
          Array.isArray(args.operations) &&
            args.operations.every((op) => op.type === 'put' && allowed(op.key))
        );
      let openedPrefix;
      if (call.method === 'open') {
        const options = args.options;
        const lower = decode(options.gte ?? options.gt),
          upper = decode(options.lte ?? options.lt);
        openedPrefix = channel.prefixes.find(
          (prefix) => lower >= prefix && upper <= prefix + '~' && lower <= upper
        );
        assert.ok(openedPrefix);
        // The session rejects unknown fields. Reject ambiguous pairs here too.
        assert.ok(!(options.gte !== undefined && options.gt !== undefined));
        assert.ok(!(options.lte !== undefined && options.lt !== undefined));
      }
      if (['next', 'nextMany', 'seek', 'end'].includes(call.method)) {
        assert.ok(channel.cursors.has(args.cursor));
        if (call.method === 'seek')
          assert.ok(contains(channel.cursors.get(args.cursor), decode(args.target)));
      }
      pending++;
      let reply;
      try {
        reply = await channel.dispatch(message.wire);
      } finally {
        pending--;
      }
      assert.ok(!signal.aborted);
      const result = JSON.parse(reply);
      assert.equal(result.id, call.id);
      if (call.method === 'open') {
        assert.ok(
          Number.isSafeInteger(result.value) &&
            result.value > 0 &&
            !channel.cursors.has(result.value)
        );
        channel.cursors.set(result.value, openedPrefix);
      }
      if (call.method === 'end') channel.cursors.delete(args.cursor);
      return JSON.stringify({ id: message.id, value: reply });
    } catch {
      close();
      throw Object.assign(new Error('Railgun wallet storage unavailable'), {
        code: 'RAILGUN_WALLET_STORAGE_REFUSED',
      });
    }
  }
  return Object.freeze({
    dispatch,
    prefixes: Object.freeze(
      Object.fromEntries(
        Object.entries(channels).map(([name, channel]) => [
          name,
          Object.freeze([...channel.prefixes]),
        ])
      )
    ),
    signal,
    close,
    assertIdle() {
      assert.ok(!signal.aborted && pending === 0);
      for (const channel of Object.values(channels)) assert.equal(channel.cursors.size, 0);
    },
  });
}
module.exports = { createRailgunWalletStorage };
