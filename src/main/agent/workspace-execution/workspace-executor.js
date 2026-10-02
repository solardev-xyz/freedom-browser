'use strict';

const { EXECUTION_STATES } = require('./execution-policy');
const { BubblewrapExecutor } = require('./bubblewrap-backend');
const { SeatbeltExecutor } = require('./seatbelt-backend');

class UnavailableWorkspaceExecutor {
  constructor(platform) {
    this.platform = platform;
  }

  async detectCapabilities() {
    return Object.freeze({
      backend: 'unavailable',
      available: false,
      denial: Object.freeze({
        code: 'WORKSPACE_EXECUTION_PLATFORM_UNAVAILABLE',
        message: 'No workspace execution backend is available on this platform',
      }),
      diagnostics: Object.freeze({ platform: this.platform }),
      enforcement: Object.freeze({}),
    });
  }

  async execute() {
    const now = Date.now();
    return Object.freeze({
      backend: 'unavailable',
      state: EXECUTION_STATES.SANDBOX_DENIED,
      startedAt: now,
      finishedAt: now,
      durationMs: 0,
      exitCode: null,
      signal: null,
      stdout: '',
      stderr: '',
      stdoutTruncated: false,
      stderrTruncated: false,
      terminationGuarantee: 'not_applicable',
      sideEffects: 'none',
      error: Object.freeze({
        code: 'WORKSPACE_EXECUTION_PLATFORM_UNAVAILABLE',
        message: 'No workspace execution backend is available on this platform',
      }),
    });
  }
}

function createWorkspaceExecutor(options = {}) {
  const platform = options.platform || process.platform;
  if (platform === 'darwin') return new SeatbeltExecutor(options.seatbelt);
  if (platform === 'linux') return new BubblewrapExecutor(options.bubblewrap);
  return new UnavailableWorkspaceExecutor(platform);
}

module.exports = {
  UnavailableWorkspaceExecutor,
  createWorkspaceExecutor,
};
