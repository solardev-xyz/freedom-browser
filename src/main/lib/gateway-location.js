/**
 * Translate a gateway redirect's `Location` into the custom-scheme URL space.
 *
 * Shared by both content-addressed transports that proxy an HTTP gateway
 * behind a custom scheme: `ipfs://` / `ipns://` (see `ipfs-manager.js`) and
 * `bzz://` (see `swarm/bzz-protocol.js`). Both glue a `/<ns>/<ref>` prefix in
 * front of the custom-scheme path to build the gateway URL, so both have the
 * same problem with a gateway-space `Location`, and both must fix it the same
 * way — hence one helper rather than a copy per transport.
 */

// Whether two path segments name the same thing, comparing what they *mean*
// rather than how they are spelled. The two sides are escaped by different
// parsers and their escape sets do not agree: Chromium (WHATWG, so also the
// `URL` parsing below) leaves `!'()*[]|^` literal in a path, while Go's
// `url.URL.EscapedPath()` — which Bee falls back to as soon as `pkg/api/bzz.go`
// mutates `u.Path` to append the canonical slash, invalidating its `RawPath` —
// percent-escapes every one of them. So `GET /bzz/<ref>/photos(2024)/blog`
// really is answered `308 Location: /bzz/<ref>/photos%282024%29/blog/`
// (reproduced against go1.26.5 `net/url` + `net/http.Redirect` on 2026-09-22), and
// a raw-bytes prefix test reads the redirect as leaving the request's directory
// and passes it through — straight back to the doubled path and leaked hash this
// helper exists to prevent. Decoding per segment (never across the whole path,
// so an encoded `/` inside a name can never be mistaken for a separator) makes
// the comparison agree with both parsers.
function sameSegment(a, b) {
  if (a === b) return true;
  const decodedA = decodeSegment(a);
  return decodedA !== null && decodedA === decodeSegment(b);
}

function decodeSegment(segment) {
  try {
    return decodeURIComponent(segment);
  } catch {
    // A malformed escape (`%zz`) decodes to nothing meaningful; only an exact
    // byte match above can carry such a segment.
    return null;
  }
}

// A gateway redirect is written in the gateway's own URL space, but Chromium
// resolves it against the `ipfs://` / `ipns://` / `bzz://` request URL — it
// never saw the gateway origin. The canonical directory redirect is the
// everyday case: Kubo answers `GET /ipfs/<cid>/docs` with
// `301 Location: /ipfs/<cid>/docs/` (measured against a default-config Kubo
// 0.42.0 on 2026-09-14), and Bee/Ant answers `GET /bzz/<ref>/blog` for a
// directory with `308 Location: /bzz/<ref>/blog/` (upstream's
// `pkg/api/bzz.go` appends `/` to `r.URL` and calls `http.Redirect(...,
// StatusPermanentRedirect)`; read 2026-09-21, and reported as the observed
// behaviour in #95). Resolved against `ipfs://<cid>/docs` / `bzz://<name>/blog`
// those yield `ipfs://<cid>/ipfs/<cid>/docs/` / `bzz://<name>/bzz/<ref>/blog/` —
// a doubled path that 404s, leaks the resolved hash into the address bar and
// leaves the mangled URL there. So every directory URL typed, bookmarked or
// linked without its trailing slash breaks.
//
// The gateway path is the custom-scheme path with a `/<ns>/<ref>` prefix glued
// in front (see `buildGatewayUrl` in ipfs/ipfs-protocol.js and
// swarm/bzz-protocol.js), and the prefix is whatever the host resolved to — a
// CID, an IPNS key, a Swarm ref, or an Ethereum name whose contenthash carries
// its own base path, none of which this layer knows. A *relative* reference
// computed from the request's gateway path is therefore the one rewrite that
// resolves identically in both spaces, whatever the prefix is, so a
// same-directory-or-below target is re-expressed that way. A target that would
// need to climb out of the request's directory can't be expressed without
// knowing how deep the prefix goes, so it is passed through untouched — as is
// any cross-origin Location, which Chromium applies the normal cross-origin
// rules to (a hostile gateway must not be able to aim the custom-scheme origin
// at a loopback service; see the `redirect: 'manual'` notes at both call
// sites).
//
// `requestUrl` is the *gateway* URL the request was issued to, not the
// custom-scheme URL: the relative reference is computed against the gateway
// path and then resolved by Chromium against the custom-scheme path, which is
// exactly why it has to be relative.
//
// Returns the rewritten reference, or `null` when the Location must be left
// exactly as the gateway wrote it.
function rewriteGatewayLocation(location, requestUrl) {
  let requested;
  let target;
  try {
    requested = new URL(requestUrl);
    target = new URL(location, requested);
  } catch {
    return null;
  }
  if (target.origin !== requested.origin) return null;

  // The request's directory — everything before the last `/` of its path — as
  // segments, since that is the granularity the escaping differs at. A path
  // with no `/` at all has no directory to resolve a relative reference
  // against.
  if (!requested.pathname.includes('/')) return null;
  const dirSegments = requested.pathname.split('/').slice(0, -1);
  const targetSegments = target.pathname.split('/');
  // Strictly *more* segments than the directory, exactly as the byte-prefix
  // test this replaced required (its `dir` ended in `/`, so the target had to
  // carry something after it). An equal-length target is the directory with
  // its trailing slash stripped, which `./` would not express — `./` resolves
  // *with* the slash, turning a slash-stripping redirect into a loop — and
  // this also keeps the comparison below from reading past the end of a
  // shorter target, where `decodeURIComponent(undefined)` is the string
  // `'undefined'` and would match a directory literally named that.
  if (targetSegments.length <= dirSegments.length) return null;
  if (!dirSegments.every((segment, i) => sameSegment(segment, targetSegments[i]))) return null;

  // Spelled as the gateway wrote it: a percent-escape it added is equivalent to
  // the literal character for both parsers, so re-expressing it would gain
  // nothing and risks disagreeing with the bytes the gateway will be asked for.
  const relative = targetSegments.slice(dirSegments.length).join('/');
  // Always `./`-prefixed, never bare. A bare relative reference whose first
  // segment contains a `:` is parsed as an absolute URL with that segment as
  // its *scheme* (RFC 3986 §4.2 / the WHATWG URL parser), and `:` is a legal
  // UnixFS / Swarm manifest directory name: `ipfs://<cid>/re:port` → Kubo's
  // `301 Location: /ipfs/<cid>/re:port/` → bare `re:port/` would be read as
  // scheme `re:` and fail the navigation instead of opening the directory.
  // The prefix also keeps a name that starts the relative part with `/` or `//`
  // (a doubled slash in the gateway path) from resolving against the origin
  // root or being read as a scheme-relative authority. It is a no-op for the
  // everyday `docs/` case (`./docs/` resolves identically) and for the empty
  // target-is-the-directory case, which stays `./`.
  return `./${relative}${target.search}${target.hash}`;
}

module.exports = { rewriteGatewayLocation };
