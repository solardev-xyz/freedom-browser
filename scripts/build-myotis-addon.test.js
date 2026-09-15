const fs = require('fs');
const path = require('path');
const { source, sha256, selectedTarget, validateManifest } = require('./build-myotis-addon');

function manifest(bytes = Buffer.from('compiled-addon')) {
  return { ...source, runtime: 'darwin-arm64', profile: 'release', addonSha256: sha256(bytes) };
}

describe('Myotis checkpoint addon provenance', () => {
  test('the reviewed native patch is pinned independently from its source archive', () => {
    const patch = fs.readFileSync(path.join(__dirname, 'myotis-native/checkpoint-import-v1.patch'));
    expect(sha256(patch)).toBe(source.patchSha256);
    expect(source.sourceSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  test('accepts a release build only for the recorded target and bytes', () => {
    const bytes = Buffer.from('compiled-addon');
    expect(validateManifest(manifest(bytes), bytes, 'mac-arm64')).toBeNull();
    expect(validateManifest(manifest(bytes), Buffer.from('replaced-addon'), 'mac-arm64')).toBe(
      'checkpoint-addon checksum mismatch'
    );
    expect(validateManifest(manifest(bytes), bytes, 'mac-x64')).toContain('incompatible');
  });

  test.each([
    { extensionVersion: 0 },
    { abi: 24 },
    { sourceCommit: 'other' },
    { patchSha256: 'other' },
    { sourceSha256: 'other' },
    { profile: 'dev' },
    { rustToolchain: 'stable' },
    { runtime: 'win32-arm64' },
  ])('rejects stale or unsupported build provenance: %j', (override) => {
    expect(
      validateManifest({ ...manifest(), ...override }, Buffer.from('compiled-addon'), 'mac-arm64')
    ).toContain('incompatible');
  });

  test('missing provenance does not authorize a vanilla upstream addon', () => {
    expect(validateManifest(null, Buffer.from('upstream-addon'), 'mac-arm64')).toContain('missing');
  });

  test('never silently substitutes a host build for another requested architecture', () => {
    expect(selectedTarget('', 'darwin', 'arm64').dir).toBe('mac-arm64');
    expect(() => selectedTarget('linux-x64', 'darwin', 'arm64')).toThrow(
      'Build the Myotis checkpoint addon on its linux-x64 host'
    );
    expect(() => selectedTarget('', 'win32', 'arm64')).toThrow('Unsupported Myotis target');
  });
});
