'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { resolveExecutableAccess } = require('./executable-access');
const {
  CAPABILITY_DEFINITIONS,
  CAPABILITY_KINDS,
  WorkspaceCapabilityGrantStore,
  capabilityImplementationStatus,
  createExecutableRootCapability,
  createFullNetworkCapabilities,
  createWorkspaceCapabilityRequest,
  executableRootForCapability,
  fullNetworkPostureForCapabilities,
  isTrustedWorkspaceCapability,
  isTrustedWorkspaceCapabilityRequest,
} = require('./workspace-capabilities');

async function resolvedExecutableFixture() {
  const fixture = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'freedom-capability-'));
  const packageRoot = path.join(fixture, 'tool-package');
  const bin = path.join(packageRoot, 'bin');
  await fs.promises.mkdir(bin, { recursive: true });
  await fs.promises.writeFile(path.join(bin, 'tool'), '#!/bin/sh\n', { mode: 0o700 });
  const access = await resolveExecutableAccess(['tool'], {
    platform: 'darwin',
    hostEnvironment: { PATH: bin },
  });
  return { fixture, root: access.runtimeRoots[0] };
}

describe('workspace capability contract', () => {
  test('defines distinct authority kinds and fails closed for unimplemented vocabulary', () => {
    expect(Object.keys(CAPABILITY_DEFINITIONS)).toEqual([
      CAPABILITY_KINDS.EXECUTABLE_ROOT,
      CAPABILITY_KINDS.FILESYSTEM_READ,
      CAPABILITY_KINDS.FILESYSTEM_WRITE,
      CAPABILITY_KINDS.NETWORK_PUBLIC,
      CAPABILITY_KINDS.NETWORK_LOOPBACK,
      CAPABILITY_KINDS.NETWORK_PRIVATE,
      CAPABILITY_KINDS.HOST_IPC,
    ]);
    expect(capabilityImplementationStatus(CAPABILITY_KINDS.EXECUTABLE_ROOT)).toBe('implemented');
    expect(capabilityImplementationStatus(CAPABILITY_KINDS.NETWORK_PUBLIC)).toBe('implemented');
    expect(capabilityImplementationStatus('invented')).toBe('unknown');
    expect(Object.isFrozen(CAPABILITY_DEFINITIONS)).toBe(true);
  });

  test('keeps executable authority opaque and rejects serialized or forged capabilities', async () => {
    const { fixture, root } = await resolvedExecutableFixture();
    try {
      const capability = createExecutableRootCapability(root);
      expect(capability).toEqual({ kind: 'executable_root', version: 1 });
      expect(isTrustedWorkspaceCapability(capability)).toBe(true);
      expect(executableRootForCapability(capability)).toBe(root);
      expect(JSON.stringify(capability)).not.toContain(fixture);
      const forged = JSON.parse(JSON.stringify(capability));
      expect(isTrustedWorkspaceCapability(forged)).toBe(false);
      expect(executableRootForCapability(forged)).toBeNull();
      expect(() =>
        createWorkspaceCapabilityRequest({
          conversationId: 'conversation_one',
          command: 'tool --version',
          workingDirectory: '.',
          capabilities: [forged],
        })
      ).toThrow(expect.objectContaining({ code: 'UNTRUSTED_CAPABILITY_AUTHORITY' }));
    } finally {
      await fs.promises.rm(fixture, { recursive: true, force: true });
    }
  });

  test('issues direct networking only as one opaque complete capability bundle', () => {
    const capabilities = createFullNetworkCapabilities();
    expect(capabilities.map((capability) => capability.kind)).toEqual([
      CAPABILITY_KINDS.NETWORK_PUBLIC,
      CAPABILITY_KINDS.NETWORK_LOOPBACK,
      CAPABILITY_KINDS.NETWORK_PRIVATE,
    ]);
    expect(capabilities.every(isTrustedWorkspaceCapability)).toBe(true);
    expect(fullNetworkPostureForCapabilities(capabilities)).toBe('full');
    expect(JSON.stringify(capabilities)).not.toContain('authority');
    expect(() => fullNetworkPostureForCapabilities(capabilities.slice(0, 1))).toThrow(
      expect.objectContaining({ code: 'UNSUPPORTED_CAPABILITY_COMBINATION' })
    );
    expect(() =>
      fullNetworkPostureForCapabilities(capabilities.map((capability) => ({ ...capability })))
    ).toThrow(expect.objectContaining({ code: 'UNTRUSTED_CAPABILITY_AUTHORITY' }));
  });

  test('consumes a one-shot permit only for its exact command and directory', async () => {
    const { fixture, root } = await resolvedExecutableFixture();
    try {
      const capability = createExecutableRootCapability(root);
      const request = createWorkspaceCapabilityRequest({
        conversationId: 'conversation_one',
        command: 'tool --version',
        workingDirectory: 'site',
        capabilities: [capability],
      });
      const grants = new WorkspaceCapabilityGrantStore();
      expect(isTrustedWorkspaceCapabilityRequest(request)).toBe(true);
      expect(() => grants.grant('conversation_two', request, 'once')).toThrow(
        expect.objectContaining({ code: 'INVALID_CAPABILITY_GRANT' })
      );
      expect(grants.grant('conversation_one', request, 'once')).toEqual({
        scope: 'once',
        capabilities: ['executable_root'],
        command: 'tool --version',
        workingDirectory: 'site',
      });
      expect(() => grants.grant('conversation_one', request, 'once')).toThrow(
        expect.objectContaining({ code: 'INVALID_CAPABILITY_GRANT' })
      );
      expect(
        grants.resolve('conversation_one', {
          command: 'tool --help',
          workingDirectory: 'site',
        })
      ).toEqual([]);
      expect(
        grants.inspect('conversation_one', {
          command: 'tool --version',
          workingDirectory: 'site',
        })
      ).toEqual([capability]);
      expect(
        grants.inspect('conversation_one', {
          command: 'tool --version',
          workingDirectory: 'site',
        })
      ).toEqual([capability]);
      expect(
        grants.resolve('conversation_one', {
          command: 'tool --version',
          workingDirectory: '.',
        })
      ).toEqual([]);
      expect(
        grants.resolve('conversation_one', {
          command: 'tool --version',
          workingDirectory: 'site',
        })
      ).toEqual([capability]);
      expect(
        grants.resolve('conversation_one', {
          command: 'tool --version',
          workingDirectory: 'site',
        })
      ).toEqual([]);
    } finally {
      await fs.promises.rm(fixture, { recursive: true, force: true });
    }
  });

  test('retains deduplicated conversation capabilities and clears scopes independently', async () => {
    const { fixture, root } = await resolvedExecutableFixture();
    try {
      const first = createExecutableRootCapability(root);
      const second = createExecutableRootCapability(root);
      const grants = new WorkspaceCapabilityGrantStore();
      grants.grant(
        'conversation_one',
        createWorkspaceCapabilityRequest({
          conversationId: 'conversation_one',
          command: 'tool first',
          workingDirectory: '.',
          capabilities: [first],
        }),
        'conversation'
      );
      grants.grant(
        'conversation_one',
        createWorkspaceCapabilityRequest({
          conversationId: 'conversation_one',
          command: 'tool second',
          workingDirectory: '.',
          capabilities: [second],
        }),
        'conversation'
      );
      grants.grant(
        'conversation_one',
        createWorkspaceCapabilityRequest({
          conversationId: 'conversation_one',
          command: 'tool exact',
          workingDirectory: '.',
          capabilities: [first],
        }),
        'once'
      );

      expect(grants.clearOnce('conversation_one')).toBe(true);
      expect(
        grants.resolve('conversation_one', {
          command: 'anything',
          workingDirectory: '.',
        })
      ).toEqual([second]);
      expect(grants.deleteConversation('conversation_one')).toBe(true);
      expect(
        grants.resolve('conversation_one', {
          command: 'anything',
          workingDirectory: '.',
        })
      ).toEqual([]);
    } finally {
      await fs.promises.rm(fixture, { recursive: true, force: true });
    }
  });
});
