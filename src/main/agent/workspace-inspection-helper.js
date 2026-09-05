'use strict';

// Appended to the existing sandboxed file helper. These operations are exposed
// only to trusted chrome; file bodies and diffs never enter Agent state/history.
const WORKSPACE_INSPECTION_HELPER = String.raw`
function inspectPath(value, allowRoot = false) {
  const safe = checkedRelative(value, allowRoot);
  if (safe.length > 1024 || safe.split('/').some((part) => part.toLowerCase() === '.git')) fail('WORKSPACE_PROTECTED_PATH');
  return safe;
}

function gitRead(args, acceptedCodes = [0]) {
  const { spawnSync } = require('child_process');
  // Workspace metadata is protected by the execution policy. Refuse legacy
  // configurations capable of loading other configs or invoking programs.
  for (const name of ['config', 'config.worktree']) {
    const filename = path.join(root, '.git', name);
    if (!fs.existsSync(filename)) continue;
    const stats = regularFile(filename);
    if (stats.size > 65536) throw new Error('Git unavailable');
    const config = fs.readFileSync(filename, 'utf8');
    if (/^\s*\[\s*(?:include|includeif|filter|diff|credential|extensions)\b/im.test(config)) throw new Error('Git unavailable');
  }
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')));
  Object.assign(env, {
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_ATTR_NOSYSTEM: '1', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0',
    GIT_LITERAL_PATHSPECS: '1', LC_ALL: 'C',
  });
  // /usr/bin/git on macOS can dispatch into a selected Xcode installation
  // outside the sandbox. Prefer the real Git in the existing system-toolchain boundary.
  const commandLineGit = '/Library/Developer/CommandLineTools/usr/bin/git';
  const executable = process.platform === 'darwin' && fs.existsSync(commandLineGit) ? commandLineGit : '/usr/bin/git';
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

function gitChanges() {
  try {
    const records = gitRead(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames', '--ignore-submodules=all']).split('\0').filter(Boolean);
    const changes = [];
    for (const record of records.slice(0, 500)) {
      const relativePath = inspectPath(record.slice(3));
      const code = record.slice(0, 2);
      const status = code.includes('U') || code === 'AA' || code === 'DD' ? 'conflicted' : code === '??' || code.includes('A') ? 'added' : code.includes('D') ? 'deleted' : 'modified';
      changes.push({ path: relativePath, status });
    }
    const branch = gitRead(['symbolic-ref', '--quiet', '--short', 'HEAD'], [0, 1]).trim().slice(0, 160);
    return { available: true, branch: branch || 'Detached HEAD', changes, limitReached: records.length > 500 };
  } catch {
    return { available: false, message: 'Git change inspection is unavailable for this workspace.' };
  }
}

function inspectText(relativePath) {
  const { target } = targetPath(inspectPath(relativePath));
  regularFile(target);
  const fd = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
  try {
    const stats = fs.fstatSync(fd);
    if (!stats.isFile() || stats.nlink !== 1) fail('WORKSPACE_FILE_UNSAFE');
    const buffer = Buffer.alloc(Math.min(stats.size, 65536));
    const count = fs.readSync(fd, buffer, 0, buffer.length, 0);
    const bytes = buffer.subarray(0, count);
    const binary = bytes.includes(0);
    return { path: relativePath, binary, truncated: stats.size > count, text: binary ? '' : bytes.toString('utf8') };
  } finally {
    fs.closeSync(fd);
  }
}

function inspectWorkspace(options) {
  const kind = options.kind;
  const relativePath = inspectPath(relative, kind === 'tree' || kind === 'changes');
  if (kind === 'tree') {
    const { target } = targetPath(relativePath, true);
    directory(target);
    const generated = new Set(['node_modules', 'dist', 'build', 'coverage', '.vite', '.next', '.cache', '.DS_Store']);
    const listing = boundedDirectoryNames(target, 500);
    const entries = [];
    let hiddenCount = 0;
    for (const name of listing.names) {
      if (name.toLowerCase() === '.git') continue;
      if (!options.showGenerated && generated.has(name)) { hiddenCount += 1; continue; }
      const stats = fs.lstatSync(path.join(target, name));
      const type = stats.isSymbolicLink() || (stats.isFile() && stats.nlink !== 1) ? 'other' : stats.isDirectory() ? 'directory' : stats.isFile() ? 'file' : 'other';
      entries.push({ name, type });
    }
    entries.sort((a, b) => (a.type === 'directory' ? 0 : 1) - (b.type === 'directory' ? 0 : 1) || a.name.localeCompare(b.name));
    return { entries, hiddenCount, limitReached: listing.limitReached };
  }
  if (kind === 'changes') return gitChanges();
  if (kind === 'file') return inspectText(relativePath);
  if (kind === 'diff') {
    const status = gitChanges();
    if (!status.available) return status;
    const change = status.changes.find((entry) => entry.path === relativePath);
    if (!change) return { available: true, path: relativePath, text: '', message: status.limitReached ? 'This file is outside the change inspection limit.' : 'No changes for this file.' };
    if (change.status !== 'deleted') {
      const file = inspectText(relativePath);
      if (file.binary || file.truncated) return { ...file, text: '', message: file.binary ? 'Binary file — diff unavailable.' : 'File exceeds the 64 KiB diff limit.' };
    }
    try {
      const hasHead = gitRead(['rev-parse', '--verify', '--quiet', 'HEAD'], [0, 1]).trim();
      // Untracked files are displayed as additions, including on an unborn branch.
      const tracked = gitRead(['ls-files', '--error-unmatch', '--', relativePath], [0, 1]).length > 0;
      if ((!tracked || !hasHead) && change.status === 'added') {
        const output = gitRead(['diff', '--no-index', '--no-ext-diff', '--no-textconv', '--', '/dev/null', relativePath], [0, 1]);
        return { available: true, path: relativePath, text: output.slice(0, 65536), truncated: output.length > 65536 };
      }
      const output = gitRead(['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--ignore-submodules=all', ...(hasHead ? ['HEAD'] : ['--cached']), '--', relativePath]);
      return { available: true, path: relativePath, text: output.slice(0, 65536), truncated: output.length > 65536 };
    } catch {
      return { available: false, message: 'This diff could not be read.' };
    }
  }
  fail('INVALID_WORKSPACE_REQUEST');
}
`;

module.exports = { WORKSPACE_INSPECTION_HELPER };
