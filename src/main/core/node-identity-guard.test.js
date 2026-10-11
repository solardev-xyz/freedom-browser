const guard = require('./node-identity-guard');

describe('node identity guard', () => {
  test('startup recovery blocks the reported node until a write installs it', () => {
    expect(guard.nodeBlockReason('bee')).toBeNull();
    guard.setStartupRecovery({ status: 'pending_recovery', op_id: 'op-1', node: 'bee' });
    expect(guard.nodeBlockReason('bee')).toMatch(/restart Freedom/);
    expect(guard.nodeBlockReason('radicle')).toBeNull();
    guard.unblockNode('bee');
    expect(guard.nodeBlockReason('bee')).toBeNull();
  });

  test('corrupt writes ask for a fresh setup; reports without a node block every node', () => {
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
});
