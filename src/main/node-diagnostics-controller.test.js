'use strict';

const { ERROR_CODES } = require('./automation/contract/errors');
const { NodeDiagnosticsController } = require('./node-diagnostics-controller');

function createController(overrides = {}) {
  const logs = {
    entries: [
      {
        sequence: 1,
        timestamp: '2026-08-28T12:00:00.000Z',
        level: 'error',
        source: 'node_stderr',
        service: 'ipfs',
        text: '[IPFS] raw peer 12D3Koo evidence at /local/path',
      },
    ],
    lineCount: 1,
    bytes: 48,
    truncated: false,
  };
  const options = {
    nodeStatusController: {
      status: jest.fn(async () => ({
        nodes: [{ id: 'ipfs', state: 'error', ready: false }],
        summary: { total: 6, ready: 0, active: 0, disabled: 0, attention: 1 },
      })),
    },
    logBuffer: { read: jest.fn(() => logs) },
    getRuntimeInfo: () => ({ freedomVersion: '0.8.1', platform: 'darwin' }),
    now: () => Date.parse('2026-08-28T12:01:00.000Z'),
    ...overrides,
  };
  return { controller: new NodeDiagnosticsController(options), options, logs };
}

describe('NodeDiagnosticsController', () => {
  test('reads raw node evidence only after exact diagnostic approval', async () => {
    const { controller, options, logs } = createController();
    const requestApproval = jest.fn(async () => ({
      status: 'approved',
      diagnosticScope: 'conversation',
    }));

    await expect(
      controller.node(
        { service: 'ipfs', maxLines: 200, maxBytes: 49_152 },
        { requestApproval }
      )
    ).resolves.toEqual({
      scope: 'node',
      service: 'ipfs',
      capturedAt: '2026-08-28T12:01:00.000Z',
      runtime: { freedomVersion: '0.8.1', platform: 'darwin' },
      status: { id: 'ipfs', state: 'error', ready: false },
      logs,
      summary: {
        scope: 'node',
        service: 'ipfs',
        lineCount: 1,
        bytes: 48,
        truncated: false,
      },
    });
    expect(requestApproval).toHaveBeenCalledWith({
      action: 'diagnostic_data',
      operation: 'node_diagnostics',
      label: 'Share recent ipfs diagnostics',
      diagnostic: {
        scope: 'node',
        service: 'ipfs',
        maxLines: 200,
        maxBytes: 49_152,
      },
    });
    expect(options.logBuffer.read).toHaveBeenCalledWith({
      service: 'ipfs',
      maxLines: 200,
      maxBytes: 49_152,
    });
  });

  test('does not read logs when approval is missing or declined', async () => {
    const { controller, options } = createController();
    await expect(
      controller.app({ maxLines: 200, maxBytes: 49_152 })
    ).rejects.toMatchObject({ code: ERROR_CODES.APPROVAL_REQUIRED });
    await expect(
      controller.app(
        { maxLines: 200, maxBytes: 49_152 },
        { requestApproval: async () => 'declined' }
      )
    ).rejects.toMatchObject({ code: ERROR_CODES.USER_CANCELLED });
    expect(options.logBuffer.read).not.toHaveBeenCalled();
  });

  test('shares bounded app logs without accepting a filesystem path', async () => {
    const { controller, options, logs } = createController();
    const result = await controller.app(
      { maxLines: 25, maxBytes: 4_096, path: '/not/accepted' },
      { requestApproval: async () => 'approved' }
    );

    expect(options.logBuffer.read).toHaveBeenCalledWith({ maxLines: 25, maxBytes: 4_096 });
    expect(result).toMatchObject({ scope: 'app', logs, summary: { lineCount: 1 } });
    expect(result).not.toHaveProperty('path');
  });
});
