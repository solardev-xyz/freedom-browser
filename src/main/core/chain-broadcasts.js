/**
 * Main's record of every `chain.broadcast` in flight (freedom-core design
 * 0005, Broadcast, Main's record). The core can die mid-broadcast (an exit,
 * the watchdog, a protocol error), and then no outcome comes back: main
 * reports one from its own record instead.
 *
 * - **Marking:** main's executors mark a record as they start an exchange
 *   that sends its bytes on its chain: a `shell.rpc` whose body is an
 *   `eth_sendRawTransaction` of them, or a Myotis `broadcast` of them.
 *   Every open record of those bytes is marked, whichever broadcast the
 *   core sent them for: a mark only ever makes an outcome less certain.
 * - **No reply from the core:** `uncertain` once marked, `not_sent`
 *   otherwise. Main never reports `rejected` on its own.
 *
 * The same signed bytes match in any hex case: they are one transaction.
 */

/** A raw transaction's key: its hex, in one case; null for anything that
 * isn't text, which no exchange sends. */
const keyOf = (raw) => (typeof raw === 'string' ? raw.toLowerCase() : null);

class BroadcastRecords {
  constructor() {
    this.open = new Set();
  }

  /** Opens the record of a broadcast of `raw` on `chainId`, before the
   * core can start it. */
  begin(chainId, raw) {
    const record = { chainId, raw: keyOf(raw), sent: false, source: null };
    this.open.add(record);
    return record;
  }

  /** Closes a record: its broadcast has its outcome. */
  end(record) {
    this.open.delete(record);
  }

  /** An executor starts an exchange that sends `raw` on `chainId` through
   * `source` (`direct` or `myotis`): every open record of those bytes is
   * possibly sent from now on. */
  sending(chainId, raw, source) {
    const key = this.open.size === 0 ? null : keyOf(raw);
    if (key === null) return;
    for (const record of this.open) {
      if (record.chainId === chainId && record.raw === key) {
        record.sent = true;
        record.source = source;
      }
    }
  }

  /** A `shell.rpc` exchange with `body` starts on one of `chainId`'s
   * endpoints: one that sends a raw transaction marks its records. Its body
   * is read only while a broadcast is open, and only when it names the
   * method. */
  exchanging(chainId, body) {
    if (this.open.size === 0 || !body.includes('"eth_sendRawTransaction"')) return;
    let request;
    try {
      request = JSON.parse(body);
    } catch {
      return;
    }
    if (request?.method !== 'eth_sendRawTransaction' || !Array.isArray(request.params)) return;
    this.sending(chainId, request.params[0], 'direct');
  }
}

module.exports = { BroadcastRecords };
