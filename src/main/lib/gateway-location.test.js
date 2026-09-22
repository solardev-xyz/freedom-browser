const { rewriteGatewayLocation } = require('./gateway-location');

// The contract both transports depend on, pinned here so neither caller's suite
// is the only thing holding it: given a gateway-space `Location` and the
// gateway URL the request went to, produce a reference that resolves to the
// same content when Chromium applies it to the custom-scheme URL instead — or
// `null` when the target cannot be expressed that way and must be passed
// through exactly as the gateway wrote it.
describe('rewriteGatewayLocation', () => {
  const CID = 'bafybeidirectory';
  const REF = 'a'.repeat(64);

  test("rewrites Kubo's hash-rooted directory redirect", () => {
    expect(
      rewriteGatewayLocation(`/ipfs/${CID}/docs/`, `http://127.0.0.1:8080/ipfs/${CID}/docs`)
    ).toBe('./docs/');
  });

  test("rewrites Bee's hash-rooted directory redirect", () => {
    expect(
      rewriteGatewayLocation(`/bzz/${REF}/blog/`, `http://127.0.0.1:1633/bzz/${REF}/blog`)
    ).toBe('./blog/');
  });

  test('keeps query and fragment on the rewritten reference', () => {
    expect(
      rewriteGatewayLocation(
        `/bzz/${REF}/blog/?page=2#top`,
        `http://127.0.0.1:1633/bzz/${REF}/blog`
      )
    ).toBe('./blog/?page=2#top');
  });

  test('accepts a same-origin absolute Location', () => {
    expect(
      rewriteGatewayLocation(
        `http://127.0.0.1:1633/bzz/${REF}/blog/`,
        `http://127.0.0.1:1633/bzz/${REF}/blog`
      )
    ).toBe('./blog/');
  });

  test('is idempotent on a reference that is already relative', () => {
    expect(rewriteGatewayLocation('./blog/', `http://127.0.0.1:1633/bzz/${REF}/blog`)).toBe(
      './blog/'
    );
  });

  test('stays `./` when the target is the request directory itself', () => {
    expect(
      rewriteGatewayLocation(`/bzz/${REF}/blog/`, `http://127.0.0.1:1633/bzz/${REF}/blog/`)
    ).toBe('./');
  });

  // `./` is load-bearing: a bare `re:port/` parses as an absolute URL with
  // scheme `re:` (RFC 3986 §4.2), and `:` is a legal path segment on both
  // transports.
  test('prefixes `./` so a colon-bearing first segment is not read as a scheme', () => {
    const out = rewriteGatewayLocation(
      `/bzz/${REF}/re:port/`,
      `http://127.0.0.1:1633/bzz/${REF}/re:port`
    );
    expect(out).toBe('./re:port/');
    expect(new URL(out, 'bzz://meinhard.eth/re:port').toString()).toBe(
      'bzz://meinhard.eth/re:port/'
    );
  });

  // Go escapes `!'()*[]|^` in a path; Chromium leaves every one of them
  // literal. So Bee's `Location` for a directory under a parent whose name
  // carries any of them is spelled differently from the request path it
  // extends, and a raw-bytes prefix test reads it as leaving the directory.
  // Verified against go1.26.5's own `net/url` + `net/http.Redirect`.
  test.each([
    ['photos(2024)', 'photos%282024%29'],
    ["it's", 'it%27s'],
    ['a[1]', 'a%5B1%5D'],
  ])('rewrites a redirect whose parent segment the gateway re-escaped (%s)', (literal, escaped) => {
    expect(
      rewriteGatewayLocation(
        `/bzz/${REF}/${escaped}/blog/`,
        `http://127.0.0.1:1633/bzz/${REF}/${literal}/blog`
      )
    ).toBe('./blog/');
  });

  // The same disagreement in the other direction: the request carried the
  // escape and the gateway's re-escape is byte-identical to it, so this one
  // already worked — pinned so the comparison stays symmetric.
  test('rewrites a redirect under a parent segment the request escaped', () => {
    expect(
      rewriteGatewayLocation(
        `/bzz/${REF}/photos%282024%29/blog/`,
        `http://127.0.0.1:1633/bzz/${REF}/photos%282024%29/blog`
      )
    ).toBe('./blog/');
  });

  // Decoding is per segment, never across the whole path: a name containing an
  // encoded `/` is one directory, so a target that splits it into two real
  // segments sits outside the request's directory and must still be declined.
  test('declines when an encoded slash would have to pass for a separator', () => {
    expect(
      rewriteGatewayLocation(
        `/bzz/${REF}/a/b/page`,
        `http://127.0.0.1:1633/bzz/${REF}/a%2Fb/index.html`
      )
    ).toBeNull();
  });

  // A climb-out has fewer segments than the request's directory, so the
  // comparison would otherwise read a missing segment — and
  // `decodeURIComponent(undefined)` is the string `'undefined'`, which a
  // directory of that name (JS-generated sites produce them) would match,
  // turning a climb-out into `./`.
  test('declines a climb-out past a directory literally named `undefined`', () => {
    expect(
      rewriteGatewayLocation(`/bzz/${REF}/a`, `http://127.0.0.1:1633/bzz/${REF}/a/undefined/x`)
    ).toBeNull();
  });

  // The directory itself, minus its trailing slash: `./` resolves *with* the
  // slash, so rewriting this would answer a slash-stripping redirect with the
  // URL it just redirected away from. Declined, exactly as the byte-prefix
  // test this replaced declined it.
  test('declines a target that is the request directory without its slash', () => {
    expect(
      rewriteGatewayLocation(`/bzz/${REF}/blog`, `http://127.0.0.1:1633/bzz/${REF}/blog/`)
    ).toBeNull();
  });

  test('declines a target that climbs out of the request directory', () => {
    expect(
      rewriteGatewayLocation(
        `/bzz/${'b'.repeat(64)}/blog/`,
        `http://127.0.0.1:1633/bzz/${REF}/blog`
      )
    ).toBeNull();
  });

  test('declines a cross-origin target', () => {
    expect(
      rewriteGatewayLocation(
        'http://127.0.0.1:5000/secret',
        `http://127.0.0.1:1633/bzz/${REF}/blog`
      )
    ).toBeNull();
  });

  test('declines an unparseable request URL', () => {
    expect(rewriteGatewayLocation('/bzz/x/', 'not a url')).toBeNull();
  });
});
