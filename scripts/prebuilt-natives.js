#!/usr/bin/env node
'use strict';

/**
 * Prebuilt natives: Arti, the whisper.cpp dictation runtime and the Windows
 * sandbox helpers, compiled once per pinned recipe by
 * `.github/workflows/natives.yml` instead of in every release build.
 *
 * Each component has a *key*: the sha256 of every repository file that decides
 * its bytes (the build script, its pins, its patches). `natives.yml` publishes
 * one `<component>-<target>.tar.gz` per target to a `natives-*` release, and
 * scripts/prebuilt-natives.json pins, per component, the key it was built from
 * and each archive's sha256. `fetch` installs an archive only while its pinned
 * key still matches the checkout; a stale component is left for the regular
 * source build, so a recipe change is never shipped with old binaries. A
 * checksum mismatch is tampering or corruption and always fails.
 *
 *   fetch [--target <t>] [<component>...]   install current prebuilts
 *   pack --target <t> --out <dir>           archive this target's built outputs
 *   manifest --dir <dir> --tag <tag> --commit <sha>
 *                                           print the pin file for archives in <dir>
 *   pin --run <id>                          pin the manifest a natives.yml run on
 *                                           main uploaded (needs `gh`)
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { downloadToFile, TIMEOUTS } = require('./lib/fetch-with-retry');

const ROOT = path.join(__dirname, '..');
const PIN_FILE = path.join(__dirname, 'prebuilt-natives.json');
const REPO = 'solardev-xyz/freedom-browser';
const TARGETS = ['mac-arm64', 'linux-x64', 'linux-arm64', 'win-x64'];
const MAX_ARCHIVE_BYTES = 200 * 1024 * 1024;
const WINDOWS_ADAPTER = 'src/main/agent/workspace-execution/native/windows';

const COMPONENTS = {
  arti: {
    targets: TARGETS,
    inputs: () => ['scripts/fetch-arti.js'],
    dir: (target) => `arti-bin/${target}`,
  },
  dictation: {
    targets: TARGETS,
    inputs: () => [
      'scripts/build-dictation-runtime.js',
      'src/shared/dictation-runtime.js',
      'src/main/agent/dictation-local-notices.txt',
    ],
    dir: (target) => `out/dictation-runtime/${target}`,
  },
  'windows-workspace': {
    targets: ['win-x64'],
    inputs: () => [
      'scripts/build-windows-workspace.js',
      'scripts/windows-workspace-notices.js',
      // windows-workspace-notices.js embeds it in CODEX-DEPENDENCIES.*.
      'LICENSE',
      ...listFiles(WINDOWS_ADAPTER),
    ],
    dir: () => 'out/windows-workspace/x64',
  },
};

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

function listFiles(relative) {
  const out = [];
  for (const item of fs.readdirSync(path.join(ROOT, relative), { withFileTypes: true })) {
    const name = `${relative}/${item.name}`;
    if (item.isDirectory()) out.push(...listFiles(name));
    else out.push(name);
  }
  return out.sort();
}

/**
 * The component's recipe key. Line endings are normalised so a Windows runner's
 * core.autocrlf checkout computes the same key as the Linux one that publishes.
 */
function componentKey(component, root = ROOT) {
  const spec = COMPONENTS[component];
  if (!spec) throw new Error(`Unknown prebuilt component: ${component}`);
  const lines = spec
    .inputs()
    .slice()
    .sort()
    .map((file) => {
      const text = fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n');
      return `${sha256(text)}  ${file}\n`;
    });
  return sha256(lines.join(''));
}

function hostTarget() {
  const osName = { darwin: 'mac', linux: 'linux', win32: 'win' }[process.platform] || process.platform;
  return `${osName}-${process.arch}`;
}

function tarBinary() {
  if (process.platform === 'win32') {
    // Not the GNU tar first on Git Bash's PATH: it reads `D:\` as a remote host.
    return path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
  }
  return process.platform === 'darwin' ? '/usr/bin/tar' : 'tar';
}

function readPins(file = PIN_FILE) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function assetName(component, target) {
  return `${component}-${target}.tar.gz`;
}

/** Archive entries must be plain files or directories inside the archive root. */
function checkListing(verbose, names) {
  for (const line of verbose.split('\n')) {
    if (line.trim() && !/^[-d]/.test(line)) throw new Error('Prebuilt archive contains links or special files');
  }
  for (const name of names.split('\n').map((n) => n.trim()).filter(Boolean)) {
    if (path.isAbsolute(name) || /^[A-Za-z]:/.test(name) || name.split(/[\\/]/).includes('..')) {
      throw new Error(`Prebuilt archive entry escapes its directory: ${name}`);
    }
  }
}

function extractArchive(archive, destination) {
  const tar = tarBinary();
  checkListing(
    execFileSync(tar, ['-tvzf', archive], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }),
    execFileSync(tar, ['-tzf', archive], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  );
  const parent = path.dirname(destination);
  fs.mkdirSync(parent, { recursive: true });
  const scratch = fs.mkdtempSync(path.join(parent, '.prebuilt-'));
  try {
    execFileSync(tar, ['-xzf', archive, '-C', scratch], { stdio: 'inherit' });
    fs.rmSync(destination, { recursive: true, force: true });
    fs.renameSync(scratch, destination);
  } catch (error) {
    fs.rmSync(scratch, { recursive: true, force: true });
    throw error;
  }
}

/**
 * Install every requested component whose pinned key matches the checkout.
 * Returns `{ <component>: 'hit' | 'stale' }`.
 */
async function fetchPrebuilt(target, components, options = {}) {
  const pins = options.pins || readPins();
  const root = options.root || ROOT;
  const download = options.download || ((url, file) =>
    downloadToFile(url, file, { maxBytes: MAX_ARCHIVE_BYTES, timeoutMs: TIMEOUTS.binary }));
  const result = {};
  for (const component of components) {
    const spec = COMPONENTS[component];
    if (!spec) throw new Error(`Unknown prebuilt component: ${component}`);
    if (!spec.targets.includes(target)) throw new Error(`${component} has no prebuilt for ${target}`);
    const pin = pins.components?.[component];
    const key = componentKey(component, root);
    if (!pins.tag || !pin || pin.key !== key || !pin.assets?.[target]) {
      console.log(`[prebuilt-natives] ${component} for ${target}: no prebuilt for this recipe, building from source`);
      result[component] = 'stale';
      continue;
    }
    const url = `https://github.com/${REPO}/releases/download/${pins.tag}/${assetName(component, target)}`;
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'prebuilt-natives-'));
    try {
      const archive = path.join(scratch, assetName(component, target));
      await download(url, archive);
      const actual = sha256(fs.readFileSync(archive));
      if (actual !== pin.assets[target]) {
        throw new Error(`${url} has sha256 ${actual}, expected ${pin.assets[target]}`);
      }
      extractArchive(archive, path.join(root, spec.dir(target)));
      console.log(`[prebuilt-natives] ${component} for ${target}: installed ${pins.tag}`);
      result[component] = 'hit';
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  }
  return result;
}

/** Archive the built outputs of every component this target has. */
function pack(target, outDir, root = ROOT) {
  fs.mkdirSync(outDir, { recursive: true });
  const written = [];
  for (const [component, spec] of Object.entries(COMPONENTS)) {
    if (!spec.targets.includes(target)) continue;
    const dir = path.join(root, spec.dir(target));
    if (!fs.existsSync(dir) || fs.readdirSync(dir).length === 0) throw new Error(`Nothing built at ${dir}`);
    const archive = path.resolve(outDir, assetName(component, target));
    execFileSync(tarBinary(), ['-czf', archive, '-C', dir, '.'], { stdio: 'inherit' });
    written.push(archive);
  }
  return written;
}

/** The pin file for the archives in `dir`; every component and target must be there. */
function manifest(dir, tag, commit, root = ROOT) {
  const components = {};
  for (const [component, spec] of Object.entries(COMPONENTS)) {
    const assets = {};
    for (const target of spec.targets) {
      assets[target] = sha256(fs.readFileSync(path.join(dir, assetName(component, target))));
    }
    components[component] = { key: componentKey(component, root), assets };
  }
  return { tag, commit, components };
}

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
}

/**
 * Pin from the run's own workflow artifact, never from the release: release
 * assets can be replaced later, the artifact of a finished run cannot.
 */
function pinRun(runId) {
  const run = JSON.parse(gh(['api', `repos/${REPO}/actions/runs/${runId}`]));
  if (run.path !== '.github/workflows/natives.yml' || run.head_branch !== 'main' ||
      run.event !== 'workflow_dispatch' || run.conclusion !== 'success') {
    throw new Error(`Run ${runId} is not a successful natives.yml dispatch on main`);
  }
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'prebuilt-natives-pin-'));
  try {
    gh(['run', 'download', String(runId), '--repo', REPO, '--name', 'prebuilt-natives-manifest', '--dir', scratch]);
    const pins = readPins(path.join(scratch, 'prebuilt-natives.json'));
    if (pins.commit !== run.head_sha) throw new Error(`Manifest commit ${pins.commit} is not the run's ${run.head_sha}`);
    for (const component of Object.keys(COMPONENTS)) {
      if (pins.components?.[component]?.key !== componentKey(component)) {
        console.warn(`[prebuilt-natives] ${component}: this checkout's recipe differs from ${pins.tag}; it will keep building from source`);
      }
    }
    fs.writeFileSync(PIN_FILE, `${JSON.stringify(pins, null, 2)}\n`);
    console.log(`[prebuilt-natives] pinned ${pins.tag} in ${path.relative(ROOT, PIN_FILE)}`);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

function option(args, name) {
  const at = args.indexOf(name);
  if (at === -1) return undefined;
  const [value] = args.splice(at, 2).slice(1);
  if (!value) throw new Error(`${name} needs a value`);
  return value;
}

async function main(argv) {
  const args = argv.slice();
  const command = args.shift();
  if (command === 'fetch') {
    const target = option(args, '--target') || hostTarget();
    const components = args.length > 0 ? args : Object.keys(COMPONENTS).filter((c) => COMPONENTS[c].targets.includes(target));
    const result = await fetchPrebuilt(target, components);
    if (process.env.GITHUB_OUTPUT) {
      fs.appendFileSync(process.env.GITHUB_OUTPUT,
        Object.entries(result).map(([c, state]) => `${c.replace(/-/g, '_')}=${state}\n`).join(''));
    }
    for (const [component, state] of Object.entries(result)) {
      if (state === 'stale' && process.env.GITHUB_ACTIONS) {
        console.log(`::warning::${component} has no prebuilt for this recipe and is compiled from source; run natives.yml on main and pin it (docs/agent-playbooks/bundled-binaries.md)`);
      }
    }
  } else if (command === 'pack') {
    pack(option(args, '--target') || hostTarget(), option(args, '--out') || 'natives-dist');
  } else if (command === 'manifest') {
    const dir = option(args, '--dir');
    const tag = option(args, '--tag');
    const commit = option(args, '--commit');
    if (!dir || !tag || !commit) throw new Error('manifest needs --dir, --tag and --commit');
    process.stdout.write(`${JSON.stringify(manifest(dir, tag, commit), null, 2)}\n`);
  } else if (command === 'pin') {
    const run = option(args, '--run');
    if (!/^\d+$/.test(run || '')) throw new Error('pin needs --run <natives.yml run id>');
    pinRun(run);
  } else {
    throw new Error('Usage: prebuilt-natives.js fetch|pack|manifest|pin (see the header of this file)');
  }
}

module.exports = { COMPONENTS, TARGETS, componentKey, fetchPrebuilt, pack, manifest, checkListing, extractArchive, assetName, hostTarget };

if (require.main === module) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`[prebuilt-natives] ${error.message}`);
    // Not process.exit(): it can hang on Node 24 (#544).
    process.exitCode = 1;
  });
}
