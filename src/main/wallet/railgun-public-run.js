/** Main-owned public scan jobs. Only bounded public logs and an acknowledged
 * storage capability enter the utility; source networking stays with main. */
const assert = require('assert/strict');
const { startRailgunProcess } = require('./railgun-process');
const { verifyRailgunEngineRuntime } = require('./railgun-engine-runtime');
const { createPrivacyScope, getPrivacyContext } = require('../networks/privacy-context');
const { QUALIFIED_THROUGH } = require('./railgun-public-policy');
const storageMethods = new Set([
  'get',
  'getMany',
  'open',
  'next',
  'nextMany',
  'seek',
  'end',
  'batch',
  'txBegin',
  'txStage',
  'txCommit',
  'txAbort',
  'txRead',
]);
const { createFeed } = require('./railgun-source-feed');
function createRailgunPublicJobs({ handle, archive }) {
  const context = getPrivacyContext(handle);
  assert.equal(context.subject.kind, 'private-account');
  assert.equal(context.subject.protocol, 'railgun');
  assert.equal(context.subject.role, 'engine');
  assert.equal(context.subject.chainId, 11155111);
  assert.equal(context.subject.operation, null);
  archive = verifyRailgunEngineRuntime(archive);
  let busy = false;
  async function run(mode, input, visit, { dispatch, signal }) {
    getPrivacyContext(handle);
    assert.ok(!busy && signal instanceof AbortSignal && !signal.aborted);
    busy = true;
    const scope = createPrivacyScope({
      profileId: context.profileId,
      signal: AbortSignal.any([context.signal, signal]),
      isCurrent: () => {
        getPrivacyContext(handle);
        return true;
      },
    });
    signal = scope.signal;
    const feed = createFeed(visit, signal);
    let task,
      result,
      sequence = 0,
      storageSequence = 0,
      reading = false,
      eof = false;
    const broker = {
      signal,
      async dispatch(wire) {
        getPrivacyContext(handle);
        assert.ok(!signal.aborted);
        const message = JSON.parse(wire);
        assert.ok(message && message.id === ++sequence);
        if (message.method === 'sourceNext') {
          assert.deepEqual(Object.keys(message).sort(), ['id', 'method']);
          assert.ok(!reading && !eof && !result);
          reading = true;
          try {
            const logs = await feed.next();
            eof = logs === null;
            return JSON.stringify({ id: message.id, value: logs });
          } finally {
            reading = false;
          }
        }
        if (message.method === 'jobResult') {
          assert.deepEqual(Object.keys(message).sort(), ['id', 'method', 'value']);
          assert.ok(eof && !result && message.value?.guards?.attempts === 0);
          result = message.value;
          return JSON.stringify({ id: message.id, value: null });
        }
        assert.ok(
          mode === 'apply' &&
            eof &&
            !result &&
            typeof dispatch === 'function' &&
            storageMethods.has(message.method)
        );
        const storageId = ++storageSequence;
        const reply = JSON.parse(await dispatch(JSON.stringify({ ...message, id: storageId })));
        assert.equal(reply.id, storageId);
        return JSON.stringify({ ...reply, id: message.id });
      },
    };
    try {
      task = startRailgunProcess({
        handle: scope.getContext({ ...context.subject, operation: 'public-scan' }),
        broker,
        filename: require.resolve('./railgun-public-job'),
        input: JSON.stringify({ mode, ...input, archive, qualifiedThrough: QUALIFIED_THROUGH }),
        startupMs: 120000,
        lifetimeMs: 170000,
      });
      await task.ready;
      assert.ok(result);
      task.close();
      const closed = await task.closed;
      assert.equal(closed.code, 'RAILGUN_PROCESS_CLOSED');
      await feed.done;
      getPrivacyContext(handle);
      assert.ok(!signal.aborted);
      return { ...result, closed };
    } catch (error) {
      task?.close();
      const closed = await task?.closed;
      throw Object.assign(new Error('Railgun public job failed', { cause: error }), {
        code: error?.code,
        closed,
      });
    } finally {
      task?.close();
      await task?.closed;
      feed.close();
      await feed.done.catch(() => {});
      scope.close();
      busy = false;
    }
  }
  return Object.freeze({
    async project({ range }, { visit, signal }) {
      return (await run('plan', { storeId: range.storeId }, visit, { signal })).state;
    },
    async apply(input, capability) {
      getPrivacyContext(handle);
      assert.ok(!busy && !capability.signal.aborted);
      if (!input.plan.state.trees.length) return { skipped: 'no-utxo-yet' };
      const { logs, plan } = input;
      assert.ok(Array.isArray(logs) && logs.length <= 4096);
      return run(
        'apply',
        { plan },
        async (consume) => {
          for (const log of logs) await consume(log);
        },
        capability
      );
    },
  });
}
module.exports = { createRailgunPublicJobs, createFeed };
