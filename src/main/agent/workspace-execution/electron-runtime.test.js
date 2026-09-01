'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  ELECTRON_RUNTIME_PROBE_MARKER,
  detectElectronJavaScriptRuntime,
  findApplicationBundle,
} = require('./electron-runtime');

describe('Electron JavaScript runtime discovery', () => {
  const roots = [];

  afterEach(async () => {
    await Promise.all(
      roots.splice(0).map((root) => fs.promises.rm(root, { recursive: true, force: true }))
    );
  });

  async function fixture() {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'freedom-electron-runtime-'));
    roots.push(root);
    const bundle = path.join(root, 'Freedom.app');
    const executableDirectory = path.join(bundle, 'Contents', 'MacOS');
    const executable = path.join(executableDirectory, 'Freedom');
    await fs.promises.mkdir(executableDirectory, { recursive: true });
    await fs.promises.writeFile(executable, 'fixture', { mode: 0o700 });
    return {
      bundle: await fs.promises.realpath(bundle),
      executable: await fs.promises.realpath(executable),
    };
  }

  test('finds only the application bundle containing the active executable', () => {
    expect(findApplicationBundle('/Applications/Freedom.app/Contents/MacOS/Freedom')).toBe(
      '/Applications/Freedom.app'
    );
    expect(findApplicationBundle('/usr/local/bin/electron')).toBeNull();
  });

  test('requires the Electron main process and fails closed when run-as-node is unavailable', async () => {
    await expect(
      detectElectronJavaScriptRuntime({ platform: 'darwin', versions: { node: '24.0.0' } })
    ).resolves.toMatchObject({
      available: false,
      denial: { code: 'ELECTRON_MAIN_PROCESS_REQUIRED' },
    });

    const { executable } = await fixture();
    await expect(
      detectElectronJavaScriptRuntime({
        platform: 'darwin',
        versions: { electron: '43.0.0', node: '24.17.0' },
        execPath: executable,
        run: async () => ({ exitCode: 1, signal: null, stdout: '', stderr: 'disabled' }),
      })
    ).resolves.toMatchObject({
      available: false,
      denial: { code: 'ELECTRON_NODE_RUNTIME_UNAVAILABLE' },
      diagnostics: { probeDiagnostic: 'disabled' },
    });
  });

  test('returns the exact bundle and executable after a successful helper probe', async () => {
    const { bundle, executable } = await fixture();
    const runtime = await detectElectronJavaScriptRuntime({
      platform: 'darwin',
      versions: { electron: '43.0.0', node: '24.17.0' },
      execPath: executable,
      freedomVersion: '0.8.1-dev',
      packaged: false,
      run: async (_binary, _args, options) => {
        expect(options.env).toEqual({
          ELECTRON_RUN_AS_NODE: '1',
          HOME: os.tmpdir(),
          PATH: '/usr/bin:/bin',
        });
        return {
          exitCode: 0,
          signal: null,
          stdout: JSON.stringify({
            marker: ELECTRON_RUNTIME_PROBE_MARKER,
            electron: '43.0.0',
            node: '24.17.0',
          }),
          stderr: '',
        };
      },
    });

    expect(runtime).toMatchObject({
      available: true,
      kind: 'electron-run-as-node',
      executablePath: executable,
      applicationBundleRoot: bundle,
      invocationEnvironment: { ELECTRON_RUN_AS_NODE: '1' },
      diagnostics: {
        electronVersion: '43.0.0',
        helperNodeVersion: '24.17.0',
        freedomVersion: '0.8.1-dev',
        packaged: false,
      },
    });
  });
});
