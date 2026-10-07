const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { SOURCES } = require('./railgun-kohaku-adapter-sources');

const root = path.resolve(__dirname, '../..');
const installed = path.dirname(
  require.resolve('@freedom/railgun-kohaku-adapter', { paths: [root] })
);

test('pins this list, the lockfile and every installed adapter file that can load', () => {
  expect(Object.isFrozen(SOURCES)).toBe(true);
  expect(new Set(SOURCES).size).toBe(SOURCES.length);
  expect(SOURCES.slice(0, 2)).toEqual([
    path.relative(root, __filename).replace(/\.test\.js$/, '.js'),
    'package-lock.json',
  ]);
  for (const name of SOURCES) {
    expect(path.isAbsolute(name) || name.split('/').includes('..')).toBe(false);
    expect(fs.statSync(path.join(root, name)).isFile()).toBe(true);
  }
  // Every installed file reached by the Freedom adapter and private-data wrappers.
  const loaded = JSON.parse(
    execFileSync(
      process.execPath,
      [
        '-e',
        `for (const name of ['private-adapter', 'public-adapter', 'snapshot-plugin', 'read-data',
          'read-dispatch']) require('./src/main/wallet/railgun-kohaku-' + name);
        for (const name of ['policy', 'intent', 'capsule', 'preparation'])
          require('./src/main/wallet/railgun-private-' + name);
        process.stdout.write(JSON.stringify(Object.keys(require.cache)));`,
      ],
      { cwd: root, encoding: 'utf8' }
    )
  )
    .filter((file) => file.startsWith(installed + path.sep))
    .map((file) => path.relative(root, file));
  expect(loaded.length).toBe(13);
  // The exports map in package.json decides which installed file runs.
  expect(SOURCES.slice(2).sort()).toEqual(
    [...loaded, path.relative(root, path.join(installed, 'package.json'))].sort()
  );
});
