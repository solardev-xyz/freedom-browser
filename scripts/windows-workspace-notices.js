'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const upstreamLicenses = new Map();

function selectedPackages(metadata, tree) {
  const selected = new Set(tree.split('\n').flatMap(line => {
    const match = /^(\S+) v(\S+)(?:\s|$)/.exec(line);
    return match ? [`${match[1]}@${match[2]}`] : [];
  }));
  const packages = metadata.packages.filter(item => selected.has(`${item.name}@${item.version}`));
  if (!selected.size || packages.length !== selected.size) throw new Error('Ambiguous sandbox dependency inventory');
  return packages.sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`));
}

function licenseFiles(directory) {
  const result = [];
  let visited = 0;
  const walk = current => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (++visited > 100000) throw new Error('Oversized crate source tree');
      const filename = path.join(current, entry.name);
      if (entry.isDirectory() && !['target', '.git'].includes(entry.name)) walk(filename);
      else if (entry.isFile() && /^(licen[cs]e|copying|notice|copyright)([._-]|$)/i.test(entry.name)) {
        if (fs.statSync(filename).size > 8 * 1024 * 1024) throw new Error('Oversized dependency notice');
        result.push({ file: path.relative(directory, filename).split(path.sep).join('/'), text: fs.readFileSync(filename, 'utf8') });
      }
    }
  };
  walk(directory);
  return result;
}

// Some published crates omit their license file. Use their crate-authenticated
// VCS commit, never a moving branch, to retrieve the missing upstream text.
async function missingLicense(item, directory) {
  const vcsFile = path.join(directory, '.cargo_vcs_info.json');
  const vcs = fs.existsSync(vcsFile) && JSON.parse(fs.readFileSync(vcsFile, 'utf8'));
  const repository = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)/.exec(item.repository || '');
  if (!repository || !/^[a-f0-9]{40}$/.test(vcs?.git?.sha1 || '')) throw new Error(`Missing pinned license source for ${item.name}`);
  const base = `https://raw.githubusercontent.com/${repository[1]}/${repository[2].replace(/\.git$/, '')}/${vcs.git.sha1}`;
  if (upstreamLicenses.has(base)) return upstreamLicenses.get(base);
  for (const name of ['LICENSE', 'LICENSE-MIT', 'LICENSE-APACHE', 'LICENSE.md', 'LICENSE.txt', 'License.txt', 'LICENCE', 'UNLICENSE']) {
    const source = `${base}/${name}`;
    const response = await fetch(source, { signal: AbortSignal.timeout(30000), redirect: 'error' });
    if (response.status === 404) continue;
    if (!response.ok) throw new Error(`Cannot retrieve pinned license for ${item.name}: ${response.status}`);
    const text = await response.text();
    if (!text.trim() || text.length > 1024 * 1024) throw new Error('Invalid upstream license text');
    const files = [{ file: name, source, text }];
    upstreamLicenses.set(base, files);
    return files;
  }
  throw new Error(`No license text at the pinned source for ${item.name}`);
}

async function writeWindowsNotices({ cargo, workspace, source, output, freedomRoot, arch }) {
  const capture = args => {
    const result = spawnSync(cargo, args, { cwd: workspace, encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
    if (result.status !== 0) throw new Error(`Cargo attribution inventory failed: ${result.stderr?.slice(-1000) || result.error?.message}`);
    return result.stdout;
  };
  const target = arch === 'x64' ? 'x86_64-pc-windows-msvc' : 'aarch64-pc-windows-msvc';
  const metadata = JSON.parse(capture(['metadata', '--locked', '--format-version', '1', '--filter-platform', target]));
  const tree = capture(['tree', '--locked', '--target', target, '-p', 'freedom-windows-workspace', '-p', 'codex-windows-sandbox', '--edges', 'normal,build', '--prefix', 'none', '--format', '{p}']);
  const packages = selectedPackages(metadata, tree);
  const inventory = [];
  const sections = ['Freedom Windows sandbox dependency notices\nIncludes normal and build dependencies of the pinned sandbox build.\nSource links identify the exact published versions; build-only entries may not be linked into the executable.'];
  for (const item of packages) {
    if (!item.license) throw new Error(`Missing license declaration: ${item.name}`);
    const directory = path.dirname(item.manifest_path);
    let files = licenseFiles(directory);
    if (!item.source && !files.length) files = [{ file: 'LICENSE', text: fs.readFileSync(path.join(item.name === 'freedom-windows-workspace' ? freedomRoot : source, 'LICENSE'), 'utf8') }];
    if (!files.some(file => /^(license|licence|copying)/i.test(path.basename(file.file)))) {
      files.push(...await missingLicense(item, directory));
    }
    const origin = item.source || `https://github.com/${item.name === 'freedom-windows-workspace' ? 'solardev-xyz/freedom-browser' : 'openai/codex'}`;
    const download = item.source?.startsWith('registry+') ? `https://crates.io/api/v1/crates/${item.name}/${item.version}/download` : origin;
    inventory.push({ name: item.name, version: item.version, license: item.license, authors: item.authors, source: origin, sourceDownload: download,
      notices: files.map(({ file, source: location, text }) => ({ file, ...(location && { source: location }), sha256: crypto.createHash('sha256').update(text).digest('hex') })) });
    sections.push(`${item.name} ${item.version}\nLicense: ${item.license}\nAuthors: ${(item.authors || []).join(', ')}\nSource: ${download}\n${files.map(file => `\n--- ${file.file}${file.source ? ` (${file.source})` : ''} ---\n${file.text}`).join('\n')}`);
  }
  fs.writeFileSync(path.join(output, 'CODEX-DEPENDENCIES.json'), JSON.stringify(inventory, null, 2) + '\n');
  fs.writeFileSync(path.join(output, 'CODEX-DEPENDENCIES.txt'), sections.join('\n\n' + '='.repeat(72) + '\n\n') + '\n');
  console.log(`Bundled notices for ${inventory.length} Windows sandbox dependencies`);
}

module.exports = { selectedPackages, writeWindowsNotices };
