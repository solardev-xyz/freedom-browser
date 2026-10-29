/**
 * Path containment for the dweb protocol handlers (`bzz:`, `ipfs:`, `ipns:`).
 *
 * A handler picks the content root, `/<namespace>/<reference>/`, from the
 * URL's host and appends the request's path to it. Chromium canonicalizes a
 * standard scheme's path before the handler sees it: `\` becomes `/`, and
 * `.`, `..`, `%2e` and `%2e%2e` segments are resolved. It keeps `%2F`,
 * `%5C` and escapes inside a segment, though, so
 * `ipfs://<cid>/..%2f..%2fipns/<name>` reaches the handler, and the node or
 * gateway behind it, as written. One that decodes those escapes before it
 * resolves dot segments then serves `/ipns/<name>`, or its own API, under the
 * CID's origin.
 *
 * The rules are freedom-core's dweb plan validation (fc-dweb `validate.rs`:
 * `check_path`, `stays_beneath`):
 *  - `%2E`, `%2F` and `%5C` are decoded in one pass, in any case, and every
 *    other escape is left as it is (`%252F` stays `%252F`);
 *  - with `/` and `\` both separating, no segment may then be `.` or `..`,
 *    and the target must still begin with `/<namespace>/<reference>`;
 *  - an encoded separator that doesn't climb (`a%2Fb`) passes, except under
 *    `/bzz/`, where any `%2F` or `%5C` is refused (O-2, #429).
 * A literal `\` is refused too: an HTTP client reads it as `/` (undici and
 * Chromium both do), so it never survives to the node as part of a name.
 */

/** `%2E`, `%2F` and `%5C`, in any case, decoded in one pass. */
function decodeDotsAndSeparators(path) {
  return path.replace(/%(?:2[eEfF]|5[cC])/g, (escape) => {
    const code = escape.slice(1).toLowerCase();
    if (code === '2e') return '.';
    if (code === '2f') return '/';
    return '\\';
  });
}

/** An encoded `/` or `\` (`%2F`, `%5C`, either case). */
function hasEncodedSeparator(path) {
  return /%(?:2f|5c)/i.test(path);
}

/** Any segment, decoded as above, that is `.` or `..`. */
function hasDotSegment(path) {
  return decodeDotsAndSeparators(path)
    .split(/[/\\]/)
    .some((segment) => segment === '.' || segment === '..');
}

/**
 * Whether a request path (a URL's `pathname`) is safe to append to a content
 * root: no literal `\`, no dot segment once decoded, and, when
 * `encodedSeparators` is false, no encoded separator at all.
 */
function isContainedPath(pathname, { encodedSeparators = true } = {}) {
  if (typeof pathname !== 'string') return false;
  if (pathname.includes('\\')) return false;
  if (!encodedSeparators && hasEncodedSeparator(pathname)) return false;
  return !hasDotSegment(pathname);
}

/**
 * Whether the gateway URL a handler built stays beneath its content root, as
 * an HTTP client will send it (`new URL` resolves dot segments and reads `\`
 * as `/`): the path begins with `/<namespace>/<reference>` for one of
 * `namespaces`, still does once decoded, and holds no dot segment.
 */
function isContainedTarget(gatewayUrl, namespaces, { encodedSeparators = true } = {}) {
  let pathname;
  try {
    ({ pathname } = new URL(gatewayUrl));
  } catch {
    return false;
  }
  const [root, namespace, reference] = pathname.split('/');
  if (root !== '' || !namespaces.includes(namespace) || !reference) return false;
  if (!encodedSeparators && hasEncodedSeparator(pathname)) return false;
  const decoded = decodeDotsAndSeparators(pathname).split(/[/\\]/);
  return (
    decoded[0] === '' &&
    decoded[1] === namespace &&
    decoded[2] === reference &&
    !decoded.some((segment) => segment === '.' || segment === '..')
  );
}

module.exports = {
  decodeDotsAndSeparators,
  hasEncodedSeparator,
  isContainedPath,
  isContainedTarget,
};
