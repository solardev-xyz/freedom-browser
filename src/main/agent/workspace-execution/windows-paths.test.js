'use strict';

const { unsafeWindowsRelativePath } = require('./windows-paths');

describe('Windows workspace path aliases', () => {
  test.each(['.git./config', '.git /config', 'file:stream', 'C:relative', 'aux.txt', 'COM1', 'lpt².log', 'folder/conout$', 'a\\b'])('rejects %s before filesystem access', value => {
    expect(unsafeWindowsRelativePath(value, 'win32')).toBe(true);
  });
  test('keeps ordinary names and POSIX filename semantics', () => {
    expect(unsafeWindowsRelativePath('src/components/page.tsx', 'win32')).toBe(false);
    expect(unsafeWindowsRelativePath('auxiliary.txt', 'win32')).toBe(false);
    expect(unsafeWindowsRelativePath('report:2026', 'darwin')).toBe(false);
  });
});
