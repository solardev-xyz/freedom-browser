#!/usr/bin/env node

/**
 * Resolves the electron-builder `publish` overrides a build should run with.
 *
 * `build.publish` in package.json points every build at the stable feed
 * (`https://freedom.baby/downloads`, channel `latest`). Nightly builds must
 * never write to that channel — a tester's nightly has to update from the
 * nightly feed and a stable user must never be offered one — so the release
 * workflow sets:
 *
 *   FREEDOM_UPDATE_CHANNEL=nightly
 *   FREEDOM_UPDATE_URL=https://github.com/<owner>/<repo>/releases/download/nightly
 *
 * and this module turns them into `-c.publish.channel` / `-c.publish.url`
 * command-line overrides. Unset, it reproduces exactly what the stable
 * pipeline passed before: nothing on macOS and Linux (package.json already
 * says `latest`) and `latest-win-<arch>` on Windows.
 *
 * Windows keeps the `-win-<arch>` suffix on the channel itself because
 * electron-updater derives no platform suffix there: `Provider.
 * getChannelFilePrefix()` returns `-mac` on darwin and `-linux[-arch]` on
 * linux but an empty string on win32, so the architecture has to be part of
 * the channel name for the two Windows manifests not to collide. The
 * manifests electron-builder then writes are `<channel>-mac.yml`,
 * `<channel>-linux.yml` / `<channel>-linux-arm64.yml` and
 * `<channel>-win-<arch>.yml` — the exact files electron-updater asks for.
 */

const DEFAULT_CHANNEL = 'latest';

/**
 * @param {object} options
 * @param {'mac'|'linux'|'win'} options.platform target platform
 * @param {string[]} options.archs target architectures, first one wins on Windows
 * @param {NodeJS.ProcessEnv} [options.env] environment to read the overrides from
 * @returns {string[]} electron-builder arguments, possibly empty
 */
function publishOverrideArgs({ platform, archs = [], env = process.env }) {
  const channel = env.FREEDOM_UPDATE_CHANNEL || DEFAULT_CHANNEL;
  const url = env.FREEDOM_UPDATE_URL;
  const args = [];

  if (platform === 'win') {
    args.push(`-c.publish.channel=${channel}-win-${archs[0] || 'x64'}`);
  } else if (channel !== DEFAULT_CHANNEL) {
    args.push(`-c.publish.channel=${channel}`);
  }

  if (url) {
    args.push(`-c.publish.url=${url}`);
  }

  return args;
}

/**
 * The update manifest a build with these overrides writes into `dist/`, so a
 * caller can assert the file exists before uploading it.
 *
 * @param {object} options
 * @param {'mac'|'linux'|'win'} options.platform target platform
 * @param {string[]} options.archs target architectures, first one wins
 * @param {NodeJS.ProcessEnv} [options.env] environment to read the overrides from
 * @returns {string} manifest file name
 */
function updateManifestName({ platform, archs = [], env = process.env }) {
  const channel = env.FREEDOM_UPDATE_CHANNEL || DEFAULT_CHANNEL;
  const arch = archs[0] || (platform === 'linux' ? 'x64' : platform === 'mac' ? 'arm64' : 'x64');

  if (platform === 'win') return `${channel}-win-${arch}.yml`;
  if (platform === 'mac') return `${channel}-mac.yml`;
  return arch === 'x64' ? `${channel}-linux.yml` : `${channel}-linux-${arch}.yml`;
}

module.exports = { DEFAULT_CHANNEL, publishOverrideArgs, updateManifestName };
