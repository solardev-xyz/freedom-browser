const fs = require('fs');
const path = require('path');
const https = require('https');
const { execSync } = require('child_process');

const OUTPUT_DIR = path.join(__dirname, '..', 'radicle-bin');

// Radicle releases are hosted at files.radicle.xyz
// Main bundle (rad, radicle-node) and httpd have SEPARATE release paths
const MAIN_RELEASES_URL = 'https://files.radicle.xyz/releases/latest';
const HTTPD_RELEASES_URL = 'https://files.radicle.xyz/releases/radicle-httpd/latest';

// Freedom platform naming (matching bee/ipfs) -> Radicle target triple
// Radicle does not publish Windows builds.
const TARGETS = {
  'mac-arm64': 'aarch64-apple-darwin',
  'mac-x64': 'x86_64-apple-darwin',
  'linux-arm64': 'aarch64-unknown-linux-musl',
  'linux-x64': 'x86_64-unknown-linux-musl',
};

const REQUIRED_BINARIES = ['rad', 'radicle-node', 'radicle-httpd', 'git-remote-rad'];

async function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        fetchJson(res.headers.location).then(resolve).catch(reject);
        return;
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            resolve(JSON.parse(data));
          } catch (err) {
            reject(new Error(`Failed to parse JSON: ${err.message}`));
          }
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${data}`));
        }
      });
    }).on('error', reject);
  });
}

async function downloadFile(url, dest) {
  console.log(`Downloading ${url}...`);
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https.get(url, (response) => {
      if (response.statusCode === 302 || response.statusCode === 301) {
        file.close();
        fs.unlinkSync(dest);
        downloadFile(response.headers.location, dest).then(resolve).catch(reject);
        return;
      }
      if (response.statusCode !== 200) {
        file.close();
        fs.unlinkSync(dest);
        reject(new Error(`HTTP ${response.statusCode} for ${url}`));
        return;
      }
      response.pipe(file);
      file.on('finish', () => {
        file.close(resolve);
      });
    }).on('error', (err) => {
      fs.unlink(dest, () => {});
      reject(err);
    });
  });
}

function extractTarXz(archivePath, destDir) {
  console.log(`Extracting ${path.basename(archivePath)}...`);
  // Use tar with xz decompression (requires xz installed, which is standard on macOS/Linux)
  execSync(`tar -xJf "${archivePath}" -C "${destDir}"`, { stdio: 'inherit' });
}

function findBinaries(searchDir, binaries) {
  const found = {};
  const search = (dir) => {
    if (!fs.existsSync(dir)) return;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isFile() && binaries.includes(entry.name)) {
        found[entry.name] = fullPath;
      } else if (entry.isDirectory()) {
        search(fullPath);
      }
    }
  };
  search(searchDir);
  return found;
}

async function installTarget(targetKey, radicleTarget, mainVersion, httpdVersion) {
  console.log(`\n=== ${targetKey} (${radicleTarget}) ===`);

  const targetDir = path.join(OUTPUT_DIR, targetKey);
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  // Main bundle (rad, radicle-node, git-remote-rad)
  const mainBundleName = mainVersion
    ? `radicle-${mainVersion}-${radicleTarget}.tar.xz`
    : `radicle-${radicleTarget}.tar.xz`;
  const mainBundleUrl = `${MAIN_RELEASES_URL}/${mainBundleName}`;
  const mainBundleDest = path.join(targetDir, mainBundleName);

  await downloadFile(mainBundleUrl, mainBundleDest);
  extractTarXz(mainBundleDest, targetDir);
  fs.unlinkSync(mainBundleDest);

  // Httpd bundle (separate release path)
  const httpdBundleName = httpdVersion
    ? `radicle-httpd-${httpdVersion}-${radicleTarget}.tar.xz`
    : `radicle-httpd-${radicleTarget}.tar.xz`;
  const httpdBundleUrl = `${HTTPD_RELEASES_URL}/${httpdBundleName}`;
  const httpdBundleDest = path.join(targetDir, httpdBundleName);

  await downloadFile(httpdBundleUrl, httpdBundleDest);
  extractTarXz(httpdBundleDest, targetDir);
  fs.unlinkSync(httpdBundleDest);

  const foundBinaries = findBinaries(targetDir, REQUIRED_BINARIES);
  for (const [name, srcPath] of Object.entries(foundBinaries)) {
    const destPath = path.join(targetDir, name);
    if (srcPath !== destPath) {
      if (fs.existsSync(destPath)) {
        fs.unlinkSync(destPath);
      }
      fs.renameSync(srcPath, destPath);
    }
    fs.chmodSync(destPath, '755');
  }

  // Clean up extracted subdirectories
  const entries = fs.readdirSync(targetDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      fs.rmSync(path.join(targetDir, entry.name), { recursive: true, force: true });
    }
  }

  const missing = REQUIRED_BINARIES.filter(
    (name) => !fs.existsSync(path.join(targetDir, name))
  );
  if (missing.length > 0) {
    console.warn(`Warning: Missing binaries for ${targetKey}: ${missing.join(', ')}`);
    return false;
  }

  for (const name of REQUIRED_BINARIES) {
    console.log(`  installed: ${name}`);
  }
  return true;
}

async function main() {
  try {
    // Determine which targets to fetch. By default, fetch all; allow overriding
    // via RADICLE_TARGET=mac-arm64 (or a comma-separated list) for host-only builds
    // used by Docker dist jobs.
    const requested = (process.env.RADICLE_TARGET || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    const targetKeys =
      requested.length > 0 ? requested : Object.keys(TARGETS);

    for (const key of targetKeys) {
      if (!TARGETS[key]) {
        console.error(`Unknown target: ${key}`);
        console.error(`Supported: ${Object.keys(TARGETS).join(', ')}`);
        process.exit(1);
      }
    }

    console.log('Fetching Radicle main bundle version info...');
    let mainVersion = null;
    try {
      const versionInfo = await fetchJson(`${MAIN_RELEASES_URL}/radicle.json`);
      mainVersion = versionInfo.version;
      console.log(`Main bundle version: ${mainVersion}`);
    } catch (err) {
      console.warn(`Could not fetch main version info: ${err.message}`);
    }

    console.log('Fetching Radicle httpd version info...');
    let httpdVersion = null;
    try {
      const httpdVersionInfo = await fetchJson(`${HTTPD_RELEASES_URL}/radicle-httpd.json`);
      httpdVersion = httpdVersionInfo.version;
      console.log(`HTTPD version: ${httpdVersion}`);
    } catch (err) {
      console.warn(`Could not fetch httpd version info: ${err.message}`);
    }

    const results = [];
    for (const key of targetKeys) {
      const ok = await installTarget(key, TARGETS[key], mainVersion, httpdVersion);
      results.push({ key, ok });
    }

    console.log('\nSummary:');
    for (const { key, ok } of results) {
      console.log(`  ${ok ? 'OK' : 'FAIL'}  ${key}`);
    }

    const failed = results.filter((r) => !r.ok);
    if (failed.length > 0) {
      process.exit(1);
    }
    console.log('\nRadicle download complete.');
    process.exit(0);
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
}

main();
