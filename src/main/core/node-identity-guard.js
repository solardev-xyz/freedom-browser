/**
 * Nodes whose identity write the core couldn't finish (freedom-core design
 * 0001, "Multi-file writes"): reported by core.hello's `node_recovery` after
 * startup recovery, or by a `nodes.write_identity` result other than
 * `installed`. Main keeps such a node stopped until a later write installs
 * its identity (design 0001: start a node only on `installed`).
 */

const blocked = new Map(); // node -> status

const NODES = ['bee', 'radicle'];

/**
 * From core.hello, on every core (re)start: `{ status, op_id?, node? }` or
 * null. Recovery has just run, so the core's report replaces what was known;
 * a report without a node covers every node.
 */
function setStartupRecovery(report) {
  blocked.clear();
  if (!report) return;
  for (const node of report.node ? [report.node] : NODES) {
    blocked.set(node, report.status);
  }
}

function blockNode(node, status) {
  blocked.set(node, status);
}

function unblockNode(node) {
  blocked.delete(node);
}

/**
 * Why `node` must not start, or null.
 * @param {'bee'|'radicle'} node
 * @returns {string|null}
 */
function nodeBlockReason(node) {
  const status = blocked.get(node);
  if (!status) return null;
  return status === 'corrupt'
    ? 'Node identity is incomplete; set up node identities again from the wallet'
    : 'Node identity update did not finish; restart Freedom to complete it';
}

module.exports = { setStartupRecovery, blockNode, unblockNode, nodeBlockReason };
