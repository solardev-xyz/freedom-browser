'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const PACKAGED_USER_DATA_ENV = 'FREEDOM_PACKAGED_QUALIFICATION_USER_DATA';
const PACKAGED_USER_DATA_PREFIX = 'freedom-packaged-sandbox-user-data-';

const LAUNCH_PREFIX = 'freedom-packaged-linux-launch-';

function validateQualificationUserData(userDataRoot, options = {}) {
  const temporaryRoot = fs.realpathSync(options.temporaryRoot || os.tmpdir());
  const canonical = fs.realpathSync(userDataRoot);
  const stats = fs.statSync(canonical);
  const relative = path.relative(temporaryRoot, canonical);
  if (
    !stats.isDirectory() ||
    !relative ||
    relative.startsWith('..') ||
    path.isAbsolute(relative) ||
    path.dirname(canonical) !== temporaryRoot ||
    !path.basename(canonical).startsWith(PACKAGED_USER_DATA_PREFIX) ||
    (stats.mode & 0o077) !== 0 ||
    (typeof process.getuid === 'function' && stats.uid !== process.getuid()) ||
    (options.requireEmpty === true && fs.readdirSync(canonical).length !== 0)
  ) {
    throw new Error('Refusing packaged qualification outside its validated private user-data root');
  }
  return canonical;
}

function run(executablePath, environment) {
  return new Promise((resolve, reject) => {
    const child = spawn(executablePath, [], { env: environment, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (exitCode, signal) => resolve({ exitCode, signal }));
  });
}

function qualificationModeEnvironment(source = process.env) {
  const destructive = source.FREEDOM_SANDBOX_DESTRUCTIVE === '1';
  const vmOnly = source.FREEDOM_SANDBOX_VM_ONLY === '1';
  if (destructive !== vmOnly) {
    throw new Error(
      'Packaged destructive qualification requires both FREEDOM_SANDBOX_DESTRUCTIVE=1 and FREEDOM_SANDBOX_VM_ONLY=1'
    );
  }
  return destructive
    ? Object.freeze({
        FREEDOM_SANDBOX_DESTRUCTIVE: '1',
        FREEDOM_SANDBOX_VM_ONLY: '1',
      })
    : Object.freeze({});
}

async function main() {
  if (process.platform !== 'linux') {
    throw new Error('Packaged Linux workspace-sandbox qualification requires Linux');
  }
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    throw new Error('Run packaged Linux qualification as an ordinary non-root user');
  }
  const executablePath = await fs.promises.realpath(path.resolve(process.argv[2] || ''));
  const launchRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), LAUNCH_PREFIX));
  const userDataRoot = await fs.promises.mkdtemp(path.join(launchRoot, PACKAGED_USER_DATA_PREFIX));
  await fs.promises.chmod(launchRoot, 0o700);
  await fs.promises.chmod(userDataRoot, 0o700);
  validateQualificationUserData(userDataRoot, { requireEmpty: true, temporaryRoot: launchRoot });
  const directories = {};
  for (const name of ['home', 'cache', 'config', 'data', 'runtime', 'tmp']) {
    directories[name] = path.join(launchRoot, name);
    await fs.promises.mkdir(directories[name], { mode: 0o700 });
  }
  const environment = {
    FREEDOM_REQUIRE_BWRAP: '1',
    FREEDOM_QUALIFICATION_FORBIDDEN_NODE: await fs.promises.realpath(process.execPath),
    DISPLAY: process.env.DISPLAY || '',
    HOME: directories.home,
    LANG: process.env.LANG || 'C.UTF-8',
    PATH: '/usr/local/bin:/usr/bin:/bin',
    TMPDIR: launchRoot,
    XDG_CACHE_HOME: directories.cache,
    XDG_CONFIG_HOME: directories.config,
    XDG_DATA_HOME: directories.data,
    XDG_RUNTIME_DIR: directories.runtime,
    ...(process.env.XAUTHORITY ? { XAUTHORITY: process.env.XAUTHORITY } : {}),
    ...qualificationModeEnvironment(),
    [PACKAGED_USER_DATA_ENV]: userDataRoot,
  };
  process.stdout.write(
    `${JSON.stringify({
      type: 'packaged-linux-qualification-launch',
      executablePath,
      launchRoot,
      userDataRoot,
    })}\n`
  );
  let result;
  try {
    result = await run(executablePath, environment);
  } finally {
    validateQualificationUserData(userDataRoot, { temporaryRoot: launchRoot });
    await Promise.all([
      fs.promises.rm(userDataRoot, { recursive: true, force: true }),
      fs.promises.rm(launchRoot, { recursive: true, force: true }),
    ]);
    process.stdout.write(
      `${JSON.stringify({ type: 'packaged-linux-qualification-cleanup', removed: true })}\n`
    );
  }
  if (result.signal) throw new Error(`Packaged qualification exited on ${result.signal}`);
  if (result.exitCode !== 0) {
    throw new Error(`Packaged qualification exited with code ${result.exitCode}`);
  }
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`Packaged Linux sandbox qualification failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { qualificationModeEnvironment, validateQualificationUserData };
