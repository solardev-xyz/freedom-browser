// Copies an already-present, pinned local addon. No build/download/native load.
const fs = require('fs');
const path = require('path');
const { expectedArtifact, readPinnedBytes } = require('../src/main/myotis/myotis-artifact');
function activateLocal(args) {
  if (args.length !== 4 || args[0] !== '--target' || args[2] !== '--file') {
    throw new Error('Use --target <platform-arch> --file <absolute already-present Node addon>');
  }
  if (!path.isAbsolute(args[3])) throw new Error('Artifact must be an absolute local file');
  const target = args[1];
  const manifest = expectedArtifact(target);
  const platform = { darwin: 'mac', linux: 'linux', win32: 'win' }[target.split('-')[0]];
  const directory = path.join(__dirname, '..', 'myotis-bin', `${platform}-${target.split('-')[1]}`);
  fs.mkdirSync(directory, { recursive: true });
  // Never overwrite or delete an existing artifact. Partial output fails closed.
  const output = fs.openSync(path.join(directory, 'myotis-node.node'), 'wx', 0o600);
  try {
    readPinnedBytes(args[3], target, (chunk) => {
      let offset = 0;
      while (offset < chunk.length) {
        const count = fs.writeSync(output, chunk, offset, chunk.length - offset);
        if (count < 1) throw new Error('Myotis artifact copy made no progress');
        offset += count;
      }
    });
    fs.fsyncSync(output);
  } finally { fs.closeSync(output); }
  fs.writeFileSync(path.join(directory, 'myotis-artifact.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
}
if (require.main === module) {
  try { activateLocal(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { activateLocal };
