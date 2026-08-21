const fs = require('fs');
const os = require('os');
const path = require('path');

jest.mock('electron', () => ({
  app: { getPath: jest.fn() },
  ipcMain: { handle: jest.fn() },
}));

jest.mock('electron-log', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

jest.mock('../identity-manager', () => ({
  getDerivedKeys: jest.fn(() => ({
    beeWallet: { address: '0xbee', privateKey: '0xkey' },
  })),
  getPublisherKey: jest.fn(async (index) => ({
    address: `0xpublisher${index}`,
    privateKey: `0xpublisherkey${index}`,
  })),
  getDerivedWallets: jest.fn(async () => []),
}));

jest.mock('./bzz-protocol', () => ({ handleBzzRequest: jest.fn() }));

const { app } = require('electron');
const permissions = require('./swarm-permissions');
const feeds = require('./feed-store');
const manifests = require('./permission-manifests');

const ORIGIN = 'recovery.eth';
const ALL_CAPABILITIES = {
  publish: { why: 'Publish content' },
  feeds: { why: 'Update feeds' },
  signing: { why: 'Sign updates' },
  messaging: { why: 'Exchange messages' },
};

let tempDir;

function responseForManifest() {
  return new Response(JSON.stringify({
    schema: 'freedom-manifest/1',
    name: 'Recovery app',
    capabilities: { swarm: ALL_CAPABILITIES },
  }));
}

async function createConsent() {
  return manifests.checkManifest({
    origin: ORIGIN,
    committedUrl: `bzz://${ORIGIN}/`,
    eager: true,
  }, { fetchManifest: async () => responseForManifest() });
}

function simulateRestart() {
  manifests._resetForTests();
  permissions._resetCache();
  feeds._resetCache();
}

function expectFullyRecovered() {
  const record = manifests.getRecord(ORIGIN);
  const permission = permissions.getPermission(ORIGIN);
  expect(record.acknowledged).toMatchObject({
    publish: { decision: 'managed' },
    feeds: { decision: 'managed' },
    signing: { decision: 'managed' },
    messaging: { decision: 'managed' },
  });
  expect(permission.autoApprove).toEqual({
    publish: true,
    feeds: true,
    signing: true,
    messaging: true,
  });
  expect(permissions.hasMessagingGrant(ORIGIN)).toBe(true);
  expect(feeds.hasIdentityMode(ORIGIN)).toBe(true);
  expect(feeds.hasFeedGrant(ORIGIN)).toBe(true);
  expect(record.managed.feedGrant).toEqual(['feeds', 'signing']);
}

function failRename(fileName, occurrence) {
  const destination = path.join(tempDir, fileName);
  const originalRename = fs.renameSync.bind(fs);
  let seen = 0;
  return jest.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
    if (to === destination) {
      seen += 1;
      if (seen === occurrence) throw new Error(`injected ${fileName} write failure ${occurrence}`);
    }
    return originalRename(from, to);
  });
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manifest-recovery-'));
  app.getPath.mockReturnValue(tempDir);
  simulateRestart();
  permissions.onRevoke(null);
});

afterEach(() => {
  jest.restoreAllMocks();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('permission manifest durable recovery with real stores', () => {
  test('retries safely when the write-ahead journal itself cannot be persisted', async () => {
    const consent = await createConsent();
    const rename = failRename('swarm-manifest-grants.json', 1);

    expect(() => manifests.decideManifest(consent.token, 'allow')).toThrow('injected');
    rename.mockRestore();
    expect(manifests.decideManifest(consent.token, 'allow')).toEqual({ allowed: true, mode: 'allow' });
    expectFullyRecovered();
  });

  test.each([1, 2, 3, 4, 5, 6])(
    'recovers after permission-store atomic write %i fails',
    async (occurrence) => {
      const consent = await createConsent();
      const rename = failRename('swarm-permissions.json', occurrence);

      expect(() => manifests.decideManifest(consent.token, 'allow')).toThrow('injected');
      rename.mockRestore();
      simulateRestart();
      expectFullyRecovered();
    }
  );

  test.each([1, 2])('recovers after feed-store atomic write %i fails', async (occurrence) => {
    const consent = await createConsent();
    const rename = failRename('swarm-feeds.json', occurrence);

    expect(() => manifests.decideManifest(consent.token, 'allow')).toThrow('injected');
    rename.mockRestore();
    simulateRestart();
    expectFullyRecovered();
  });

  test('recovers when the final manifest commit cannot replace the journal', async () => {
    const consent = await createConsent();
    const rename = failRename('swarm-manifest-grants.json', 2);

    expect(() => manifests.decideManifest(consent.token, 'allow')).toThrow('injected');
    rename.mockRestore();
    simulateRestart();
    expectFullyRecovered();
  });

  test('replays the connection grant an individual decision makes', async () => {
    const consent = await createConsent();
    // The `individual` outcome connects the origin without managing
    // anything. That grant is part of the decision, so it has to be journaled
    // with it: a stop right after the journal must still leave the origin
    // connected once recovery replays, and must not have connected it before
    // the journal existed (that is the state nothing can replay or undo).
    manifests._setFaultInjectorForTests((point) => {
      if (point === 'after-journal') throw new Error('simulated crash at after-journal');
    });

    expect(() => manifests.decideManifest(consent.token, 'individual')).toThrow('simulated crash');
    expect(permissions.getPermission(ORIGIN)).toBeNull();

    manifests._setFaultInjectorForTests(null);
    simulateRestart();

    const record = manifests.getRecord(ORIGIN);
    expect(permissions.getPermission(ORIGIN)).not.toBeNull();
    expect(record.acknowledged).toMatchObject({
      publish: { decision: 'individual' },
      feeds: { decision: 'individual' },
      signing: { decision: 'individual' },
      messaging: { decision: 'individual' },
    });
    expect(record.detached.connection).toBe(true);
    expect(record.managed.connection).toBeUndefined();
  });

  test.each([
    'after-journal',
    'after-operation:0:connection',
    'after-operation:1:autoApprove.publish',
    'after-operation:2:identity',
    'after-operation:3:feedGrant',
    'after-operation:4:autoApprove.feeds',
    'after-operation:5:autoApprove.signing',
    'after-operation:6:messagingGrant',
    'after-operation:7:autoApprove.messaging',
    'before-commit',
  ])('recovers after a simulated process stop at %s', async (boundary) => {
    const consent = await createConsent();
    manifests._setFaultInjectorForTests((point) => {
      if (point === boundary) throw new Error(`simulated crash at ${point}`);
    });

    expect(() => manifests.decideManifest(consent.token, 'allow')).toThrow('simulated crash');
    simulateRestart();
    expectFullyRecovered();
  });
});
