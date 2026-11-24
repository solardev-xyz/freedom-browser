'use strict';

const { compareEntries, textPreview } = require('./workspace-comparison');

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { workspaceGitCommand } = require('./workspace-git-command');
const { WorkspaceHistoryError, validateSnapshot } = require('./managed-workspace-history');
const { historyPathReason, historyContainsSecret } = require('./workspace-history-policy');

const OID = /^[a-f0-9]{40}$/;
const fail = (message) => { throw new WorkspaceHistoryError(message); };
const digest = (bytes) => crypto.createHash('sha256').update(bytes || '').digest('hex');

// Main-owned fixed Git plumbing. Never runs shell commands, hooks, filters,
// signing programs or network operations from a selected repository.
class ExternalProjectGit {
  constructor(root, { signal, authorize, temporaryRoot, globalConfigFiles }) {
    this.root = root;
    this.directory = path.join(root, '.git');
    this.signal = signal;
    this.authorize = authorize;
    this.temporaryRoot = temporaryRoot;
    this.configFiles = [...(globalConfigFiles || [
      '/etc/gitconfig',
      ...(process.platform === 'darwin' ? ['/Library/Developer/CommandLineTools/usr/etc/gitconfig'] : []),
      path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'git/config'),
      path.join(os.homedir(), '.gitconfig'),
    ]), path.join(this.directory, 'config')];
    this.globalIgnorePath = globalConfigFiles ? null : path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'git/ignore');
    this.deadline = Date.now() + 30000;
    this.configEntriesCache = new Map();
  }

  async read(filename, optional = false, limit = 8 * 1024 * 1024) {
    let handle;
    try {
      if (filename.startsWith(`${this.directory}${path.sep}`) && this.metadataIdentity) await this.checkMetadataIdentity();
      handle = await fs.promises.open(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > limit) fail('Unsupported Git metadata. Use your Git client for this repository.');
      return await handle.readFile();
    } catch (error) {
      if (optional && error.code === 'ENOENT') return null;
      throw error;
    } finally { await handle?.close(); }
  }

  async checkMetadataIdentity() {
    const stat = await fs.promises.lstat(this.directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() ||
        (this.metadataIdentity && this.metadataIdentity !== `${stat.dev}:${stat.ino}`)) fail('Git metadata changed or was replaced. Reopen and review this project.');
    this.metadataIdentity = `${stat.dev}:${stat.ino}`;
  }

  async validate() {
    await this.authorize(false);
    let stat;
    try { stat = await fs.promises.lstat(this.directory); }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('Linked worktrees and external Git directories are not supported yet.');
    await this.checkMetadataIdentity();
    let count = 0;
    const visit = async (directory, depth = 0) => {
      if (depth > 32) fail('Git metadata is nested too deeply.');
      for (const name of await fs.promises.readdir(directory)) {
        if (++count > 50000 || Date.now() > this.deadline) fail('Git metadata exceeds the inspection limit.');
        const target = path.join(directory, name);
        const entry = await fs.promises.lstat(target);
        if (entry.isSymbolicLink() || (!entry.isDirectory() && (!entry.isFile() || entry.nlink !== 1))) fail('Linked or special Git metadata is not supported.');
        if (name.endsWith('.promisor') || name.startsWith('sharedindex.')) fail('Partial clones and split indexes require your Git client.');
        if (entry.isDirectory()) await visit(target, depth + 1);
      }
    };
    await visit(this.directory);
    for (const name of ['commondir', 'config.worktree', 'objects/info/alternates', 'objects/info/http-alternates', 'shallow', 'info/grafts']) {
      if (await this.read(path.join(this.directory, name), true)) fail('This Git layout requires your Git client.');
    }
    const config = await this.configEntries(await this.read(path.join(this.directory, 'config'), false, 65536));
    if (config.some(key => /^(?:include|includeif|filter|extensions)\./i.test(key))) fail('Git includes, filters and repository extensions are not supported yet. Use your Git client.');
    if (config.some(key => /\.(?:promisor|partialclonefilter|sparsecheckout|splitindex)$/i.test(key))) fail('Partial, sparse and split Git repositories require your Git client.');
    return true;
  }

  async configEntries(bytes) {
    const remaining = this.deadline - Date.now();
    if (this.signal?.aborted || remaining <= 0) fail('Git configuration inspection stopped. Inspect repository state before retrying.');
    const key = digest(bytes);
    if (this.configEntriesCache.has(key)) return this.configEntriesCache.get(key);
    const executable = workspaceGitCommand();
    if (!executable) fail('Git is unavailable. Project editing remains available.');
    // Parse captured bytes with Git itself: inline sections and case variants
    // must not bypass screening. No include expansion or repository discovery.
    const output = await new Promise((resolve, reject) => {
      const child = execFile(executable, ['config', '--file', '-', '--no-includes', '--null', '--list'], {
        cwd: this.temporaryRoot, signal: this.signal, timeout: Math.min(5000, remaining),
        killSignal: 'SIGKILL', maxBuffer: 262144, encoding: 'utf8',
        env: { PATH: '/usr/bin:/bin', LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' },
      }, (error, stdout) => error ? reject(new WorkspaceHistoryError('Git configuration could not be inspected. Use your Git client to check it.')) : resolve(stdout));
      child.stdin.on('error', () => {});
      child.stdin.end(bytes);
    });
    const entries = output.split('\0').filter(Boolean).map(entry => entry.split('\n')[0]);
    this.configEntriesCache.set(key, entries);
    return entries;
  }

  async git(args, { input = '', index, identity, codes = [0], expected, onDispatch } = {}) {
    if (!await this.validate()) fail('This folder has no Git repository.');
    await this.authorize(['hash-object', 'commit-tree', 'update-ref'].includes(args[0]));
    const executable = workspaceGitCommand();
    if (!executable) fail('Git is unavailable. Project editing remains available.');
    if (this.signal?.aborted || Date.now() >= this.deadline) fail('Git operation stopped or timed out.');
    if (expected && JSON.stringify(await this.baseline()) !== JSON.stringify(expected)) fail('Git changed before commit dispatch. Review the files again.');
    return new Promise((resolve, reject) => {
      const remaining = this.deadline - Date.now();
      if (remaining <= 0) { reject(new WorkspaceHistoryError('Git operation timed out before dispatch. Review repository state and retry.')); return; }
      const child = execFile(executable, ['--no-pager', `--git-dir=${this.directory}`, `--work-tree=${this.root}`,
        '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.attributesFile=/dev/null',
        '-c', 'core.excludesFile=/dev/null', '-c', 'core.logAllRefUpdates=true', '-c', 'gc.auto=0',
        '-c', 'maintenance.auto=false', '-c', 'commit.gpgSign=false', '-c', 'log.showSignature=false', '-c', 'protocol.allow=never', ...args], {
        cwd: this.root, signal: this.signal, timeout: Math.min(5000, remaining),
        killSignal: 'SIGKILL', maxBuffer: 16 * 1024 * 1024, encoding: 'buffer',
        env: { PATH: '/usr/bin:/bin', LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_SYSTEM: '/dev/null',
          GIT_CONFIG_GLOBAL: '/dev/null', GIT_ATTR_NOSYSTEM: '1', GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1',
          GIT_TERMINAL_PROMPT: '0', GIT_ALLOW_PROTOCOL: '', ...(args[0] !== 'check-ignore' && { GIT_LITERAL_PATHSPECS: '1' }), GIT_OPTIONAL_LOCKS: '0',
          ...(index && { GIT_INDEX_FILE: index }), ...(identity && {
            GIT_AUTHOR_NAME: identity.name, GIT_AUTHOR_EMAIL: identity.email,
            GIT_COMMITTER_NAME: identity.name, GIT_COMMITTER_EMAIL: identity.email,
          }) },
      }, (error, stdout) => {
        if (error && !codes.includes(error.code)) reject(new WorkspaceHistoryError('Git could not complete this operation. Check repository state before retrying.'));
        else resolve(stdout);
      });
      if (child.pid) onDispatch?.();
      child.stdin.on('error', () => {});
      child.stdin.end(input);
    });
  }

  async baseline() {
    const head = (await this.read(path.join(this.directory, 'HEAD'), false, 1024)).toString();
    const id = (await this.git(['rev-parse', '--verify', '--quiet', 'HEAD'], { codes: [0, 1] })).toString().trim();
    if (id && !OID.test(id)) fail('Unsupported Git object format.');
    const stat = await fs.promises.lstat(this.directory);
    return { head, id, metadata: `${stat.dev}:${stat.ino}`, index: digest(await this.read(path.join(this.directory, 'index'), true)) };
  }

  async list(request = {}) {
    if (!await this.validate()) return { versions: [], noRepository: true, source: 'repository', restorable: false };
    const { id } = await this.baseline();
    if (!id) return { versions: [], source: 'repository', restorable: false };
    if (request.cursor) await this.entries(request.cursor);
    if (request.path && historyPathReason(request.path)) fail('That file is excluded from history.');
    const output = await this.git(['log', '-101', '--no-show-signature', '--no-decorate', '--format=%H%x00%ct%x00%s', request.cursor || id, '--', ...(request.path ? [request.path] : [])]);
    const rows = output.toString().trimEnd().split('\n').filter(Boolean);
    const versions = rows.slice(0, 100).map((line) => {
      const [id, seconds, ...label] = line.split('\0');
      if (!OID.test(id) || !/^\d+$/.test(seconds)) fail('Invalid Git history result.');
      // eslint-disable-next-line no-control-regex
      return { id, label: label.join(' ').replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 240), createdAt: Number(seconds) * 1000, source: 'repository' };
    });
    return { versions, limitReached: rows.length > 100, nextCursor: rows[100]?.split('\0')[0] || null, source: 'repository', restorable: false };
  }

  async entries(id) {
    if (!OID.test(id)) fail('Invalid commit.');
    await this.git(['merge-base', '--is-ancestor', id, 'HEAD']);
    const output = await this.git(['ls-tree', '-r', '-z', id]);
    return output.toString().split('\0').filter(Boolean).map((line) => {
      const match = /^(\d+) (blob|commit) ([a-f0-9]{40})\t(.+)$/.exec(line);
      if (!match) fail('Unsupported Git tree entry.');
      return { mode: match[1], type: match[2], oid: match[3], path: match[4] };
    });
  }

  async inspect(request) {
    if (request.action === 'list') return this.list(request);
    if (request.action === 'recovery') return this.recovery();
    if (request.action === 'repair_commit') return this.repairCommit(request.token);
    if (!await this.validate()) fail('This folder has no Git repository. No history has been created.');
    const entries = await this.entries(request.versionId);
    const files = entries.filter(entry => !historyPathReason(entry.path) && ['100644', '100755'].includes(entry.mode));
    if (['comparison', 'comparison_file'].includes(request.action)) {
      const parents = (await this.git(['rev-list', '--parents', '-1', request.versionId])).toString().trim().split(' ');
      const baseId = request.baseId || parents[1] || null;
      const before = baseId ? (await this.entries(baseId)).filter(entry => !historyPathReason(entry.path) && ['100644', '100755'].includes(entry.mode)) : [];
      const changes = compareEntries(before, files);
      if (request.action === 'comparison') return { files: changes.slice(request.offset || 0, (request.offset || 0) + 200), nextOffset: changes.length > (request.offset || 0) + 200 ? (request.offset || 0) + 200 : null, truncated: changes.length > (request.offset || 0) + 200, baseId, versionId: request.versionId };
      const change = changes.find(entry => entry.path === request.path);
      if (!change) fail('This file is not in the comparison. Refresh changes.');
      const read = async (list, name) => {
        const entry = list.find(file => file.path === name);
        return entry ? this.previewBlob(entry.oid, request.offset) : { text: '', missing: true };
      };
      return { before: await read(before, change.oldPath || change.path), after: await read(files, change.path), baseId, versionId: request.versionId };
    }
    if (request.action === 'files') return { files: files.slice(request.offset || 0, (request.offset || 0) + 200).map(({ path }) => ({ path })), nextOffset: files.length > (request.offset || 0) + 200 ? (request.offset || 0) + 200 : null, truncated: files.length > (request.offset || 0) + 200 };
    if (request.action !== 'file') fail('Use your Git client to restore or change repository history.');
    const file = files.find(entry => entry.path === request.path);
    if (!file) fail('Commit file is unavailable or excluded.');
    return this.previewBlob(file.oid, request.offset);
  }

  async previewBlob(oid, offset = 0) {
    const size = Number((await this.git(['cat-file', '-s', oid])).toString());
    if (size > 1024 * 1024) return { text: '', truncated: true, message: 'File exceeds the 1 MiB preview limit. Open it in your editor.' };
    const bytes = await this.git(['cat-file', 'blob', oid]);
    if (historyContainsSecret(bytes)) fail('This file may contain credentials and cannot be previewed.');
    return textPreview(bytes, offset);
  }

  async recovery() {
    if (!await this.validate()) return { pending: false };
    const bytes = await this.read(path.join(this.temporaryRoot, 'git-commit-pending.json'), true, 65536);
    if (!bytes) return { pending: false };
    let record;
    try { record = JSON.parse(bytes); } catch { /* Interrupted journal creation is recoverable without touching Git. */ }
    const readable = record?.root === this.root && OID.test(record?.candidate || '') &&
      typeof record?.baseline?.head === 'string' && /^(?:[a-f0-9]{40})?$/.test(record?.baseline?.id ?? '!') &&
      /^[a-f0-9]{64}$/.test(record?.baseline?.index || '');
    if (!readable) record = { baseline: {}, candidate: null };
    const current = await this.baseline();
    const lockPath = path.join(this.directory, 'index.lock');
    const lock = await this.read(lockPath, true);
    const lockStat = lock ? await fs.promises.lstat(lockPath) : null;
    const ownedLock = Boolean(lockStat && lockStat.dev === record.indexLock?.dev && lockStat.ino === record.indexLock?.ino && lockStat.birthtimeMs === record.indexLock?.birthtimeMs && lockStat.ctimeMs === record.indexLock?.ctimeMs && digest(lock) === record.preparedIndex);
    const lockNames = ['HEAD.lock', 'packed-refs.lock'];
    for (const head of [record.baseline.head, current.head]) {
      if (head?.startsWith('ref: ')) lockNames.push(`${head.slice(5).trim()}.lock`);
    }
    const blockedRef = lockNames.some(name => {
      const target = path.resolve(this.directory, name);
      return !target.startsWith(this.directory + path.sep) || fs.existsSync(target);
    });
    const activeOperation = ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'sequencer']
      .some(name => fs.existsSync(path.join(this.directory, name)));
    const metadataChanged = record.baseline.metadata && record.baseline.metadata !== current.metadata;
    const blocked = Boolean(blockedRef || activeOperation || metadataChanged || (lock && !ownedLock));
    const repairable = readable && !blocked && current.head === record.baseline.head && (
      (current.id === record.candidate && ((ownedLock && current.index === record.baseline.index) || (!lock && current.index === record.preparedIndex))) ||
      (current.id === record.baseline.id && (ownedLock || !lock) && current.index === record.baseline.index));
    const token = digest(JSON.stringify({ journal: digest(bytes), current, lock: lock ? digest(lock) : null, inode: lockStat?.ino, blocked }));
    const state = !readable ? 'unreadable' : current.id === record.candidate ? 'committed' : current.id === record.baseline.id && current.head === record.baseline.head ? 'not_applied' : 'uncertain';
    // Evidence contains object identities and bounded paths, never source text.
    // Failure to compare is uncertainty, not permission to discard staging.
    const evidence = readable && !blocked && !lock && !repairable ? await this.recoveryEvidence(record, current) : null;
    const canKeepCurrent = !blocked && !lock;
    const automatic = repairable ? 'finalize' : canKeepCurrent && evidence?.completed ? 'archive' : null;
    return { pending: true, state, repairable, token, candidate: record.candidate, currentId: current.id,
      canKeepCurrent, automatic, evidence,
      nextAction: automatic ? 'recover' : blocked || lock ? 'wait_or_inspect' : 'ask_user',
      message: automatic === 'finalize' ? 'Freedom can safely finish its interrupted operation without changing working files.'
        : automatic === 'archive' ? 'The selected changes are already committed and staging is reconciled. Freedom can archive its old record.'
          : blocked || lock ? 'Git has an active operation, changed metadata or a remaining lock. Do not remove locks. Inspect or wait for that operation.'
            : !readable ? 'The interrupted record is incomplete or invalid. Inspect current Git state and ask in chat if keeping it is unclear. keep_current can archive only this private record; no commit outcome is established.'
              : 'The repository has changed. Compare this evidence with the task; ask the user in chat if keeping the current state is unclear.',
      steps: ['Use workspace_history recovery to inspect fresh evidence, then recover with its token and resolution automatic when offered.',
        'For ambiguity, explain the current state and ask the user in chat whether to keep it. recover with resolution keep_current only archives Freedom’s record; it never changes repository files, staging or history.',
        'Never reset, rewrite history, delete foreign locks or repeat a commit blindly. After recovery, inspect status and obtain fresh review tokens before any separately authorized commit.'] };
  }

  async recoveryEvidence(record, current) {
    try {
      if (!current.id) return { completed: false, comparisonAvailable: false };
      const changed = await this.git(['diff-tree', '--no-commit-id', '--no-renames', '--name-only', '-r', '-z',
        ...(record.baseline.id ? [record.baseline.id, record.candidate] : ['--root', record.candidate]), '--']);
      const paths = changed.toString().split('\0').filter(Boolean);
      if (!paths.length || paths.length > 200 || paths.some(name => historyPathReason(name))) return { completed: false, comparisonAvailable: false };
      const parse = (bytes, index = false) => {
        const entries = new Map();
        for (const line of bytes.toString().split('\0').filter(Boolean)) {
          const match = (index ? /^(\d+) ([a-f0-9]{40}) 0\t(.+)$/ : /^(\d+) blob ([a-f0-9]{40})\t(.+)$/).exec(line);
          if (!match || !['100644', '100755'].includes(match[1])) throw new Error('Unsupported recovery entry');
          entries.set(match[3], `${match[1]}:${match[2]}`);
        }
        return entries;
      };
      const candidate = parse(await this.git(['ls-tree', '-r', '-z', record.candidate, '--', ...paths]));
      const committed = parse(await this.git(['ls-tree', '-r', '-z', current.id, '--', ...paths]));
      const staged = parse(await this.git(['ls-files', '--stage', '-z', '--', ...paths]), true);
      const ancestor = (await this.git(['merge-base', record.candidate, current.id], { codes: [0, 1] })).toString().trim() === record.candidate;
      const selectedChangesMatch = paths.every(name => candidate.get(name) === committed.get(name));
      const stagingMatchesCurrent = paths.every(name => committed.get(name) === staged.get(name));
      return { comparisonAvailable: true, paths, candidateInHistory: ancestor, selectedChangesMatch, stagingMatchesCurrent,
        completed: current.head === record.baseline.head && stagingMatchesCurrent && (ancestor || selectedChangesMatch) };
    } catch {
      return { completed: false, comparisonAvailable: false };
    }
  }

  async recoverCommit({ token, resolution = 'automatic', reason } = {}) {
    if (!['automatic', 'keep_current'].includes(resolution)) fail('Choose automatic recovery or keep_current after resolving intent in chat.');
    if (resolution === 'keep_current' && (typeof reason !== 'string' || !reason.trim() || reason.length > 160 || historyContainsSecret(reason))) fail('Provide a short non-sensitive reason for keeping the current repository state.');
    await this.authorize(true);
    const state = await this.recovery();
    if (!state.pending || state.token !== token) fail('Recovery state changed. Call workspace_history recovery again; no resolution was applied.');
    if (resolution === 'automatic' && state.automatic === 'finalize') {
      const result = await this.repairCommit(token);
      return { ...result, resolved: true, recoveryOutcome: state.state === 'not_applied' ? 'not_applied' : 'finalized' };
    }
    if (!state.canKeepCurrent || (resolution === 'automatic' && state.automatic !== 'archive')) fail('Automatic recovery is unavailable. Inspect recovery evidence; ask the user in chat when intent is unclear. Do not remove locks or change Git state to bypass this check.');
    await this.authorize(true);
    const rechecked = await this.recovery();
    if (rechecked.token !== token || !rechecked.canKeepCurrent || (resolution === 'automatic' && rechecked.automatic !== 'archive')) fail('Recovery state changed. Inspect it again; no resolution was applied.');
    await this.checkMetadataIdentity();
    if (this.signal?.aborted || Date.now() >= this.deadline) fail('Recovery stopped before resolution. Inspect recovery again.');
    const outcome = resolution === 'automatic' ? 'already_completed' : 'kept_current';
    await fs.promises.rename(path.join(this.temporaryRoot, 'git-commit-pending.json'),
      path.join(this.temporaryRoot, `git-commit-reconciled-${outcome}-${state.candidate || 'unreadable'}-${crypto.randomBytes(8).toString('hex')}.json`));
    return { resolved: true, recoveryOutcome: outcome, id: state.currentId, candidate: state.candidate,
      message: 'Archived the interrupted operation. Repository files, staging and history were not changed. Review current changes before any new commit.' };
  }

  async repairCommit(token) {
    await this.authorize(true);
    const state = await this.recovery();
    if (!state.repairable || state.token !== token) fail('Repository recovery state changed. Inspect recovery again; no repair was applied.');
    const journalPath = path.join(this.temporaryRoot, 'git-commit-pending.json');
    const record = JSON.parse(await this.read(journalPath, false, 65536));
    for (const name of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'sequencer']) {
      if (fs.existsSync(path.join(this.directory, name))) fail('Finish the other Git operation before recovering this commit.');
    }
    await this.authorize(true);
    const rechecked = await this.recovery();
    if (!rechecked.repairable || rechecked.token !== token) fail('Repository recovery state changed. Inspect recovery again.');
    if (this.signal?.aborted || Date.now() >= this.deadline) fail('Recovery was stopped. Inspect recovery again before retrying.');
    await this.checkMetadataIdentity();
    if (this.signal?.aborted) fail('Recovery was stopped. Inspect recovery again before retrying.');
    const lockPath = path.join(this.directory, 'index.lock');
    if (fs.existsSync(lockPath)) {
      // recovery() verified the original lock inode and prepared bytes. A
      // not-applied repair never installs an index or writes the branch.
      const stat = await fs.promises.lstat(lockPath);
      if (stat.dev !== record.indexLock.dev || stat.ino !== record.indexLock.ino || stat.birthtimeMs !== record.indexLock.birthtimeMs || stat.ctimeMs !== record.indexLock.ctimeMs) fail('The Git lock changed. Inspect repository state before retrying.');
      if (state.state === 'not_applied') {
        await fs.promises.unlink(lockPath);
      }
      else await fs.promises.rename(lockPath, path.join(this.directory, 'index'));
    }
    // Archive our journal, retaining evidence. Never remove an unrelated lock or
    // write working files. A failed archive can be finalized by inspecting again.
    await fs.promises.rename(journalPath, path.join(this.temporaryRoot, `git-commit-recovered-${record.candidate}-${crypto.randomBytes(8).toString('hex')}.json`));
    return { repaired: true, id: state.state === 'not_applied' ? record.baseline.id : record.candidate, message: state.state === 'not_applied'
      ? 'The commit was not applied. Its owned lock was released; review changes before retrying.'
      : 'Commit finalization completed. Working files were not changed.' };
  }

  async configuration() {
    const settings = {};
    const configuration = [];
    for (const filename of this.configFiles) {
      const bytes = await this.read(filename, true, 65536);
      configuration.push([filename, digest(bytes)]);
      if (!bytes) continue;
      if ((await this.configEntries(bytes)).some(key => /^(?:include|includeif)\./i.test(key))) fail('Git configuration includes require your Git client for commits.');
      for (const key of ['user.name', 'user.email', 'core.hooksPath', 'commit.gpgSign', 'core.autocrlf', 'core.fileMode', 'core.attributesFile', 'core.excludesFile']) {
        const value = (await this.git(['config', '--no-includes', '--file', filename,
          ...(['commit.gpgSign', 'core.autocrlf', 'core.fileMode'].includes(key) ? ['--type=bool'] : []), '--get', key], { codes: [0, 1] })).toString().trim();
        if (value) settings[key] = value;
      }
    }
    if (settings['core.hooksPath'] || settings['core.attributesFile'] || (settings['commit.gpgSign'] && settings['commit.gpgSign'] !== 'false') ||
        (settings['core.autocrlf'] && settings['core.autocrlf'] !== 'false')) fail('This repository uses hooks, signing or line-ending conversion. Commit with your Git client; Freedom will not bypass those requirements.');
    if (settings['core.excludesFile'] || (this.globalIgnorePath && (await this.read(this.globalIgnorePath, true, 65536))?.length)) fail('Global Git ignore rules are not supported by this commit tool yet. Commit with your Git client; Freedom will not ignore those rules.');
    const hooks = path.join(this.directory, 'hooks');
    for (const name of await fs.promises.readdir(hooks).catch(error => { if (error.code === 'ENOENT') return []; throw error; })) {
      if (name.endsWith('.sample')) continue;
      const stat = await fs.promises.lstat(path.join(hooks, name));
      configuration.push([name, stat.mode, digest(await this.read(path.join(hooks, name)))]);
      if (stat.mode & 0o111) fail('This repository has active Git hooks. Commit with your Git client; Freedom will not bypass them.');
    }
    const name = settings['user.name']; const email = settings['user.email'];
    // eslint-disable-next-line no-control-regex
    if (!name || !email || [name, email].some(value => value.length > 200 || /[\x00-\x1f<>]/.test(value))) fail('Configure your Git user.name and user.email before committing.');
    return { name, email, fileMode: settings['core.fileMode'] !== 'false', fingerprint: digest(JSON.stringify(configuration)) };
  }

  async commit(reviews, expected, message, recheck) {
    if (!await this.validate()) fail('This folder has no Git repository. Initialize it explicitly with your Git client first.');
    await this.authorize(true);
    if (typeof message !== 'string' || !message.trim() || message.length > 2000 || message.includes('\0') || historyContainsSecret(message)) fail('Provide a commit message without credentials.');
    if (!reviews.length || reviews.length > 200 || reviews.some(review => historyPathReason(review.path))) fail('Select reviewed project files.');
    validateSnapshot({ files: reviews.filter(review => review.file).map(review => review.file) });
    const baseline = await this.baseline();
    if (JSON.stringify(baseline) !== JSON.stringify(expected)) fail('Git HEAD or staging changed since review. Review the changes again.');
    if (!/^ref: refs\/heads\/[^\s]+\n$/.test(baseline.head)) fail('Check out a branch before committing.');
    await this.git(['check-ref-format', baseline.head.slice(5).trim()]);
    const directRef = await this.read(path.join(this.directory, baseline.head.slice(5).trim()), true, 1024);
    if (directRef && !/^[a-f0-9]{40}\n$/.test(directRef.toString())) fail('Symbolic branch chains require your Git client.');
    for (const name of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'sequencer']) {
      if (fs.existsSync(path.join(this.directory, name))) fail('Finish the current Git operation in your Git client first.');
    }
    const identity = await this.configuration();
    const attributes = await this.git(['check-attr', '-z', '--all', '--', ...reviews.map(review => review.path)]);
    const attrs = attributes.toString().split('\0');
    for (let i = 1; i < attrs.length; i += 3) {
      if (['filter', 'text', 'eol', 'working-tree-encoding', 'ident'].includes(attrs[i]) && attrs[i + 1] !== 'unset') fail('Selected files require Git content conversion. Commit with your Git client.');
    }
    const lockPath = path.join(this.directory, 'index.lock');
    const journalPath = path.join(this.temporaryRoot, 'git-commit-pending.json');
    if (fs.existsSync(journalPath)) fail('A previous commit needs inspection. Call workspace_history with action recovery, then recover with the returned token when automatic resolution is available. If intent is ambiguous, ask the user in chat before keeping the current state. Do not retry the commit blindly.');
    let lock; let lockIdentity; let temporary; let candidate = null; let committed = null; let refAttempted = false; let journalCreated = false;
    const ownsLock = async () => {
      try {
        await this.checkMetadataIdentity();
        const stat = await fs.promises.lstat(lockPath);
        return stat.isFile() && !stat.isSymbolicLink() && stat.dev === lockIdentity.dev && stat.ino === lockIdentity.ino;
      } catch { return false; }
    };
    try {
      lock = await fs.promises.open(lockPath, 'wx', 0o600);
      lockIdentity = await lock.stat();
      temporary = await fs.promises.mkdtemp(path.join(this.temporaryRoot, 'git-commit-'));
      const treeIndex = path.join(temporary, 'tree-index');
      const nextIndex = path.join(temporary, 'next-index');
      const originalIndex = await this.read(path.join(this.directory, 'index'), true);
      if (originalIndex) await fs.promises.writeFile(nextIndex, originalIndex, { flag: 'wx', mode: 0o600 });
      else await this.git(['read-tree', '--empty'], { index: nextIndex });
      if ((await this.git(['ls-files', '--unmerged'], { index: nextIndex })).length) fail('Resolve Git conflicts before committing.');
      const flags = (await this.git(['ls-files', '-v', '-z'], { index: nextIndex })).toString().split('\0').filter(Boolean);
      if (flags.some(entry => !entry.startsWith('H '))) fail('Special index flags require your Git client.');
      const indexDebug = (await this.git(['ls-files', '--debug', '--', ...reviews.map(review => review.path)], { index: nextIndex })).toString();
      if ([...indexDebug.matchAll(/flags: (\w+)/g)].some(match => match[1] !== '0')) fail('Extended index flags require your Git client.');
      await this.git(['read-tree', ...(baseline.id ? [baseline.id] : ['--empty'])], { index: treeIndex });
      const baseEntries = new Map((baseline.id ? await this.entries(baseline.id) : []).map(entry => [entry.path, entry]));
      const staged = (await this.git(['ls-files', '--stage', '-z'], { index: nextIndex })).toString().split('\0').filter(Boolean);
      const stagedEntries = new Map(staged.map(line => {
        const match = /^(\d+) ([a-f0-9]{40}) 0\t(.+)$/.exec(line);
        if (!match) fail('Unsupported staged entry.');
        return [match[3], { mode: match[1], oid: match[2] }];
      }));
      const changes = [];
      const fold = name => name.normalize('NFC').toLowerCase();
      const names = [...baseEntries.keys(), ...stagedEntries.keys()];
      for (const review of reviews) {
        if (names.some(name => name !== review.path && fold(name) === fold(review.path)))
          fail('The selected filename differs in case or Unicode normalization from Git history. Use the exact tracked name or rename it with your Git client.');
      }
      for (const review of reviews) {
        if (!baseEntries.has(review.path) && (await this.git(['check-ignore', '--no-index', '-z', '--stdin'],
          { input: `./${review.path}\0`, codes: [0, 1] })).length) fail('A selected file is ignored by the repository. It was not committed.');
      }
      for (const review of reviews) {
        const file = review.file;
        const base = baseEntries.get(review.path); const stage = stagedEntries.get(review.path);
        const oid = file ? (await this.git(['hash-object', '-w', '--stdin', '--no-filters'], { input: Buffer.from(file.content, 'base64') })).toString().trim() : null;
        if (base && !['100644', '100755'].includes(base.mode)) fail('Submodule and symlink commits require your Git client.');
        const same = (entry, other) => (!entry && !other) || (entry?.oid === other?.oid && entry?.mode === other?.mode);
        const mode = file && !identity.fileMode ? (base?.mode || stage?.mode || '100644') : file?.mode;
        const desired = file ? { mode, oid } : undefined;
        if (!same(stage, base) && !same(stage, desired)) fail('A selected file has different staged changes. Resolve its staging before committing.');
        changes.push(`${file ? mode : '0'} ${oid || '0'.repeat(40)}\t${review.path}\0`);
      }
      for (const index of [treeIndex, nextIndex]) await this.git(['update-index', '-z', '--index-info'], { index, input: changes.join('') });
      const tree = (await this.git(['write-tree'], { index: treeIndex })).toString().trim();
      if (baseline.id && tree === (await this.git(['rev-parse', `${baseline.id}^{tree}`])).toString().trim()) return { saved: false, id: baseline.id, source: 'repository' };
      const id = (await this.git(['commit-tree', tree, ...(baseline.id ? ['-p', baseline.id] : [])], { input: `${message.trim()}\n`, identity })).toString().trim();
      if (!OID.test(id)) fail('Invalid Git commit result.');
      candidate = id;
      await lock.writeFile(await this.read(nextIndex)); await lock.sync();
      await this.validate(); await this.authorize(true); await recheck();
      if ((await this.configuration()).fingerprint !== identity.fingerprint ||
          !(await this.git(['check-attr', '-z', '--all', '--', ...reviews.map(review => review.path)])).equals(attributes)) fail('Git requirements changed during preparation. Review again.');
      if (JSON.stringify(await this.baseline()) !== JSON.stringify(baseline)) fail('Git changed during commit preparation. Review again.');
      if (!await ownsLock()) fail('The Git index lock changed. Inspect repository state before retrying.');
      const journal = await fs.promises.open(journalPath, 'wx', 0o600);
      journalCreated = true;
      try {
        const preparedLock = await lock.stat();
        await journal.writeFile(JSON.stringify({ root: this.root, baseline, candidate: id, temporary,
          preparedIndex: digest(await this.read(nextIndex)), indexLock: { dev: preparedLock.dev, ino: preparedLock.ino, birthtimeMs: preparedLock.birthtimeMs, ctimeMs: preparedLock.ctimeMs }, phase: 'ref_update_pending' }));
        await journal.sync();
      } finally { await journal.close(); }
      const journalDirectory = await fs.promises.open(this.temporaryRoot, 'r');
      try { await journalDirectory.sync(); } finally { await journalDirectory.close(); }
      await this.authorize(true);
      await this.git(['update-ref', '--no-deref', '-m', `commit: ${message.split('\n')[0].slice(0, 160)}`, baseline.head.slice(5).trim(), id, baseline.id || '0'.repeat(40)],
        { identity, expected: baseline, onDispatch: () => { refAttempted = true; } });
      committed = id;
      await this.authorize(true);
      if ((await this.read(path.join(this.directory, 'HEAD'))).toString() !== baseline.head ||
          (await this.baseline()).id !== id || !await ownsLock()) fail('Git state changed during commit finalization.');
      await lock.close(); lock = null;
      await fs.promises.rename(lockPath, path.join(this.directory, 'index'));
      await fs.promises.unlink(journalPath);
      return { saved: true, id, source: 'repository', branch: baseline.head.slice('ref: refs/heads/'.length).trim() };
    } catch (error) {
      if (refAttempted) fail(committed
        ? `Commit ${committed} was created, but finalization did not finish. Inspect Git status and the retained recovery record before any further operation.`
        : `The outcome of commit ${candidate} is uncertain. Inspect Git history and the retained recovery record before retrying.`);
      if (error.code === 'EEXIST') fail('Git is busy. Wait for the other Git operation to finish.');
      throw error;
    } finally {
      if (lock) { await lock.close(); if (!refAttempted && await ownsLock()) await fs.promises.unlink(lockPath).catch(() => {}); }
      // Only our own temporary files are removed; never project files.
      if (temporary && (!refAttempted || !fs.existsSync(journalPath))) await fs.promises.rm(temporary, { recursive: true, force: true });
      if (journalCreated && !refAttempted) await fs.promises.unlink(journalPath);
    }
  }
}

module.exports = { ExternalProjectGit };
