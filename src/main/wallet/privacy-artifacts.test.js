const fs = require('fs');
const os = require('os');
const path = require('path');
const { createHash } = require('crypto');
const { createPrivacyScope } = require('../networks/privacy-context');
const { createPrivacyArtifactLoader } = require('./privacy-artifacts');
let scope, handle, directory, manifest, loader;
const bytes = Buffer.from('public synthetic proving artifact fixture');
beforeEach(() => {
  scope = createPrivacyScope({ profileId: 'artifact-fixture', signal: new AbortController().signal });
  handle = scope.getContext({ kind: 'private-account', principal: 'fixture', protocol: 'ppv2-fixture', deployment: 'sepolia-fixture', role: 'artifacts', chainId: 11155111 });
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-fixture-'));
  fs.writeFileSync(path.join(directory, 'circuit.wasm'), bytes);
  manifest = [{ name: 'circuit.wasm', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }];
  loader = createPrivacyArtifactLoader({ handle, directory, manifest });
});
afterEach(() => { scope.close(); jest.restoreAllMocks(); });

test('only pinned names, exact length and digest pass; grants cannot be widened after creation', async () => {
  expect(await loader.load('circuit.wasm')).toEqual(bytes);
  manifest.push({ ...manifest[0], name: 'other.wasm' });
  await expect(loader.load('other.wasm')).rejects.toMatchObject({ code: 'PRIVATE_ARTIFACT_INVALID' });
  fs.writeFileSync(path.join(directory, 'circuit.wasm'), Buffer.alloc(bytes.length));
  await expect(loader.load('circuit.wasm')).rejects.toMatchObject({ code: 'PRIVATE_ARTIFACT_INVALID' });
  fs.writeFileSync(path.join(directory, 'circuit.wasm'), Buffer.alloc(bytes.length + 1));
  await expect(loader.load('circuit.wasm')).rejects.toMatchObject({ code: 'PRIVATE_ARTIFACT_INVALID' });
});

test('path traversal, symlinks, oversized manifests and missing files fail without a download fallback', async () => {
  for (const name of ['../circuit.wasm', '/circuit.wasm']) {
    expect(() => createPrivacyArtifactLoader({ handle, directory, manifest: [{ ...manifest[0], name }] }))
      .toThrow(expect.objectContaining({ code: 'PRIVATE_ARTIFACT_INVALID' }));
  }
  expect(() => createPrivacyArtifactLoader({ handle, directory, manifest: [{ ...manifest[0], size: 256 * 1024 * 1024 + 1 }] }))
    .toThrow(expect.objectContaining({ code: 'PRIVATE_ARTIFACT_INVALID' }));
  fs.symlinkSync(path.join(directory, 'circuit.wasm'), path.join(directory, 'linked.wasm'));
  loader = createPrivacyArtifactLoader({ handle, directory, manifest: [{ ...manifest[0], name: 'linked.wasm' }, { ...manifest[0], name: 'missing.wasm' }] });
  await expect(loader.load('linked.wasm')).rejects.toMatchObject({ code: 'PRIVATE_ARTIFACT_INVALID' });
  await expect(loader.load('missing.wasm')).rejects.toMatchObject({ code: 'PRIVATE_ARTIFACT_INVALID' });
});

test('lock while opening a file and caller cancellation refuse late bytes and close the descriptor', async () => {
  const original = fs.promises.open.bind(fs.promises);
  let close;
  jest.spyOn(fs.promises, 'open').mockImplementation(async (...args) => {
    const file = await original(...args); close = jest.spyOn(file, 'close'); scope.close(); return file;
  });
  await expect(loader.load('circuit.wasm')).rejects.toMatchObject({ code: 'PRIVACY_CONTEXT_REVOKED' });
  expect(close).toHaveBeenCalledTimes(1);
});

test('a cancelled request does not open a file', async () => {
  const controller = new AbortController(); controller.abort();
  const open = jest.spyOn(fs.promises, 'open');
  await expect(loader.load('circuit.wasm', { signal: controller.signal })).rejects.toMatchObject({ code: 'PRIVACY_REQUEST_ABORTED' });
  expect(open).not.toHaveBeenCalled();
});
