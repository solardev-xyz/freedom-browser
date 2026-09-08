const RADICLE_ADDON_VERSION = '0.7.1';

// Every function the app requires the addon to expose. Shared (not
// main-process-only) so build/CI checks can verify a downloaded
// `libradicle.node` against the same list radicle-embedded.js loads by.
const RADICLE_ADDON_REQUIRED_EXPORTS = [
  'start',
  'shutdown',
  'connectSeeds',
  'cloneRepo',
  'cloneRepoWithProgress',
  'cancelClone',
  'unseedRepo',
  'listRepos',
  'listSeededRepos',
  'issues',
  'issue',
  'patches',
  'patch',
  'identity',
  'createIssue',
  'commentIssue',
  'editIssueState',
  'commentPatch',
  'importRepo',
  'repoInfo',
  'commits',
  'commit',
  'tree',
  'treeAt',
  'blob',
  'blobAt',
  'remotes',
  'repoStats',
  'status',
  'seeders',
];

module.exports = {
  RADICLE_ADDON_VERSION,
  RADICLE_ADDON_RELEASE_TAG: `v${RADICLE_ADDON_VERSION}`,
  RADICLE_ADDON_REQUIRED_EXPORTS,
};
