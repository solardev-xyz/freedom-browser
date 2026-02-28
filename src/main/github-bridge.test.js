// Mock electron before requiring github-bridge
jest.mock('electron', () => ({
  ipcMain: { handle: jest.fn() },
}));

// Mock radicle-manager (required by github-bridge)
jest.mock('./radicle-manager', () => ({
  getRadicleBinaryPath: (bin) => `/mock/path/${bin}`,
  getRadicleDataPath: () => '/mock/radicle-data',
}));

const { validateGitHubUrl } = require('./github-bridge');

describe('github-bridge', () => {
  describe('validateGitHubUrl', () => {
    test('accepts full HTTPS GitHub URL', () => {
      const result = validateGitHubUrl('https://github.com/solardev-xyz/freedom-browser');
      expect(result.success).toBe(true);
      expect(result.valid).toBe(true);
      expect(result.owner).toBe('solardev-xyz');
      expect(result.repo).toBe('freedom-browser');
      expect(result.cloneUrl).toBe('https://github.com/solardev-xyz/freedom-browser.git');
    });

    test('accepts GitHub URL with .git suffix', () => {
      const result = validateGitHubUrl('https://github.com/owner/repo.git');
      expect(result.valid).toBe(true);
      expect(result.owner).toBe('owner');
      expect(result.repo).toBe('repo');
    });

    test('accepts GitHub URL without protocol', () => {
      const result = validateGitHubUrl('github.com/owner/repo');
      expect(result.valid).toBe(true);
      expect(result.owner).toBe('owner');
      expect(result.repo).toBe('repo');
    });

    test('accepts shorthand owner/repo', () => {
      const result = validateGitHubUrl('owner/repo');
      expect(result.success).toBe(true);
      expect(result.valid).toBe(true);
      expect(result.owner).toBe('owner');
      expect(result.repo).toBe('repo');
      expect(result.cloneUrl).toBe('https://github.com/owner/repo.git');
    });

    test('accepts URL with trailing slash', () => {
      const result = validateGitHubUrl('https://github.com/owner/repo/');
      expect(result.valid).toBe(true);
      expect(result.owner).toBe('owner');
      expect(result.repo).toBe('repo');
    });

    test('accepts URL with www prefix', () => {
      const result = validateGitHubUrl('https://www.github.com/owner/repo');
      expect(result.valid).toBe(true);
    });

    test('rejects empty input', () => {
      const result = validateGitHubUrl('');
      expect(result.valid).toBe(false);
      expect(result.success).toBe(false);
      expect(result.error).toEqual({
        code: 'INVALID_URL',
        message: 'Please enter a GitHub repository URL',
        details: { field: 'url' },
      });
    });

    test('rejects null/undefined', () => {
      expect(validateGitHubUrl(null).valid).toBe(false);
      expect(validateGitHubUrl(undefined).valid).toBe(false);
    });

    test('rejects non-GitHub URLs', () => {
      expect(validateGitHubUrl('https://gitlab.com/owner/repo').valid).toBe(false);
    });

    test('rejects URLs with extra path segments', () => {
      expect(validateGitHubUrl('https://github.com/owner/repo/tree/main').valid).toBe(false);
    });

    test('rejects bare owner without repo', () => {
      expect(validateGitHubUrl('https://github.com/owner').valid).toBe(false);
    });

    test('handles owner/repo with dots and hyphens', () => {
      const result = validateGitHubUrl('my-org.io/my-repo.js');
      expect(result.valid).toBe(true);
      expect(result.owner).toBe('my-org.io');
      expect(result.repo).toBe('my-repo.js');
    });
  });
});
