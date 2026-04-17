/**
 * Integration test: Kubo's subdomain gateway behaviour on `localhost`.
 *
 * Freedom routes IPFS content through `http://localhost:<port>/ipfs/<CID>` and
 * relies on Kubo redirecting to `http://<cidv1>.ipfs.localhost:<port>/` so that
 * `_redirects` files (e.g. SPA fallbacks on ENS-hosted sites) work correctly.
 *
 * That redirect behaviour is load-bearing for the fix — it comes from Kubo's
 * built-in `PublicGateways` default for the `localhost` hostname. This test
 * guards against a Kubo upgrade silently breaking the assumption.
 */

const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');

function getIpfsBinaryPath() {
  const arch = process.arch;
  const platformMap = { darwin: 'mac', linux: 'linux', win32: 'win' };
  const platform = platformMap[process.platform] || process.platform;
  const binName = process.platform === 'win32' ? 'ipfs.exe' : 'ipfs';
  const projectRoot = path.resolve(__dirname, '../../../..');
  const binPath = path.join(projectRoot, 'ipfs-bin', `${platform}-${arch}`, binName);
  return fs.existsSync(binPath) ? binPath : null;
}

function waitForIpfsReady(port, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      const req = http.request(
        { host: '127.0.0.1', port, path: '/api/v0/id', method: 'POST', timeout: 2000 },
        (res) => {
          if (res.statusCode === 200) resolve(true);
          else if (Date.now() - start < timeout) setTimeout(check, 500);
          else reject(new Error(`IPFS not ready after ${timeout}ms`));
        }
      );
      req.on('error', () => {
        if (Date.now() - start < timeout) setTimeout(check, 500);
        else reject(new Error(`IPFS not ready after ${timeout}ms`));
      });
      req.end();
    };
    check();
  });
}

function addFileViaApi(port, content, fileName = 'index.html') {
  const boundary = `----freedom-${Date.now()}`;
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\n` +
        `Content-Type: text/plain\r\n\r\n`
    ),
    Buffer.from(content),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);

  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/api/v0/add?cid-version=0',
        method: 'POST',
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': body.length,
        },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try {
            // The /add endpoint returns one JSON object per line; we only add one file.
            const line = data.trim().split('\n')[0];
            resolve(JSON.parse(line));
          } catch {
            reject(new Error(`Failed to parse /add response: ${data}`));
          }
        });
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function headRequest(host, port, urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host, port, path: urlPath, method: 'HEAD', timeout: 5000 },
      (res) => {
        resolve({ statusCode: res.statusCode, headers: res.headers });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

describe('Kubo subdomain gateway redirect', () => {
  const ipfsBinary = getIpfsBinaryPath();
  let tempDir;
  let ipfsProcess;
  const TEST_API_PORT = 15011;
  const TEST_GATEWAY_PORT = 18091;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ipfs-subdomain-test-'));
  });

  afterEach(async () => {
    if (ipfsProcess && !ipfsProcess.killed) {
      ipfsProcess.kill('SIGTERM');
      await new Promise((resolve) => {
        ipfsProcess.on('exit', resolve);
        setTimeout(resolve, 3000);
      });
    }
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  const maybeTest = ipfsBinary ? test : test.skip;

  maybeTest(
    'redirects localhost path-gateway request to <cid>.ipfs.localhost subdomain form',
    async () => {
      execSync(`"${ipfsBinary}" init`, {
        env: { ...process.env, IPFS_PATH: tempDir },
        stdio: 'pipe',
      });

      const configPath = path.join(tempDir, 'config');
      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      config.Addresses.API = `/ip4/127.0.0.1/tcp/${TEST_API_PORT}`;
      config.Addresses.Gateway = `/ip4/127.0.0.1/tcp/${TEST_GATEWAY_PORT}`;
      config.Addresses.Swarm = [];
      config.Bootstrap = [];
      config.Routing = { Type: 'none' };
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

      ipfsProcess = spawn(ipfsBinary, ['daemon', '--offline'], {
        env: { ...process.env, IPFS_PATH: tempDir },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      ipfsProcess.stderr.on('data', () => {});

      await waitForIpfsReady(TEST_API_PORT, 60000);

      const added = await addFileViaApi(
        TEST_API_PORT,
        '<!doctype html><title>hi</title>',
        'index.html'
      );
      const cid = added.Hash;
      expect(cid).toMatch(/^Qm/); // CIDv0 (cid-version=0)

      // Hitting the path gateway on hostname `localhost` must redirect to the
      // subdomain gateway form. This is what makes `_redirects` work.
      const res = await headRequest('localhost', TEST_GATEWAY_PORT, `/ipfs/${cid}/`);
      expect(res.statusCode).toBe(301);
      expect(res.headers.location).toMatch(
        new RegExp(`^http://[a-z0-9]+\\.ipfs\\.localhost:${TEST_GATEWAY_PORT}/`)
      );

      // Sanity check: hitting 127.0.0.1 with the same path does NOT redirect to
      // subdomain form (Kubo only applies subdomain rewriting for `localhost`).
      const resLoopback = await headRequest('127.0.0.1', TEST_GATEWAY_PORT, `/ipfs/${cid}/`);
      expect(resLoopback.statusCode).toBe(200);
    },
    120000
  );
});
