'use strict';

const { createPlatformAdapter } = require('./platform-adapter');

describe('workspace qualification platform adapters', () => {
  test('preserves the Linux Bubblewrap receipt, signal, runtime, and network contract', () => {
    const adapter = createPlatformAdapter('linux');
    const receipt = {
      state: 'cancelled',
      backend: 'linux-bubblewrap',
      signal: 'SIGKILL',
      terminationGuarantee: 'namespace_scoped',
      terminationScope: 'pid_namespace',
      sideEffects: 'unknown',
      survivorsPossible: false,
      completeDescendantTermination: true,
    };

    expect(adapter).toMatchObject({
      platform: 'linux',
      sandboxName: 'Bubblewrap',
      backend: 'linux-bubblewrap',
      terminationGuarantee: 'namespace_scoped',
      terminationScope: 'pid_namespace',
      survivorsPossible: false,
      completeDescendantTermination: true,
      fullNetworkIncludesHostAbstractUnixSockets: true,
    });
    expect(adapter.receiptMatches(receipt, 'cancelled')).toBe(true);
    expect(adapter.receiptMatches({ ...receipt, backend: 'macos-seatbelt' }, 'cancelled')).toBe(
      false
    );
    expect(adapter.receiptMatches({ ...receipt, survivorsPossible: undefined }, 'cancelled')).toBe(
      false
    );
    expect(
      adapter.receiptMatches({ ...receipt, completeDescendantTermination: undefined }, 'cancelled')
    ).toBe(false);
    expect(adapter.receiptMatches({ ...receipt, survivorsPossible: true }, 'cancelled')).toBe(
      false
    );
    expect(
      adapter.receiptMatches({ ...receipt, completeDescendantTermination: false }, 'cancelled')
    ).toBe(false);
    expect(
      adapter.ledgerReceiptMatches(
        { ...receipt, survivorsPossible: undefined, completeDescendantTermination: undefined },
        'cancelled'
      )
    ).toBe(true);
    expect(adapter.signalMatches('SIGKILL')).toBe(true);
    expect(adapter.signalMatches('SIGTERM')).toBe(false);
    expect(adapter.approvedRuntimeMatches('/opt/freedom-toolchain/approved/node/bin/node')).toBe(
      true
    );
    expect(adapter.approvedRuntimeMatches('/usr/bin/node')).toBe(false);
    expect(adapter.runtimeWriteDenied('EROFS')).toBe(true);
    expect(adapter.runtimeWriteDenied('EPERM')).toBe(false);
    expect(adapter.offlineNetworkErrorMatches('net:ConnectionRefusedError')).toBe(true);
  });

  test('models macOS Seatbelt receipts as best-effort original-group cleanup', () => {
    const adapter = createPlatformAdapter('darwin');
    const receipt = {
      state: 'timed_out',
      backend: 'macos-seatbelt',
      signal: 'SIGTERM',
      terminationGuarantee: 'best_effort',
      terminationScope: 'original_process_group',
      sideEffects: 'unknown',
      survivorsPossible: true,
      completeDescendantTermination: false,
    };

    expect(adapter).toMatchObject({
      platform: 'darwin',
      sandboxName: 'Seatbelt',
      backend: 'macos-seatbelt',
      terminationGuarantee: 'best_effort',
      terminationScope: 'original_process_group',
      survivorsPossible: true,
      completeDescendantTermination: false,
      fullNetworkIncludesHostAbstractUnixSockets: false,
    });
    expect(adapter.receiptMatches(receipt, 'timed_out')).toBe(true);
    expect(adapter.receiptMatches({ ...receipt, survivorsPossible: undefined }, 'timed_out')).toBe(
      false
    );
    expect(
      adapter.receiptMatches({ ...receipt, completeDescendantTermination: undefined }, 'timed_out')
    ).toBe(false);
    expect(adapter.receiptMatches({ ...receipt, survivorsPossible: false }, 'timed_out')).toBe(
      false
    );
    expect(
      adapter.receiptMatches({ ...receipt, completeDescendantTermination: true }, 'timed_out')
    ).toBe(false);
    expect(
      adapter.ledgerReceiptMatches(
        { ...receipt, survivorsPossible: undefined, completeDescendantTermination: undefined },
        'timed_out'
      )
    ).toBe(true);
    expect(adapter.signalMatches('SIGTERM')).toBe(true);
    expect(adapter.signalMatches('SIGKILL')).toBe(true);
    expect(adapter.offlineNetworkErrorMatches('net:PermissionError')).toBe(true);
  });

  test('returns no adapter for an unsupported platform', () => {
    expect(createPlatformAdapter('win32')).toBeNull();
  });
});
