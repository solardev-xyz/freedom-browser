const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  installTarget,
  PINNED_SOURCE_COMMIT,
  RELEASE_REPO,
  selectedTargets,
  runtimeTarget,
  TARGETS,
} = require('./fetch-tonutils-freedom');

test('uses upstream source and selects the runtime or explicit build target', () => {
  expect(RELEASE_REPO).toBe('xssnick/Tonutils-Proxy');
  expect(PINNED_SOURCE_COMMIT).toMatch(/^[a-f0-9]{40}$/);
  expect(TARGETS).toHaveLength(5);
  expect(selectedTargets([], 'darwin', 'arm64')[0]).toMatchObject({ os: 'mac', arch: 'arm64' });
  expect(selectedTargets(['--linux', '--x64'], 'darwin', 'arm64')[0]).toMatchObject({
    os: 'linux',
    arch: 'x64',
  });
  expect(runtimeTarget('win32', 'arm64')).toEqual({ os: 'win', arch: 'x64' });
  expect(() => selectedTargets(['--mac', '--linux'])).toThrow(/Conflicting/);
});

test('builds only clean pinned source with locked dependencies', async () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-ton-build-test-'));
  const calls = [];
  const run = (command, args, options) => {
    calls.push({ command, args, options });
    if (args.includes('rev-parse')) return PINNED_SOURCE_COMMIT;
    if (args.includes('status')) return '';
    if (command === 'go') fs.writeFileSync(args[args.indexOf('-o') + 1], 'built proxy');
    return '';
  };
  const dest = await installTarget(TARGETS[0], { outputDir, run });
  expect(fs.readFileSync(dest, 'utf8')).toBe('built proxy');
  expect(calls.find(({ args }) => args.includes('fetch')).args).toContain(PINNED_SOURCE_COMMIT);
  const build = calls.find(({ command }) => command === 'go');
  expect(build.args).toContain('-mod=readonly');
  expect(build.options.env).toMatchObject({ CGO_ENABLED: '0', GOOS: 'darwin', GOARCH: 'arm64' });
});

test('rejects different or locally modified source before building', async () => {
  for (const [commit, dirty] of [
    ['0'.repeat(40), ''],
    [PINNED_SOURCE_COMMIT, ' M proxy/proxy.go'],
  ]) {
    const run = jest.fn((_command, args) => (args.includes('rev-parse') ? commit : dirty));
    await expect(
      installTarget(TARGETS[0], { sourceDir: '/tmp/source', outputDir: os.tmpdir(), run })
    ).rejects.toThrow(/source/);
    expect(run.mock.calls.some(([command]) => command === 'go')).toBe(false);
  }
});

test.each(['dist:linux:arm64:docker', 'dist:linux:x64:docker'])(
  '%s installs Go before building TON',
  (name) => {
    const command = require('../package.json').scripts[name];
    expect(command).toMatch(/apt-get install[^&]* golang-go/);
    expect(command.indexOf('golang-go')).toBeLessThan(command.indexOf('npm run ton:download'));
  }
);
