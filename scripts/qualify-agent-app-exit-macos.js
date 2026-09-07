#!/usr/bin/env node

'use strict';

const { spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { _electron: electron } = require('@playwright/test');

const PREFIX = 'freedom-agent-app-exit-';
const MODES = ['idle', 'running', 'detached'];
const DETACHED_FAILURE_INJECTION = 'after_detached_process_created';
const DETACHED_FAILURE_MESSAGE = 'Injected Agent exit failure after detached process creation';
const MAX_OUTPUT_BYTES = 256 * 1024;

function emit(type, value = {}) {
  process.stdout.write(`${JSON.stringify({ type, ...value })}\n`);
}

function boundedAppend(current, chunk) {
  return `${current}${chunk}`.slice(-MAX_OUTPUT_BYTES);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fileSize(candidate) {
  try {
    return fs.statSync(candidate).size;
  } catch {
    return -1;
  }
}

function processRows() {
  const result = spawnSync('/bin/ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8' });
  if (result.status !== 0) return [];
  return result.stdout
    .split('\n')
    .map((line) => /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line))
    .filter(Boolean)
    .map((match) => ({ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] }));
}

function processIdentity(pid) {
  const command = spawnSync('/bin/ps', ['-p', String(pid), '-o', 'command='], {
    encoding: 'utf8',
  });
  const started = spawnSync('/bin/ps', ['-p', String(pid), '-o', 'lstart='], {
    encoding: 'utf8',
  });
  if (command.status !== 0 || started.status !== 0) return null;
  return { pid, command: command.stdout.trim(), started: started.stdout.trim() };
}

function identityMatches(identity, token = null) {
  const current = processIdentity(identity.pid);
  return Boolean(
    current &&
      current.command === identity.command &&
      current.started === identity.started &&
      (!token || current.command.includes(token))
  );
}

function descendantPids(rootPid, rows = processRows()) {
  const found = new Set([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (found.has(row.ppid) && !found.has(row.pid)) {
        found.add(row.pid);
        changed = true;
      }
    }
  }
  return [...found];
}

function tokenProcesses(token) {
  return processRows().filter((row) => row.command.includes(token));
}

function listener(port) {
  if (!port) return '';
  const result = spawnSync('/usr/sbin/lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], {
    encoding: 'utf8',
  });
  return result.status === 0 ? result.stdout.trim() : '';
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode) {
    return Promise.resolve({ exitCode: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve, reject) => {
    let timer = null;
    const cleanup = () => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      child.removeListener('exit', onExit);
    };
    const onExit = (exitCode, signal) => {
      cleanup();
      resolve({ exitCode, signal });
    };
    child.once('exit', onExit);
    timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Freedom did not exit within ${timeoutMs} ms`));
    }, timeoutMs);
    timer.unref?.();
  });
}

async function stopExactProcess(identity, token, signal) {
  if (!identityMatches(identity, token)) return true;
  process.kill(identity.pid, signal);
  for (let index = 0; index < 80; index += 1) {
    if (!identityMatches(identity, token)) return true;
    await delay(25);
  }
  return false;
}

async function cleanupTokenProcesses(token, identities) {
  const cleaned = [];
  const errors = [];
  for (const identity of identities) {
    try {
      if (!identityMatches(identity, token)) continue;
      if (!(await stopExactProcess(identity, token, 'SIGTERM'))) {
        if (!identityMatches(identity, token)) continue;
        if (!(await stopExactProcess(identity, token, 'SIGKILL'))) {
          throw new Error(`Token-owned process ${identity.pid} survived bounded cleanup`);
        }
      }
      cleaned.push(identity.pid);
    } catch (error) {
      errors.push(`${identity.pid}:${error.message}`);
    }
  }
  return { cleaned, errors };
}

async function settleWithin(promise, timeoutMs) {
  let timer = null;
  try {
    return await Promise.race([
      promise,
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

async function ensureApplicationStopped(electronApp, child) {
  if (child.exitCode !== null || child.signalCode) return;
  await settleWithin(electronApp.close().catch(() => {}), 5_000);
  if (child.exitCode !== null || child.signalCode) return;
  child.kill('SIGTERM');
  try {
    await waitForExit(child, 5_000);
    return;
  } catch {
    child.kill('SIGKILL');
    await waitForExit(child, 5_000);
  }
}

function publicIdentities(identities) {
  return identities.map(({ role, pid, started, ownershipBasis, tokenVerified }) => ({
    role,
    pid,
    started,
    ownershipBasis,
    ...(tokenVerified !== undefined && { tokenVerified }),
  }));
}

async function runMode(mode, results, options = {}) {
  const scenario = options.scenario || mode;
  const failureInjection = options.failureInjection || null;
  const expectsPreparationFailure = failureInjection !== null;
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), PREFIX));
  await fs.promises.chmod(root, 0o700);
  const launchToken = `freedom-agent-exit-launch-${crypto.randomBytes(12).toString('hex')}`;
  const ownership = Object.freeze({
    token: `freedom-agent-app-exit-${crypto.randomBytes(12).toString('hex')}`,
    userDataRoot: root,
  });
  let stdout = '';
  let stderr = '';
  let electronApp = null;
  let child = null;
  let fixture = null;
  let identities = [];
  let survivorsBeforeCleanup = [];
  let cleanupPids = [];
  const check = (id, name, condition, evidence = {}) => {
    const status = condition ? 'passed' : 'failed';
    results.push({ id: `${scenario}:${id}`, status });
    emit('assertion', { scenario, mode, id, name, status, evidence });
  };

  emit('app-exit-scenario', { scenario, mode, userDataRoot: path.basename(root) });
  emit('app-exit-ownership', {
    scenario,
    mode,
    cleanupTokenRegisteredBeforePreparation: true,
    userDataRootRegisteredBeforePreparation: true,
  });
  try {
    electronApp = await electron.launch({
      args: ['.', `--freedom-agent-exit-token=${launchToken}`],
      cwd: path.join(__dirname, '..'),
      env: {
        ...process.env,
        FREEDOM_TEST_MODE: '1',
        FREEDOM_TEST_USER_DATA: root,
        ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
        LANG: 'en_US.UTF-8',
      },
      timeout: 20_000,
    });
    child = electronApp.process();
    child.stdout?.on('data', (chunk) => {
      stdout = boundedAppend(stdout, chunk);
    });
    child.stderr?.on('data', (chunk) => {
      stderr = boundedAppend(stderr, chunk);
    });
    await electronApp.firstWindow();
    fixture = await electronApp.evaluate(
      async (_electron, request) =>
        globalThis.__FREEDOM_TEST_HARNESS__.prepareAgentExitScenario(request),
      { mode, token: ownership.token, failureInjection }
    );
    if (expectsPreparationFailure) {
      throw new Error('Expected Agent exit preparation failure was not injected');
    }

    const explicitRoles = new Map(
      (fixture.ownedProcesses || []).map((entry) => [entry.pid, entry.role])
    );
    identities = descendantPids(child.pid)
      .map((pid) => {
        const identity = processIdentity(pid);
        if (!identity) return null;
        const fixtureToken = explicitRoles.has(pid) ? fixture.token : null;
        return {
          ...identity,
          role: pid === child.pid ? 'electron-main' : explicitRoles.get(pid) || 'electron-helper',
          ownershipToken: fixtureToken,
          ownershipBasis: fixtureToken
            ? 'fixture_token'
            : pid === child.pid
              ? 'launch_token'
              : 'pre_quit_descendant_identity',
          ...(fixtureToken && { tokenVerified: identity.command.includes(fixtureToken) }),
          ...(pid === child.pid && { tokenVerified: identity.command.includes(launchToken) }),
        };
      })
      .filter(Boolean);
    for (const entry of fixture.ownedProcesses || []) {
      if (identities.some((identity) => identity.pid === entry.pid)) continue;
      const identity = processIdentity(entry.pid);
      if (!identity) continue;
      identities.push({
        ...identity,
        role: entry.role,
        ownershipToken: fixture.token,
        ownershipBasis: 'fixture_token',
        tokenVerified: identity.command.includes(fixture.token),
      });
    }

    const heartbeatBefore = fileSize(fixture.heartbeatPath);
    const detachedHeartbeatBefore = fileSize(fixture.detachedHeartbeatPath);
    const listenerBefore = listener(fixture.preview?.port);
    check(
      'prepared',
      'the app-owned Agent service, controller, and process manager prepared the requested state',
      fixture.appOwnedService === true &&
        fixture.appOwnedWorkspaceController === true &&
        fixture.appOwnedProcessManager === true &&
        identities.some((identity) => identity.role === 'electron-main' && identity.tokenVerified) &&
        (fixture.ownedProcesses || []).every((entry) =>
          identities.some((identity) => identity.pid === entry.pid && identity.tokenVerified)
        ),
      {
        composition: {
          service: fixture.appOwnedService,
          controller: fixture.appOwnedWorkspaceController,
          processManager: fixture.appOwnedProcessManager,
        },
        ownedBeforeQuit: publicIdentities(identities),
      }
    );
    if (mode === 'running') {
      check(
        'preview-before-quit',
        'the declared preview route and its owned listener are live before application Quit',
        fixture.preview?.statusBeforeQuit === 200 &&
          fixture.preview.bodyBeforeQuit === 'agent-exit-preview' &&
          listenerBefore.includes(`127.0.0.1:${fixture.preview.port}`) &&
          heartbeatBefore >= 0,
        {
          routeStatus: fixture.preview?.statusBeforeQuit,
          listenerPresent: Boolean(listenerBefore),
          heartbeatBytes: heartbeatBefore,
        }
      );
    }
    if (mode === 'detached') {
      check(
        'detached-confined',
        'the deliberately detached descendant is live and Seatbelt-confined before Quit',
        fixture.confinement?.outsideRead === 1 &&
          fixture.confinement.loopback === 1 &&
          fixture.confinement.dns !== 'unexpected' &&
          detachedHeartbeatBefore >= 0,
        {
          confinement: fixture.confinement,
          detachedHeartbeatBytes: detachedHeartbeatBefore,
        }
      );
    }

    const quitStartedAt = Date.now();
    await electronApp.evaluate(({ Menu }) => {
      Menu.sendActionToFirstResponder('terminate:');
    });
    const outcome = await waitForExit(child, 20_000);
    const quitDurationMs = Date.now() - quitStartedAt;
    await delay(250);

    survivorsBeforeCleanup = identities.filter((identity) =>
      identityMatches(identity, identity.ownershipToken)
    );
    const untrackedTokenSurvivors = tokenProcesses(fixture.token).filter(
      (entry) => !survivorsBeforeCleanup.some((identity) => identity.pid === entry.pid)
    );
    for (const row of untrackedTokenSurvivors) {
      const identity = processIdentity(row.pid);
      if (identity) {
        survivorsBeforeCleanup.push({
          ...identity,
          role: 'token-owned-untracked',
          ownershipToken: fixture.token,
          ownershipBasis: 'fixture_token',
          tokenVerified: true,
        });
      }
    }

    const heartbeatAfterA = fileSize(fixture.heartbeatPath);
    const detachedHeartbeatAfterA = fileSize(fixture.detachedHeartbeatPath);
    const listenerAfterA = listener(fixture.preview?.port);
    await delay(250);
    const heartbeatAfterB = fileSize(fixture.heartbeatPath);
    const detachedHeartbeatAfterB = fileSize(fixture.detachedHeartbeatPath);
    const listenerAfterB = listener(fixture.preview?.port);
    const combinedOutput = `${stdout}\n${stderr}`;
    check(
      'native-quit',
      'the native macOS application Quit action reaches orderly Agent disposal and an actual zero-code OS exit',
      outcome.exitCode === 0 &&
        outcome.signal === null &&
        combinedOutput.includes('agent_dispose_started') &&
        combinedOutput.includes('agent_dispose_finished') &&
        combinedOutput.includes('process_exit'),
      {
        invokedBy: 'Menu.sendActionToFirstResponder("terminate:")',
        exitCode: outcome.exitCode,
        signal: outcome.signal,
        durationMs: quitDurationMs,
        agentDisposeStarted: combinedOutput.includes('agent_dispose_started'),
        agentDisposeFinished: combinedOutput.includes('agent_dispose_finished'),
        processExitObserved: combinedOutput.includes('process_exit'),
      }
    );

    if (mode === 'idle') {
      check(
        'idle-processes',
        'the idle app and all independently tracked helper identities are gone after Quit',
        survivorsBeforeCleanup.length === 0,
        { survivorsBeforeCleanup: publicIdentities(survivorsBeforeCleanup) }
      );
    } else if (mode === 'running') {
      check(
        'running-processes',
        'application Quit stops the running managed process, heartbeat, preview listener, and route owner',
        survivorsBeforeCleanup.length === 0 &&
          heartbeatAfterA === heartbeatAfterB &&
          listenerAfterA === '' &&
          listenerAfterB === '',
        {
          survivorsBeforeCleanup: publicIdentities(survivorsBeforeCleanup),
          heartbeat: { before: heartbeatBefore, afterA: heartbeatAfterA, afterB: heartbeatAfterB },
          preview: {
            listenerBefore: Boolean(listenerBefore),
            listenerAfterA: Boolean(listenerAfterA),
            listenerAfterB: Boolean(listenerAfterB),
            routeAfterQuit: 'application_exited',
          },
        }
      );
    } else {
      const detached = survivorsBeforeCleanup.find(
        (identity) => identity.role === 'detached-descendant'
      );
      const managed = survivorsBeforeCleanup.find((identity) => identity.role === 'managed-parent');
      check(
        'detached-processes',
        'Quit stops the original managed process but truthfully leaves the detached descendant alive',
        !managed &&
          Boolean(detached) &&
          detached?.tokenVerified === true &&
          heartbeatAfterA === heartbeatAfterB &&
          detachedHeartbeatAfterB > detachedHeartbeatAfterA,
        {
          survivorsBeforeCleanup: publicIdentities(survivorsBeforeCleanup),
          managedHeartbeat: {
            before: heartbeatBefore,
            afterA: heartbeatAfterA,
            afterB: heartbeatAfterB,
          },
          detachedHeartbeat: {
            before: detachedHeartbeatBefore,
            afterA: detachedHeartbeatAfterA,
            afterB: detachedHeartbeatAfterB,
          },
          terminationGuarantee: 'best_effort',
          survivorsPossible: true,
          completeDescendantTermination: false,
        }
      );
    }
  } catch (error) {
    if (expectsPreparationFailure && error.message.includes(DETACHED_FAILURE_MESSAGE)) {
      check(
        'injected-preparation-failure',
        'the deterministic failure occurs only after the detached process was created',
        true,
        { failureInjection, message: DETACHED_FAILURE_MESSAGE }
      );
    } else {
      results.push({ id: `${scenario}:scenario`, status: 'failed' });
      emit('app-exit-error', { scenario, mode, message: error.message });
    }
  } finally {
    const cleanupErrors = [];
    if (electronApp && child) {
      try {
        await ensureApplicationStopped(electronApp, child);
      } catch (error) {
        cleanupErrors.push(`application:${error.message}`);
      }
    }
    const tokenIdentities = tokenProcesses(ownership.token)
      .map((row) => {
        const identity = processIdentity(row.pid);
        return identity
          ? {
              ...identity,
              role: 'token-owned-cleanup',
              ownershipToken: ownership.token,
              ownershipBasis: 'fixture_token',
              tokenVerified: identity.command.includes(ownership.token),
            }
          : null;
      })
      .filter(Boolean);
    if (expectsPreparationFailure) {
      survivorsBeforeCleanup = tokenIdentities;
      check(
        'partial-setup-process-discovery',
        'cleanup rediscovers token-owned processes after preparation failed and the app stopped',
        tokenIdentities.length > 0 &&
          tokenIdentities.every((identity) => identity.tokenVerified === true),
        { ownedProcesses: publicIdentities(tokenIdentities) }
      );
    }
    if (tokenIdentities.length > 0) {
      const cleanup = await cleanupTokenProcesses(ownership.token, tokenIdentities);
      cleanupPids = cleanup.cleaned;
      cleanupErrors.push(...cleanup.errors.map((error) => `fixture-process:${error}`));
    }
    const finalTokenSurvivors = tokenProcesses(ownership.token);
    const applicationStopped = !child || child.exitCode !== null || child.signalCode !== null;
    if (applicationStopped && finalTokenSurvivors.length === 0) {
      try {
        await fs.promises.rm(root, { recursive: true, force: true });
      } catch (error) {
        cleanupErrors.push(`fixture-directory:${error.message}`);
      }
    }
    const cleanupPassed =
      applicationStopped &&
      finalTokenSurvivors.length === 0 &&
      !fs.existsSync(root) &&
      cleanupErrors.length === 0;
    results.push({ id: `${scenario}:cleanup`, status: cleanupPassed ? 'passed' : 'failed' });
    emit('app-exit-cleanup', {
      scenario,
      mode,
      survivorsBeforeCleanup: publicIdentities(survivorsBeforeCleanup),
      tokenValidatedCleanupPids: cleanupPids,
      survivorsAfterCleanup: finalTokenSurvivors.map(({ pid }) => pid),
      applicationStopped,
      fixtureRemoved: !fs.existsSync(root),
      cleanupErrors,
      status: cleanupPassed ? 'passed' : 'failed',
    });
  }
}

async function main() {
  if (process.platform !== 'darwin') throw new Error('Application-exit qualification requires macOS');
  const results = [];
  for (const mode of MODES) await runMode(mode, results);
  await runMode('detached', results, {
    scenario: 'detached-setup-failure',
    failureInjection: DETACHED_FAILURE_INJECTION,
  });
  const passed = results.filter((entry) => entry.status === 'passed').length;
  const failed = results.filter((entry) => entry.status === 'failed').length;
  emit('app-exit-summary', {
    passed,
    failed,
    modes: MODES,
    failureInjections: [DETACHED_FAILURE_INJECTION],
  });
  if (failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`macOS application-exit qualification failed: ${error.message}\n`);
  process.exitCode = 1;
});
