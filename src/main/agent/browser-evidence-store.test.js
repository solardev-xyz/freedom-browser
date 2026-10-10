'use strict';
const { BrowserEvidenceStore } = require('./browser-evidence-store');
const { OPERATIONS } = require('../automation/contract/operations');
const observation = (text) => ({
  ok: true,
  result: {
    title: 'Old page',
    text,
    documentId: 'doc',
    elements: [{ ref: 'ref_secret', name: 'Continue' }],
    frames: [{ viewport: { ref: 'scroll_secret' } }],
  },
});

test('retrieves immutable historical text after live state and context have changed, without action authority', () => {
  const store = new BrowserEvidenceStore();
  const envelope = observation('Earlier receipt ABC-72');
  const id = store.record(OPERATIONS.SNAPSHOT, envelope);
  envelope.result.text = 'Changed page';
  const index = store.recall({ query: 'abc-72' });
  expect(index.entries.map((entry) => entry.id)).toEqual([id]);
  const result = store.recall({ id });
  expect(result).toMatchObject({ historical: true, live: false, found: true });
  expect(result.text).toContain('Earlier receipt ABC-72');
  expect(result.text).not.toMatch(/ref_secret|scroll_secret|documentId/);
  expect(store.recall({ query: 'not present' }).entries).toEqual([]);
  expect(new BrowserEvidenceStore().recall({ id }).found).toBe(false);
});

test('reports clipping, pagination and bounded eviction; excludes screenshots and submitted inputs', () => {
  const store = new BrowserEvidenceStore();
  expect(
    store.record(OPERATIONS.SCREENSHOT, { ok: true, result: { base64: 'pixels' } })
  ).toBeNull();
  const oldest = store.record(OPERATIONS.SNAPSHOT, observation('earliest'));
  let newest;
  for (let i = 0; i < 40; i++)
    newest = store.record(OPERATIONS.SNAPSHOT, observation('😀'.repeat(40000)));
  expect(store.bytes).toBeLessThanOrEqual(512 * 1024);
  expect(store.entries.size).toBeLessThanOrEqual(32);
  expect(store.recall({ id: oldest }).found).toBe(false);
  const chunk = store.recall({ id: newest });
  expect(chunk.truncated).toBe(true);
  expect(chunk.text.length).toBe(8000);
  expect(chunk.nextOffset).toBe(8000);
  expect(store.recall().evicted).toBeGreaterThan(0);
  expect(store.recall({ id: newest, offset: 64000 }).nextOffset).toBeNull();
});

test('validates retrieval input and does not retain failures or arbitrary operations', () => {
  const store = new BrowserEvidenceStore();
  expect(store.record(OPERATIONS.TYPE, { ok: false })).toBeNull();
  expect(
    store.record(OPERATIONS.WALLET_TRANSFER, { ok: true, result: { sensitive: 'secret' } })
  ).toBeNull();
  for (const input of [
    { offset: -1 },
    { offset: 1.5 },
    { query: 'a'.repeat(201) },
    { id: 'file:///anything' },
  ])
    expect(() => store.recall(input)).toThrow();
});
