'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { checkoutId, locateProfile } = require('./profile-locator');

describe('Freedom CLI profile locator', () => {
  test('matches the browser checkout identity and development app root', () => {
    const repoRoot = path.resolve('/tmp/example-checkout');
    const expectedHash = crypto.createHash('sha256').update(repoRoot).digest('hex').slice(0, 8);
    expect(checkoutId(repoRoot)).toBe(`freedom-browser-${expectedHash}`);
    expect(
      locateProfile({
        repoRoot,
        platform: 'linux',
        env: { XDG_CONFIG_HOME: '/tmp/freedom-config' },
      })
    ).toMatchObject({
      id: 'automation',
      appRoot: path.join('/tmp/freedom-config', 'Freedom Dev', `freedom-browser-${expectedHash}`),
      source: 'derived',
    });
  });

  test('uses an existing catalog record without modifying the catalog', () => {
    const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-cli-catalog-'));
    const profileDir = path.join(appRoot, 'external-agent-profile');
    const catalogPath = path.join(appRoot, 'profile-registry.json');
    const catalog = { version: 1, profiles: [{ id: 'agent', dir: profileDir }] };
    fs.writeFileSync(catalogPath, JSON.stringify(catalog));
    const before = fs.readFileSync(catalogPath, 'utf8');

    expect(locateProfile({ appRoot, profile: 'agent', env: {} })).toMatchObject({
      id: 'agent',
      userDataDir: profileDir,
      source: 'catalog',
    });
    expect(fs.readFileSync(catalogPath, 'utf8')).toBe(before);
  });

  test('honors the test user-data contract used by the browser', () => {
    expect(locateProfile({ env: { FREEDOM_TEST_USER_DATA: '/tmp/freedom-cli-test' } })).toEqual({
      id: 'test',
      userDataDir: '/tmp/freedom-cli-test',
      appRoot: '/tmp/freedom-cli-test',
      source: 'test-user-data',
    });
  });
});
