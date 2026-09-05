'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const {
  HISTORY_LIMITS,
  historyPathReason,
  historyContainsSecret,
} = require('./workspace-history-policy');

const { workspaceGitCommand } = require('./workspace-git-command');

const OID = /^[a-f0-9]{40}$/;
const MAX_RECORD_BYTES = 64 * 1024;

class WorkspaceHistoryError extends Error {
  constructor(message) {
    super(message);
    this.code = 'WORKSPACE_HISTORY_UNAVAILABLE';
  }
}

function fingerprint(snapshot) {
  return crypto
    .createHash('sha256')
    .update(
      JSON.stringify(snapshot.files.map(({ path, content, mode }) => ({ path, content, mode })))
    )
    .digest('hex');
}

function validateSnapshot(snapshot) {
  if (!Array.isArray(snapshot?.files) || snapshot.files.length > HISTORY_LIMITS.files)
    throw new WorkspaceHistoryError('Workspace history exceeds its file limit');
  let total = 0;
  const seen = new Set();
  for (const file of snapshot.files) {
    if (
      historyPathReason(file.path) ||
      seen.has(file.path) ||
      !['100644', '100755'].includes(file.mode) ||
      typeof file.content !== 'string'
    )
      throw new WorkspaceHistoryError('Workspace history contains an unsupported file');
    seen.add(file.path);
    const content = Buffer.from(file.content, 'base64');
    total += content.length;
    if (
      content.toString('base64') !== file.content ||
      content.length > HISTORY_LIMITS.fileBytes ||
      total > HISTORY_LIMITS.totalBytes ||
      historyContainsSecret(content)
    )
      throw new WorkspaceHistoryError('Workspace history refused excluded or oversized content');
  }
  return snapshot;
}

async function checkedDirectory(directory) {
  const stats = await fs.promises.lstat(directory);
  if (!stats.isDirectory() || stats.isSymbolicLink())
    throw new WorkspaceHistoryError('Workspace Git metadata is unsafe');
}

async function readMetadata(filename, limit = MAX_RECORD_BYTES) {
  const handle = await fs.promises.open(
    filename,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK
  );
  try {
    const stats = await handle.stat();
    if (!stats.isFile() || stats.nlink !== 1 || stats.size > limit)
      throw new WorkspaceHistoryError('Workspace Git metadata is unsafe');
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

async function atomicMetadata(filename, bytes) {
  try {
    await readMetadata(filename, 1024 * 1024);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const temporary = `${filename}.freedom-${crypto.randomBytes(8).toString('hex')}`;
  const handle = await fs.promises.open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.promises.rename(temporary, filename);
}

class ManagedWorkspaceHistory {
  constructor(workspaceRoot, { signal } = {}) {
    this.signal = signal;
    this.root = workspaceRoot;
    this.deadline = Date.now() + 15000;
    this.gitDirectory = path.join(workspaceRoot, '.git');
    this.recordsDirectory = path.join(this.gitDirectory, 'freedom-history');
  }

  async validate() {
    if (!workspaceGitCommand())
      throw new WorkspaceHistoryError(
        'Version history is unavailable because Git is not available in the supported system toolchain. Project editing remains available.'
      );
    if (this.signal?.aborted) throw new WorkspaceHistoryError('Workspace history was stopped');
    await checkedDirectory(this.root);
    await checkedDirectory(this.gitDirectory);
    for (const directory of ['objects', 'refs', 'refs/heads'])
      await checkedDirectory(path.join(this.gitDirectory, directory));
    const head = (await readMetadata(path.join(this.gitDirectory, 'HEAD'))).toString('utf8');
    if (head !== 'ref: refs/heads/main\n')
      throw new WorkspaceHistoryError('Automatic history requires the managed main branch');
    const config = (await readMetadata(path.join(this.gitDirectory, 'config'))).toString('utf8');
    // Only the configuration written by Freedom is accepted for privileged Git
    // plumbing. No includes, hooks, filters, external object stores or extensions.
    if (config !== '[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = false\n')
      throw new WorkspaceHistoryError(
        'Automatic history is unavailable for externally configured repositories'
      );
    for (const name of [
      'commondir',
      'config.worktree',
      'objects/info/alternates',
      'objects/info/http-alternates',
      'shallow',
      'packed-refs',
    ]) {
      try {
        await fs.promises.lstat(path.join(this.gitDirectory, name));
      } catch (error) {
        if (error.code === 'ENOENT') continue;
        throw error;
      }
      throw new WorkspaceHistoryError('Automatic history is unavailable for external Git metadata');
    }
    // Protected metadata cannot be redirected to host paths, even after restart.
    let count = 0;
    const visit = async (directory) => {
      for (const entry of await fs.promises.readdir(directory, { withFileTypes: true })) {
        if (++count > 20000)
          throw new WorkspaceHistoryError('Workspace history metadata limit reached');
        const filename = path.join(directory, entry.name);
        const stats = await fs.promises.lstat(filename);
        if (
          stats.isSymbolicLink() ||
          (!stats.isDirectory() && (!stats.isFile() || stats.nlink !== 1))
        )
          throw new WorkspaceHistoryError('Workspace Git metadata is unsafe');
        if (stats.isDirectory()) await visit(filename);
      }
    };
    await visit(this.gitDirectory);
    await fs.promises.mkdir(this.recordsDirectory, { recursive: true, mode: 0o700 });
    await checkedDirectory(this.recordsDirectory);
  }

  async git(args, input = '') {
    const remaining = this.deadline - Date.now();
    if (this.signal?.aborted) throw new WorkspaceHistoryError('Workspace history was stopped');
    if (remaining <= 0) throw new WorkspaceHistoryError('Workspace history operation timed out');
    const executable = workspaceGitCommand();
    if (!executable)
      throw new WorkspaceHistoryError(
        'Git is unavailable for workspace history. Project editing remains available.'
      );
    // Fixed plumbing only. Git never reads project file contents; screened bytes
    // arrive on stdin from the sandbox helper. Do not inherit host Git settings.
    return new Promise((resolve, reject) => {
      const child = execFile(
        executable,
        [
          '--no-pager',
          `--git-dir=${this.gitDirectory}`,
          '-c',
          'core.hooksPath=/dev/null',
          '-c',
          'core.fsmonitor=false',
          ...args,
        ],
        {
          cwd: this.recordsDirectory,
          signal: this.signal,
          timeout: Math.min(5000, remaining),
          killSignal: 'SIGKILL',
          maxBuffer: 1024 * 1024,
          env: {
            PATH: '/usr/bin:/bin',
            LC_ALL: 'C',
            GIT_CONFIG_NOSYSTEM: '1',
            GIT_CONFIG_SYSTEM: '/dev/null',
            GIT_CONFIG_GLOBAL: '/dev/null',
            GIT_NO_REPLACE_OBJECTS: '1',
            GIT_NO_LAZY_FETCH: '1',
            GIT_TERMINAL_PROMPT: '0',
            GIT_AUTHOR_NAME: 'Freedom',
            GIT_AUTHOR_EMAIL: 'workspace@freedom.local',
            GIT_COMMITTER_NAME: 'Freedom',
            GIT_COMMITTER_EMAIL: 'workspace@freedom.local',
            GIT_INDEX_FILE: path.join(this.gitDirectory, 'freedom-history-index'),
          },
          encoding: 'buffer',
        },
        (error, stdout) =>
          error
            ? reject(
                new WorkspaceHistoryError('Local Git could not save or read workspace history')
              )
            : resolve(stdout)
      );
      child.stdin.on('error', () => {});
      child.stdin.end(input);
    });
  }

  async currentId() {
    try {
      const value = (await readMetadata(path.join(this.gitDirectory, 'refs/heads/main')))
        .toString('utf8')
        .trim();
      if (!OID.test(value)) throw new WorkspaceHistoryError('Invalid workspace history reference');
      return value;
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }

  async record(id) {
    if (!OID.test(id || ''))
      throw new WorkspaceHistoryError('That workspace version is unavailable');
    let record;
    try {
      record = JSON.parse(await readMetadata(path.join(this.recordsDirectory, `${id}.json`)));
    } catch {
      throw new WorkspaceHistoryError('That version was not created by Freedom');
    }
    if (
      record.id !== id ||
      !Array.isArray(record.files) ||
      record.files.length > HISTORY_LIMITS.files ||
      !OID.test(record.tree || '') ||
      (record.parent && !OID.test(record.parent))
    )
      throw new WorkspaceHistoryError('Invalid workspace version');
    for (const file of record.files) {
      if (
        historyPathReason(file.path) ||
        !OID.test(file.oid || '') ||
        !['100644', '100755'].includes(file.mode)
      )
        throw new WorkspaceHistoryError('Invalid workspace version file');
    }
    return record;
  }

  async exclusions() {
    await this.validate();
    try {
      const values = JSON.parse(
        await readMetadata(path.join(this.recordsDirectory, 'exclusions.json'))
      );
      if (
        !Array.isArray(values) ||
        values.length > 200 ||
        values.some(
          (entry) =>
            historyPathReason(entry.path) ||
            typeof entry.reason !== 'string' ||
            entry.reason.length > 160 ||
            historyContainsSecret(entry.reason)
        )
      )
        throw new Error();
      return values;
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw new WorkspaceHistoryError('Workspace exclusions are unavailable');
    }
  }

  async setExclusions(values) {
    await this.validate();
    if (values.length > 200) throw new WorkspaceHistoryError('Too many workspace exclusions');
    await atomicMetadata(
      path.join(this.recordsDirectory, 'exclusions.json'),
      Buffer.from(JSON.stringify(values))
    );
  }

  async currentSnapshot() {
    await this.validate();
    const id = await this.currentId();
    return id && (await this.record(id)).reviewed === true
      ? this.snapshot(id) : { files: [], excluded: [], excludedCount: 0 };
  }

  async list() {
    await this.validate();
    const records = [];
    let id = await this.currentId();
    while (id && records.length < 100) {
      const record = await this.record(id);
      records.push({
        id,
        label: record.label,
        reviewed: record.reviewed === true,
        kind: record.kind,
        createdAt: record.createdAt,
        fileCount: record.files.length,
        excludedCount: record.excludedCount || 0,
      });
      id = record.parent;
    }
    return { versions: records, limitReached: Boolean(id) };
  }

  async ownedRecord(id) {
    const listing = await this.list();
    if (!listing.versions.some((version) => version.id === id))
      throw new WorkspaceHistoryError('That version is outside the available workspace history');
    return this.record(id);
  }

  async snapshot(id) {
    const record = await this.ownedRecord(id);
    const files = [];
    for (const file of record.files) {
      const content = await this.git(['cat-file', 'blob', file.oid]);
      files.push({ path: file.path, mode: file.mode, content: content.toString('base64') });
    }
    return validateSnapshot({ files, excluded: [], excludedCount: record.excludedCount });
  }

  async save(snapshot, { label, kind = 'manual', onlyIfChanged = false, reviewed = false } = {}) {
    if (reviewed !== true) throw new WorkspaceHistoryError('A checkpoint requires explicit file review');
    validateSnapshot(snapshot);
    if (
      typeof label !== 'string' ||
      !label.trim() ||
      label.length > 80 ||
      [...label].some((character) => character.charCodeAt(0) < 32) ||
      historyContainsSecret(label)
    )
      throw new WorkspaceHistoryError('Use a short version name without credentials');
    await this.validate();
    const parent = await this.currentId();
    const previous = parent ? await this.record(parent) : null;
    const digest = fingerprint(snapshot);
    if (onlyIfChanged && previous?.reviewed === true && previous.digest === digest)
      return { saved: false, id: parent, excludedCount: snapshot.excludedCount || 0 };
    const files = [];
    for (const file of snapshot.files) {
      const oid = (
        await this.git(
          ['hash-object', '-w', '--stdin', '--no-filters'],
          Buffer.from(file.content, 'base64')
        )
      )
        .toString('utf8')
        .trim();
      if (!OID.test(oid)) throw new WorkspaceHistoryError('Git returned an invalid object');
      files.push({ path: file.path, mode: file.mode, oid });
    }
    await this.git(['read-tree', '--empty']);
    await this.git(
      ['update-index', '-z', '--index-info'],
      files.map((file) => `${file.mode} ${file.oid}\t${file.path}\0`).join('')
    );
    const tree = (await this.git(['write-tree'])).toString('utf8').trim();
    if (!OID.test(tree)) throw new WorkspaceHistoryError('Git returned an invalid tree');
    const id = (
      await this.git(['commit-tree', tree, ...(parent ? ['-p', parent] : [])], `${label.trim()}\n`)
    )
      .toString('utf8')
      .trim();
    if (!OID.test(id)) throw new WorkspaceHistoryError('Git returned an invalid commit');
    const record = {
      id,
      parent,
      tree,
      digest,
      label: label.trim(),
      kind,
      createdAt: Date.now(),
      reviewed: true,
      files,
      excludedCount: snapshot.excludedCount || 0,
      excluded: (snapshot.excluded || []).slice(0, 20),
    };
    const recordBytes = Buffer.from(JSON.stringify(record));
    if (recordBytes.length > MAX_RECORD_BYTES)
      throw new WorkspaceHistoryError('Workspace version metadata is too large');
    await atomicMetadata(path.join(this.recordsDirectory, `${id}.json`), recordBytes);
    // The branch update is the commit point. An interrupted earlier write leaves
    // only unreachable objects; history always follows the committed parent chain.
    const index = await readMetadata(
      path.join(this.gitDirectory, 'freedom-history-index'),
      1024 * 1024
    );
    await atomicMetadata(path.join(this.gitDirectory, 'index'), index);
    await this.git(['update-ref', 'refs/heads/main', id, parent || '0'.repeat(40)]);
    return { saved: true, id, label: record.label, excludedCount: record.excludedCount };
  }
}

module.exports = { ManagedWorkspaceHistory, WorkspaceHistoryError, fingerprint, validateSnapshot };
