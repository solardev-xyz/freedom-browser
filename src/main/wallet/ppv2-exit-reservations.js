/** The encrypted public journal, not the disposable SDK cache, owns exit
 * reservations. Inclusion, generic resolution and archival never release one.
 * Releasing a failed exit requires a separate reviewed recovery policy.
 */
const { privacyError } = require('../networks/privacy-context');
const { isExitIntent } = require('./private-transaction-intent');
const { safeNotes } = require('./ppv2-note-recovery');
const recovery = () =>
  privacyError('PRIVATE_PPV2_EXIT_RECOVERY_REQUIRED', 'Public exit history requires recovery');
const reserved = () =>
  privacyError('PRIVATE_PPV2_EXIT_RESERVED', 'Selected note has a recorded exit attempt');

function createPPv2ExitReservations({ journal, pool }) {
  async function commitments() {
    // Read live records first: an intervening archive may duplicate a record,
    // but cannot hide it between these two reads.
    const records = [...(await journal.list()), ...(await journal.listArchive())];
    const result = new Set();
    for (const record of records) {
      if (!record.intent || (isExitIntent(record.intent) && !record.intent.commitment))
        throw recovery();
      if (isExitIntent(record.intent) && record.intent.pool === pool.toLowerCase())
        result.add(record.intent.commitment);
    }
    return result;
  }
  async function assertAvailable(commitment) {
    if ((await commitments()).has(commitment?.toLowerCase())) throw reserved();
  }
  async function assertSelectable(values, asset) {
    const held = await commitments();
    // The pinned adapter chooses inputs itself. Avoid asking it for a quote
    // while its current active set still includes a held input of this asset.
    for (const note of safeNotes(values)) {
      if (
        note.status === 'active' &&
        held.has(note.commitment) &&
        note.asset.__type === asset.__type &&
        (asset.__type === 'native' || note.asset.contract === asset.contract)
      )
        throw reserved();
    }
  }
  async function notes(values) {
    const held = await commitments();
    return Object.freeze(
      safeNotes(values).map((note) =>
        held.has(note.commitment) && !['spent', 'exited'].includes(note.status)
          ? Object.freeze({ ...note, status: 'exit_pending', labelState: 'unknown' })
          : note
      )
    );
  }
  async function balance(values) {
    const totals = new Map();
    for (const note of await notes(values)) {
      if (['spent', 'exited'].includes(note.status)) continue;
      const key = note.asset.__type === 'native' ? 'native' : note.asset.contract;
      if (!totals.has(key)) totals.set(key, { asset: note.asset, spendable: 0n, unspendable: 0n });
      totals.get(key)[note.status === 'active' ? 'spendable' : 'unspendable'] += note.value;
    }
    return Object.freeze(
      [...totals.values()].flatMap((entry) =>
        ['spendable', 'unspendable'].map((tag) =>
          Object.freeze({ asset: entry.asset, amount: entry[tag], tag })
        )
      )
    );
  }
  return Object.freeze({ assertAvailable, assertSelectable, notes, balance });
}
module.exports = { createPPv2ExitReservations };
