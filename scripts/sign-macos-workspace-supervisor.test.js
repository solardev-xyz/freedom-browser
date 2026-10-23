'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { createSupervisorSigner } = require('./sign-macos-workspace-supervisor');

describe('workspace supervisor nested signing', () => {
  let root;
  let app;
  let helper;
  let manifestPath;
  beforeEach(async () => {
    root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'freedom-sign-unit-'));
    app = path.join(root, 'Freedom.app');
    const directory = path.join(app, 'Contents/Resources/workspace-supervisor');
    await fs.promises.mkdir(directory, { recursive: true });
    helper = path.join(directory, 'freedom-workspace-supervisor');
    manifestPath = path.join(directory, 'manifest.json');
    await fs.promises.writeFile(helper, 'unsigned fixture');
    await fs.promises.writeFile(manifestPath, JSON.stringify({ protocol: 1, sourceSha256: 'source' }));
  });
  afterEach(async () => { await fs.promises.rm(root, { recursive: true, force: true }); });

  const details = 'CodeDirectory v=20400 flags=0x10000(runtime)\nTeamIdentifier=EXAMPLETEAM\n';
  function mockCodesign(overrides = {}) {
    return jest.fn(async (_binary, args) => {
      if (args[0] === '--force') await fs.promises.writeFile(helper, 'signed fixture');
      if (args.includes('--entitlements') && args[0] === '--display') {
        return { stdout: overrides.entitlements ?? '<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "https://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict></dict></plist>', stderr: '' };
      }
      return { stdout: '', stderr: args.at(-1) === app ? overrides.appDetails ?? details : overrides.details ?? details };
    });
  }

  test('signs the leaf with empty entitlements and updates its hash before sealing the app', async () => {
    const run = mockCodesign();
    const originalOptions = jest.fn(() => ({ entitlements: 'browser.plist' }));
    const sign = jest.fn(async (options) => {
      expect(run).toHaveBeenCalledTimes(4);
      expect(options.ignore(helper)).toBe(true);
      expect(options.ignore('/existing/ignored')).toBe(true);
      expect(options.ignore(app)).toBe(false);
      expect(options.optionsForFile).toBe(originalOptions);
      const manifest = JSON.parse(await fs.promises.readFile(manifestPath, 'utf8'));
      expect(manifest).toEqual({ protocol: 1, sourceSha256: 'source',
        binarySha256: crypto.createHash('sha256').update('signed fixture').digest('hex') });
    });
    await createSupervisorSigner({ run, sign })({ app, identity: 'exact-identity', keychain: '/keychain',
      optionsForFile: originalOptions, strictVerify: true, ignore: (file) => file === '/existing/ignored' });
    const [binary, args] = run.mock.calls[0];
    expect(binary).toBe('/usr/bin/codesign');
    expect(args).toEqual(['--force', '--sign', 'exact-identity', '--options', 'runtime', '--entitlements',
      path.join(__dirname, '../config/entitlements.workspace-supervisor.mac.plist'),
      '--keychain', '/keychain', '--timestamp', helper]);
    expect(await fs.promises.readFile(args[6], 'utf8')).toContain('<dict/>');
    expect(sign.mock.calls[0][0].strictVerify).toBe(true);
    expect(run.mock.calls.filter(([, args]) => args[0] === '--verify')).toHaveLength(2);
  });

  test('a changed leaf after app signing fails the build', async () => {
    await expect(createSupervisorSigner({ run: mockCodesign(), sign: async () => {
      await fs.promises.writeFile(helper, 'unexpected rewrite');
    } })({ app, identity: 'identity' })).rejects.toThrow('changed the supervisor');
  });

  test('preserves explicit timestamp disabling for the leaf', async () => {
    const run = mockCodesign();
    await createSupervisorSigner({ run, sign: async () => {} })({ app, identity: 'identity',
      optionsForFile: () => ({ timestamp: false }) });
    expect(run.mock.calls[0][1]).toContain('--timestamp=none');
  });

  test('accepts a verified signature with no entitlement data', async () => {
    const sign = jest.fn();
    await createSupervisorSigner({ run: mockCodesign({ entitlements: '' }), sign })({ app, identity: 'identity' });
    expect(sign).toHaveBeenCalledTimes(1);
  });

  test.each([
    [{ entitlements: '<plist version="1.0"><dict><key>com.apple.security.cs.allow-jit</key><true/></dict></plist>' }, 'empty entitlements'],
    [{ details: details.replace('(runtime)', '(adhoc)') }, 'hardened runtime'],
    [{ details: details.replace('EXAMPLETEAM', 'not set') }, 'no signing team'],
  ])('rejects unexpected leaf signing privileges or identity: %s', async (overrides, message) => {
    const sign = jest.fn();
    await expect(createSupervisorSigner({ run: mockCodesign(overrides), sign })({ app, identity: 'identity' }))
      .rejects.toThrow(message);
    expect(sign).not.toHaveBeenCalled();
  });

  test('rejects a different enclosing-app signing team', async () => {
    await expect(createSupervisorSigner({ run: mockCodesign({ appDetails: details.replace('EXAMPLETEAM', 'OTHERTEAM') }),
      sign: async () => {} })({ app, identity: 'identity' })).rejects.toThrow('signing teams differ');
  });

  test('leaf signing failure never proceeds to enclosing-app signing', async () => {
    const sign = jest.fn();
    await expect(createSupervisorSigner({ run: async () => { throw new Error('sign failed'); }, sign })({
      app, identity: 'identity',
    })).rejects.toThrow('sign failed');
    expect(sign).not.toHaveBeenCalled();
  });
});
