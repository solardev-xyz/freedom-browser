/** Two fixed viewing-only jobs; construction and reconstruction never share a process. */
const assert = require('assert/strict');
exports.run = async (inputText, context) => {
  const input = JSON.parse(inputText);
  assert.equal(input.restore, true);
  for (const name of ['privateIntent', 'privateOperation', 'privateRecovery'])
    assert.equal(input[name], undefined);
  const constructing = input.relayRequest !== undefined;
  assert.equal(constructing, input.relayDraftText === undefined);
  require('./railgun-relay-quote-data').shape(input, [
    'archive',
    'descriptor',
    'checkpoint',
    'walletId',
    'restore',
    'prefixes',
    ...(constructing ? ['relayRequest'] : ['relayDraftText']),
  ]);
  const data = require('./railgun-relay-wallet-data');
  const request = constructing
    ? data.normalizeRailgunRelayRequest(input.relayRequest, input.walletId)
    : undefined;
  if (!constructing) data.parseRailgunRelayDraft(input.relayDraftText, input.walletId);
  return require('./railgun-wallet-job').withWallet(
    inputText,
    context,
    constructing ? 'relay-prepare' : 'relay-reconstruct',
    async (restored) =>
      constructing
        ? {
            relayDraft: await require('./railgun-relay-witness').prepareRailgunRelayDraft({
              ...restored,
              request,
            }),
          }
        : {
            relayReconstruction:
              await require('./railgun-relay-reconstruct').reconstructRailgunRelayDraft({
                ...restored,
                draftText: input.relayDraftText,
              }),
          }
  );
};
