const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const DATA_DIR = path.join(__dirname, '..', 'ipfs-data');

function getIpfsBinaryPath() {
  const platform = process.platform;
  const arch = process.arch;
  const binName = platform === 'win32' ? 'ipfs.exe' : 'ipfs';
  return path.join(__dirname, '..', 'ipfs-bin', `${platform}-${arch}`, binName);
}

function initIpfs() {
  try {
    const binPath = getIpfsBinaryPath();

    if (!fs.existsSync(binPath)) {
      console.error(`IPFS binary not found at ${binPath}`);
      console.error('Run "npm run ipfs:download" first.');
      process.exit(1);
    }

    // Check if already initialized
    const repoPath = path.join(DATA_DIR, 'config');
    if (fs.existsSync(repoPath)) {
      console.log('IPFS is already initialized (repo exists). Skipping.');
      return;
    }

    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      console.log(`Created data directory: ${DATA_DIR}`);
    }

    console.log('Initializing IPFS repository...');
    execSync(`"${binPath}" init`, {
      stdio: 'inherit',
      env: { ...process.env, IPFS_PATH: DATA_DIR },
    });

    // Configure IPFS for low-bandwidth embedded use
    console.log('Configuring IPFS for Freedom (low-bandwidth mode)...');

    const configPath = path.join(DATA_DIR, 'config');
    if (fs.existsSync(configPath)) {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

      // Set API address
      config.Addresses = config.Addresses || {};
      config.Addresses.API = '/ip4/127.0.0.1/tcp/5001';
      config.Addresses.Gateway = '/ip4/127.0.0.1/tcp/8080';

      // Enable CORS for local access
      config.API = config.API || {};
      config.API.HTTPHeaders = config.API.HTTPHeaders || {};
      config.API.HTTPHeaders['Access-Control-Allow-Origin'] = ['*'];
      config.API.HTTPHeaders['Access-Control-Allow-Methods'] = ['GET', 'POST', 'PUT'];

      // CRITICAL: Run as DHT client only, not server
      // This drastically reduces bandwidth usage
      config.Routing = config.Routing || {};
      config.Routing.Type = 'dhtclient';

      // Aggressive connection limits for embedded use
      config.Swarm = config.Swarm || {};
      config.Swarm.ConnMgr = config.Swarm.ConnMgr || {};
      config.Swarm.ConnMgr.LowWater = 10;
      config.Swarm.ConnMgr.HighWater = 30;
      config.Swarm.ConnMgr.GracePeriod = '30s';

      // Disable relay to save bandwidth (we don't need to relay for others)
      config.Swarm.RelayClient = config.Swarm.RelayClient || {};
      config.Swarm.RelayClient.Enabled = true; // Can use relays
      config.Swarm.RelayService = config.Swarm.RelayService || {};
      config.Swarm.RelayService.Enabled = false; // Don't relay for others

      // Disable reproviding (reduces DHT traffic significantly)
      // Use new 'Provide' config instead of deprecated 'Reprovider'
      config.Provide = config.Provide || {};
      config.Provide.Enabled = false;

      // Disable local network discovery (can be noisy)
      config.Discovery = config.Discovery || {};
      config.Discovery.MDNS = config.Discovery.MDNS || {};
      config.Discovery.MDNS.Enabled = false;

      // Disable swarm listening to prevent macOS local network prompt
      // As a DHT client, we only need outbound connections
      config.Addresses.Swarm = [];

      // Disable AutoTLS since we have no swarm listeners
      config.AutoTLS = config.AutoTLS || {};
      config.AutoTLS.Enabled = false;
      config.AutoTLS.AutoWSS = false;

      fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
      console.log('IPFS configuration updated (low-bandwidth mode).');
    }

    console.log('IPFS initialized successfully.');
    console.log(`Repo path: ${DATA_DIR}`);
  } catch (err) {
    console.error('Failed to initialize IPFS:', err.message);
    process.exit(1);
  }
}

initIpfs();
