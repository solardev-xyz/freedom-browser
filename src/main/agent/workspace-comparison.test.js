const { compareEntries, textPreview } = require('./workspace-comparison');
const file = (path, oid, mode = '100644') => ({ path, oid, mode });
test('tree comparison reports changes and only unambiguous exact renames', () => {
  expect(compareEntries([file('old', 'a'), file('same', 'b'), file('mode', 'c')], [file('new', 'a'), file('same', 'b'), file('mode', 'c', '100755')])).toEqual([
    { path: 'mode', status: 'modified' }, { path: 'new', status: 'renamed', oldPath: 'old' },
  ]);
  expect(compareEntries([file('old', 'a')], [file('one', 'a'), file('two', 'a')]).every(change => change.status !== 'renamed')).toBe(true);
});
test('text paging preserves unicode, marks binary and reports continuation', () => {
  const text = 'ä'.repeat(70000); const first = textPreview(Buffer.from(text));
  expect(first.nextOffset).toBe(65536); expect(first.text + textPreview(Buffer.from(text), first.nextOffset).text).toBe(text);
  expect(textPreview(Buffer.from([0, 1]))).toMatchObject({ binary: true, text: '' });
});
