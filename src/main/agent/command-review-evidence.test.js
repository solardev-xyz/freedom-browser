'use strict';
const { collectCommandReviewEvidence } = require('./command-review-evidence');
const permission = { command: 'npm run dev', workingDirectory: '.' };
function fixture(files) {
  return { readFile: jest.fn(async (_owner, name) => {
    if (!(name in files)) throw Object.assign(new Error('missing'), { code: 'WORKSPACE_PATH_NOT_FOUND' });
    return Buffer.from(files[name]);
  }) };
}
test('collects manifests and direct scripts, marks absent config, and binds raw bytes', async () => {
  const files = { 'package.json': JSON.stringify({ scripts: { dev: 'node scripts/dev.js' }, dependencies: { next: '15.5.25' } }), 'scripts/dev.js': 'console.log("preview")' };
  const controller = fixture(files);
  const first = await collectCommandReviewEvidence(controller, 'conversation', permission);
  expect(first.data.records).toEqual(expect.arrayContaining([
    expect.objectContaining({ path: 'package.json', status: 'read' }),
    { path: '.npmrc', status: 'missing' },
    expect.objectContaining({ path: 'scripts/dev.js', content: 'console.log("preview")' }),
  ]));
  files['scripts/dev.js'] = 'console.log("changed")';
  expect((await collectCommandReviewEvidence(controller, 'conversation', permission)).fingerprint).not.toBe(first.fingerprint);
});
test('never discloses npm auth config or manifest secrets and bounds large evidence', async () => {
  const controller = fixture({ '.npmrc': '//registry.npmjs.org/:_authToken=fixture-secret', 'package.json': JSON.stringify({ scripts: { dev: 'TOKEN=abcdefghijk next dev' } }) });
  const result = await collectCommandReviewEvidence(controller, 'conversation', permission);
  expect(JSON.stringify(result)).not.toContain('fixture-secret');
  expect(JSON.stringify(result)).not.toContain('abcdefghijk');
  expect(result.data.records).toEqual(expect.arrayContaining([{ path: '.npmrc', status: 'present_not_disclosed' }]));
  const large = fixture({ 'package.json': 'x'.repeat(129 * 1024) });
  expect((await collectCommandReviewEvidence(large, 'conversation', permission)).data.records[0].status).toBe('too_large');
});
test('does not read outside the project or claim unsupported command evidence', async () => {
  const controller = fixture({});
  for (const workingDirectory of ['../private', '/private', 'foo\\bar']) await collectCommandReviewEvidence(controller, 'c', { ...permission, workingDirectory });
  await collectCommandReviewEvidence(controller, 'c', { command: 'python task.py' });
  expect(controller.readFile).not.toHaveBeenCalled();
});
