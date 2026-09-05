'use strict';

const {
  HISTORY_LIMITS,
  historyPathReason,
  historyContainsSecret,
} = require('./workspace-history-policy');

const WORKSPACE_HISTORY_HELPER = String.raw`
const HISTORY_LIMITS = ${JSON.stringify(HISTORY_LIMITS)};
${historyPathReason.toString()}
${historyContainsSecret.toString()}

function historyReadFile(relativePath) {
  const { target } = targetPath(relativePath);
  regularFile(target);
  const fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stats = fs.fstatSync(fd);
    if (!stats.isFile() || stats.nlink !== 1) fail('WORKSPACE_FILE_UNSAFE');
    if (stats.size > HISTORY_LIMITS.fileBytes) return { excluded: 'large file' };
    const bytes = Buffer.alloc(stats.size + 1);
    const count = fs.readSync(fd, bytes, 0, bytes.length, 0);
    const after = fs.fstatSync(fd);
    if (count !== stats.size || after.size !== stats.size || after.mtimeMs !== stats.mtimeMs || after.ctimeMs !== stats.ctimeMs) fail('WORKSPACE_HISTORY_CHANGED');
    const content = bytes.subarray(0, count);
    if (historyContainsSecret(content)) return { excluded: 'possible secret content' };
    return { path: relativePath, content: content.toString('base64'), mode: stats.mode & 0o111 ? '100755' : '100644' };
  } finally { fs.closeSync(fd); }
}

function historySnapshot() {
  const requested = encoded ? JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')).paths : null;
  if (requested && (!Array.isArray(requested) || requested.length > 400 || requested.some((value) => historyPathReason(value)))) fail('WORKSPACE_FILE_UNSAFE');
  const candidates = [...new Set(gitRead(['ls-files', '--cached', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean))].filter((value) => !requested || requested.includes(value)).sort();
  if (candidates.length > 2000) fail('WORKSPACE_HISTORY_TOO_LARGE');
  const files = [];
  const excluded = [];
  let total = 0;
  for (const relativePath of candidates) {
    const reason = historyPathReason(relativePath);
    if (reason) { excluded.push({ path: relativePath.slice(0, 1024), reason }); continue; }
    let file;
    try { file = historyReadFile(relativePath); }
    catch (error) {
      if (error.code === 'ENOENT') continue;
      if (error.code === 'WORKSPACE_HISTORY_CHANGED') throw error;
      excluded.push({ path: relativePath, reason: 'unsafe file or link' });
      continue;
    }
    if (file.excluded) { excluded.push({ path: relativePath, reason: file.excluded }); continue; }
    total += Buffer.byteLength(file.content, 'base64');
    if (files.length >= HISTORY_LIMITS.files || total > HISTORY_LIMITS.totalBytes) fail('WORKSPACE_HISTORY_TOO_LARGE');
    files.push(file);
  }
  return { files, excluded: excluded.slice(0, 200), excludedCount: excluded.length };
}

function historyValidateRestore() {
  const entries = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
  if (!Array.isArray(entries) || entries.length > HISTORY_LIMITS.files * 2) fail('WORKSPACE_HISTORY_TOO_LARGE');
  for (const entry of entries) {
    if (historyPathReason(entry.path)) fail('WORKSPACE_FILE_UNSAFE');
    let current = null;
    try { current = historyReadFile(entry.path); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (current?.excluded) fail('WORKSPACE_HISTORY_CHANGED');
    const digest = current ? require('crypto').createHash('sha256').update(current.mode + ':' + current.content).digest('hex') : null;
    if (digest !== entry.expected) fail('WORKSPACE_HISTORY_CHANGED');
  }
  writeJson({ valid: true });
}

function historyRestoreEntry() {
  const input = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
  if (historyPathReason(relative) || !input || !['write', 'remove'].includes(input.action)) fail('WORKSPACE_FILE_UNSAFE');
  let current = null;
  try { current = historyReadFile(relative); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (current?.excluded) fail('WORKSPACE_HISTORY_CHANGED');
  const digest = current ? require('crypto').createHash('sha256').update(current.mode + ':' + current.content).digest('hex') : null;
  if (digest !== input.expected) fail('WORKSPACE_HISTORY_CHANGED');
  if (input.action === 'remove') {
    // Exact eligible files only; never recursively remove directories or ignored files.
    if (current) fs.unlinkSync(targetPath(relative).target);
    writeJson({ applied: true });
    return;
  }
  const content = Buffer.from(input.content, 'base64');
  if (content.length > HISTORY_LIMITS.fileBytes || historyContainsSecret(content) || !['100644', '100755'].includes(input.mode)) fail('WORKSPACE_FILE_UNSAFE');
  const parent = ensureDirectory(path.posix.dirname(relative));
  const destination = path.join(parent, path.posix.basename(relative));
  const fd = fs.openSync(destination, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK, 0o600);
  try {
    const stats = fs.fstatSync(fd);
    if (!stats.isFile() || stats.nlink !== 1) fail('WORKSPACE_FILE_UNSAFE');
    fs.ftruncateSync(fd, 0);
    fs.writeFileSync(fd, content);
    fs.fchmodSync(fd, input.mode === '100755' ? 0o700 : 0o600);
  } finally { fs.closeSync(fd); }
  writeJson({ applied: true });
}
`;

module.exports = { WORKSPACE_HISTORY_HELPER };
