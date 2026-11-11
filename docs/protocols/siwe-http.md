# Sign-In with Ethereum over HTTP Authentication

A site can ask Freedom to sign the visitor in with an Ethereum account using
plain HTTP authentication headers, without a wallet-connect button, page
JavaScript or a dApp connection. The site answers a page load with `401` and
a `SIWE` challenge; Freedom asks the user, signs an
[ERC-4361](https://eips.ethereum.org/EIPS/eip-4361) message with the account
they choose, and loads the page again with the signed message in an
`Authorization` header. The site checks it and usually sets a session cookie.

This page is the specification as Freedom implements it (#1152). It is meant
to become an EIP. A complete server is in
[`scripts/siwe-reference-server.js`](../../scripts/siwe-reference-server.js).
It serves plain HTTP and takes its origin from the `Host` header, so it also
works unchanged behind a Tor onion service.

## Exchange

```text
GET /members HTTP/1.1
Host: club.example

HTTP/1.1 401 Unauthorized
WWW-Authenticate: SIWE realm="club.example", nonce="8nQ2vLx0mK91abCdT4wZpR",
    uri="https://club.example/members", chain-id=1, version=1,
    statement="Sign in to Example Club",
    expiration-time="2026-11-10T12:05:00Z"

(Freedom shows its sign-in card; the user picks an account and signs.)

GET /members HTTP/1.1
Host: club.example
Authorization: SIWE result="eyJtZXNzYWdlIjoiY2x1Yi5leGFtcGxlIHdhbnRzIHlvdSB0by…"

HTTP/1.1 200 OK
Set-Cookie: session=…; Secure; HttpOnly; SameSite=Lax
```

## The challenge

An [RFC 9110](https://www.rfc-editor.org/rfc/rfc9110#section-11.6.1)
challenge with the auth-scheme `SIWE` (case-insensitive). It may share a
`WWW-Authenticate` header with other schemes, including token68 ones such as
`Negotiate`. Its auth-params, as tokens or quoted strings:

| Parameter         | Required | Meaning                                                                                                   |
| ----------------- | -------- | --------------------------------------------------------------------------------------------------------- |
| `nonce`           | yes      | ERC-4361 nonce: at least 8 ASCII letters and digits, issued by the server for this sign-in and used once. |
| `chain-id`        | yes      | EIP-155 chain ID the message names.                                                                       |
| `realm`           | no       | The page's host (with its port, if any). If present and different, the challenge is refused.              |
| `uri`             | no       | The ERC-4361 URI. Must be on the page's origin; defaults to the page's URL without its fragment.          |
| `version`         | no       | Must be `1`.                                                                                              |
| `statement`       | no       | ERC-4361 statement: at most 512 ASCII letters, digits, spaces and RFC 3986 reserved/unreserved marks.     |
| `expiration-time` | no       | RFC 3339 time after which the message is invalid. A challenge already past it is refused.                 |
| `not-before`      | no       | RFC 3339 time before which the message is invalid.                                                        |
| `request-id`      | no       | ERC-4361 request ID (`*pchar`), 1 to 200 characters.                                                      |

The message's `domain` is never taken from the challenge: it is the host of
the page the browser loaded, so a challenge cannot make the user sign in to
another site (ERC-4361's phishing rule). A `realm` or `uri` naming another
host or origin makes the browser ignore the challenge and show the 401 page.

## The response

The browser builds the ERC-4361 message itself, exactly as the ERC lays it
out, with the chosen account's EIP-55 address and the current time as
`Issued At`. For `http` pages (onion services and `localhost`, see below)
the first line carries the `http://` scheme prefix. It signs with EIP-191 `personal_sign`
and sends the same request again with:

```text
Authorization: SIWE result="<base64url of {"message": <string>, "signature": <0x hex>}>"
```

`result` is the unpadded base64url encoding of a UTF-8 JSON object with the
exact message signed and its 65-byte signature.

## What the server checks

Everything ERC-4361 asks of a verifier:

- the message parses as ERC-4361;
- its domain (and scheme, for `http`) is the server's own;
- its URI is on the server's origin;
- its nonce was issued by the server with at least 128 bits of randomness,
  is unexpired and is consumed now;
- its chain ID, version, `Expiration Time` and `Not Before` hold;
- the signature recovers to the address the message names. A smart-account
  server may also accept ERC-1271 or ERC-6492 signatures.

A refused sign-in is answered with `401` again. The browser then shows that
page and does not ask again for that load.

An onion service on plain HTTP must leave `Secure` off its session cookie.
Freedom, like Chromium, does not count `http://….onion` as a secure origin,
so it drops a `Secure` cookie set there and the user is never signed in.
Tor keeps the cookie private on the way regardless.

## What Freedom does

- **Only top-level page loads (GET).** A 401 on an image, a fetch or a form
  POST reaches the page untouched.
- **Only over a connection that proves which site answers and keeps the
  exchange private:**
  - HTTPS;
  - an onion service over plain HTTP (`http://<v3 address>.onion`), when
    Freedom routes it through Tor. A v3 onion address is the service's
    public key and Tor encrypts the traffic end to end, so it gives what
    HTTPS gives, without a certificate (whose issuance would publish the
    address in the Certificate Transparency logs). Freedom asks the tab's
    session how it routes the page, when the 401 arrives and again before
    the signed header goes out; with Tor off the challenge is ignored;
  - plain HTTP to `localhost`, `*.localhost`, `127.0.0.1` and `[::1]` for
    development.

  Not on `bzz://`, `ipfs://` and other dweb pages, not in private windows,
  and not in a tab the Agent is driving.

- **Always asks.** The sign-in card shows the site, the account (the one
  used last on that site is preselected), and the full message. There is no
  "always allow". The card shows only while its tab is active.
- **Accounts that can `personal_sign`:** recovery-phrase accounts, Ledger
  and phone accounts. Not Safe accounts yet.
- The header goes on one GET reload of the exact URL, in that tab, while
  that reload is under way (at most a minute); a redirect does not carry it
  on, and if the reload fails it is dropped.
- Freedom remembers which account signed in to each origin, for the
  preselection only (`siwe-accounts.json` in the profile).

The code is in `src/main/siwe-auth/` (challenge parsing, message, request
interception) and `src/renderer/lib/wallet/siwe-signin.js` (the card).
