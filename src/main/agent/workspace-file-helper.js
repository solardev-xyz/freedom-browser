'use strict';

const { unsafeWindowsRelativePath } = require('./workspace-execution/windows-paths');
const { WORKSPACE_HISTORY_HELPER } = require('./workspace-history-helper');
const { WORKSPACE_INSPECTION_HELPER } = require('./workspace-inspection-helper');

// Serialized into the isolated file helper; keep this function self-contained.
// Coverage counters belong to the parent process and cannot enter that script.
/* istanbul ignore next */
function workspaceFileVersion(stats, bytes, platform = process.platform) {
  // Applying a Windows sandbox DACL changes ctime without changing the file.
  // Keep the content digest, identity, mode and modification time authoritative.
  const metadata = [stats.dev, stats.ino, stats.mode, stats.mtimeMs];
  if (platform !== 'win32') metadata.push(stats.ctimeMs);
  return require('crypto').createHash('sha256').update(metadata.join(':')).update(bytes).digest('hex');
}
// Windows has a 32K command-line limit; the fixed helper and bounded content
// travel over the private input pipe instead. No temporary executable is needed.
const WINDOWS_FILE_HELPER_BOOTSTRAP = `
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  input += chunk;
  if (input.length > 256 * 1024) process.exit(73);
  const end = input.indexOf('\\n');
  if (end < 0) return;
  process.stdin.destroy();
  const { script, args } = JSON.parse(input.slice(0, end));
  process.argv = [process.execPath, ...args];
  require('vm').runInThisContext(script, { filename: 'freedom-workspace-file' });
});
`;
const WORKSPACE_FILE_HELPER = String.raw`
${unsafeWindowsRelativePath.toString()}
const fs = process.versions.electron ? require('original-fs') : require('fs');
const path = require('path');
const READ_LIMIT = 524288;
const WRITE_LIMIT = 65536;
const DIRECTORY_LIMIT = 500;
const FIND_LIMIT = 1000;
const GREP_LIMIT = 200;
const SCAN_ENTRY_LIMIT = 50000;
const SCAN_BYTE_LIMIT = 16777216;
const OUTPUT_LIMIT = 51200;
const PATTERN_LIMIT = 1000;
const LINE_LIMIT = 500;
const [operation, relative, encoded = '', expected = '', identity = ''] = process.argv.slice(1);
const root = fs.realpathSync(process.cwd());

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function checkedRelative(value, allowRoot = false) {
  if (typeof value !== 'string' || !value || value.includes('\0') || value.includes('\\') || path.posix.isAbsolute(value)) fail('INVALID_WORKSPACE_REQUEST');
  if (value === '.' && allowRoot) return value;
  if (unsafeWindowsRelativePath(value)) fail('INVALID_WORKSPACE_REQUEST');
  const parts = value.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) fail('INVALID_WORKSPACE_REQUEST');
  return parts.join('/');
}

function targetPath(value, allowRoot = false) {
  const safe = checkedRelative(value, allowRoot);
  if (safe === '.') return { safe, target: root };
  const parts = safe.split('/');
  let target = root;
  for (let index = 0; index < parts.length; index += 1) {
    target = path.join(target, parts[index]);
    const stats = fs.lstatSync(target);
    if (stats.isSymbolicLink()) fail('WORKSPACE_FILE_UNSAFE');
    if (index < parts.length - 1 && !stats.isDirectory()) fail('WORKSPACE_PATH_TYPE_MISMATCH');
  }
  return { safe, target };
}

function regularFile(target) {
  const stats = fs.lstatSync(target);
  if (stats.isSymbolicLink()) fail('WORKSPACE_FILE_UNSAFE');
  if (!stats.isFile()) fail('WORKSPACE_PATH_TYPE_MISMATCH');
  if (stats.nlink !== 1) fail('WORKSPACE_FILE_UNSAFE');
  return stats;
}

// Recheck the opened inode: active projects can replace entries after listing.
// NONBLOCK prevents a regular-file-to-FIFO race from hanging a read.
function readRegularFile(target, stats) {
  const fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.nlink !== 1 || opened.ino !== stats.ino || opened.dev !== stats.dev || opened.size > READ_LIMIT) fail('WORKSPACE_FILE_UNSAFE');
    const bytes = Buffer.alloc(opened.size + 1);
    const count = fs.readSync(fd, bytes, 0, bytes.length, 0);
    const after = fs.fstatSync(fd);
    if (after.nlink !== 1 || count !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) fail('WORKSPACE_HISTORY_CHANGED');
    return { content: bytes.subarray(0, count), stats: after };
  } finally { fs.closeSync(fd); }
}

function directory(target) {
  const stats = fs.lstatSync(target);
  if (stats.isSymbolicLink()) fail('WORKSPACE_FILE_UNSAFE');
  if (!stats.isDirectory()) fail('WORKSPACE_PATH_TYPE_MISMATCH');
  return stats;
}

function optionsPayload() {
  let decoded;
  try {
    const raw = Buffer.from(encoded, 'base64');
    if (raw.byteLength > 8192) fail('INVALID_WORKSPACE_REQUEST');
    decoded = raw.byteLength ? JSON.parse(raw.toString('utf8')) : {};
  } catch (error) {
    if (error && error.code === 'INVALID_WORKSPACE_REQUEST') throw error;
    fail('INVALID_WORKSPACE_REQUEST');
  }
  if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) fail('INVALID_WORKSPACE_REQUEST');
  return decoded;
}

function boundedInteger(value, fallback, maximum) {
  if (value === undefined || value === null) return fallback;
  if (!Number.isFinite(value)) fail('INVALID_WORKSPACE_REQUEST');
  return Math.max(1, Math.min(maximum, Math.floor(value)));
}

function searchPattern(value) {
  if (typeof value !== 'string' || value.length > PATTERN_LIMIT || value.includes('\0')) fail('INVALID_WORKSPACE_REQUEST');
  return value;
}

function ignoredPath(relativePath) {
  return relativePath.split('/').some((part) => part === '.git' || part === 'node_modules');
}

function boundedDirectoryNames(directoryPath, limit) {
  const names = [];
  const handle = fs.opendirSync(directoryPath);
  try {
    while (names.length <= limit) {
      const entry = handle.readSync();
      if (!entry) break;
      names.push(entry.name);
    }
  } finally {
    handle.closeSync();
  }
  const limitReached = names.length > limit;
  if (limitReached) names.length = limit;
  names.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  return { names, limitReached };
}

function matchesGlob(relativePath, pattern) {
  try {
    if (pattern.includes('/')) {
      return path.posix.matchesGlob(relativePath, pattern) || path.posix.matchesGlob(relativePath, '**/' + pattern);
    }
    return path.posix.matchesGlob(path.posix.basename(relativePath), pattern);
  } catch {
    fail('INVALID_WORKSPACE_REQUEST');
  }
}

function walkFiles(relativeRoot, visit) {
  const { target } = targetPath(relativeRoot, true);
  const rootStats = fs.lstatSync(target);
  if (rootStats.isSymbolicLink()) fail('WORKSPACE_FILE_UNSAFE');
  let entriesSeen = 0;
  let bytesRead = 0;
  let scanLimitReached = false;

  const visitFile = (filePath, relativePath, stats) => {
    entriesSeen += 1;
    if (entriesSeen > SCAN_ENTRY_LIMIT) {
      scanLimitReached = true;
      return false;
    }
    if (!stats.isFile() || stats.nlink !== 1 || stats.size > READ_LIMIT) return true;
    if (bytesRead + stats.size > SCAN_BYTE_LIMIT) {
      scanLimitReached = true;
      return false;
    }
    const shouldContinue = visit(filePath, relativePath, stats, () => {
      bytesRead += stats.size;
      return readRegularFile(filePath, stats).content;
    });
    return shouldContinue !== false;
  };

  const walkDirectory = (directoryPath, relativeDirectory) => {
    const remaining = Math.max(1, SCAN_ENTRY_LIMIT - entriesSeen + 1);
    const listing = boundedDirectoryNames(directoryPath, remaining);
    const names = listing.names;
    if (listing.limitReached) scanLimitReached = true;
    for (const name of names) {
      const relativePath = relativeDirectory ? relativeDirectory + '/' + name : name;
      if (ignoredPath(relativePath)) continue;
      entriesSeen += 1;
      if (entriesSeen > SCAN_ENTRY_LIMIT) {
        scanLimitReached = true;
        return false;
      }
      const child = path.join(directoryPath, name);
      let stats;
      try {
        stats = fs.lstatSync(child);
      } catch {
        continue;
      }
      if (stats.isSymbolicLink()) continue;
      if (stats.isDirectory()) {
        if (!walkDirectory(child, relativePath)) return false;
      } else {
        entriesSeen -= 1;
        if (!visitFile(child, relativePath, stats)) return false;
      }
    }
    return true;
  };

  if (rootStats.isDirectory()) walkDirectory(target, '');
  else visitFile(target, path.posix.basename(relativeRoot), rootStats);
  return { scanLimitReached };
}

function boundedLine(value) {
  const normalized = value.replace(/\r/g, '');
  return normalized.length > LINE_LIMIT ? { text: normalized.slice(0, LINE_LIMIT) + '…', truncated: true } : { text: normalized, truncated: false };
}

function boundedOutput(value) {
  const buffer = Buffer.from(value, 'utf8');
  if (buffer.byteLength <= OUTPUT_LIMIT) return { output: value, truncated: false };
  return { output: buffer.subarray(0, OUTPUT_LIMIT).toString('utf8'), truncated: true };
}

function writeJson(value) {
  process.stdout.write(JSON.stringify(value));
}

function ensureDirectory(relativeDirectory) {
  const safe = checkedRelative(relativeDirectory, true);
  if (safe === '.') return root;
  let current = root;
  for (const part of safe.split('/')) {
    current = path.join(current, part);
    try {
      const stats = fs.lstatSync(current);
      if (stats.isSymbolicLink() || !stats.isDirectory()) fail('WORKSPACE_FILE_UNSAFE');
    } catch (error) {
      if (!error || error.code !== 'ENOENT') throw error;
      try { fs.mkdirSync(current, { mode: 0o700 }); }
      catch (created) {
        if (created.code !== 'EEXIST') throw created;
        const stats = fs.lstatSync(current);
        if (stats.isSymbolicLink() || !stats.isDirectory()) fail('WORKSPACE_FILE_UNSAFE');
      }
    }
  }
  return current;
}

function writablePath(value) {
  const safe = checkedRelative(value);
  if (safe.split('/').some((part) => part.toLowerCase() === '.git')) fail('WORKSPACE_PROTECTED_PATH');
  return safe;
}

const fileVersion = (${workspaceFileVersion.toString()});

${WORKSPACE_INSPECTION_HELPER}
${WORKSPACE_HISTORY_HELPER}

try {
  if (identity) {
    const stats = fs.statSync(root);
    if (identity !== String(stats.dev) + ':' + String(stats.ino)) fail('WORKSPACE_FILE_UNSAFE');
  }
  if (operation === 'history_snapshot') {
    writeJson(historySnapshot());
  } else if (operation === 'history_restore') {
    historyRestoreEntry();
  } else if (operation === 'history_validate') {
    historyValidateRestore();
  } else if (operation === 'workspace_inspect') {
    writeJson(inspectWorkspace(optionsPayload()));
  } else if (operation === 'access' || operation === 'read' || operation === 'read_version') {
    const { target } = targetPath(relative);
    const stats = regularFile(target);
    if (stats.size > READ_LIMIT) fail('WORKSPACE_FILE_TOO_LARGE');
    if (operation !== 'access') {
      const { content, stats: after } = readRegularFile(target, stats);
      if (operation === 'read_version') process.stdout.write(JSON.stringify({ content: content.toString('base64'), version: fileVersion(after, content) }));
      else process.stdout.write(content);
    }
  } else if (operation === 'list') {
    const requested = optionsPayload();
    const limit = boundedInteger(requested.limit, DIRECTORY_LIMIT, DIRECTORY_LIMIT);
    const { target } = targetPath(relative, true);
    directory(target);
    const listing = boundedDirectoryNames(target, limit);
    const names = listing.names;
    const entries = [];
    for (const name of names) {
      let type = 'other';
      try {
        const stats = fs.lstatSync(path.join(target, name));
        if (stats.isDirectory()) type = 'directory';
        else if (stats.isFile()) type = 'file';
      } catch {
        continue;
      }
      entries.push({ name, type });
    }
    writeJson({ entries, limitReached: listing.limitReached });
  } else if (operation === 'find') {
    const requested = optionsPayload();
    const pattern = searchPattern(requested.pattern);
    const limit = boundedInteger(requested.limit, FIND_LIMIT, FIND_LIMIT);
    const results = [];
    let resultLimitReached = false;
    const scan = walkFiles(relative, (_target, relativePath) => {
      if (!matchesGlob(relativePath, pattern)) return true;
      if (results.length >= limit) {
        resultLimitReached = true;
        return false;
      }
      results.push(relativePath);
      return true;
    });
    writeJson({ results, limitReached: resultLimitReached, scanLimitReached: scan.scanLimitReached });
  } else if (operation === 'grep') {
    const requested = optionsPayload();
    const pattern = searchPattern(requested.pattern);
    const glob = requested.glob === undefined ? null : searchPattern(requested.glob);
    const limit = boundedInteger(requested.limit, 100, GREP_LIMIT);
    const context = requested.context === undefined ? 0 : Math.max(0, Math.min(10, Math.floor(requested.context)));
    if (!Number.isFinite(context)) fail('INVALID_WORKSPACE_REQUEST');
    const literal = requested.literal === true;
    const ignoreCase = requested.ignoreCase === true;
    let matcher;
    if (literal) {
      const needle = ignoreCase ? pattern.toLowerCase() : pattern;
      matcher = (line) => (ignoreCase ? line.toLowerCase() : line).includes(needle);
    } else {
      let regex;
      try {
        regex = new RegExp(pattern, ignoreCase ? 'i' : undefined);
      } catch {
        fail('INVALID_WORKSPACE_REQUEST');
      }
      matcher = (line) => regex.test(line);
    }
    const outputLines = [];
    let matchCount = 0;
    let matchLimitReached = false;
    let linesTruncated = false;
    const scan = walkFiles(relative, (_target, relativePath, _stats, read) => {
      if (glob && !matchesGlob(relativePath, glob)) return true;
      const content = read();
      if (content.includes(0)) return true;
      const lines = content.toString('utf8').replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
      for (let index = 0; index < lines.length; index += 1) {
        if (!matcher(lines[index] || '')) continue;
        matchCount += 1;
        const start = context > 0 ? Math.max(0, index - context) : index;
        const end = context > 0 ? Math.min(lines.length - 1, index + context) : index;
        for (let current = start; current <= end; current += 1) {
          const bounded = boundedLine(lines[current] || '');
          if (bounded.truncated) linesTruncated = true;
          outputLines.push(relativePath + (current === index ? ':' : '-') + (current + 1) + (current === index ? ': ' : '- ') + bounded.text);
        }
        if (matchCount >= limit) {
          matchLimitReached = true;
          return false;
        }
      }
      return true;
    });
    const bounded = boundedOutput(outputLines.join('\n'));
    writeJson({
      output: bounded.output,
      matchCount,
      limitReached: matchLimitReached,
      linesTruncated,
      outputTruncated: bounded.truncated,
      scanLimitReached: scan.scanLimitReached,
    });
  } else if (operation === 'mkdir') {
    ensureDirectory(relative === '.' ? '.' : writablePath(relative));
  } else if (operation === 'write') {
    const safe = writablePath(relative);
    const content = Buffer.from(encoded, 'base64');
    if (content.byteLength > WRITE_LIMIT) fail('WORKSPACE_FILE_TOO_LARGE');
    const parent = ensureDirectory(path.posix.dirname(safe));
    const target = path.join(parent, path.posix.basename(safe));
    try {
      regularFile(target);
    } catch (error) {
      if (!error || error.code !== 'ENOENT') throw error;
    }
    let fd;
    let original;
    try {
      fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | (fs.constants.O_NOFOLLOW || 0));
      original = fs.fstatSync(fd);
      if (!original.isFile() || original.nlink !== 1) fail('WORKSPACE_FILE_UNSAFE');
      if (expected === 'missing') fail('WORKSPACE_HISTORY_CHANGED');
      if (expected) {
        if (original.size > READ_LIMIT) fail('WORKSPACE_HISTORY_CHANGED');
        const previous = fs.readFileSync(fd);
        if (fileVersion(original, previous) !== expected) fail('WORKSPACE_HISTORY_CHANGED');
      }
    } catch (error) {
      if (error.code !== 'ENOENT' || (expected && expected !== 'missing')) throw error;
    } finally { if (fd !== undefined) fs.closeSync(fd); }
    const temporary = path.join(parent, '.freedom-write-' + require('crypto').randomBytes(16).toString('hex'));
    const output = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), original ? original.mode & 0o777 : 0o600);
    try {
      if (original) fs.fchmodSync(output, original.mode & 0o777);
      try { fs.writeFileSync(output, content); fs.fsyncSync(output); } finally { fs.closeSync(output); }
      let current;
      try { current = fs.lstatSync(target); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (original ? !current || current.dev !== original.dev || current.ino !== original.ino || current.mtimeMs !== original.mtimeMs || current.ctimeMs !== original.ctimeMs : current) fail('WORKSPACE_HISTORY_CHANGED');
      fs.renameSync(temporary, target);
    } finally {
      try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }

  } else {
    fail('INVALID_WORKSPACE_REQUEST');
  }
} catch (error) {
  const allowed = new Set(['INVALID_WORKSPACE_REQUEST', 'WORKSPACE_FILE_CHANGED', 'WORKSPACE_FILE_TOO_LARGE', 'WORKSPACE_FILE_UNSAFE', 'WORKSPACE_PATH_TYPE_MISMATCH', 'WORKSPACE_PROTECTED_PATH', 'WORKSPACE_HISTORY_CHANGED', 'WORKSPACE_HISTORY_TOO_LARGE']);
  const native = new Map([
    ['ENOENT', 'WORKSPACE_PATH_NOT_FOUND'],
    ['ENOTDIR', 'WORKSPACE_PATH_TYPE_MISMATCH'],
    ['EISDIR', 'WORKSPACE_PATH_TYPE_MISMATCH'],
    ['EEXIST', 'WORKSPACE_HISTORY_CHANGED'],
  ]);
  const readOnly = new Set(['read', 'read_version', 'access', 'list', 'find', 'grep', 'workspace_inspect', 'history_snapshot', 'history_validate']);
  const fallback = readOnly.has(operation) ? 'WORKSPACE_FILE_UNAVAILABLE' : 'WORKSPACE_WRITE_FAILED';
  const code = allowed.has(error && error.code) ? error.code : native.get(error && error.code) || fallback;
  process.stderr.write('FREEDOM_FILE_ERROR:' + code);
  process.exit(73);
}
`;

module.exports = { WORKSPACE_FILE_HELPER, WINDOWS_FILE_HELPER_BOOTSTRAP, workspaceFileVersion };
