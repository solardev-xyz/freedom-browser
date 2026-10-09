const {
  MAX_LAUNCH_URLS,
  MAX_LAUNCH_URL_LENGTH,
  extractLaunchUrls,
  isAcceptedLaunchUrl,
  sanitizeLaunchUrls,
} = require('./launch-urls');

describe('launch URLs (#597)', () => {
  describe('isAcceptedLaunchUrl', () => {
    test.each([
      'https://freedombrowser.eth.limo/',
      'http://example.com/path?q=1#top',
      'freedom://settings',
      'freedom://settings/profile',
      'bzz://ab12cd34/index.html',
      'ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi',
      'ipns://docs.ipfs.tech',
      'ens://vitalik.eth',
      'web3://0x1234567890123456789012345678901234567890',
      'rad:z3gqcJUoA1n9HaHKufZs5FCSGazv5',
    ])('accepts %s', (url) => {
      expect(isAcceptedLaunchUrl(url)).toBe(true);
    });

    test.each([
      'file:///etc/passwd',
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'ethereum:0x1234567890123456789012345678901234567890@1?value=1e18',
      'chrome://settings',
      'about:blank',
      'example.com',
      '/home/user/page.html',
      'C:\\Users\\me\\page.html',
      '.',
      '',
      'https://example.com/ with-space',
      'https://example.com/\nfile:///etc/passwd',
      `https://example.com/${'a'.repeat(MAX_LAUNCH_URL_LENGTH)}`,
      null,
      42,
      { href: 'https://example.com' },
    ])('rejects %p', (value) => {
      expect(isAcceptedLaunchUrl(value)).toBe(false);
    });
  });

  describe('extractLaunchUrls', () => {
    test('a packaged launch: the URL after the executable', () => {
      expect(extractLaunchUrls(['/opt/Freedom/freedom', 'freedom://settings'])).toEqual([
        'freedom://settings',
      ]);
    });

    test('a development launch: the app path is not a URL', () => {
      expect(
        extractLaunchUrls(['/path/to/electron', '.', 'https://freedombrowser.eth.limo/'])
      ).toEqual(['https://freedombrowser.eth.limo/']);
    });

    test('never treats argv[0] as a URL', () => {
      expect(extractLaunchUrls(['https://example.com/'])).toEqual([]);
    });

    test('skips switches and the values of --profile / --profile-dir', () => {
      expect(
        extractLaunchUrls([
          'freedom',
          '--profile',
          'https://not-a-url-to-open.example/',
          '--profile-dir',
          'bzz://also-a-value',
          '--open-settings',
          '--profile=work',
          '--no-sandbox',
          'bzz://ab12cd34/',
          'ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi',
        ])
      ).toEqual([
        'bzz://ab12cd34/',
        'ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi',
      ]);
    });

    test('drops schemes Freedom does not open', () => {
      expect(
        extractLaunchUrls([
          'freedom',
          'file:///etc/passwd',
          'javascript:alert(1)',
          'https://a.example/',
        ])
      ).toEqual(['https://a.example/']);
    });

    test('keeps the URL as given, case included', () => {
      expect(
        extractLaunchUrls(['freedom', 'ipfs://QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG'])
      ).toEqual(['ipfs://QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG']);
    });

    test('tolerates a missing or odd argv', () => {
      expect(extractLaunchUrls(undefined)).toEqual([]);
      expect(extractLaunchUrls(['freedom', 7, null])).toEqual([]);
    });
  });

  describe('sanitizeLaunchUrls', () => {
    test('keeps accepted URLs in order, without duplicates', () => {
      expect(
        sanitizeLaunchUrls([
          'https://b.example/',
          'file:///etc/passwd',
          'https://a.example/',
          'https://b.example/',
        ])
      ).toEqual(['https://b.example/', 'https://a.example/']);
    });

    test(`caps the list at ${MAX_LAUNCH_URLS}`, () => {
      const urls = Array.from({ length: MAX_LAUNCH_URLS + 5 }, (_, i) => `https://e${i}.example/`);
      expect(sanitizeLaunchUrls(urls)).toEqual(urls.slice(0, MAX_LAUNCH_URLS));
    });

    test('anything but an array yields no URLs', () => {
      expect(sanitizeLaunchUrls(undefined)).toEqual([]);
      expect(sanitizeLaunchUrls('https://example.com/')).toEqual([]);
      expect(sanitizeLaunchUrls({ 0: 'https://example.com/' })).toEqual([]);
    });
  });
});
