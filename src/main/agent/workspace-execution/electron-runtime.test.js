'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  ELECTRON_RUNTIME_PROBE_MARKER,
  detectElectronJavaScriptRuntime,
  findApplicationBundle,
  isValidatedElectronJavaScriptRuntime,
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

  async function linuxFixture() {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'freedom-electron-linux-'));
    roots.push(root);
    const runtimeRoot = path.join(root, 'linux-unpacked');
    const resourcesPath = path.join(runtimeRoot, 'resources');
    const executable = path.join(runtimeRoot, 'freedom');
    await fs.promises.mkdir(resourcesPath, { recursive: true });
    await fs.promises.writeFile(path.join(resourcesPath, 'app.asar'), 'fixture');
    await fs.promises.writeFile(executable, 'fixture', { mode: 0o700 });
    return {
      runtimeRoot: await fs.promises.realpath(runtimeRoot),
      resourcesPath: await fs.promises.realpath(resourcesPath),
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
    expect(isValidatedElectronJavaScriptRuntime(runtime)).toBe(true);
    expect(isValidatedElectronJavaScriptRuntime({ ...runtime })).toBe(false);
  });

  test('derives one packaged Linux runtime and an explicit sandbox executable', async () => {
    const fixture = await linuxFixture();
    const forgedAppDir = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), '.mount_Freedom-forged-')
    );
    roots.push(forgedAppDir);
    const forgedAppImage = path.join(forgedAppDir, 'Freedom.AppImage');
    await fs.promises.writeFile(forgedAppImage, 'forged');
    const runtime = await detectElectronJavaScriptRuntime({
      platform: 'linux',
      versions: { electron: '43.0.0', node: '24.17.0', chrome: '142.0.0' },
      execPath: fixture.executable,
      resourcesPath: fixture.resourcesPath,
      freedomVersion: '0.8.1-dev',
      packaged: true,
      environment: { APPDIR: forgedAppDir, APPIMAGE: forgedAppImage },
      run: async (binary) => {
        expect(binary).toBe(fixture.executable);
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
      platform: 'linux',
      layout: 'linux-packaged-directory',
      packaged: true,
      executablePath: fixture.executable,
      runtimeRoot: fixture.runtimeRoot,
      resourcesPath: fixture.resourcesPath,
      relativeExecutablePath: 'freedom',
      sandboxExecutablePath: '/opt/freedom-toolchain/electron/freedom',
      diagnostics: {
        resourcesPath: fixture.resourcesPath,
        appImage: {
          appDirEnvironmentPresent: true,
          appDirMatchesRuntimeRoot: false,
          appImagePath: await fs.promises.realpath(forgedAppImage),
        },
      },
    });
  });

  test('fails closed for Linux resources outside the active executable tree', async () => {
    const fixture = await linuxFixture();
    const other = await linuxFixture();
    await expect(
      detectElectronJavaScriptRuntime({
        platform: 'linux',
        versions: { electron: '43.0.0', node: '24.17.0' },
        execPath: fixture.executable,
        resourcesPath: other.resourcesPath,
        packaged: true,
      })
    ).resolves.toMatchObject({
      available: false,
      denial: { code: 'ELECTRON_BUNDLE_UNAVAILABLE' },
    });
  });
});
