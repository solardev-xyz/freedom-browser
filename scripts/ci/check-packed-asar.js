#!/usr/bin/env node
// Packages an unpacked `--dir` build for one target and runs the app.asar
// check (#576, scripts/check-asar-contents.js) on it. The `packed-asar-contents`
// CI job runs this for mac, win and linux from one ubuntu runner, so a pull
// request exercises the guard's per-platform paths (`.app/Contents/Resources`
// on darwin, the target's better-sqlite3 prebuild name) instead of first
// meeting them in release.yml at tag time.
//
// It uses the real `build` config from package.json, `files` lists included,
// and drops only what cannot run on a linux host for another platform:
// native rebuilds (every native dependency ships prebuilds), signing, fuses
// (@electron/fuses cannot flip a mac binary from linux), and the rest of
// scripts/after-pack.js (the Windows VC++ runtime bundling needs the
// redistributable). Release builds still run the same check from
// scripts/after-pack.js.
//
//   node scripts/ci/check-packed-asar.js --mac --arm64
const path = require('path');
const { Arch } = require('builder-util');
const builder = require('electron-builder');
const { checkPackedApp } = require('../check-asar-contents');

const args = process.argv.slice(2);
const platform = ['mac', 'linux', 'win'].find((p) => args.includes(`--${p}`));
const arch = ['arm64', 'x64'].find((a) => args.includes(`--${a}`));
if (!platform || !arch) {
  console.error('usage: check-packed-asar.js --mac|--linux|--win --arm64|--x64');
  process.exit(2);
}

const root = path.join(__dirname, '..', '..');
const pkg = require(path.join(root, 'package.json'));
const config = {
  ...pkg.build,
  npmRebuild: false,
  electronFuses: null,
  mac: { ...pkg.build.mac, identity: null, notarize: false },
  directories: { ...pkg.build.directories, output: path.join('dist', 'asar-check') },
  afterPack: async (context) => {
    const packed = checkPackedApp(context, Arch[context.arch]);
    console.log(
      `  • ${context.electronPlatformName}-${Arch[context.arch]}: app.asar holds ${packed} files, all inside the build.files allowlist`
    );
  },
};

builder
  .build({
    projectDir: root,
    targets: builder.Platform[
      { mac: 'MAC', linux: 'LINUX', win: 'WINDOWS' }[platform]
    ].createTarget('dir', builder.Arch[arch]),
    config,
    publish: 'never',
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
