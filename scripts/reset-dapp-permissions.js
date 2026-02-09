#!/usr/bin/env node
/**
 * Reset dApp permissions
 * Usage: npm run reset:dapp-permissions
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

// Determine userData path based on platform
function getUserDataPath() {
  const appName = 'Freedom';
  switch (process.platform) {
    case 'darwin':
      return path.join(os.homedir(), 'Library', 'Application Support', appName);
    case 'win32':
      return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), appName);
    default: // linux and others
      return path.join(os.homedir(), '.config', appName);
  }
}

const permissionsFile = path.join(getUserDataPath(), 'dapp-permissions.json');

console.log('dApp permissions file:', permissionsFile);

if (fs.existsSync(permissionsFile)) {
  fs.unlinkSync(permissionsFile);
  console.log('✓ dApp permissions reset (file deleted)');
} else {
  console.log('✓ No permissions file found (already clean)');
}
