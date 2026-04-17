const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');

// Pin to a specific release. Update src/shared/ton-version.js to upgrade.
const { RELEASE_TAG } = require('../src/shared/ton-version');

const OUTPUT_DIR = path.join(__dirname, '..', 'ton-bin');

const BINARY_NAME = 'tonutils-freedom-cli';

const TARGETS = [
  { os: 'mac', arch: 'arm64', platform: 'darwin', goArch: 'arm64' },
  { os: 'mac', arch: 'x64', platform: 'darwin', goArch: 'amd64' },
  { os: 'linux', arch: 'x64', platform: 'linux', goArch: 'amd64' },
  { os: 'linux', arch: 'arm64', platform: 'linux', goArch: 'arm64' },
  { os: 'win', arch: 'x64', platform: 'windows', goArch: 'amd64', exe: true },
];

function buildDownloadUrl(tag, platform, goArch, isExe) {
  const suffix = isExe ? '.exe' : '';
  return (
    `https://github.com/TONresistor/Tonutils-Proxy/releases/download/${tag}/` +
    `${BINARY_NAME}-${platform}-${goArch}${suffix}`
  );
}

function downloadFile(url, dest) {
  console.log(`Downloading ${url} to ${dest}...`);
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https
      .get(url, { headers: { 'User-Agent': 'Freedom-Updater' } }, (response) => {
        if (response.statusCode === 302 || response.statusCode === 301) {
          file.close();
          fs.unlink(dest, () => {});
          downloadFile(response.headers.location, dest).then(resolve).catch(reject);
          return;
        }
        if (response.statusCode !== 200) {
          file.close();
          fs.unlink(dest, () => {});
          reject(new Error(`HTTP ${response.statusCode} downloading ${url}`));
          return;
        }
        response.pipe(file);
        file.on('finish', () => {
          file.close(resolve);
        });
        file.on('error', (err) => {
          fs.unlink(dest, () => {});
          reject(err);
        });
      })
      .on('error', (err) => {
        fs.unlink(dest, () => {});
        reject(err);
      });
  });
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

function downloadText(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { 'User-Agent': 'Freedom-Updater' } }, (response) => {
        if (response.statusCode === 302 || response.statusCode === 301) {
          downloadText(response.headers.location).then(resolve).catch(reject);
          return;
        }
        if (response.statusCode !== 200) {
          reject(new Error(`HTTP ${response.statusCode} fetching ${url}`));
          return;
        }
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          body += chunk;
        });
        response.on('end', () => resolve(body));
        response.on('error', reject);
      })
      .on('error', reject);
  });
}

async function fetchChecksums(tag) {
  const url =
    `https://github.com/TONresistor/Tonutils-Proxy/releases/download/${tag}/checksums.txt`;
  const text = await downloadText(url);
  const map = new Map();
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(/\s+/);
    if (parts.length < 2) continue;
    const [hash, name] = parts;
    map.set(name, hash.toLowerCase());
  }
  return map;
}

function checkBinary() {
  const platformMap = { darwin: 'mac', linux: 'linux', win32: 'win' };
  const os = platformMap[process.platform] || process.platform;
  const arch = process.arch;

  const basePath = path.join(__dirname, '..', 'ton-bin');
  const binName = process.platform === 'win32' ? `${BINARY_NAME}.exe` : BINARY_NAME;
  const binPath = path.join(basePath, `${os}-${arch}`, binName);
  const available = fs.existsSync(binPath);
  return {
    available,
    path: available ? binPath : null,
    version: null,
  };
}

async function main() {
  try {
    console.log(`Fetching tonutils-freedom-cli ${RELEASE_TAG}...`);

    let checksums;
    try {
      checksums = await fetchChecksums(RELEASE_TAG);
      console.log(`Loaded ${checksums.size} pinned checksums from release.`);
    } catch (err) {
      console.error(`Cannot fetch checksums.txt: ${err.message}. Aborting.`);
      process.exit(1);
    }

    for (const target of TARGETS) {
      const url = buildDownloadUrl(RELEASE_TAG, target.platform, target.goArch, target.exe);
      const targetDir = path.join(OUTPUT_DIR, `${target.os}-${target.arch}`);

      if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
      }

      const binName = target.exe ? `${BINARY_NAME}.exe` : BINARY_NAME;
      const destFile = path.join(targetDir, binName);

      try {
        await downloadFile(url, destFile);

        if (!target.exe) {
          fs.chmodSync(destFile, '755');
        }

        const checksum = await sha256File(destFile);
        const assetName = `${BINARY_NAME}-${target.platform}-${target.goArch}${target.exe ? '.exe' : ''}`;
        const expected = checksums.get(assetName);
        if (!expected) {
          fs.unlinkSync(destFile);
          throw new Error(`No pinned checksum for ${assetName}`);
        }
        if (expected !== checksum) {
          fs.unlinkSync(destFile);
          throw new Error(
            `Checksum mismatch for ${assetName}: expected ${expected}, got ${checksum}`
          );
        }
        console.log(
          `Installed tonutils-freedom-cli for ${target.os}-${target.arch} (sha256: ${checksum})`
        );
      } catch (err) {
        console.warn(`Could not fetch ${target.os}-${target.arch}: ${err.message}`);
        console.warn('Binary may not yet exist for this target, skipping.');
      }
    }

    // Copy win-x64 to win-arm64 as emulation fallback
    const winX64Bin = path.join(OUTPUT_DIR, 'win-x64', `${BINARY_NAME}.exe`);
    const winArm64Dir = path.join(OUTPUT_DIR, 'win-arm64');
    const winArm64Bin = path.join(winArm64Dir, `${BINARY_NAME}.exe`);

    if (fs.existsSync(winX64Bin)) {
      if (!fs.existsSync(winArm64Dir)) {
        fs.mkdirSync(winArm64Dir, { recursive: true });
      }
      fs.copyFileSync(winX64Bin, winArm64Bin);
      console.log('Copied win-x64 binary to win-arm64 (emulation fallback)');
    }

    console.log('All downloads complete.');
    process.exit(0);
  } catch (err) {
    console.error('Error:', err);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { checkBinary, RELEASE_TAG, BINARY_NAME };
