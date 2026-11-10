/**
 * The per-origin Radicle permission store: the "always allow writes" rule
 * (autoApprove.signing, R-6) has to come off again, from the chrome, at any
 * time, and stay off across a restart.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

let mockUserData;
const mockIpcHandle = jest.fn();
jest.mock('electron', () => ({
  app: { getPath: jest.fn(() => mockUserData) },
  ipcMain: { handle: (...args) => mockIpcHandle(...args) },
}));

const permissions = require('./radicle-permissions');

const ORIGIN = 'https://forge.example';

beforeEach(() => {
  mockUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'radicle-permissions-'));
  permissions._resetCache();
  jest.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
  fs.rmSync(mockUserData, { recursive: true, force: true });
});

const ruleOn = () => permissions.getAutoApprove(ORIGIN, 'signing');

// A connected site with the signing grant and the rule on, the state the
// write prompt's "always allow" checkbox leaves behind.
const connectWithRule = () => {
  permissions.grantPermission(ORIGIN);
  permissions.grantSigning(ORIGIN);
  expect(permissions.setAutoApprove(ORIGIN, 'signing', true)).toBe(true);
  expect(ruleOn()).toBe(true);
};

describe('"always allow writes" rule', () => {
  test('a new connection starts with the rule off', () => {
    permissions.grantPermission(ORIGIN);
    expect(ruleOn()).toBe(false);
    expect(permissions.getPermission(ORIGIN).autoApprove).toEqual({ node: false, signing: false });
  });

  test('turning it off takes effect at once and keeps the connection and grant', () => {
    connectWithRule();
    expect(permissions.setAutoApprove(ORIGIN, 'signing', false)).toBe(true);
    expect(ruleOn()).toBe(false);
    expect(permissions.hasSigningGrant(ORIGIN)).toBe(true);
    expect(permissions.getPermission(ORIGIN)).not.toBeNull();
  });

  test('turning it off is saved to disk and survives a restart', () => {
    connectWithRule();
    // The rule was on on disk, so reading it back off proves the off was saved.
    permissions._resetCache();
    expect(ruleOn()).toBe(true);
    permissions.setAutoApprove(ORIGIN, 'signing', false);
    permissions._resetCache();
    expect(ruleOn()).toBe(false);
    const stored = JSON.parse(
      fs.readFileSync(path.join(mockUserData, 'radicle-permissions.json'), 'utf8')
    );
    expect(stored[ORIGIN].autoApprove.signing).toBe(false);
  });

  test('turning it off leaves the node rule alone', () => {
    connectWithRule();
    permissions.setAutoApprove(ORIGIN, 'node', true);
    permissions.setAutoApprove(ORIGIN, 'signing', false);
    expect(permissions.getAutoApprove(ORIGIN, 'node')).toBe(true);
  });

  test('only a literal true turns it on', () => {
    permissions.grantPermission(ORIGIN);
    for (const value of ['true', 1, {}, 'yes']) {
      permissions.setAutoApprove(ORIGIN, 'signing', value);
      expect(permissions.getPermission(ORIGIN).autoApprove.signing).toBe(false);
      expect(ruleOn()).toBe(false);
    }
  });

  test('an unknown origin or rule type is refused', () => {
    expect(permissions.setAutoApprove(ORIGIN, 'signing', false)).toBe(false);
    connectWithRule();
    expect(permissions.setAutoApprove(ORIGIN, 'everything', false)).toBe(false);
    expect(ruleOn()).toBe(true);
  });

  test('disconnecting removes the rule with the record', () => {
    connectWithRule();
    permissions.revokePermission(ORIGIN);
    expect(ruleOn()).toBe(false);
    permissions.grantPermission(ORIGIN);
    expect(ruleOn()).toBe(false);
  });

  test('the chrome IPC handler turns it off', () => {
    connectWithRule();
    permissions.registerRadiclePermissionsIpc();
    const handler = mockIpcHandle.mock.calls.find(
      ([channel]) => channel === 'radicle:set-auto-approve'
    )[1];
    expect(handler({}, ORIGIN, 'signing', false)).toBe(true);
    expect(ruleOn()).toBe(false);
  });
});
