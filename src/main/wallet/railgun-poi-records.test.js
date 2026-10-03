const {
  REQUIRED_LIST,
  normalizePoiNotes,
  normalizePoiStatuses,
  normalizePoiProofs,
  verifyPoiMembership,
  verifyPoiEvent,
} = require('./railgun-poi-records');
const hex = (n) => BigInt(n).toString(16).padStart(64, '0');
const notes = [{ blindedCommitment: '0x' + hex(7), type: 'Shield' }];
// Deliberately order-sensitive stand-in: real Poseidon is qualified separately.
const pair = (a, b) => hex(BigInt('0x' + a) * 3n + BigInt('0x' + b));
function proof(index = 5) {
  const p = { leaf: hex(7), elements: Array(16).fill(hex(2)), indices: hex(index), root: '' };
  let h = p.leaf;
  p.elements.forEach((e, level) => {
    h = index & (2 ** level) ? pair(e, h) : pair(h, e);
  });
  p.root = h;
  return p;
}
test('canonical notes, exact required-list statuses and membership paths are immutable', () => {
  expect(normalizePoiNotes([{ ...notes[0], blindedCommitment: hex(7) }])).toEqual(notes);
  const statuses = normalizePoiStatuses(
    { [notes[0].blindedCommitment]: { [REQUIRED_LIST]: 'Missing' } },
    notes
  );
  expect(statuses[0].status).toBe('Missing');
  expect(Object.isFrozen(statuses[0])).toBe(true);
  const result = verifyPoiMembership([proof()], notes, pair);
  expect(result).toEqual([proof()]);
  expect(Object.isFrozen(result[0].elements)).toBe(true);
});
test('the captured public Sepolia event verifies under the pinned list public key', () => {
  const input = require('../../../scripts/fixtures/railgun-poi-signed-event.json');
  const event = input[0].signedPOIEvent;
  const note = { blindedCommitment: event.blindedCommitment, type: event.type };
  const path = { ...proof(0), leaf: event.blindedCommitment.slice(2) };
  expect(verifyPoiEvent(input, note, path)).toEqual(input[0]);
  // These changes retain a well-shaped record but invalidate signature/provenance.
  for (const change of [
    { index: 1 },
    { type: 'Transact' },
    { blindedCommitment: hex(7) },
    { blindedCommitment: event.blindedCommitment.slice(2) },
    { signature: '0'.repeat(128) },
  ]) {
    const changed = [{ ...input[0], signedPOIEvent: { ...event, ...change } }];
    const changedNote = {
      blindedCommitment: changed[0].signedPOIEvent.blindedCommitment,
      type: changed[0].signedPOIEvent.type,
    };
    const changedPath = {
      ...path,
      leaf: changedNote.blindedCommitment.replace(/^0x/, ''),
      indices: hex(changed[0].signedPOIEvent.index),
    };
    expect(() => verifyPoiEvent(changed, changedNote, changedPath)).toThrow();
  }
  expect(() => verifyPoiEvent([], note, path)).toThrow();
  expect(() => verifyPoiEvent([...input, ...input], note, path)).toThrow();
  expect(() => verifyPoiEvent(input, note, { ...path, indices: hex(1) })).toThrow();
});
test.each(['empty', 'capacity', 'duplicate', 'type', 'extra', 'field'])(
  'refuses %s note requests',
  (kind) => {
    let n = JSON.parse(JSON.stringify(notes));
    if (kind === 'empty') n = [];
    if (kind === 'capacity')
      n = Array.from({ length: 4 }, (_, i) => ({ ...notes[0], blindedCommitment: hex(i) }));
    if (kind === 'duplicate') n.push({ ...n[0], type: 'Transact' });
    if (kind === 'type') n[0].type = 'Unshield';
    if (kind === 'extra') n[0].secret = 'no';
    if (kind === 'field') n[0].blindedCommitment = 'f'.repeat(64);
    expect(() => normalizePoiNotes(n)).toThrow();
  }
);
test.each(['missing', 'foreign-note', 'foreign-list', 'unknown', 'extra-list'])(
  'refuses %s status responses',
  (kind) => {
    let value = { [notes[0].blindedCommitment]: { [REQUIRED_LIST]: 'Valid' } };
    if (kind === 'missing') value = {};
    if (kind === 'foreign-note') value['0x' + hex(8)] = value[notes[0].blindedCommitment];
    if (kind === 'foreign-list') value[notes[0].blindedCommitment] = { other: 'Valid' };
    if (kind === 'unknown') value[notes[0].blindedCommitment][REQUIRED_LIST] = true;
    if (kind === 'extra-list') value[notes[0].blindedCommitment].other = 'Valid';
    expect(() => normalizePoiStatuses(value, notes)).toThrow();
  }
);
test.each(['leaf', 'path', 'index', 'high-index', 'root', 'depth', 'field', 'count', 'shape'])(
  'refuses %s membership changes',
  (kind) => {
    const p = proof();
    let values = [p];
    if (kind === 'leaf') p.leaf = hex(8);
    if (kind === 'path') p.elements[8] = hex(3);
    if (kind === 'index') p.indices = hex(6);
    if (kind === 'high-index') p.indices = hex(65536);
    if (kind === 'root') p.root = hex(9);
    if (kind === 'depth') p.elements.pop();
    if (kind === 'field') p.elements[0] = 'f'.repeat(64);
    if (kind === 'count') values = [];
    if (kind === 'shape') p.other = 'no';
    expect(() => verifyPoiMembership(values, notes, pair)).toThrow();
  }
);
test('proof order must match the fixed notes; prefix encoding is normalized', () => {
  const p = proof();
  p.leaf = '0x' + p.leaf;
  p.root = '0x' + p.root;
  expect(normalizePoiProofs([p], notes)).toEqual([proof()]);
  expect(() =>
    normalizePoiProofs(
      [proof(), proof()],
      [notes[0], { type: 'Transact', blindedCommitment: hex(8) }]
    )
  ).toThrow();
});
