'use strict';

// Compare already-authorized tree entries, never paths supplied to a shell.
function compareEntries(before, after) {
  const old = new Map(before.map(file => [file.path, file]));
  const next = new Map(after.map(file => [file.path, file]));
  const files = [];
  for (const file of after) {
    const previous = old.get(file.path);
    if (!previous) files.push({ path: file.path, status: 'added' });
    else if (previous.oid !== file.oid || previous.mode !== file.mode) files.push({ path: file.path, status: 'modified' });
  }
  for (const file of before) if (!next.has(file.path)) files.push({ path: file.path, status: 'deleted' });
  // Only exact-content, same-mode renames are inferred. Ambiguous duplicates
  // stay additions/deletions rather than claiming a false rename.
  for (const added of files.filter(file => file.status === 'added')) {
    const value = next.get(added.path);
    const candidates = files.filter(file => file.status === 'deleted' && old.get(file.path).oid === value.oid && old.get(file.path).mode === value.mode);
    const twins = files.filter(file => file.status === 'added' && next.get(file.path).oid === value.oid);
    if (candidates.length === 1 && twins.length === 1) {
      added.status = 'renamed'; added.oldPath = candidates[0].path;
      files.splice(files.indexOf(candidates[0]), 1);
    }
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

function textPreview(bytes, offset = 0) {
  const binary = bytes.includes(0);
  const text = binary ? '' : bytes.toString('utf8');
  // Character paging avoids splitting UTF-8 byte sequences between reads.
  const end = offset + 65536;
  return { text: text.slice(offset, end), binary, offset, truncated: text.length > end,
    nextOffset: text.length > end ? end : null, size: bytes.length };
}

module.exports = { compareEntries, textPreview };
