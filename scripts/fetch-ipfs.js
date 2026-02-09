const fs = require('fs');
const path = require('path');
const https = require('https');
const { execSync } = require('child_process');

const OUTPUT_DIR = path.join(__dirname, '..', 'ipfs-bin');

// Kubo releases are hosted at dist.ipfs.tech
const DIST_URL = 'https://dist.ipfs.tech/kubo/versions';

async function fetchVersionsList() {
  return new Promise((resolve, reject) => {
    https
      .get(DIST_URL, (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          if (res.statusCode === 200) {
            // Parse versions list (one per line, newest first after sorting)
            const versions = data
              .trim()
              .split('\n')
              .filter((v) => v.startsWith('v') && !v.includes('-rc'))
              .sort((a, b) => {
                // Sort semver descending
                const pa = a.slice(1).split('.').map(Number);
                const pb = b.slice(1).split('.').map(Number);
                for (let i = 0; i < 3; i++) {
                  if (pa[i] !== pb[i]) return pb[i] - pa[i];
                }
                return 0;
              });
            resolve(versions);
          } else {
            reject(new Error(`Failed to fetch versions: ${res.statusCode}`));
          }
        });
      })
      .on('error', reject);
  });
}

async function downloadFile(url, dest) {
  console.log(`Downloading ${url}...`);
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https
      .get(url, (response) => {
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
      })
      .on('error', (err) => {
        fs.unlink(dest, () => {});
        reject(err);
      });
  });
}

async function main() {
  try {
    console.log('Fetching latest Kubo (IPFS) version...');
    const versions = await fetchVersionsList();
    const latestVersion = versions[0];
    console.log(`Latest version: ${latestVersion}`);

    const targets = [
      { os: 'mac', arch: 'arm64', distArch: 'darwin-arm64' },
      { os: 'mac', arch: 'x64', distArch: 'darwin-amd64' },
      { os: 'linux', arch: 'x64', distArch: 'linux-amd64' },
      { os: 'linux', arch: 'arm64', distArch: 'linux-arm64' },
      { os: 'win', arch: 'x64', distArch: 'windows-amd64', exe: true, zip: true },
      { os: 'win', arch: 'arm64', distArch: 'windows-arm64', exe: true, zip: true },
    ];

    for (const target of targets) {
      const ext = target.zip ? 'zip' : 'tar.gz';
      const fileName = `kubo_${latestVersion}_${target.distArch}.${ext}`;
      const downloadUrl = `https://dist.ipfs.tech/kubo/${latestVersion}/${fileName}`;

      const targetDir = path.join(OUTPUT_DIR, `${target.os}-${target.arch}`);
      if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
      }

      const tempDest = path.join(targetDir, fileName);
      const binName = target.exe ? 'ipfs.exe' : 'ipfs';
      const destFile = path.join(targetDir, binName);

      await downloadFile(downloadUrl, tempDest);

      console.log(`Extracting ${fileName}...`);
      if (target.zip) {
        execSync(`unzip -o "${tempDest}" -d "${targetDir}"`);
      } else {
        execSync(`tar -xzf "${tempDest}" -C "${targetDir}"`);
      }
      fs.unlinkSync(tempDest);

      // Kubo extracts to kubo/ipfs (or kubo/ipfs.exe on Windows), move it up
      const extractedBinName = target.exe ? 'ipfs.exe' : 'ipfs';
      const extractedBin = path.join(targetDir, 'kubo', extractedBinName);
      if (fs.existsSync(extractedBin)) {
        fs.renameSync(extractedBin, destFile);
        // Clean up extracted folder
        fs.rmSync(path.join(targetDir, 'kubo'), { recursive: true, force: true });
      }

      if (fs.existsSync(destFile)) {
        if (!target.exe) fs.chmodSync(destFile, '755');
        console.log(`Successfully installed Kubo (IPFS) for ${target.os}-${target.arch}`);
      } else {
        console.error(
          `Failed to locate 'ipfs' binary after extraction for ${target.os}-${target.arch}`
        );
      }
    }

    console.log('All IPFS downloads complete.');
    process.exit(0);
  } catch (err) {
    console.error('Error:', err);
    process.exit(1);
  }
}

main();
