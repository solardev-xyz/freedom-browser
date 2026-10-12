const fs = require('fs');
const os = require('os');
const path = require('path');
const guard = require('./node-identity-guard');

let dir;

beforeEach(() => {
  guard._internal.reset();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'node-identity-guard-'));
  guard.setIdentityDir(dir);
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('node identity guard', () => {
  test('startup recovery blocks the reported node until a write installs it', () => {
    guard.setStartupRecovery(null);
    expect(guard.nodeBlockReason('bee')).toBeNull();
    guard.setStartupRecovery({ status: 'pending_recovery', op_id: 'op-1', node: 'bee' });
    expect(guard.nodeBlockReason('bee')).toMatch(/restart Freedom/);
    expect(guard.nodeBlockReason('radicle')).toBeNull();
    guard.unblockNode('bee');
    expect(guard.nodeBlockReason('bee')).toBeNull();
  });

  test('corrupt writes ask for a fresh setup; reports without a node block every node', () => {
    guard.setStartupRecovery(null);
    guard.blockNode('radicle', 'corrupt');
    expect(guard.nodeBlockReason('radicle')).toMatch(/set up node identities again/);
    guard.unblockNode('radicle');
    // Without a node, the report covers every node.
    guard.setStartupRecovery({ status: 'corrupt' });
    expect(guard.nodeBlockReason('bee')).not.toBeNull();
    expect(guard.nodeBlockReason('radicle')).not.toBeNull();
    // The next start's report replaces it.
    guard.setStartupRecovery(null);
    expect(guard.nodeBlockReason('bee')).toBeNull();
    expect(guard.nodeBlockReason('radicle')).toBeNull();
  });

  test("main's own write blocks survive a core report; only installed lifts them", () => {
    guard.setStartupRecovery(null);
    guard.blockNode('bee', 'writing');
    expect(guard.nodeBlockReason('bee')).toMatch(/being updated/);
    // The outcome is unknown; the core restarts and reports nothing pending
    // (the write never committed, but Bee was already wiped).
    guard.blockNode('bee', 'pending_recovery');
    guard.setRecoveryUnknown();
    guard.setStartupRecovery(null);
    expect(guard.nodeBlockReason('bee')).toMatch(/did not finish/);
    guard.unblockNode('bee');
    expect(guard.nodeBlockReason('bee')).toBeNull();
  });

  test('before any report, nodes wait unless there is nothing to protect', () => {
    // A profile that never set up an identity: nothing to protect.
    expect(guard.nodeBlockReason('bee')).toBeNull();
    for (const name of ['identity-vault.json', 'node-identity-journal.json']) {
      fs.writeFileSync(path.join(dir, name), '{}');
      expect(guard.nodeBlockReason('bee')).toMatch(/identity core is not available/);
      expect(guard.nodeBlockReason('radicle')).toMatch(/identity core is not available/);
      fs.rmSync(path.join(dir, name));
    }
    fs.writeFileSync(path.join(dir, 'identity-vault.json'), '{}');
    guard.setStartupRecovery(null);
    expect(guard.nodeBlockReason('bee')).toBeNull();
    // The core exited: unknown again until its next report.
    guard.setRecoveryUnknown();
    expect(guard.nodeBlockReason('bee')).not.toBeNull();
    guard.setStartupRecovery(null);
    expect(guard.nodeBlockReason('bee')).toBeNull();
  });

  test('an unreadable identity directory is not "nothing to protect"', () => {
    const spy = jest.spyOn(fs, 'lstatSync').mockImplementation(() => {
      throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
    });
    try {
      expect(guard.nodeBlockReason('bee')).toMatch(/identity core is not available/);
    } finally {
      spy.mockRestore();
    }
  });

  test('without an identity directory, unknown means blocked', () => {
    guard._internal.reset();
    expect(guard.nodeBlockReason('bee')).not.toBeNull();
  });
});
