const path = require('path');
const { pathToFileURL } = require('url');
const { grantDictationCapture, revokeDictationCapture, permitsDictationCapture } = require('./dictation-capture');

test('microphone grants are ephemeral, exact-chrome, audio-only and never cover guest frames', () => {
  const chromeUrl = pathToFileURL(path.resolve(__dirname, '../../renderer/index.html')).href;
  const sender = { getType: () => 'window', getURL: () => chromeUrl, isDestroyed: () => false };
  const request = { mediaTypes: ['audio'], requestingUrl: chromeUrl, isMainFrame: true };
  expect(permitsDictationCapture(sender, request)).toBe(false);
  grantDictationCapture(sender, 'recording');
  expect(permitsDictationCapture(sender, request)).toBe(true);
  expect(permitsDictationCapture(sender, { ...request, mediaTypes: ['video'] })).toBe(false);
  expect(permitsDictationCapture(sender, { ...request, mediaTypes: ['audio', 'video'] })).toBe(false);
  expect(permitsDictationCapture(sender, { ...request, isMainFrame: false })).toBe(false);
  expect(permitsDictationCapture(sender, { ...request, requestingUrl: 'https://example.com/' })).toBe(false);
  expect(permitsDictationCapture(sender, { mediaType: 'audio' }, true)).toBe(true);
  expect(permitsDictationCapture(sender, { mediaType: 'video' }, true)).toBe(false);
  expect(permitsDictationCapture({ ...sender, getType: () => 'webview' }, request)).toBe(false);
  revokeDictationCapture(sender, 'older-recording');
  expect(permitsDictationCapture(sender, request)).toBe(true);
  revokeDictationCapture(sender, 'recording');
  expect(permitsDictationCapture(sender, request)).toBe(false);
});
