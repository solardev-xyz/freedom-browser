'use strict';

// Use only installed Git within the existing system-toolchain sandbox boundary.
// In particular, never execute macOS /usr/bin/git: it can launch the developer
// tools installer when the real command-line tools are absent.
function workspaceGitCommand(platform = process.platform, accessible) {
  const executable =
    platform === 'darwin'
      ? '/Library/Developer/CommandLineTools/usr/bin/git'
      : platform === 'linux'
        ? '/usr/bin/git'
        : null;
  if (!executable) return null;
  try {
    if (accessible) return accessible(executable) ? executable : null;
    const fs = require('fs');
    fs.accessSync(executable, fs.constants.X_OK);
    return fs.statSync(executable).isFile() ? executable : null;
  } catch {
    return null;
  }
}

module.exports = { workspaceGitCommand };
