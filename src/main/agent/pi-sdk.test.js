'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const rootPackage = require('../../../package.json');
const {
  PI_SDK_PACKAGE,
  PiSdkLoadError,
  createPiSdkLoader,
  validatePiSdk,
} = require('./pi-sdk');

const repositoryRoot = path.resolve(__dirname, '../../..');

const completeSdk = () => ({
  createAgentSession: jest.fn(),
  createBashTool: jest.fn(),
  createEditTool: jest.fn(),
  createExtensionRuntime: jest.fn(),
  createReadTool: jest.fn(),
  createWriteTool: jest.fn(),
  defineTool: jest.fn(),
  ModelRuntime: jest.fn(),
  SessionManager: jest.fn(),
  SettingsManager: jest.fn(),
});

describe('Pi SDK loader', () => {
  test('pins the reviewed ESM package and engine floor', () => {
    const packageMetadata = JSON.parse(
      fs.readFileSync(
        path.join(repositoryRoot, 'node_modules', PI_SDK_PACKAGE, 'package.json'),
        'utf8'
      )
    );
    expect(rootPackage.dependencies[PI_SDK_PACKAGE]).toBe('0.84.2');
    expect(packageMetadata).toMatchObject({
      name: PI_SDK_PACKAGE,
      version: '0.84.2',
      type: 'module',
      license: 'MIT',
      engines: { node: '>=22.19.0' },
    });
  });

  test('loads lazily and shares one in-flight import', async () => {
    const sdk = completeSdk();
    const importModule = jest.fn().mockResolvedValue(sdk);
    const loader = createPiSdkLoader({ importModule });

    expect(importModule).not.toHaveBeenCalled();
    const first = loader();
    const second = loader();

    await expect(first).resolves.toBe(sdk);
    await expect(second).resolves.toBe(sdk);
    expect(importModule).toHaveBeenCalledTimes(1);
  });

  test('allows a failed import to be retried', async () => {
    const cause = new Error('module load failed');
    const sdk = completeSdk();
    const importModule = jest.fn().mockRejectedValueOnce(cause).mockResolvedValueOnce(sdk);
    const loader = createPiSdkLoader({ importModule });

    await expect(loader()).rejects.toMatchObject({
      name: 'PiSdkLoadError',
      code: 'PI_SDK_UNAVAILABLE',
      cause,
    });
    await expect(loader()).resolves.toBe(sdk);
    expect(importModule).toHaveBeenCalledTimes(2);
  });

  test('rejects an incompatible module namespace', () => {
    expect(() => validatePiSdk({ createAgentSession: () => {} })).toThrow(
      new PiSdkLoadError(
        'Pi SDK is missing required exports: createBashTool, createEditTool, createExtensionRuntime, createReadTool, createWriteTool, defineTool, ModelRuntime, SessionManager, SettingsManager'
      )
    );
  });

  test('imports the installed Pi SDK through the CommonJS boundary', () => {
    const output = execFileSync(
      process.execPath,
      [
        '-e',
        'require("./src/main/agent/pi-sdk").loadPiSdk().then((sdk) => process.stdout.write([typeof sdk.createAgentSession, typeof sdk.createBashTool, typeof sdk.createReadTool, typeof sdk.createWriteTool, typeof sdk.createEditTool, typeof sdk.defineTool, typeof sdk.ModelRuntime].join(",")))',
      ],
      { cwd: repositoryRoot, encoding: 'utf8' }
    );

    expect(output).toBe('function,function,function,function,function,function,function');
  });
});
