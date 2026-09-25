const packageJson = require('../package.json');
const { DEFAULT_CHANNEL, publishOverrideArgs, updateManifestName } = require('./publish-channel');

describe('publish overrides', () => {
  test('the default channel is the one package.json pins for the stable feed', () => {
    expect(packageJson.build.publish.channel).toBe(DEFAULT_CHANNEL);
    expect(packageJson.build.publish.provider).toBe('generic');
  });

  describe('with no environment overrides', () => {
    const env = {};

    test.each([
      ['mac', ['arm64']],
      ['linux', ['x64']],
      ['linux', ['arm64']],
    ])('passes nothing on %s-%s, leaving package.json in charge', (platform, archs) => {
      expect(publishOverrideArgs({ platform, archs, env })).toEqual([]);
    });

    test.each([
      ['x64', '-c.publish.channel=latest-win-x64'],
      ['arm64', '-c.publish.channel=latest-win-arm64'],
    ])('keeps the Windows %s channel pin', (arch, expected) => {
      expect(publishOverrideArgs({ platform: 'win', archs: [arch], env })).toEqual([expected]);
    });

    test('defaults the Windows architecture to x64', () => {
      expect(publishOverrideArgs({ platform: 'win', archs: [], env })).toEqual([
        '-c.publish.channel=latest-win-x64',
      ]);
    });
  });

  describe('with a nightly channel and feed', () => {
    const env = {
      FREEDOM_UPDATE_CHANNEL: 'nightly',
      FREEDOM_UPDATE_URL:
        'https://github.com/solardev-xyz/freedom-browser/releases/download/nightly',
    };

    test.each([
      ['mac', ['arm64'], '-c.publish.channel=nightly'],
      ['linux', ['x64'], '-c.publish.channel=nightly'],
      ['linux', ['arm64'], '-c.publish.channel=nightly'],
      ['win', ['x64'], '-c.publish.channel=nightly-win-x64'],
    ])('redirects %s-%s off the stable channel', (platform, archs, expectedChannel) => {
      expect(publishOverrideArgs({ platform, archs, env })).toEqual([
        expectedChannel,
        `-c.publish.url=${env.FREEDOM_UPDATE_URL}`,
      ]);
    });
  });

  test('a channel without a URL keeps the package.json feed', () => {
    expect(
      publishOverrideArgs({
        platform: 'mac',
        archs: ['arm64'],
        env: { FREEDOM_UPDATE_CHANNEL: 'beta' },
      })
    ).toEqual(['-c.publish.channel=beta']);
  });

  test('a URL without a channel keeps the stable channel', () => {
    expect(
      publishOverrideArgs({
        platform: 'linux',
        archs: ['x64'],
        env: { FREEDOM_UPDATE_URL: 'https://example.test/downloads' },
      })
    ).toEqual(['-c.publish.url=https://example.test/downloads']);
  });
});

describe('update manifest names', () => {
  // The names electron-builder writes (app-builder-lib's
  // getUpdateInfoFileName: `${channel}${osSuffix}${archPrefix}.yml`, where the
  // os suffix is empty on Windows and the arch prefix only appears for
  // non-x64 Linux) and the ones electron-updater asks the feed for
  // (Provider.getCustomChannelName + getChannelFilePrefix). The release
  // workflow uploads these, so a drift here ships a nightly that cannot
  // update itself.
  test.each([
    ['mac', ['arm64'], undefined, 'latest-mac.yml'],
    ['linux', ['x64'], undefined, 'latest-linux.yml'],
    ['linux', ['arm64'], undefined, 'latest-linux-arm64.yml'],
    ['win', ['x64'], undefined, 'latest-win-x64.yml'],
    ['mac', ['arm64'], 'nightly', 'nightly-mac.yml'],
    ['linux', ['x64'], 'nightly', 'nightly-linux.yml'],
    ['linux', ['arm64'], 'nightly', 'nightly-linux-arm64.yml'],
    ['win', ['x64'], 'nightly', 'nightly-win-x64.yml'],
  ])('%s-%s on channel %s writes %s', (platform, archs, channel, expected) => {
    const env = channel ? { FREEDOM_UPDATE_CHANNEL: channel } : {};
    expect(updateManifestName({ platform, archs, env })).toBe(expected);
  });
});
