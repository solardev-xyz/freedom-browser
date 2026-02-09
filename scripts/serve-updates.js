#!/usr/bin/env node

/**
 * Simple HTTP server to serve update files for local testing
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 8765;
const ROOT_DIR = path.join(__dirname, '..');
const DIST_DIR = path.join(ROOT_DIR, 'dist');
const DEV_UPDATE_FILE = path.join(ROOT_DIR, 'dev-app-update.yml');

const server = http.createServer((req, res) => {
  // Remove query string for file lookup
  let urlPath = req.url.split('?')[0];

  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);

  // For dev testing, if requesting latest-mac.yml, serve dev-app-update.yml instead
  let filePath;
  if (urlPath === '/latest-mac.yml') {
    filePath = DEV_UPDATE_FILE;
    console.log(`  → Serving dev-app-update.yml`);
  } else {
    filePath = path.join(DIST_DIR, urlPath);
  }

  // Security: ensure we're serving from allowed locations
  const isInDist = filePath.startsWith(DIST_DIR);
  const isDevUpdate = filePath === DEV_UPDATE_FILE;

  if (!isInDist && !isDevUpdate) {
    console.log(`  → 403 Forbidden: ${filePath}`);
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  // Check if file exists
  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      console.log(`  → 404 Not Found: ${filePath}`);
      res.writeHead(404);
      res.end('Not Found');
      return;
    }

    // Determine content type
    const ext = path.extname(filePath).toLowerCase();
    const contentTypes = {
      '.yml': 'text/yaml',
      '.yaml': 'text/yaml',
      '.json': 'application/json',
      '.zip': 'application/zip',
      '.dmg': 'application/x-apple-diskimage',
      '.exe': 'application/x-msdownload',
      '.blockmap': 'application/octet-stream',
    };
    const contentType = contentTypes[ext] || 'application/octet-stream';

    // Add CORS headers for testing
    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': stats.size,
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-cache',
    });

    // Stream the file
    const stream = fs.createReadStream(filePath);
    stream.pipe(res);

    console.log(`  → 200 OK (${stats.size} bytes)`);
  });
});

server.listen(PORT, 'localhost', () => {
  console.log('');
  console.log('🚀 Update Server Running');
  console.log('========================');
  console.log(`URL: http://localhost:${PORT}`);
  console.log(`Serving: ${DIST_DIR}`);
  console.log('');
  console.log('📋 To test updates:');
  console.log('1. Ensure dev-app-update.yml points to this server');
  console.log('2. Run: ENABLE_DEV_UPDATER=true npm start');
  console.log('3. Check for updates in the app');
  console.log('');
  console.log('Press Ctrl+C to stop');
  console.log('');
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`❌ Port ${PORT} is already in use. Kill the process or use a different port.`);
  } else {
    console.error('❌ Server error:', err);
  }
  process.exit(1);
});
