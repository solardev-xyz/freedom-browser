'use strict';

const fs = require('fs');
const path = require('path');

// A minimal, ordinary Git repository. Creating the empty metadata directly avoids
// requiring a host Git installation merely to allocate a managed workspace.
const INITIAL_GIT_FILES = Object.freeze({
  HEAD: 'ref: refs/heads/main\n',
  config: '[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = false\n',
  'info/exclude':
    '# Freedom workspace defaults\nnode_modules/\ndist/\nbuild/\ncoverage/\n.vite/\n.next/\n.cache/\n.DS_Store\n.env\n.env.*\n!.env.example\n!.env.sample\n*.pem\n*.key\n*.p12\n*.pfx\n',
});

async function initializeWorkspaceGit(workspaceRoot) {
  const directory = path.join(workspaceRoot, '.git');
  const stats = await fs.promises.lstat(directory);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error('Managed workspace Git metadata is unavailable');
  }
  // Only initialize the empty directory reserved by Freedom. Existing repositories
  // (including partially initialized or unfamiliar metadata) are never rewritten.
  if ((await fs.promises.readdir(directory)).length) return;
  for (const name of ['objects', 'refs', 'refs/heads', 'refs/tags', 'info']) {
    await fs.promises.mkdir(path.join(directory, name), { mode: 0o700 });
  }
  for (const [name, content] of Object.entries(INITIAL_GIT_FILES)) {
    await fs.promises.writeFile(path.join(directory, name), content, { flag: 'wx', mode: 0o600 });
  }
}

module.exports = { initializeWorkspaceGit };
