const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { PassThrough } = require('stream');

jest.mock('https');

const { release, sha256, selectedTargets, verifyBytes, validateInstalledAddon, download, pruneLeftoverAddons } = require('./fetch-myotis');

// Scripted `https.get` responses (fetch-ant.test.js convention). The download
// goes through scripts/lib/fetch-with-retry.js, whose own suite pins the retry
// policy; what matters here is that this script's rules still hold through it.
function mockResponses(responses) {
  const calls = [];
  https.get.mockImplementation((url, options, callback) => {
    const scripted = responses[calls.length];
    const req = new PassThrough();
    req.setTimeout = jest.fn();
    req.destroy = jest.fn();
    calls.push({ url, headers: options.headers, req });
    if (!scripted) throw new Error(`Unexpected request #${calls.length} to ${url}`);
    process.nextTick(() => {
      const res = new PassThrough();
      res.statusCode = scripted.statusCode;
      res.headers = scripted.headers || {};
      res.complete = true;
      callback(res);
      process.nextTick(() => {
        if (scripted.body !== undefined) res.write(Buffer.from(scripted.body));
        res.end();
      });
    });
    return req;
  });
  return calls;
}

const noWait = { sleep: () => Promise.resolve(), log: () => {} };

afterEach(() => jest.resetAllMocks());

test('selects official assets for all five targets, including cross-target downloads', () => {
  expect(release.abi).toBe(26);
  expect(selectedTargets()).toHaveLength(5);
  expect(selectedTargets('win32-x64')[0].dir).toBe('win-x64');
  expect(() => selectedTargets('win32-arm64')).toThrow('Unsupported');
});

test('changed addon bytes fail the committed checksum, regardless of local build metadata', () => {
  const bytes = Buffer.from('addon');
  expect(() => verifyBytes({ sha256: sha256(bytes) }, bytes)).not.toThrow();
  expect(() => verifyBytes({ sha256: sha256(bytes) }, Buffer.from('changed'))).toThrow('checksum');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myotis-release-check-'));
  const dir = path.join(root, 'mac-arm64'); fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'myotis-node.node'), bytes);
  fs.writeFileSync(path.join(dir, 'myotis-build.json'), JSON.stringify({ addonSha256: sha256(bytes) }));
  expect(validateInstalledAddon(dir)).toContain('checksum');
  expect(validateInstalledAddon(path.join(root, 'win-x64'))).toContain('missing');
});

test('removes replaced and abandoned addon copies without touching the installed one', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'myotis-prune-'));
  const uuid = '9f3b1c2d-4e5a-4b6c-8d7e-0f1a2b3c4d5e';
  const keep = ['myotis-node.node', 'myotis-build.json', 'myotis-node.candidate.node', 'notes.previous-1'];
  const remove = [`myotis-node.candidate-${uuid}.node`, `myotis-node.node.previous-${uuid}`];
  for (const name of [...keep, ...remove]) fs.writeFileSync(path.join(dir, name), 'bytes');
  pruneLeftoverAddons(dir);
  expect(fs.readdirSync(dir).sort()).toEqual(keep.sort());
});

test('refuses HTTP redirects before requesting their content', async () => {
  const calls = mockResponses([
    { statusCode: 302, headers: { location: 'http://untrusted.invalid/addon' } },
  ]);
  await expect(download('https://github.com/example', noWait)).rejects.toThrow(
    'Refusing non-HTTPS redirect'
  );
  expect(calls).toHaveLength(1);
  expect(calls[0].headers).not.toHaveProperty('Authorization');
});

test('retries a transient GitHub failure and refuses an over-size body', async () => {
  const calls = mockResponses([
    { statusCode: 500 },
    { statusCode: 429, headers: { 'retry-after': '1' } },
    { statusCode: 200, body: 'addon-bytes' },
  ]);
  await expect(download('https://github.com/example', noWait)).resolves.toEqual(
    Buffer.from('addon-bytes')
  );
  expect(calls).toHaveLength(3);

  jest.resetAllMocks();
  const oversize = mockResponses([{ statusCode: 200, body: 'x'.repeat(64) }]);
  await expect(download('https://github.com/example', { ...noWait, maxBytes: 16 })).rejects.toThrow(
    /exceeds the 16-byte limit/
  );
  expect(oversize).toHaveLength(1);
});

// A missing asset is an answer: four attempts would only delay the failure.
test('never retries a 404', async () => {
  const calls = mockResponses([{ statusCode: 404 }]);
  await expect(download('https://github.com/example', noWait)).rejects.toThrow(/HTTP 404/);
  expect(calls).toHaveLength(1);
});
