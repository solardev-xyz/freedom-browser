'use strict';

const packageMetadata = require('../package.json');

const releaseBuild = packageMetadata.build;

module.exports = {
  ...releaseBuild,
  directories: {
    ...releaseBuild.directories,
    output: 'out/agent-sandbox-packaged-linux',
  },
  extraMetadata: {
    main: 'src/main/agent/workspace-execution/electron-qualification-main.js',
  },
  afterPack: './scripts/prepare-agent-sandbox-linux-package.js',
  // This qualification needs Electron, app.asar and the Linux package layout only.
  // Optional product node payloads are deliberately excluded from the throwaway build.
  extraResources: [],
  linux: {
    ...releaseBuild.linux,
    target: ['dir', 'deb', 'AppImage'],
    extraResources: [],
  },
  publish: null,
};
