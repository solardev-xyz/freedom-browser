#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const distDir = path.resolve(__dirname, '..', 'dist');
const receiptsDir = path.join(distDir, 'notary-submissions');
const appleId = process.env.APPLE_ID;
const appleTeamId = process.env.APPLE_TEAM_ID;
const applePassword = process.env.APPLE_APP_SPECIFIC_PASSWORD;
const profile = process.env.NOTARY_PROFILE;

function fail(message) {
  console.error(message);
  process.exit(1);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    stdio: 'pipe',
    ...options,
  });

  if (result.status !== 0) {
    const stderr = result.stderr || '';
    const stdout = result.stdout || '';
    fail(
      `Command failed: ${command} ${args.join(' ')}\n${stderr || stdout || 'No command output.'}`,
    );
  }

  return result.stdout;
}

function readJson(text, source) {
  try {
    return JSON.parse(text);
  } catch (error) {
    fail(`Failed to parse JSON from ${source}: ${error.message}`);
  }
}

function hasAppleCredentials() {
  return Boolean(appleId && appleTeamId && applePassword);
}

function authMode() {
  if (hasAppleCredentials()) return 'env';
  if (profile) return 'profile';
  return null;
}

function getAuthArgs(mode = authMode(), savedProfile) {
  if (mode === 'env') {
    return ['--apple-id', appleId, '--team-id', appleTeamId, '--password', applePassword];
  }

  if (mode === 'profile') {
    return ['--keychain-profile', savedProfile || profile];
  }

  fail(
    'Missing notarization credentials. Use APPLE_ID, APPLE_TEAM_ID, and APPLE_APP_SPECIFIC_PASSWORD (recommended), or set NOTARY_PROFILE.',
  );
}

function ensureReceiptsDir() {
  fs.mkdirSync(receiptsDir, { recursive: true });
}

function findNotaryArtifacts() {
  if (!fs.existsSync(distDir)) {
    fail('dist/ does not exist. Run a macOS dist build first.');
  }

  const entries = fs.readdirSync(distDir);
  const artifacts = entries
    .filter((name) => name.endsWith('.dmg') || /-mac\.zip$/.test(name))
    .map((name) => path.join(distDir, name));

  if (artifacts.length === 0) {
    fail('No macOS notarization artifacts found in dist/.');
  }

  return artifacts;
}

function receiptPathFor(artifactPath) {
  const artifactName = path.basename(artifactPath);
  return path.join(receiptsDir, `${artifactName}.json`);
}

function findReceiptFiles() {
  if (!fs.existsSync(receiptsDir)) return [];
  return fs
    .readdirSync(receiptsDir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => path.join(receiptsDir, name));
}

function readReceipts() {
  const files = findReceiptFiles();
  if (files.length === 0) {
    fail('No notarization submission receipts found in dist/notary-submissions/.');
  }

  return files.map((filePath) => {
    const raw = fs.readFileSync(filePath, 'utf8');
    return { filePath, receipt: readJson(raw, filePath) };
  });
}

function submitArtifacts() {
  ensureReceiptsDir();
  const artifacts = findNotaryArtifacts();
  const mode = authMode();

  for (const artifactPath of artifacts) {
    const artifactName = path.basename(artifactPath);
    console.log(`Submitting ${artifactName}...`);

    const output = run('xcrun', [
      'notarytool',
      'submit',
      artifactPath,
      ...getAuthArgs(mode),
      '--output-format',
      'json',
    ]);

    const parsed = readJson(output, `notarytool submit (${artifactName})`);
    const receipt = {
      artifactPath,
      artifactName,
      submissionId: parsed.id,
      authMode: mode,
      profile: mode === 'profile' ? profile : null,
      submittedAt: new Date().toISOString(),
      status: 'Submitted',
    };

    fs.writeFileSync(receiptPathFor(artifactPath), `${JSON.stringify(receipt, null, 2)}\n`);
    console.log(`Submitted ${artifactName}: ${parsed.id}`);
  }
}

function refreshStatus(receiptWrapper) {
  const { filePath, receipt } = receiptWrapper;
  const mode = receipt.authMode || authMode();
  const output = run('xcrun', [
    'notarytool',
    'info',
    receipt.submissionId,
    ...getAuthArgs(mode, receipt.profile),
    '--output-format',
    'json',
  ]);

  const parsed = readJson(output, `notarytool info (${receipt.submissionId})`);
  const updated = {
    ...receipt,
    authMode: mode,
    status: parsed.status,
    statusCode: parsed.statusCode,
    checkedAt: new Date().toISOString(),
  };

  fs.writeFileSync(filePath, `${JSON.stringify(updated, null, 2)}\n`);
  return updated;
}

function showStatus() {
  const receipts = readReceipts();
  let allAccepted = true;

  for (const receiptWrapper of receipts) {
    const updated = refreshStatus(receiptWrapper);
    console.log(`${updated.artifactName}: ${updated.status}`);
    if (updated.status !== 'Accepted') {
      allAccepted = false;
    }
  }

  if (!allAccepted) {
    process.exitCode = 2;
  }
}

function showLog(submissionId) {
  if (!submissionId) {
    fail('Usage: node scripts/macos-notary.js log <submission-id>');
  }

  const mode = authMode();
  run(
    'xcrun',
    ['notarytool', 'log', submissionId, ...getAuthArgs(mode), '--output-format', 'json'],
    { stdio: 'inherit' },
  );
}

function findMacApps() {
  if (!fs.existsSync(distDir)) return [];

  const entries = fs.readdirSync(distDir, { withFileTypes: true });
  const macDirs = entries.filter((entry) => entry.isDirectory() && entry.name.startsWith('mac'));
  const appPaths = [];

  for (const dir of macDirs) {
    const dirPath = path.join(distDir, dir.name);
    const children = fs.readdirSync(dirPath);
    for (const child of children) {
      if (child.endsWith('.app')) {
        appPaths.push(path.join(dirPath, child));
      }
    }
  }

  return appPaths;
}

function stapleAccepted() {
  const receipts = readReceipts();
  const updatedReceipts = receipts.map(refreshStatus);
  const accepted = updatedReceipts.filter((receipt) => receipt.status === 'Accepted');
  const pending = updatedReceipts.filter((receipt) => receipt.status !== 'Accepted');

  if (accepted.length === 0) {
    fail('No accepted notarization submissions yet. Run status later.');
  }

  if (pending.length > 0) {
    console.log('Some artifacts are not accepted yet:');
    for (const receipt of pending) {
      console.log(`- ${receipt.artifactName}: ${receipt.status}`);
    }
    process.exitCode = 2;
    return;
  }

  for (const receipt of accepted) {
    if (receipt.artifactName.endsWith('.zip')) {
      console.log(`Skipping stapling for ${receipt.artifactName} (ZIP files cannot be stapled).`);
      continue;
    }

    console.log(`Stapling ${receipt.artifactName}...`);
    run('xcrun', ['stapler', 'staple', receipt.artifactPath], { stdio: 'inherit' });
    run('xcrun', ['stapler', 'validate', receipt.artifactPath], { stdio: 'inherit' });
  }

  const appPaths = findMacApps();
  for (const appPath of appPaths) {
    console.log(`Stapling ${path.basename(appPath)}...`);
    run('xcrun', ['stapler', 'staple', appPath], { stdio: 'inherit' });
    run('xcrun', ['stapler', 'validate', appPath], { stdio: 'inherit' });
  }
}

const command = process.argv[2];
const commandArg = process.argv[3];

if (command === 'submit') submitArtifacts();
else if (command === 'status') showStatus();
else if (command === 'staple') stapleAccepted();
else if (command === 'log') showLog(commandArg);
else {
  console.log('Usage: node scripts/macos-notary.js <submit|status|staple|log> [submission-id]');
  process.exit(1);
}
