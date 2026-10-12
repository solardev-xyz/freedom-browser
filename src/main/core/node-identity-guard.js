/**
 * Whether a managed node may start on its vault-backed identity (freedom-core
 * design 0001, "Multi-file writes": start a node only on `installed`).
 *
 * Three things can hold a node back:
 * - **The core's report.** core.hello's `node_recovery`, after startup
 *   recovery: writes recovery couldn't finish, or nodes left corrupt. Each
 *   hello replaces it; a report without a node covers every node.
 * - **Main's own writes.** From the moment main starts re-keying a node (before
 *   it stops and wipes it) until a write is known to be `installed`. An
 *   unknown or failed outcome keeps the block: the node's files may be wiped or
 *   half written. A later core report doesn't lift it; only `installed` does.
 * - **No report yet.** Until a hello has reported recovery (at startup, and
 *   after the core exits until it is back), nothing is known. Starts are held
 *   unless the identity directory has nothing to protect: no vault and no node
 *   journal (a profile that never set up an identity).
 *
 * Callers check at their start boundary, after their last await, so a block
 * that arrives while a start is preparing still stops it.
 */

const fs = require('fs');
const path = require('path');

const NODES = ['bee', 'radicle'];
// The core's files in the identity directory that mean "something to
// protect" (freedom-core: fc-vault's vault file and the node journal's).
const IDENTITY_FILES = [
  'identity-vault.json',
  'node-identity-journal.json',
  'node-identity-staging.json',
  'node-identity-unresolved.json',
];

const reported = new Map(); // node -> status, from the last core.hello
const writes = new Map(); // node -> status, main's own outstanding writes
let known = false;
let identityDir = null;

/** Where the core keeps its files, for the "nothing to protect" check. */
function setIdentityDir(dir) {
  identityDir = dir;
}

/**
 * From core.hello, on every core (re)start: `{ status, op_id?, node? }` or
 * null. Recovery has just run, so it replaces the previous report.
 */
function setStartupRecovery(report) {
  known = true;
  reported.clear();
  if (!report) return;
  for (const node of report.node ? [report.node] : NODES) {
    reported.set(node, report.status);
  }
}

/** The core exited or couldn't start: unknown until the next hello. */
function setRecoveryUnknown() {
  known = false;
}

/** Main is re-keying `node`, or its write ended without `installed`. */
function blockNode(node, status) {
  writes.set(node, status);
}

/** A write installed `node`'s identity. */
function unblockNode(node) {
  writes.delete(node);
  reported.delete(node);
}

function nothingToProtect() {
  if (!identityDir) return false;
  try {
    return IDENTITY_FILES.every((name) => !fs.existsSync(path.join(identityDir, name)));
  } catch {
    return false;
  }
}

function describe(status) {
  switch (status) {
    case 'corrupt':
      return 'Node identity is incomplete; set up node identities again from the wallet';
    case 'writing':
      return 'Node identity is being updated';
    case 'unknown':
      return 'The identity core is not available; restart Freedom';
    default:
      return 'Node identity update did not finish; restart Freedom to complete it';
  }
}

/**
 * Why `node` must not start, or null.
 * @param {'bee'|'radicle'} node
 * @returns {string|null}
 */
function nodeBlockReason(node) {
  const status = writes.get(node) || reported.get(node);
  if (status) return describe(status);
  if (!known && !nothingToProtect()) return describe('unknown');
  return null;
}

module.exports = {
  setIdentityDir,
  setStartupRecovery,
  setRecoveryUnknown,
  blockNode,
  unblockNode,
  nodeBlockReason,
  _internal: {
    reset() {
      reported.clear();
      writes.clear();
      known = false;
      identityDir = null;
    },
  },
};
