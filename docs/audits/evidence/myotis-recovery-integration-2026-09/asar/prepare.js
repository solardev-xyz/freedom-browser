const fs = require('fs/promises');
const path = require('path');
const root = path.resolve(process.argv[2] || process.cwd());
(async () => {
  const dir = await fs.mkdtemp('/private/tmp/myotis-asar-');
  const stage = path.join(dir, 'stage');
  for (const file of ['src/main/myotis/checkpoint-verifier.js', 'src/main/myotis/checkpoint-verifier-worker.js', 'src/main/ens/colibri-runtime.js']) {
    await fs.mkdir(path.dirname(path.join(stage, file)), { recursive: true });
    await fs.copyFile(path.join(root, file), path.join(stage, file));
  }
  await fs.cp(path.join(root, 'node_modules/@corpus-core/colibri-stateless'), path.join(stage, 'node_modules/@corpus-core/colibri-stateless'), { recursive: true });
  const asar = require(path.join(root, 'node_modules/@electron/asar'));
  await asar.createPackage(stage, path.join(dir, 'app.asar'));
  const entry = `const { app } = require('electron');\napp.setPath('userData', ${JSON.stringify(path.join(dir, 'profile'))});\napp.whenReady().then(async()=>{try { const { acquireCheckpoint } = require(${JSON.stringify(path.join(dir, 'app.asar/src/main/myotis/checkpoint-verifier.js'))}); for(const chainId of [1,100]) console.log(JSON.stringify({chainId,checkpoint:await acquireCheckpoint(chainId)})); app.exit(0); } catch(error) { console.error(error.code,error.message,error.stack); app.exit(1); }});\n`;
  await fs.writeFile(path.join(dir, 'main.cjs'), entry);
  console.log(dir);
})().catch(error => { console.error(error); process.exitCode=1; });
