const fs = require('fs');
const path = require('path');
const https = require('https');
const { execSync } = require('child_process');

const OUTPUT_DIR = path.join(__dirname, '..', 'radicle-bin');

// Radicle releases are hosted at files.radicle.xyz
// Main bundle (rad, radicle-node) and httpd have SEPARATE release paths
const MAIN_RELEASES_URL = 'https://files.radicle.xyz/releases/latest';
const HTTPD_RELEASES_URL = 'https://files.radicle.xyz/releases/radicle-httpd/latest';

// Target mapping: Freedom platform naming to Radicle target triple
// Freedom uses mac-arm64/mac-x64/linux-arm64/linux-x64 (matching bee/ipfs)
const PLATFORM_MAP = {
  darwin: 'mac',
  linux: 'linux',
};

const TARGETS = {
  'mac-arm64': 'aarch64-apple-darwin',
  'mac-x64': 'x86_64-apple-darwin',
  'linux-arm64': 'aarch64-unknown-linux-musl',
  'linux-x64': 'x86_64-unknown-linux-musl',
};

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

async function main() {
  try {
    const platform = PLATFORM_MAP[process.platform] || process.platform;
    const arch = process.arch;
    const targetKey = `${platform}-${arch}`;

    const radicleTarget = TARGETS[targetKey];
    if (!radicleTarget) {
      console.error(`Unsupported platform: ${targetKey}`);
      console.error(`Supported platforms: ${Object.keys(TARGETS).join(', ')}`);
      process.exit(1);
    }

    console.log(`Platform: ${targetKey} -> Radicle target: ${radicleTarget}`);

    // Create target directory
    const targetDir = path.join(OUTPUT_DIR, targetKey);
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }

    // Fetch main bundle version info
    console.log('\nFetching Radicle main bundle version info...');
    let mainVersion;
    try {
      const versionInfo = await fetchJson(`${MAIN_RELEASES_URL}/radicle.json`);
      mainVersion = versionInfo.version;
      console.log(`Main bundle version: ${mainVersion}`);
    } catch (err) {
      console.warn(`Could not fetch main version info: ${err.message}`);
      mainVersion = null;
    }

    // Download main bundle (rad, radicle-node, git-remote-rad)
    // Use version-less filename as fallback (symlinked to latest)
    const mainBundleName = mainVersion
      ? `radicle-${mainVersion}-${radicleTarget}.tar.xz`
      : `radicle-${radicleTarget}.tar.xz`;
    const mainBundleUrl = `${MAIN_RELEASES_URL}/${mainBundleName}`;
    const mainBundleDest = path.join(targetDir, mainBundleName);

    await downloadFile(mainBundleUrl, mainBundleDest);
    extractTarXz(mainBundleDest, targetDir);
    fs.unlinkSync(mainBundleDest);

    // Fetch httpd version info (different release path!)
    console.log('\nFetching Radicle httpd version info...');
    let httpdVersion;
    try {
      const httpdVersionInfo = await fetchJson(`${HTTPD_RELEASES_URL}/radicle-httpd.json`);
      httpdVersion = httpdVersionInfo.version;
      console.log(`HTTPD version: ${httpdVersion}`);
    } catch (err) {
      console.warn(`Could not fetch httpd version info: ${err.message}`);
      httpdVersion = null;
    }

    // Download httpd bundle (separate release path)
    const httpdBundleName = httpdVersion
      ? `radicle-httpd-${httpdVersion}-${radicleTarget}.tar.xz`
      : `radicle-httpd-${radicleTarget}.tar.xz`;
    const httpdBundleUrl = `${HTTPD_RELEASES_URL}/${httpdBundleName}`;
    const httpdBundleDest = path.join(targetDir, httpdBundleName);

    await downloadFile(httpdBundleUrl, httpdBundleDest);
    extractTarXz(httpdBundleDest, targetDir);
    fs.unlinkSync(httpdBundleDest);

    // Find and move binaries to target directory root
    // Radicle tarballs extract to a subdirectory with bin/ folder
    const findAndMoveBinaries = (searchDir, binaries) => {
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
    };

    const requiredBinaries = ['rad', 'radicle-node', 'radicle-httpd', 'git-remote-rad'];
    const foundBinaries = findAndMoveBinaries(targetDir, requiredBinaries);

    // Move binaries to target directory root and set permissions
    for (const [name, srcPath] of Object.entries(foundBinaries)) {
      const destPath = path.join(targetDir, name);
      if (srcPath !== destPath) {
        if (fs.existsSync(destPath)) {
          fs.unlinkSync(destPath);
        }
        fs.renameSync(srcPath, destPath);
      }
      fs.chmodSync(destPath, '755');
      console.log(`Installed: ${name}`);
    }

    // Clean up extracted subdirectories
    const entries = fs.readdirSync(targetDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        fs.rmSync(path.join(targetDir, entry.name), { recursive: true, force: true });
      }
    }

    // Verify required binaries
    const missing = requiredBinaries.filter(name => !fs.existsSync(path.join(targetDir, name)));
    if (missing.length > 0) {
      console.warn(`\nWarning: Missing binaries: ${missing.join(', ')}`);
    }

    console.log(`\nRadicle binaries installed to ${targetDir}`);
    console.log('Installed binaries:');
    for (const name of requiredBinaries) {
      const binPath = path.join(targetDir, name);
      if (fs.existsSync(binPath)) {
        console.log(`  ✓ ${name}`);
      } else {
        console.log(`  ✗ ${name} (missing)`);
      }
    }

    console.log('\nRadicle download complete.');
    process.exit(0);

  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
}

main();
