// Research harness for the pinned Colibri 2.0.6 package; no application integration.
require('node:assert/strict').equal(
  require(
    require('node:path').resolve(
      __dirname,
      '../../../../node_modules/@corpus-core/colibri-stateless/package.json'
    )
  ).version,
  '2.0.6'
);
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

(async () => {
  const source = path.resolve(
    __dirname,
    '../../../../node_modules/@corpus-core/colibri-stateless/http.js'
  );
  const { handle_request } = await import(pathToFileURL(source).href);
  const seen = [];
  const responses = [];
  const errors = [];
  const root = `0x${'ab'.repeat(32)}`;
  const config = {
    checkpointz: ['https://independent.invalid'],
    beacon_apis: ['https://independent-beacon.invalid'],
    prover: ['https://same-prover.invalid'],
    fetch: async (url) => {
      seen.push(url);
      if (!url.startsWith('https://same-prover.invalid/'))
        return new Response('unavailable', { status: 503 });
      return new Response(JSON.stringify({ data: { root } }), { status: 200 });
    },
  };
  await handle_request(
    {
      reqSetResponse: (_req, data, nodeIndex) =>
        responses.push({ body: new TextDecoder().decode(data), nodeIndex }),
      reqSetError: (_req, error, nodeIndex) => errors.push({ error, nodeIndex }),
    },
    { type: 'checkpointz', url: 'eth/v1/beacon/blocks/1/root', method: 'get', encoding: 'json' },
    config
  );
  assert.equal(errors.length, 0);
  assert.equal(responses.length, 1);
  assert.equal(responses[0].nodeIndex, 2);
  assert.equal(JSON.parse(responses[0].body).data.root, root);
  assert.equal(seen.length, 3);
  console.log(
    JSON.stringify(
      {
        result: 'PASS: checkpoint request can fall back to the same prover',
        seen,
        responses,
        errors,
      },
      null,
      2
    )
  );
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
