'use strict';

const packageMetadata = require('../package.json');

const releaseBuild = packageMetadata.build;

module.exports = {
  ...releaseBuild,
  directories: {
    ...releaseBuild.directories,
    output: 'out/agent-sandbox-packaged',
  },
  extraMetadata: {
    main: 'src/main/agent/workspace-execution/electron-qualification-main.js',
  },
  // The qualification exercises Electron, app.asar and Seatbelt. The optional
  // product node payloads are unrelated and are absent on the throwaway host.
  extraResources: [],
  mac: {
    ...releaseBuild.mac,
    target: ['dir'],
    identity: null,
    notarize: false,
    extraResources: [],
  },
};
