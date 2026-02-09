const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SAMPLE_CONFIG = path.join(__dirname, '..', 'config', 'bee.yaml');
const DATA_DIR = path.join(__dirname, '..', 'bee-data');
const TARGET_CONFIG = path.join(DATA_DIR, 'config.yaml');

function generatePassword(length = 32) {
  return crypto.randomBytes(length).toString('hex');
}

function initBee() {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      console.log(`Created data directory: ${DATA_DIR}`);
    }

    if (fs.existsSync(TARGET_CONFIG)) {
      console.log('Bee is already initialized (config.yaml exists). Skipping.');
      return;
    }

    if (!fs.existsSync(SAMPLE_CONFIG)) {
      console.error('Sample bee.yaml not found in project root.');
      process.exit(1);
    }

    let configContent = fs.readFileSync(SAMPLE_CONFIG, 'utf-8');
    const password = generatePassword();

    // Replace placeholders
    configContent = configContent.replace(/DATA_DIR/g, DATA_DIR);
    configContent = configContent.replace(/PASSWORD/g, password);

    fs.writeFileSync(TARGET_CONFIG, configContent);
    console.log(`Initialized Bee config at ${TARGET_CONFIG}`);
    console.log(`Generated secure password: ${password}`);

    // Run bee init
    const { execSync } = require('child_process');
    const platform = process.platform;
    const arch = process.arch;
    const binName = platform === 'win32' ? 'bee.exe' : 'bee';
    // Assuming we are running this in dev/test context where we know where the bin is
    // Or use the same logic as fetch-bee or bee-manager.
    // For simplicity in this script, assuming standard path in project root
    const binPath = path.join(__dirname, '..', 'bee-bin', `${platform}-${arch}`, binName);

    if (fs.existsSync(binPath)) {
      console.log(`Running bee init with config ${TARGET_CONFIG}...`);
      try {
        execSync(`"${binPath}" init --config="${TARGET_CONFIG}"`, { stdio: 'inherit' });
        console.log('Bee keys initialized successfully.');
      } catch (e) {
        console.error('Bee init failed:', e.message);
        // Don't exit 1 if it's just keys existing or something, but usually init is safe to re-run?
        // Actually init creates keys. If config exists but keys don't, we need this.
      }
    } else {
      console.warn(
        `Bee binary not found at ${binPath}, skipping 'bee init'. Make sure to run bee:download first.`
      );
    }
  } catch (err) {
    console.error('Failed to initialize Bee:', err);
    process.exit(1);
  }
}

initBee();
