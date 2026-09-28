'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { SwarmPublicationStore } = require('./swarm-publication-store');

test('persists receipts atomically, isolates owners on deletion and preserves the journal on write failure', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-publication-store-'));
  try {
    const store = new SwarmPublicationStore(directory);
    const record = { publicationId: `swarm_pub_${'a'.repeat(24)}`, ownerId: 'one', state: 'confirming', reference: 'b'.repeat(64) };
    store.save(record);
    const write = jest.spyOn(fs, 'writeFileSync').mockImplementationOnce(() => { throw new Error('disk full'); });
    expect(() => store.save({ ...record, state: 'completed' })).toThrow('disk full');
    write.mockRestore();
    expect(new SwarmPublicationStore(directory).list()).toEqual([record]);
    store.deleteConversation('other');
    expect(store.list()).toEqual([record]);
    store.deleteConversation('one');
    expect(new SwarmPublicationStore(directory).list()).toEqual([]);
  } finally { jest.restoreAllMocks(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test('does not prune unresolved uploads to make room for another publication', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-publication-store-'));
  try {
    const records = Array.from({ length: 500 }, (_, index) => ({
      publicationId: `swarm_pub_${index.toString(16).padStart(24, '0')}`,
      ownerId: 'one', state: 'outcome_unknown',
    }));
    fs.writeFileSync(path.join(directory, 'agent-publications.json'), JSON.stringify(records));
    const store = new SwarmPublicationStore(directory);
    expect(() => store.save({ publicationId: `swarm_pub_${'f'.repeat(24)}`, ownerId: 'one', state: 'uploading' })).toThrow('Too many pending publications');
    expect(new SwarmPublicationStore(directory).list()).toEqual(records);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
