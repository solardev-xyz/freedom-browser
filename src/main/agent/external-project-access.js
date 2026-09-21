'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

function projectError(code, message) {
  return Object.assign(new Error(message), { code });
}

function contains(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

// Only native-picker results reach this class. Persisted paths identify a project,
// but are not grants: every application lifetime requires explicit reconnection.
class ExternalProjectAccess {
  constructor({ userDataDir }) {
    this.userDataDir = userDataDir;
    this.grants = new Map();
  }

  async identify(selectedPath) {
    if (typeof selectedPath !== 'string' || !path.isAbsolute(selectedPath)) {
      throw projectError('PROJECT_UNSAFE', 'Choose a project folder.');
    }
    const entry = await fs.promises.lstat(selectedPath);
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw projectError('PROJECT_UNSAFE', 'Choose a regular project folder, not a link.');
    }
    const root = await fs.promises.realpath(selectedPath);
    const home = await fs.promises.realpath(os.homedir());
    const privateRoot = await fs.promises.realpath(this.userDataDir);
    if (contains(root, home) || contains(root, privateRoot) || contains(privateRoot, root) ||
        ['.git', '.ssh', '.gnupg', '.aws', '.codex'].some((part) => root.split(path.sep).some((name) => name.toLowerCase() === part)) ||
        ['Library', 'AppData', '.config', '.local/share'].some((relative) => contains(path.join(home, relative), root)) ||
        ['/System', '/Library', '/Applications', '/usr', '/bin', '/sbin', '/etc', '/private/etc'].some((base) => contains(base, root))) {
      throw projectError('PROJECT_UNSAFE', 'Choose a project folder outside application and system storage.');
    }
    const stats = await fs.promises.stat(root);
    if (stats.dev !== entry.dev || stats.ino !== entry.ino) {
      throw projectError('PROJECT_CHANGED', 'The selected folder changed. Choose it again.');
    }
    return Object.freeze({ root, dev: String(stats.dev), ino: String(stats.ino), name: path.basename(root) });
  }

  grant(workspaceId, identity, mode = 'read') {
    if (!['read', 'write'].includes(mode)) throw projectError('PROJECT_ACCESS_INVALID', 'Invalid project access.');
    for (const [id, grant] of this.grants) {
      if (id !== workspaceId && (mode === 'write' || grant.mode === 'write') &&
          (contains(identity.root, grant.root) || contains(grant.root, identity.root))) {
        throw projectError('PROJECT_IN_USE', 'This folder overlaps a project already open for editing. Remove its access first.');
      }
    }
    this.grants.set(workspaceId, Object.freeze({ ...identity, mode }));
  }

  async resolve(workspaceId, { write = false } = {}) {
    const grant = this.grants.get(workspaceId);
    if (!grant) throw projectError('PROJECT_RECONNECT_REQUIRED', 'Reconnect this project to give Freedom Agent access.');
    if (write && grant.mode !== 'write') throw projectError('PROJECT_READ_ONLY', 'Allow editing from the project menu first.');
    try {
      const stats = await fs.promises.lstat(grant.root);
      if (!stats.isDirectory() || stats.isSymbolicLink() || String(stats.dev) !== grant.dev || String(stats.ino) !== grant.ino ||
          await fs.promises.realpath(grant.root) !== grant.root) throw new Error('changed');
    } catch {
      this.grants.delete(workspaceId);
      throw projectError('PROJECT_CHANGED', 'This project moved or became unavailable. Reconnect it to continue.');
    }
    // Revocation may have happened during the filesystem checks.
    if (this.grants.get(workspaceId) !== grant) throw projectError('PROJECT_RECONNECT_REQUIRED', 'Project access changed. Try again.');
    return grant;
  }

  revoke(workspaceId) { this.grants.delete(workspaceId); }
  clear() { this.grants.clear(); }
}

module.exports = { ExternalProjectAccess, projectError };
