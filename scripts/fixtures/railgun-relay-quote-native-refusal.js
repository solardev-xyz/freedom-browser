/** Qualification-only negative envelope; never production authority. */
const assert = require('assert/strict');
const fs = require('fs');
const crypto = require('crypto');
const {
  shape,
  normalizeRailgunRelayQuote,
  EXPECTED_GUARDS,
} = require('../../src/main/wallet/railgun-relay-quote-data');
const { verifyRailgunEngineRuntime } = require('../../src/main/wallet/railgun-engine-runtime');
const approved = require('./railgun-relay-quote-native-pins.json');
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
function assertionAt(error, filename, line) {
  if (error?.code !== 'ERR_ASSERTION' || typeof error.stack !== 'string') return false;
  const frames = error.stack.split('\n').filter((text) => /^\s+at /.test(text));
  const escaped = filename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const origin = new RegExp('(?:^\\s+at |\\()' + escaped + ':' + line + ':\\d+\\)?$');
  return frames.length > 0 && origin.test(frames[0]);
}
exports.assertionAt = assertionAt;
exports.run = async function run(text, api) {
  assert.ok(api.signal instanceof AbortSignal && !api.signal.aborted);
  assert.ok(typeof text === 'string' && Buffer.byteLength(text) <= 26000);
  const input = JSON.parse(text);
  shape(input, ['caseId', 'productionInput']);
  assert.ok(Object.hasOwn(approved.refusalLines, input.caseId));
  const production = JSON.parse(input.productionInput);
  shape(production, ['archive', 'quote', 'gas']);
  normalizeRailgunRelayQuote(production.quote, production.gas);
  const archive = verifyRailgunEngineRuntime(production.archive);
  const filename = require.resolve('../../src/main/wallet/railgun-relay-quote-job');
  assert.equal(sha(fs.readFileSync(filename)), approved.jobSha256);
  const job = require(filename);
  let dispatches = 0;
  let failure;
  try {
    await job.run(input.productionInput, {
      signal: api.signal,
      guardReport: api.guardReport,
      request() {
        dispatches++;
        throw Object.assign(new Error('Unexpected production result'), {
          code: 'QUALIFICATION_UNEXPECTED_RESULT',
        });
      },
    });
  } catch (error) {
    failure = error;
  }
  // Runtime/source provenance and lifecycle checks are outside the catch.
  assert.equal(verifyRailgunEngineRuntime(production.archive), archive);
  assert.equal(sha(fs.readFileSync(filename)), approved.jobSha256);
  assert.ok(!api.signal.aborted);
  assert.equal(dispatches, 0);
  assert.ok(assertionAt(failure, filename, approved.refusalLines[input.caseId]));
  const guards = api.guardReport();
  assert.deepEqual(guards, EXPECTED_GUARDS);
  assert.deepEqual(
    JSON.parse(
      await api.request(
        JSON.stringify({
          id: 1,
          method: 'result',
          value: {
            caseId: input.caseId,
            productionInputSha256: sha(input.productionInput),
            jobSha256: approved.jobSha256,
            observedAssertionRefusal: true,
            productionResultMessages: 0,
            exactCryptographicPredicateIndependentlyAttributed: false,
            guards,
          },
        })
      )
    ),
    { id: 1, value: null }
  );
  assert.ok(!api.signal.aborted);
};
