/** Fresh reconstruction is evidence for recovery, never permission to replace
 * the encrypted cache or forget notes missing from an unverified remote view.
 */
const { getPrivacyContext, privacyError } = require('../networks/privacy-context');
const { FIELD } = require('./ppv2-deposit-policy');
const hash = (v) => typeof v === 'string' && /^0x[0-9a-f]{64}$/i.test(v);
const statuses = ['inactive', 'pending', 'active', 'rejected', 'spent', 'exit_pending', 'exited'];
const fail = () => privacyError('PRIVATE_PPV2_RECOVERY_FAILED', 'PPv2 note recovery could not be inspected');
function safeNotes(notes) {
  if (!Array.isArray(notes) || notes.length > 4096) throw fail();
  const seen = new Set();
  return Object.freeze(notes.map((note) => {
    if (!hash(note.commitment) || BigInt(note.commitment) >= FIELD || seen.has(note.commitment.toLowerCase()) ||
        typeof note.value !== 'bigint' || note.value < 0n || note.value >= 1n << 128n ||
        !statuses.includes(note.status) || !['pending', 'approved', 'revoked', 'unknown'].includes(note.labelState)) throw fail();
    const asset = note.asset?.__type === 'native' ? { __type: 'native' }
      : note.asset?.__type === 'erc20' && /^0x[0-9a-f]{40}$/i.test(note.asset.contract)
        ? { __type: 'erc20', contract: note.asset.contract.toLowerCase() } : null;
    if (!asset) throw fail();
    seen.add(note.commitment.toLowerCase());
    return Object.freeze({ commitment: note.commitment.toLowerCase(), asset: Object.freeze(asset), value: note.value,
      status: note.status, labelState: note.labelState });
  }));
}

async function inspectPPv2NoteRecovery({ handle, createPlugin, host, params, plugin }) {
  const assertActive = () => getPrivacyContext(handle);
  const values = new Map();
  let open = true;
  const check = (name) => {
    assertActive();
    if (!open || typeof name !== 'string' || name.length > 256 || !name.startsWith('ppv2:controlled:')) throw fail();
  };
  // Fresh SDK state cannot access the persistent cache, even by key name.
  // Bound both individual values and total storage just like the disk store.
  const storage = Object.freeze({ _brand: 'Storage',
    async get(name) { check(name); return values.get(name) ?? null; },
    async set(name, value) {
      check(name);
      if (typeof value !== 'string' || Buffer.byteLength(value) > 1024 * 1024 ||
          (!values.has(name) && values.size >= 256)) throw fail();
      const bytes = [...values].reduce((size, [key, content]) => size + (key === name ? 0 : Buffer.byteLength(content)), 0);
      if (bytes + Buffer.byteLength(value) > 4 * 1024 * 1024) throw fail();
      values.set(name, value);
    } });
  try {
    assertActive();
    // Export remains inside main and is reduced immediately to commitments.
    // It contains SDK secrets; never return it or include it in diagnostics.
    const exported = await plugin.exportAccount();
    assertActive();
    if (typeof exported !== 'string' || Buffer.byteLength(exported) > 4 * 1024 * 1024) throw fail();
    const cached = JSON.parse(exported).notes;
    if (!Array.isArray(cached) || cached.length > 4096 || !cached.every((note) => hash(note.commitment))) throw fail();
    const commitments = new Set(cached.map((note) => note.commitment.toLowerCase()));
    const fresh = await createPlugin(Object.freeze({ ...host, storage }), params);
    assertActive();
    const notes = safeNotes(await fresh.notes(undefined, true));
    assertActive();
    const recovered = new Set(notes.map((note) => note.commitment));
    return Object.freeze({ notes, missingFromScan: Object.freeze([...commitments].filter((id) => !recovered.has(id))),
      newlyDiscovered: Object.freeze([...recovered].filter((id) => !commitments.has(id))),
      chainStateVerified: false, historyCompletenessVerified: false, cacheReplaced: false,
      requiresReview: true });
  } catch {
    assertActive();
    throw fail();
  } finally { open = false; values.clear(); }
}
module.exports = { inspectPPv2NoteRecovery };
