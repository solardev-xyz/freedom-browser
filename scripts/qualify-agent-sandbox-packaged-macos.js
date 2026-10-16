'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  PACKAGED_USER_DATA_ENV,
  PACKAGED_USER_DATA_PREFIX,
  validateQualificationUserData,
} = require('../src/main/agent/workspace-execution/qualification-user-data');

function defaultApplicationPath() {
  const outputDirectory = process.arch === 'arm64' ? 'mac-arm64' : 'mac';
  return path.join(
    __dirname,
    '..',
    'out',
    'agent-sandbox-packaged',
    outputDirectory,
    'Freedom.app'
  );
}

function run(executablePath, args, environment) {
  return new Promise((resolve, reject) => {
    const child = spawn(executablePath, args, {
      env: environment,
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', (exitCode, signal) => resolve({ exitCode, signal }));
  });
}

async function main() {
  if (process.platform !== 'darwin') {
    throw new Error('Packaged workspace-sandbox qualification requires macOS');
  }
  const applicationPath = await fs.promises.realpath(
    path.resolve(process.argv.find((argument) => argument.endsWith('.app')) || defaultApplicationPath())
  );
  if (path.extname(applicationPath) !== '.app') {
    throw new Error('Packaged qualification target must be a macOS application bundle');
  }
  const executablePath = await fs.promises.realpath(
    path.join(applicationPath, 'Contents', 'MacOS', 'Freedom')
  );
  const userDataRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), PACKAGED_USER_DATA_PREFIX));
  await fs.promises.chmod(userDataRoot, 0o700);
  validateQualificationUserData(userDataRoot, { requireEmpty: true });

  const environment = {
    ...process.env,
    FREEDOM_REQUIRE_SEATBELT: '1',
    FREEDOM_QUALIFICATION_FORBIDDEN_NODE: await fs.promises.realpath(process.execPath),
    [PACKAGED_USER_DATA_ENV]: userDataRoot,
  };
  delete environment.ELECTRON_RUN_AS_NODE;
  delete environment.FREEDOM_SANDBOX_DESTRUCTIVE;

  const workspaceProduct = process.argv.includes('--workspace-product');
  const destructive = process.argv.includes('--destructive');
  if (workspaceProduct && destructive) {
    throw new Error('Choose either the workspace product corpus or the detached corpus');
  }
  if (
    destructive &&
    (process.env.FREEDOM_SANDBOX_DESTRUCTIVE !== '1' ||
      process.env.FREEDOM_SANDBOX_VM_ONLY !== '1')
  ) {
    throw new Error('Packaged destructive qualification requires both disposable-host gates');
  }
  const args = [];
  if (workspaceProduct) {
    const entryPath = path.join(
      applicationPath,
      'Contents',
      'Resources',
      'app.asar',
      'scripts',
      'qualify-agent-workspace.js'
    );
    args.push(entryPath, 'all');
    environment.ELECTRON_RUN_AS_NODE = '1';
    environment.FREEDOM_AGENT_WORKSPACE_PACKAGED = '1';
  } else if (destructive) {
    environment.FREEDOM_SANDBOX_DESTRUCTIVE = '1';
    environment.FREEDOM_SANDBOX_VM_ONLY = '1';
  }

  process.stdout.write(
    `${JSON.stringify({
      type: 'packaged-qualification-launch',
      applicationPath,
      executablePath,
      userDataRoot,
      mode: workspaceProduct ? 'workspace-product' : destructive ? 'destructive' : 'ordinary',
    })}\n`
  );
  let result;
  try {
    result = await run(executablePath, args, environment);
  } finally {
    validateQualificationUserData(userDataRoot);
    await fs.promises.rm(userDataRoot, { recursive: true, force: true });
    process.stdout.write(
      `${JSON.stringify({ type: 'packaged-user-data-cleanup', removed: true })}\n`
    );
  }
  if (result.signal) throw new Error(`Packaged qualification exited on ${result.signal}`);
  if (result.exitCode !== 0) {
    throw new Error(`Packaged qualification exited with code ${result.exitCode}`);
  }
}

main().catch((error) => {
  process.stderr.write(`Packaged macOS sandbox qualification failed: ${error.message}\n`);
  process.exitCode = 1;
});
