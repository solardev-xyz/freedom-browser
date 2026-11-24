# Pubky public files

Freedom opens public files stored on [Pubky](https://pubky.org) homeservers. A Pubky user is an Ed25519 public key, and their files live on a homeserver that the key names in a signed [Pkarr](https://pkarr.org) record. The address stays the same when the user moves to another homeserver.

## Addresses

| You enter                                     | Freedom loads                                                   |
| --------------------------------------------- | --------------------------------------------------------------- |
| `pubky://<public-key>/pub/<path>`             | The file at `/pub/<path>`                                       |
| `pubky<public-key>/pub/<path>`                | The same file. This is the Pubky SDK's display form.            |
| `pubky://<public-key>` or `pubky<public-key>` | `pubky://<public-key>/pub/`, the list of the key's public files |

`<public-key>` is 52 z-base-32 characters. The address bar always shows the `pubky://` form, and Pubky addresses are never sent to the search provider. These forms follow [Pubky Chromium's identifier grammar](https://github.com/pubky/pubky-chromium/blob/pubky/pubky/IDENTIFIERS.md).

## How a request is served

`pubky` is registered in `src/main/index.js` as a privileged standard scheme, like `ipfs` and `bzz`. Each public key is its own origin, so relative links, sub-resources and `fetch()` in a page served from `pubky://<public-key>/` work without a gateway.

The handler in `src/main/pubky/pubky-protocol.js` uses the [Pubky JS SDK](https://www.npmjs.com/package/@synonymdev/pubky) to resolve the key's homeserver through Pkarr relays and fetch the file. The homeserver's status, headers and body go back to the page, so a missing file returns `404` and an HTML file renders as a page.

The key's owner chooses the homeserver address, so every request the SDK makes for a `pubky://` page is checked first:

- Only `https://` is dialled.
- Redirects are never followed. A homeserver that answers with a redirect gets the page a `502`.
- The host must resolve only to public addresses. Loopback, private (LAN), link-local, carrier-grade NAT and other reserved ranges are refused, so a `pubky://` page can't read the local Ant API or a router's admin page. A DNS answer that changes between this check and the connection (DNS rebinding) is not caught.

Loading the SDK replaces Node's global `fetch` with a cookie-storing wrapper. The handler puts the original back as soon as the SDK has loaded, so no cookie jar is kept for Pubky or for any other main-process request. The SDK's own requests are routed through the checks above; every other caller reaches the original `fetch` unchanged.

## Limits

- Only `GET` and `HEAD` under `/pub/` are served. Other methods return `405`, and other paths return `400`.
- Freedom never signs in to a homeserver, so it can't write files or read private data.
- If the homeserver can't be resolved or reached, or a check above refuses it, the handler returns `502` with a fixed message. SDK error text never reaches the page.
- The handler doesn't log request URLs, because they name the key being read.
