// Guards what electron-builder packs into app.asar (#576). The top-level
// `build.files` allowlist only holds while every platform `files` list carries
// positive patterns too: a list of negations alone makes electron-builder put
// `**/*` in front of it, and the whole repository (docs, tests, scripts, other
// platforms' node binaries) ships in the signed bundle. Run from the afterPack
// hook so a leaking build fails on every platform before it is signed.
const fs = require('fs');
const path = require('path');

// Everything outside node_modules must sit under one of these.
const ALLOWED_TOP_LEVEL = new Set(['src', 'package.json', 'node_modules']);
const TEST_FILE = /\.(test|spec)\.js$/;
// Test-only directories: their helpers, probes and fixtures are not named
// *.test.js (Safe test owners with hardhat keys, Electron probe scripts, JSON
// fixtures) and nothing at runtime loads them.
const TEST_DIR = /(^|\/)(__tests__|__fixtures__|__mocks__)\//;

// The asar header is a pickled JSON string: an 8-byte size pickle, then a
// 4-byte payload length and a 4-byte string length, then the JSON itself.
function readAsarHeader(asarPath) {
  const fd = fs.openSync(asarPath, 'r');
  try {
    const sizeBuf = Buffer.alloc(16);
    fs.readSync(fd, sizeBuf, 0, 16, 0);
    const jsonLength = sizeBuf.readUInt32LE(12);
    const jsonBuf = Buffer.alloc(jsonLength);
    fs.readSync(fd, jsonBuf, 0, jsonLength, 16);
    return JSON.parse(jsonBuf.toString('utf8'));
  } finally {
    fs.closeSync(fd);
  }
}

function listAsarFiles(header) {
  const out = [];
  const walk = (node, prefix) => {
    for (const [name, child] of Object.entries(node.files || {})) {
      const rel = prefix ? `${prefix}/${name}` : name;
      if (child.files) walk(child, rel);
      else out.push(rel);
    }
  };
  walk(header, '');
  return out;
}

// `files`: paths inside app.asar, `/`-separated. `prebuilds`: file names in
// app.asar.unpacked/node_modules/better-sqlite3/prebuilds. `targets`: the
// prebuild names this build may keep (e.g. ['linux-x64.node']).
function findAsarProblems({ files, prebuilds = [], targets = [] }) {
  const problems = [];
  const strayTopLevel = new Set();
  for (const file of files) {
    const top = file.split('/')[0];
    if (top === 'node_modules') continue;
    if (!ALLOWED_TOP_LEVEL.has(top)) strayTopLevel.add(top);
    else if (TEST_FILE.test(file) || TEST_DIR.test(file)) {
      problems.push(`test file packed: ${file}`);
    }
  }
  for (const top of [...strayTopLevel].sort()) {
    problems.push(`unexpected top-level entry packed: ${top}`);
  }
  for (const name of prebuilds) {
    if (!targets.includes(name)) problems.push(`foreign better-sqlite3 prebuild packed: ${name}`);
  }
  return problems;
}

function resourcesDir(context) {
  if (context.electronPlatformName === 'darwin' || context.electronPlatformName === 'mas') {
    return path.join(
      context.appOutDir,
      `${context.packager.appInfo.productFilename}.app`,
      'Contents',
      'Resources'
    );
  }
  return path.join(context.appOutDir, 'resources');
}

function prebuildTargets(platform, arch) {
  const prefix = platform === 'mas' ? 'darwin' : platform;
  const archs = arch === 'universal' ? ['x64', 'arm64'] : [arch];
  return archs.map((a) => `${prefix}-${a}.node`);
}

function checkPackedApp(context, arch) {
  const resources = resourcesDir(context);
  const asarPath = path.join(resources, 'app.asar');
  if (!fs.existsSync(asarPath)) {
    throw new Error(`app.asar not found at ${asarPath}`);
  }
  const files = listAsarFiles(readAsarHeader(asarPath));
  const prebuildDir = path.join(
    resources,
    'app.asar.unpacked',
    'node_modules',
    'better-sqlite3',
    'prebuilds'
  );
  const prebuilds = fs.existsSync(prebuildDir) ? fs.readdirSync(prebuildDir) : [];
  const problems = findAsarProblems({
    files,
    prebuilds,
    targets: prebuildTargets(context.electronPlatformName, arch),
  });
  if (problems.length > 0) {
    throw new Error(
      `app.asar holds files the build.files allowlist excludes (see #576):\n  ` +
        problems.join('\n  ')
    );
  }
  return files.length;
}

module.exports = {
  readAsarHeader,
  listAsarFiles,
  findAsarProblems,
  prebuildTargets,
  checkPackedApp,
};
