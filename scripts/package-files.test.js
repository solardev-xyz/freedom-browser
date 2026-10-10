// Exercise electron-builder's normalized matchers: an exclusion-only platform
// files list creates a separate default matcher and implicitly includes **/*.
const path = require('node:path');
const { doMergeConfigs } = require('app-builder-lib/out/util/config/config');
const { getMainFileMatchers } = require('app-builder-lib/out/fileMatcher');
const pkg = require('../package.json');

for (const platform of ['mac', 'linux', 'win']) {
  test(`${platform} packages application sources without build caches or repository artifacts`, () => {
    const root = path.resolve('/fixture');
    const config = doMergeConfigs([structuredClone(pkg.build)]);
    const matchers = getMainFileMatchers(root, path.join(root, 'dist/app'),
      value => value.replaceAll('${arch}', 'x64'), config[platform], {
        info: { config, projectDir: root, buildResourcesDir: 'assets', debugLogger: { isEnabled: false } },
      }, path.join(root, 'dist'), false);
    const included = relative => matchers.some(matcher => matcher.createFilter()(
      path.join(root, relative), { isDirectory: () => false }));
    expect(included('src/main/index.js')).toBe(true);
    expect(included('src/renderer/index.html')).toBe(true);
    expect(included('package.json')).toBe(true);
    for (const file of ['out/windows-workspace-source/target/release/cache.bin',
      'out/windows-workspace/x64/freedom-workspace-runner.exe', 'docs/audits/report.pdf',
      'research/notes.md', 'ant-bin/win-arm64/antd.exe', 'scratch/private.txt',
      'src/main/index.test.js']) {
      expect({ file, included: included(file) }).toEqual({ file, included: false });
    }
  });
}
