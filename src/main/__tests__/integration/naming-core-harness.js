/**
 * A real freedom-cored with naming attached, for the live name-resolution
 * batteries: the resolvers' lookups go to it as they do in the app. The
 * binary is FREEDOM_CORED_PATH, else the one `npm run core:download`
 * fetched.
 *
 * Jest has no Electron session, so a battery routes the core's HTTP
 * exchanges through Node's fetch before requiring anything that loads
 * naming:
 *
 *   jest.mock('../../ipfs/gateway-transport', () => ({
 *     ...jest.requireActual('../../ipfs/gateway-transport'),
 *     netGatewayFetch: (url, init) => globalThis.fetch(url, init),
 *   }));
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { CoreClient } = require('../../core/core-client');
const { attachNaming, detachNaming } = require('../../core/naming');

function coredBinary() {
  if (process.env.FREEDOM_CORED_PATH) return process.env.FREEDOM_CORED_PATH;
  const platform = { darwin: 'mac', linux: 'linux', win32: 'win' }[process.platform];
  const name = process.platform === 'win32' ? 'freedom-cored.exe' : 'freedom-cored';
  return path.join(
    __dirname,
    '..',
    '..',
    '..',
    '..',
    'freedom-cored-bin',
    `${platform || process.platform}-${process.arch}`,
    name
  );
}

/** Starts the core, naming attached, and waits until naming is usable. */
async function startNamingCore() {
  const command = coredBinary();
  if (!fs.existsSync(command)) {
    throw new Error(`no freedom-cored at ${command}: set FREEDOM_CORED_PATH`);
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-naming-live-'));
  const quiet = { info() {}, warn() {}, error() {}, debug() {} };
  const client = new CoreClient({
    spawn,
    command,
    args: [
      'serve',
      '--data-dir',
      path.join(root, 'identity'),
      '--lock-dir',
      path.join(root, 'locks'),
      '--parent-pid',
      String(process.pid),
    ],
    log: quiet,
    shellVersion: 'jest',
  });
  const { config } = attachNaming(client);
  await client.start();
  if (!(await config.whenReady())) throw new Error('the naming core did not initialize');
  return {
    async stop() {
      detachNaming();
      await client.stop();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

module.exports = { startNamingCore };
