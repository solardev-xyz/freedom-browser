const fs = require('fs');
const path = require('path');
const { createHash } = require('crypto');
const root = path.resolve(__dirname, '..');
const rawIndex = fs.readFileSync(path.join(root, 'docs/railgun-qualification-archive.json'));
const index = JSON.parse(rawIndex);
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

test('archive reference pins the reviewed manifest and retained-input mapping', () => {
  expect(sha(rawIndex)).toBe('9a9ddb85dc325fb1308d0e2f8f8266e7de152d63f4d54d74e93770138c60e57f');
  expect(index.archiveCommit).toBe('377c2a5d1aca18f0ed328dfdda955bd7d1ba271c');
  expect(index.archiveTree).toBe('4fc082b216692f1ee92c089ec8d9414aba29ab7e');
  expect(index.archiveManifestSha256).toBe(
    'ad170fca262809aea199ae2977e75df0ba8a5b5c524bbbbc721e0b41d7d140a8'
  );
  expect(index.retainedInputs).toHaveLength(17);
  expect(new Set(index.retainedInputs.map((row) => row.path)).size).toBe(17);
});

test.each(index.retainedInputs)('retained public input matches archive: $path', (row) => {
  const file = path.join(root, row.path);
  expect(fs.lstatSync(file).isFile()).toBe(true);
  expect(fs.realpathSync(file)).toBe(file);
  const bytes = fs.readFileSync(file);
  expect(bytes.length).toBe(row.bytes);
  expect(sha(bytes)).toBe(row.sha256);
  const blob = createHash('sha1')
    .update(Buffer.from('blob ' + bytes.length + '\0'))
    .update(bytes)
    .digest('hex');
  expect(blob).toBe(row.gitBlob);
});
