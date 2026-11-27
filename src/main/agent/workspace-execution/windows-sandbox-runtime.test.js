'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { resolveWindowsSandbox } = require('./windows-sandbox-runtime');
const { BINARIES, REVISION, adapterSourceSha256 } = require('../../../../scripts/build-windows-workspace');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

test('runtime rejects an adapter manifest that omits the startup-lock module', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-windows-source-'));
  try {
    const image = Buffer.alloc(160);
    image.write('MZ'); image.writeUInt32LE(128, 60); image.writeUInt32LE(0x4550, 128); image.writeUInt16LE(0x8664, 132);
    for (const name of BINARIES) fs.writeFileSync(path.join(directory, name), image);
    const manifest = { version: 1, backend: 'elevated', revision: REVISION, arch: 'x64',
      adapterSha256: sha(fs.readFileSync(path.join(__dirname, 'native/windows/src/main.rs'))),
      binaries: Object.fromEntries(BINARIES.map(name => [name, sha(image)])) };
    const save = () => fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify(manifest));
    save();
    await expect(resolveWindowsSandbox({ directory, arch: 'x64' })).rejects.toThrow('adapter is stale');
    manifest.adapterSha256 = adapterSourceSha256(); save();
    await expect(resolveWindowsSandbox({ directory, arch: 'x64' })).resolves.toMatchObject({ backend: 'elevated' });
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
