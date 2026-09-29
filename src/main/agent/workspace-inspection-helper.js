'use strict';

const { workspaceGitCommand } = require('./workspace-git-command');

// Appended to the existing sandboxed file helper. These operations are exposed
// to trusted chrome and the bounded model-facing history diff tool. The tool
// applies history exclusions and secret checks before returning text to the model.
const WORKSPACE_INSPECTION_HELPER = String.raw`
${workspaceGitCommand.toString()}
function inspectPath(value, allowRoot = false) {
  const safe = checkedRelative(value, allowRoot);
  if (safe.length > 1024 || safe.split('/').some((part) => part.toLowerCase() === '.git')) fail('WORKSPACE_PROTECTED_PATH');
  return safe;
}

function gitRead(args, acceptedCodes = [0]) {
  const { spawnSync } = require('child_process');
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')));
  Object.assign(env, {
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_ATTR_NOSYSTEM: '1', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0',
    GIT_LITERAL_PATHSPECS: '1', GIT_NO_LAZY_FETCH: '1', GIT_ALLOW_PROTOCOL: '', LC_ALL: 'C',
  });
  const gitDirectory = fs.lstatSync(path.join(root, '.git'));
  if (!gitDirectory.isDirectory() || gitDirectory.isSymbolicLink()) throw new Error('Git unavailable');
  // A redirected common directory would make Git read a different config from
  // the one screened below. Linked/alternate layouts need their own grant path.
  for (const name of ['commondir', 'config.worktree', 'objects/info/alternates', 'objects/info/http-alternates']) {
    try { fs.lstatSync(path.join(root, '.git', name)); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    throw new Error('Git unavailable');
  }
  const executable = workspaceGitCommand();
  if (!executable) throw new Error('Git unavailable');
  for (const name of ['config']) {
    const filename = path.join(root, '.git', name);
    if (!fs.existsSync(filename)) continue;
    const stats = regularFile(filename);
    if (stats.size > 65536) throw new Error('Git unavailable');
    const parsed = spawnSync(executable, ['config', '--file', filename, '--no-includes', '--null', '--list'],
      { cwd: root, env, encoding: 'utf8', timeout: 5000, maxBuffer: 262144, windowsHide: true });
    if (parsed.error || parsed.status !== 0 || parsed.stdout.split('\0').some(entry =>
      /^(?:include|includeif|filter|diff|credential|extensions)\.|\.(?:promisor|partialclonefilter)$/i.test(entry.split('\n')[0]))) throw new Error('Git unavailable');
  }

  const result = spawnSync(executable, [
    '--no-pager', '--git-dir=.git', '--work-tree=.',
    '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null',
    '-c', 'core.attributesFile=/dev/null', '-c', 'core.excludesFile=/dev/null',
    '-c', 'core.quotePath=false', '-c', 'color.ui=false',
    ...args,
  ], { cwd: root, env, encoding: 'utf8', timeout: 5000, killSignal: 'SIGKILL', maxBuffer: 524288, windowsHide: true });
  if (result.error || !acceptedCodes.includes(result.status)) throw new Error('Git unavailable');
  return result.stdout;
}

function gitChanges(scope = 'all') {
  if (!fs.existsSync(path.join(root, '.git'))) return { available: false, noRepository: true, message: 'This project has no Git repository.' };
  try {
    const records = gitRead(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--renames', '--ignore-submodules=all']).split('\0').filter(Boolean);
    const changes = [];
    for (let index = 0; index < records.length && changes.length < 500; index += 1) {
      const record = records[index];
      const relativePath = inspectPath(record.slice(3));
      const code = record.slice(0, 2);
      const oldPath = /[RC]/.test(code) ? inspectPath(records[++index]) : undefined;
      if (scope === 'staged' && (code[0] === ' ' || code === '??')) continue;
      if (scope === 'unstaged' && code[1] === ' ') continue;
      const status = oldPath ? 'renamed' : code.includes('U') || code === 'AA' || code === 'DD' ? 'conflicted' : code === '??' || code.includes('A') ? 'added' : code.includes('D') ? 'deleted' : 'modified';
      changes.push({ path: relativePath, status, ...(oldPath && { oldPath }), staged: code !== '??' && code[0] !== ' ', unstaged: code[1] !== ' ' });
    }
    const branch = gitRead(['symbolic-ref', '--quiet', '--short', 'HEAD'], [0, 1]).trim().slice(0, 160);
    return { available: true, branch: branch || 'Detached HEAD', changes, limitReached: records.length > 500 };
  } catch {
    return { available: false, message: 'Git change inspection is unavailable for this workspace.' };
  }
}

function inspectText(relativePath, options = {}) {
  // Browsing generated output does not enroll it in checkpoint history.
  if (historyPathReason(relativePath, true)) fail('WORKSPACE_PROTECTED_PATH');
  const { target } = targetPath(inspectPath(relativePath));
  regularFile(target);
  const fd = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
  try {
    const stats = fs.fstatSync(fd);
    if (!stats.isFile() || stats.nlink !== 1) fail('WORKSPACE_FILE_UNSAFE');
    if (stats.size > 1048576) return { text: '', truncated: true, message: 'File exceeds the 1 MiB preview limit. Open it in your editor.' };
    const buffer = Buffer.alloc(stats.size);
    const count = fs.readSync(fd, buffer, 0, buffer.length, 0);
    const after = fs.fstatSync(fd);
    if (count !== stats.size || after.size !== stats.size || after.mtimeMs !== stats.mtimeMs || after.ctimeMs !== stats.ctimeMs) fail('WORKSPACE_FILE_CHANGED');
    const bytes = buffer.subarray(0, count);
    const revision = require('crypto').createHash('sha256').update(bytes).digest('hex');
    if (options.revision && options.revision !== revision) fail('WORKSPACE_FILE_CHANGED');
    if (options.kind === 'image') {
      if (bytes.length > 393216) return { message: 'Image exceeds the 384 KiB preview limit. Open it in your image viewer.' };
      const signatures = [ ['image/png', bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))], ['image/jpeg', bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255], ['image/gif', /^GIF8[79]a$/.test(bytes.subarray(0,6).toString())], ['image/webp', bytes.subarray(0,4).toString() === 'RIFF' && bytes.subarray(8,12).toString() === 'WEBP'] ];
      const mime = signatures.find(entry => entry[1])?.[0];
      if (!mime) return { message: 'This image format is not supported. Open it in your image viewer.' };
      return { dataUrl: 'data:' + mime + ';base64,' + bytes.toString('base64') };
    }
    if (historyContainsSecret(bytes)) fail('WORKSPACE_PROTECTED_PATH');
    const binary = bytes.includes(0);
    const text = binary ? '' : bytes.toString('utf8');
    const offset = options.offset || 0;
    const end = offset + 65536;
    return { path: relativePath, binary, offset, revision, size: stats.size, truncated: text.length > end, nextOffset: text.length > end ? end : null, text: text.slice(offset, end) };
  } finally {
    fs.closeSync(fd);
  }
}

function diffPreview(text, options) {
  const revision = require('crypto').createHash('sha256').update(text).digest('hex');
  if (options.revision && options.revision !== revision) fail('WORKSPACE_FILE_CHANGED');
  const offset = options.offset || 0, end = offset + 65536;
  return { available: true, text: text.slice(offset, end), revision, truncated: text.length > end, nextOffset: text.length > end ? end : null };
}

function inspectWorkspace(options) {
  const kind = options.kind;
  const relativePath = inspectPath(relative, kind === 'tree' || kind === 'changes' || kind === 'search');
  if (relativePath !== '.' && historyPathReason(relativePath, true)) fail('WORKSPACE_PROTECTED_PATH');
  if (kind === 'search') {
    const entries = [], pending = ['.']; let seen = 0, limitReached = false;
    const caches = new Set(['node_modules', '.vite', '.next', '.nuxt', '.cache', '.parcel-cache', '.turbo', '.svelte-kit', '.pytest_cache', '.mypy_cache', '.ruff_cache', '__pycache__', '.venv', 'venv']);
    while (pending.length && seen < 50000 && entries.length < 200) {
      const parent = pending.shift(); const { target } = targetPath(parent, true); directory(target);
      const listing = boundedDirectoryNames(target, Math.min(10000, 50000 - seen));
      limitReached ||= listing.limitReached;
      for (const name of listing.names.sort((a, b) => a.localeCompare(b))) {
        if (++seen > 50000 || entries.length >= 200) { limitReached = true; break; }
        const candidate = parent === '.' ? name : parent + '/' + name;
        if (historyPathReason(candidate, true) || caches.has(name.toLowerCase()) || name === '.DS_Store') continue;
        const stats = fs.lstatSync(path.join(target, name));
        if (stats.isSymbolicLink()) continue;
        if (stats.isDirectory()) pending.push(candidate);
        else if (stats.isFile() && stats.nlink === 1 && candidate.toLocaleLowerCase().includes(options.query.toLocaleLowerCase())) entries.push({ path: candidate, name, type: 'file' });
      }
    }
    return { entries, limitReached: limitReached || pending.length > 0 || entries.length >= 200 };
  }
  if (kind === 'tree') {
    const { target } = targetPath(relativePath, true);
    directory(target);
    const generated = new Set(['node_modules', 'dist', 'build', 'coverage', '.vite', '.next', '.cache', '.DS_Store']);
    const listing = boundedDirectoryNames(target, 10000);
    listing.names.sort((a, b) => a.localeCompare(b));
    const entries = [];
    let hiddenCount = 0;
    for (const name of listing.names) {
      if (!options.showGenerated && generated.has(name)) { hiddenCount += 1; continue; }
      if (historyPathReason(relativePath === '.' ? name : relativePath + '/' + name, true)) continue;
      const stats = fs.lstatSync(path.join(target, name));
      const type = stats.isSymbolicLink() || (stats.isFile() && stats.nlink !== 1) ? 'other' : stats.isDirectory() ? 'directory' : stats.isFile() ? 'file' : 'other';
      entries.push({ name, type });
    }
    entries.sort((a, b) => (a.type === 'directory' ? 0 : 1) - (b.type === 'directory' ? 0 : 1) || a.name.localeCompare(b.name));
    const offset = options.offset || 0;
    return { entries: entries.slice(offset, offset + 200), hiddenCount, limitReached: listing.limitReached || entries.length > offset + 200, nextOffset: entries.length > offset + 200 ? offset + 200 : null };
  }
  if (kind === 'changes') return gitChanges(options.scope);
  if (kind === 'file' || kind === 'image') return inspectText(relativePath, options);
  if (kind === 'diff') {
    const status = gitChanges(options.scope);
    if (!status.available) return status;
    const change = status.changes.find((entry) => entry.path === relativePath);
    if (!change) return { available: true, path: relativePath, text: '', message: status.limitReached ? 'This file is outside the change inspection limit.' : 'No changes for this file.' };
    if (change.status !== 'deleted') {
      const file = inspectText(relativePath);
      if (file.binary || file.message) return { ...file, text: '', message: file.binary ? 'Binary file — diff unavailable.' : file.message };
    }
    try {
      const hasHead = gitRead(['rev-parse', '--verify', '--quiet', 'HEAD'], [0, 1]).trim();
      // Untracked files are displayed as additions, including on an unborn branch.
      const tracked = gitRead(['ls-files', '--error-unmatch', '--', relativePath], [0, 1]).length > 0;
      if (!tracked && options.scope !== 'staged' && change.status === 'added') {
        const output = gitRead(['diff', '--no-index', '--no-ext-diff', '--no-textconv', '--', '/dev/null', relativePath], [0, 1]);
        return { path: relativePath, ...diffPreview(output, options) };
      }
      const output = gitRead(['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--ignore-submodules=all', ...(options.scope === 'staged' ? ['--cached'] : options.scope === 'unstaged' ? [] : hasHead ? ['HEAD'] : ['--cached']), '--', ...(change.oldPath ? [change.oldPath, relativePath] : [relativePath])]);
      return { path: relativePath, ...diffPreview(output, options) };
    } catch (error) {
      if (error.code === 'WORKSPACE_FILE_CHANGED') throw error;
      return { available: false, message: 'This diff could not be read within the preview limits. Refresh or inspect it in your Git client.' };
    }
  }
  fail('INVALID_WORKSPACE_REQUEST');
}
`;

module.exports = { WORKSPACE_INSPECTION_HELPER };
