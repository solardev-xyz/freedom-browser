'use strict';

const { test, expect, _electron: electron } = require('@playwright/test');
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'src', 'cli', 'freedom.js');

async function runCli(args, env) {
  const result = await new Promise((resolve) => {
    const child = spawn(process.execPath, [cliPath, '--json', ...args], {
      cwd: repoRoot,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('close', (status, signal) => resolve({ status, signal, stdout, stderr }));
  });
  let output = null;
  try {
    output = JSON.parse(result.stdout || result.stderr);
  } catch {
    // Preserve raw output in the assertion below.
  }
  expect(
    { status: result.status, signal: result.signal, stdout: result.stdout, stderr: result.stderr },
    `freedom ${args.join(' ')} failed`
  ).toMatchObject({ status: 0, signal: null, stderr: '' });
  expect(output).toMatchObject({ ok: true });
  return output;
}

test('Freedom CLI starts, controls, and stops a persistent headless runtime', async () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-cli-e2e-'));
  const discoveryPath = path.join(userDataDir, 'automation-runtime', 'runtime.json');
  const env = {
    ...process.env,
    FREEDOM_TEST_MODE: '1',
    FREEDOM_TEST_USER_DATA: userDataDir,
    FREEDOM_RUNTIME_EXECUTABLE: require('electron'),
    ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
    LANG: 'en_US.UTF-8',
  };

  try {
    const [started, concurrentStart] = await Promise.all([
      runCli(['runtime', 'start'], env),
      runCli(['runtime', 'start'], env),
    ]);
    expect(started).toMatchObject({
      command: 'runtime.start',
      result: {
        state: 'ready',
        protocolVersion: 1,
        profile: { id: 'test' },
        idle: { enabled: false },
      },
    });
    expect(concurrentStart).toMatchObject({
      command: 'runtime.start',
      result: {
        state: 'ready',
        runtimeId: started.result.runtimeId,
        profile: { id: 'test' },
      },
    });

    expect(await runCli(['runtime', 'status'], env)).toMatchObject({
      command: 'runtime.status',
      result: { state: 'ready', profile: { id: 'test' } },
    });
    expect(await runCli(['tabs', 'list'], env)).toMatchObject({
      command: 'tabs.list',
      result: { ok: true, result: { tabs: [] } },
    });
    expect(await runCli(['runtime', 'stop'], env)).toMatchObject({
      command: 'runtime.stop',
      result: { shuttingDown: true },
    });
    await expect
      .poll(() => {
        try {
          return JSON.parse(fs.readFileSync(discoveryPath, 'utf8')).state;
        } catch {
          return null;
        }
      }, { timeout: 10_000 })
      .toBe('stopped');
  } finally {
    const discovery = (() => {
      try {
        return JSON.parse(fs.readFileSync(discoveryPath, 'utf8'));
      } catch {
        return null;
      }
    })();
    if (discovery?.state === 'ready') spawnSync(process.execPath, [cliPath, 'runtime', 'stop'], {
      cwd: repoRoot,
      env,
      encoding: 'utf8',
      timeout: 10_000,
    });
  }
});

test('Freedom CLI fulfills a page interaction chain through the runtime', async () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-cli-page-e2e-'));
  const screenshotPath = path.join(userDataDir, 'page.png');
  const firstUrl = `bzz://${'c'.repeat(64)}/cli-first`;
  const secondUrl = `bzz://${'d'.repeat(64)}/cli-second`;
  const env = {
    ...process.env,
    FREEDOM_TEST_MODE: '1',
    FREEDOM_TEST_USER_DATA: userDataDir,
    ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
    LANG: 'en_US.UTF-8',
  };
  let app;
  try {
    app = await electron.launch({
      args: ['.', '--runtime'],
      cwd: repoRoot,
      env,
      timeout: 20_000,
    });
    await expect
      .poll(() => {
        try {
          return JSON.parse(
            fs.readFileSync(path.join(userDataDir, 'automation-runtime', 'runtime.json'), 'utf8')
          ).state;
        } catch {
          return null;
        }
      }, { timeout: 10_000 })
      .toBe('ready');
    await expect
      .poll(async () => {
        try {
          return await app.evaluate(() => Boolean(globalThis.__FREEDOM_TEST_HARNESS__));
        } catch {
          return false;
        }
      }, { timeout: 10_000 })
      .toBe(true);
    await app.evaluate((_electron, fixtures) => {
      globalThis.__FREEDOM_TEST_HARNESS__.setContentFixture(fixtures.firstUrl, {
        body: `<!doctype html>
          <title>CLI first</title>
          <label>Name <input aria-label="Name"></label>
          <button onclick="document.querySelector('#status').textContent = document.querySelector('input').value">Submit</button>
          <p id="status">Waiting</p>`,
      });
      globalThis.__FREEDOM_TEST_HARNESS__.setContentFixture(fixtures.secondUrl, {
        body: '<!doctype html><title>CLI second</title><h1>Navigation complete</h1>',
      });
    }, { firstUrl, secondUrl });

    const opened = await runCli(['tabs', 'open', '--url', firstUrl], env);
    const tabId = opened.result.result.tab.tabId;
    expect(tabId).toEqual(expect.any(String));
    expect(await runCli(['tabs', 'get', '--tab', tabId], env)).toMatchObject({
      result: { result: { tab: { tabId, url: firstUrl, kind: 'headless' } } },
    });

    const snapshot = await runCli(['page', 'snapshot', '--tab', tabId], env);
    const elements = snapshot.result.result.elements;
    const inputRef = elements.find((element) => element.name === 'Name')?.ref;
    const submitRef = elements.find((element) => element.name === 'Submit')?.ref;
    expect(inputRef).toBeTruthy();
    expect(submitRef).toBeTruthy();
    await runCli(['page', 'type', '--tab', tabId, '--ref', inputRef, '--text', 'Freedom CLI'], env);
    await runCli(['page', 'click', '--tab', tabId, '--ref', submitRef], env);
    expect(
      await runCli([
        'page',
        'wait',
        '--tab',
        tabId,
        '--until',
        'text',
        '--text',
        'Freedom CLI',
        '--timeout-ms',
        '2000',
      ], env)
    ).toMatchObject({ result: { result: { matched: true, condition: 'text' } } });

    expect(await runCli(['page', 'navigate', '--tab', tabId, '--url', secondUrl], env)).toMatchObject({
      result: { ok: true, tabId },
    });
    expect(await runCli(['page', 'screenshot', '--tab', tabId, '--output', screenshotPath], env))
      .toMatchObject({
        result: { result: { mediaType: 'image/png', path: screenshotPath, bytes: expect.any(Number) } },
      });
    expect(fs.statSync(screenshotPath).size).toBeGreaterThan(100);
    expect(await runCli(['tabs', 'close', '--tab', tabId], env)).toMatchObject({
      result: { result: { closed: true, tabId } },
    });
    await runCli(['runtime', 'stop'], env);
  } finally {
    try {
      await app?.close();
    } catch {
      // The CLI shutdown command may already have closed the app.
    }
  }
});
