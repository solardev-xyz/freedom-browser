const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const DATA_DIR = path.join(__dirname, '..', 'radicle-data');

function getRadicleBinaryPath(binary) {
  const arch = process.arch;
  const platformMap = {
    darwin: 'mac',
    linux: 'linux',
    win32: 'win',
  };
  const platform = platformMap[process.platform] || process.platform;
  const binName = process.platform === 'win32' ? `${binary}.exe` : binary;
  return path.join(__dirname, '..', 'radicle-bin', `${platform}-${arch}`, binName);
}

function initRadicle() {
  try {
    const radPath = getRadicleBinaryPath('rad');

    if (!fs.existsSync(radPath)) {
      console.error(`rad binary not found at ${radPath}`);
      console.error('Run "npm run radicle:download" first.');
      process.exit(1);
    }

    // Check if already initialized
    const keysDir = path.join(DATA_DIR, 'keys');
    if (fs.existsSync(keysDir) && fs.readdirSync(keysDir).length > 0) {
      console.log('Radicle is already initialized (identity exists). Skipping.');
      return;
    }

    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      console.log(`Created data directory: ${DATA_DIR}`);
    }

    console.log('Creating Radicle identity...');
    execSync(`"${radPath}" auth --alias FreedomBrowser`, {
      env: {
        ...process.env,
        RAD_HOME: DATA_DIR,
        RAD_PASSPHRASE: '',
      },
      stdio: 'inherit',
    });

    console.log('Radicle identity created successfully.');
    console.log(`Data path: ${DATA_DIR}`);

  } catch (err) {
    console.error('Failed to initialize Radicle:', err.message);
    process.exit(1);
  }
}

initRadicle();
