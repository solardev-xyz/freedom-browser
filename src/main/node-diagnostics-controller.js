'use strict';

const { app } = require('electron');
const { DIAGNOSTIC_SERVICES, OPERATIONS } = require('./automation/contract/operations');
const { AutomationError, ERROR_CODES } = require('./automation/contract/errors');
const { diagnosticLogBuffer } = require('./diagnostic-log-buffer');

const DIAGNOSTIC_SERVICE_SET = new Set(DIAGNOSTIC_SERVICES);

function defaultRuntimeInfo() {
  let freedomVersion = '';
  try {
    freedomVersion = app.getVersion();
  } catch {
    // Plain-Node tests and tooling do not initialize Electron's app lifecycle.
  }
  return Object.freeze({
    ...(freedomVersion && { freedomVersion }),
    platform: process.platform,
    architecture: process.arch,
    ...(process.versions.electron && { electronVersion: process.versions.electron }),
    ...(process.versions.chrome && { chromiumVersion: process.versions.chrome }),
    nodeVersion: process.versions.node,
  });
}

function diagnosticDecisionApproved(decision) {
  return (
    decision === true ||
    decision === 'approved' ||
    (decision && typeof decision === 'object' && decision.status === 'approved')
  );
}

async function requireDiagnosticApproval(requestApproval, request) {
  if (typeof requestApproval !== 'function') {
    throw new AutomationError(
      ERROR_CODES.APPROVAL_REQUIRED,
      'Sharing raw diagnostics requires user approval'
    );
  }
  const decision = await requestApproval(request);
  if (!diagnosticDecisionApproved(decision)) {
    throw new AutomationError(
      ERROR_CODES.USER_CANCELLED,
      'The user declined sharing raw diagnostics'
    );
  }
}

function logServiceFor(service) {
  return service.startsWith('myotis-') ? 'myotis' : service;
}

class NodeDiagnosticsController {
  constructor(options = {}) {
    if (!options.nodeStatusController || typeof options.nodeStatusController.status !== 'function') {
      throw new TypeError('Node diagnostics require a node status controller');
    }
    this.nodeStatusController = options.nodeStatusController;
    this.logBuffer = options.logBuffer || diagnosticLogBuffer;
    this.getRuntimeInfo = options.getRuntimeInfo || defaultRuntimeInfo;
    this.now = options.now || Date.now;
  }

  async node(input, context = {}) {
    if (!DIAGNOSTIC_SERVICE_SET.has(input?.service)) {
      throw new AutomationError(ERROR_CODES.INVALID_ARGUMENT, 'Unsupported diagnostic service');
    }
    await requireDiagnosticApproval(context.requestApproval, {
      action: 'diagnostic_data',
      operation: OPERATIONS.NODE_DIAGNOSTICS,
      label: `Share recent ${input.service} diagnostics`,
      diagnostic: {
        scope: 'node',
        service: input.service,
        maxLines: input.maxLines,
        maxBytes: input.maxBytes,
      },
    });
    const statusSnapshot = await this.nodeStatusController.status();
    const status = statusSnapshot.nodes.find((node) => node.id === input.service) || null;
    const logs = this.logBuffer.read({
      service: logServiceFor(input.service),
      maxLines: input.maxLines,
      maxBytes: input.maxBytes,
    });
    return Object.freeze({
      scope: 'node',
      service: input.service,
      capturedAt: new Date(this.now()).toISOString(),
      runtime: this.getRuntimeInfo(),
      status,
      logs,
      summary: Object.freeze({
        scope: 'node',
        service: input.service,
        lineCount: logs.lineCount,
        bytes: logs.bytes,
        truncated: logs.truncated,
      }),
    });
  }

  async app(input, context = {}) {
    await requireDiagnosticApproval(context.requestApproval, {
      action: 'diagnostic_data',
      operation: OPERATIONS.APP_DIAGNOSTICS,
      label: 'Share recent Freedom application diagnostics',
      diagnostic: {
        scope: 'app',
        maxLines: input.maxLines,
        maxBytes: input.maxBytes,
      },
    });
    const logs = this.logBuffer.read({ maxLines: input.maxLines, maxBytes: input.maxBytes });
    return Object.freeze({
      scope: 'app',
      capturedAt: new Date(this.now()).toISOString(),
      runtime: this.getRuntimeInfo(),
      logs,
      summary: Object.freeze({
        scope: 'app',
        lineCount: logs.lineCount,
        bytes: logs.bytes,
        truncated: logs.truncated,
      }),
    });
  }
}

module.exports = { NodeDiagnosticsController, diagnosticDecisionApproved, logServiceFor };
