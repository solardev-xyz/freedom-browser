/**
 * Ant's background batch rediscovery, as seen from the bundled node's log.
 *
 * Since Ant v0.5.58 (#506, freedom-hq/ant#118/#120), `/health.chainReady`
 * no longer waits for antd to rediscover the postage batches its wallet owns
 * on chain. Until antd logs "background batch rediscovery finished", `GET
 * /stamps` lists only the batches reloaded from the data dir's `postage/`
 * store: on the first start of a wallet with history (a fresh data dir, a
 * key restored onto another device, a first scan that was cut short) that
 * can be a long window, and publish setup must not offer to buy storage the
 * wallet already owns in it (#510).
 *
 * Ant's HTTP API reports nothing about this scan (checked against the
 * bundled v0.5.58: `/health` carries `status`, `version`, `apiVersion` and
 * `chainReady` only). A `walletScan` field on `/health` is planned upstream
 * (#493); until it ships, the two log lines below are the only signal, and
 * only for a node Freedom spawned and reads the output of. Both are matched
 * as plain substrings of antd's `tracing` output (the message text is not
 * coloured), copied verbatim from `crates/antd/src/main.rs` at v0.5.58:
 *
 *   - FINISHED: logged once per start, after the background pass has added
 *     every batch it found. Also logged after a failed scan, with nothing
 *     added, so FAILED must be remembered across it.
 *   - FAILED: the transfer scan or the batch reads failed; antd carries on
 *     with the batches it has and does not retry until the next start.
 *
 * A node started without a write RPC rediscovers before `chainReady` and
 * never logs FINISHED; Freedom always passes one to the bundled node
 * (ant-manager.js). Callers still bound how long they trust a `running`
 * state, since a renamed log line or a `RUST_LOG` above `info` would leave it
 * running forever.
 */

const FINISHED_LINE = 'background batch rediscovery finished';
const FAILED_LINE = 'postage batch rediscovery scan failed';

function createRediscoveryTracker({ now = () => Date.now() } = {}) {
  let current = null;
  let runs = 0;
  const listeners = new Set();

  function notify() {
    const snapshot = get();
    for (const listener of listeners) {
      try {
        listener(snapshot);
      } catch {
        // A failing subscriber must not stop the others or the log pipe.
      }
    }
  }

  function get() {
    return current ? { ...current } : null;
  }

  /**
   * A bundled node is being spawned: its rediscovery has not finished.
   * `startedAt` is the spawn time, which callers bound the hold from.
   */
  function begin() {
    current = { run: ++runs, state: 'running', failed: false, startedAt: now() };
    notify();
    return current.run;
  }

  /** The node this tracker followed is gone, or Freedom does not own it. */
  function end(run = null) {
    if (!current || (run !== null && current.run !== run)) return;
    current = null;
    notify();
  }

  /**
   * One line of the node's output. `run` is the spawn it came from, so a
   * line still draining from a previous process cannot mark a new one done.
   */
  function noteLine(run, line) {
    if (!current || current.run !== run || current.state !== 'running') return;
    if (typeof line !== 'string') return;
    if (line.includes(FAILED_LINE)) {
      current = { ...current, failed: true };
      notify();
      return;
    }
    if (line.includes(FINISHED_LINE)) {
      current = { ...current, state: 'finished' };
      notify();
    }
  }

  function onChange(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  return { begin, end, noteLine, get, onChange };
}

module.exports = { createRediscoveryTracker, FINISHED_LINE, FAILED_LINE };
