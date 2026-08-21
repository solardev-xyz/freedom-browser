'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createRuntimeServer } = require('../main/automation/runtime-server');
const { connectRuntime } = require('./runtime-client');

describe('Freedom CLI runtime client', () => {
  test('authenticates and correlates out-of-order responses', async () => {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-cli-runtime-'));
    const socketRoot = fs.mkdtempSync('/tmp/freedom-cli-sockets-');
    let releaseSlow;
    const slow = new Promise((resolve) => {
      releaseSlow = resolve;
    });
    const controller = {
      runtimeId: 'runtime_cli_test',
      contextId: 'context_cli_test',
      async execute(operation) {
        if (operation === 'slow') await slow;
        return { ok: true, result: { operation } };
      },
    };
    const profile = { id: 'automation', displayName: 'Automation', userDataDir };
    const server = createRuntimeServer({
      profile,
      controller,
      token: 'c'.repeat(64),
      socketRoot,
      endpointNonce: 'cli-test',
      logger: { info() {}, warn() {}, error() {} },
    });
    await server.start();
    const { client, status } = await connectRuntime(profile);
    expect(status).toMatchObject({ state: 'ready', runtimeId: 'runtime_cli_test' });

    const slowRequest = client.request('automation.execute', { operation: 'slow', input: {} });
    const fastRequest = client.request('automation.execute', { operation: 'fast', input: {} });
    await expect(fastRequest).resolves.toMatchObject({ result: { operation: 'fast' } });
    releaseSlow();
    await expect(slowRequest).resolves.toMatchObject({ result: { operation: 'slow' } });

    client.close();
    await server.stop();
  });

  test('rejects discovery for a different profile before connecting', async () => {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-cli-discovery-'));
    const runtimeDir = path.join(userDataDir, 'automation-runtime');
    fs.mkdirSync(runtimeDir);
    fs.writeFileSync(
      path.join(runtimeDir, 'runtime.json'),
      JSON.stringify({ schemaVersion: 1, profile: { id: 'other' }, state: 'ready' }),
      { mode: 0o600 }
    );
    await expect(connectRuntime({ id: 'automation', userDataDir })).rejects.toMatchObject({
      code: 'RUNTIME_NOT_READY',
      exitCode: 10,
    });
  });
});
