'use strict';

const { OPERATIONS } = require('./automation/contract/operations');
const { AutomationError, ERROR_CODES } = require('./automation/contract/errors');
const { EFFECTS, decideEffectPolicy, unknownClassification } = require('./agent/effect-classifier');

const DEFAULT_VERIFY_TIMEOUT_MS = 30_000;
const DEFAULT_VERIFY_INTERVAL_MS = 250;
const RUNNING_STATES = new Set(['running', 'syncing', 'ready']);
const STOPPED_STATES = new Set(['stopped', 'disabled', 'unavailable']);
const START_TERMINAL_FAILURE_STATES = new Set(['disabled', 'unavailable', 'error']);

function defaultDependencies() {
  return {
    startAnt: () => require('./ant-manager').startAnt(),
    stopAnt: () => require('./ant-manager').stopAnt(),
    startIpfs: () => require('./ipfs-manager').startIpfs(),
    stopIpfs: () => require('./ipfs-manager').stopIpfs(),
    startRadicle: () => require('./radicle-manager').startRadicle(),
    stopRadicle: () => require('./radicle-manager').stopRadicle(),
    startTor: () => require('./tor-manager').startTor(),
    stopTor: () => require('./tor-manager').stopTor(),
    startMyotis: (chainId) => require('./myotis/myotis-manager').startMyotis({ chainId }),
    stopMyotis: (chainId) => require('./myotis/myotis-manager').stopMyotis(chainId),
  };
}

function approved(decision) {
  return (
    decision === true ||
    decision === 'approved' ||
    (decision && typeof decision === 'object' && decision.status === 'approved')
  );
}

function chainIdForService(service) {
  if (service === 'myotis-ethereum') return 1;
  if (service === 'myotis-gnosis') return 100;
  return null;
}

function expectedState(action, state) {
  return action === 'stop' ? STOPPED_STATES.has(state) : RUNNING_STATES.has(state);
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class NodeLifecycleController {
  constructor(options = {}) {
    if (!options.nodeStatusController || typeof options.nodeStatusController.status !== 'function') {
      throw new TypeError('Node lifecycle requires a node status controller');
    }
    this.nodeStatusController = options.nodeStatusController;
    this.dependencies = { ...defaultDependencies(), ...options.dependencies };
    this.verifyTimeoutMs = Number.isFinite(options.verifyTimeoutMs)
      ? Math.max(0, options.verifyTimeoutMs)
      : DEFAULT_VERIFY_TIMEOUT_MS;
    this.verifyIntervalMs = Number.isFinite(options.verifyIntervalMs)
      ? Math.max(1, options.verifyIntervalMs)
      : DEFAULT_VERIFY_INTERVAL_MS;
  }

  async lifecycle(input, context = {}) {
    const before = await this.#readService(input.service);
    const classification =
      typeof context.classifyEffect === 'function'
        ? await context.classifyEffect({
            domain: 'node',
            action: {
              service: input.service,
              transport: 'freedom_lifecycle',
              action: input.action,
            },
            trustedContext: {
              authority: 'Freedom node manager',
              semantics: 'Start, stop, or restart one integrated node service',
            },
          })
        : unknownClassification('classifier_unavailable');
    const policy = decideEffectPolicy(classification, {
      minimumEffect: EFFECTS.REVERSIBLE_ADMIN,
    });
    if (typeof context.requestApproval !== 'function') {
      throw new AutomationError(
        ERROR_CODES.APPROVAL_REQUIRED,
        'This node lifecycle action requires user approval'
      );
    }
    const decision = await context.requestApproval({
      action: 'node_lifecycle',
      operation: OPERATIONS.NODE_LIFECYCLE,
      label: `${input.action} ${input.service}`,
      nodeLifecycle: {
        service: input.service,
        action: input.action,
        effect: policy.effect,
        beforeState: before.state,
        classification: policy.classification,
      },
    });
    if (!approved(decision)) {
      throw new AutomationError(
        ERROR_CODES.USER_CANCELLED,
        'The user declined the node lifecycle action'
      );
    }
    if (context.signal?.aborted) {
      throw new AutomationError(ERROR_CODES.USER_CANCELLED, 'The node lifecycle action was cancelled');
    }

    await this.#apply(input.service, input.action);
    const after = await this.#verify(input.service, input.action, context.signal);
    const summary = Object.freeze({
      service: input.service,
      action: input.action,
      effect: policy.effect,
      beforeState: before.state,
      afterState: after.state,
      verified: true,
    });
    return Object.freeze({ ...summary, summary });
  }

  async #apply(service, action) {
    const chainId = chainIdForService(service);
    const start =
      chainId === null
        ? this.dependencies[`start${service[0].toUpperCase()}${service.slice(1)}`]
        : () => this.dependencies.startMyotis(chainId);
    const stop =
      chainId === null
        ? this.dependencies[`stop${service[0].toUpperCase()}${service.slice(1)}`]
        : () => this.dependencies.stopMyotis(chainId);
    if (typeof start !== 'function' || typeof stop !== 'function') {
      throw new AutomationError(
        ERROR_CODES.CAPABILITY_UNAVAILABLE,
        `Freedom cannot manage the ${service} node lifecycle`
      );
    }
    if (action === 'restart') {
      await stop();
      await start();
    } else if (action === 'start') {
      await start();
    } else {
      await stop();
    }
  }

  async #readService(service) {
    const snapshot = await this.nodeStatusController.status();
    const node = snapshot?.nodes?.find((candidate) => candidate.id === service);
    if (!node) {
      throw new AutomationError(
        ERROR_CODES.CAPABILITY_UNAVAILABLE,
        `Freedom cannot read the ${service} node state`
      );
    }
    return node;
  }

  async #verify(service, action, signal) {
    const deadline = Date.now() + this.verifyTimeoutMs;
    let node = await this.#readService(service);
    while (!expectedState(action, node.state) && Date.now() < deadline) {
      if (
        (action !== 'stop' && START_TERMINAL_FAILURE_STATES.has(node.state)) ||
        (action === 'stop' && node.state === 'error')
      ) {
        break;
      }
      if (signal?.aborted) {
        throw new AutomationError(
          ERROR_CODES.USER_CANCELLED,
          'The node lifecycle verification was cancelled'
        );
      }
      await wait(this.verifyIntervalMs);
      node = await this.#readService(service);
    }
    if (!expectedState(action, node.state)) {
      throw new AutomationError(
        ERROR_CODES.CAPABILITY_UNAVAILABLE,
        `Freedom could not verify that ${service} reached the expected state after ${action}`
      );
    }
    return node;
  }
}

module.exports = {
  NodeLifecycleController,
  RUNNING_STATES,
  STOPPED_STATES,
  chainIdForService,
  expectedState,
};
