# Wallet Tor response bounds and local drain — October 4, 2026

This prerequisite gives a future
Railgun POI sender a bounded response and an explicit local cleanup barrier. It
adds no sender, consent, live query, wallet operation or retry permission.

## Response contract

A request may lower `maxResponseBytes` from the existing 4 MiB default. The value
must be a positive safe integer no greater than that default, checked before
network admission. An optional caller signal must be an AbortSignal; omitted or
undefined remains allowed. Invalid signals refuse before endpoint/group
lookup, preserving existing idle cleanup. Accumulation rejects before retaining a chunk that would
exceed the limit. It does not truncate and return a misleading prefix. The bound
covers retained body bytes, not already-arrived chunks, TLS/socket buffers or
wire bytes received before destruction. Existing callers retain their limit.

`requireFramedResponse` is an optional Boolean, false by default. The intended
POI sender will set it to true alongside a 2,048-byte body cap. Explicit
Content-Length or supported chunked framing is then required, in addition to
HTTP parser completeness. Close-delimited responses cannot establish whether the
server intended a longer body and are refused in this mode. Ordinary callers keep
support for complete close-delimited responses. Missing bytes in length/chunked
framing must not return a successful partial body, including for default callers.
Strict framing conservatively refuses even bodiless responses without explicit
framing; the planned POI request expects HTTP 200.

Compression remains refused and requests continue to ask for identity encoding.
No decompression, redirect, retry or direct fallback is introduced. Even a
complete matching response only supports bounded diagnostics; it does not prove
POI acceptance, propagation, membership, non-delivery or retry safety.

## Local cleanup contract

Request rejection remains prompt. It does not imply that underlying sockets have
closed. `transport.close()` requests immediate revocation and destruction;
`transport.closed` is a separate, never-rejecting barrier after terminal close,
request settlement, connection continuations/agent callbacks and observed closure
of every tracked raw/TLS socket. Tracking must include failed SOCKS handshakes,
late connections and groups already removed from the reusable pool. An aborted
queued request which never acquired a socket may never emit a ClientRequest close
event in Node. Once that request has settled, waiting for such an event is not a
resource-drain requirement. Pending connection work and every actually allocated
socket remain separately tracked; the agent's internal queue is not mutated.

A dedicated transport instance lets a future sender await that barrier without
closing unrelated requests. Existing pooled requests and release behavior remain.
A stalled callback or delayed close may extend cleanup beyond the admission
budget; there is no hard drain-time guarantee. Local drain is not proof that a
remote service did not receive or process a request.

SOCKS isolation comes from the privacy context, not the transport instance.
Creating another transport does not itself allocate different credentials, and
different credentials are not evidence of distinct physical circuits or
unlinkability. Existing original-root readers create their own scopes/transports;
the planned POST will need its own reviewed operation context.

## Qualification

Independent tests distinguish native loopback behavior from controlled delayed
callbacks and socket-close events. The offline qualifier runs in Node and Electron
main using real HTTP/TLS and a SOCKS fixture which forwards only to loopback. Its
public test certificate is already in the repository. It loads no wallet and runs
no Arti process or live service query.

Native scenarios cover exact/oversized bodies, framed chunked responses,
truncated length/chunked responses, strict framing refusal, default compatibility,
unsupported encoding, partial cancellation, TLS/SOCKS failure and invalid options
before endpoint lookup. All transport instances must resolve their cleanup barrier before
fixture teardown. The native report records that promise settlement; controlled
unit tests establish the specific delayed-close ordering. All native cases use
one context, so separate transport instances reuse its isolation credentials. Deterministic unit cases separately establish ordering when
native socket timing cannot reliably be delayed. Neither fixture constitutes OS
network tracing, real Tor circuit qualification or live POI evidence.

Review reproduced a queued-request hang in the first candidate: occupy two real
agent sockets, then enqueue six additional requests and close or release the
transport. All eight request promises refuse, but the cleanup barrier remains
pending. The Node test has two bounded failures, and the Electron qualifier hits
its watchdog at the same stage. Those failure logs do not embed their source
hashes; the tool record captured the unchanged candidate hash before the fix. Starting all eight during asynchronous SOCKS/TLS
setup did not reliably establish six queued requests and was corrected before
using this evidence. A separate initial qualifier setup failure omitted its
privacy lifetime signal; that fixture error was also corrected.

The final focused run passes 125 tests across three suites with native loopback
access in 0.734 seconds. Earlier sandbox runs refused loopback binds with EPERM;
they do not qualify network behavior. The final files include default-compatibility,
cap/framing/truncation, invalid-signal, true-queue, helper-observer and controlled
delayed request/connection/raw/TLS close cases. Lint passes.

The offline [Node report](qualification/wallet-tor-drain-node-2026-10-04.json) and
[Electron main report](qualification/wallet-tor-drain-electron-2026-10-04.json)
each pass 16 cases with 15 local HTTP requests and nine matching source hashes.
Node 24.18.1 completes in 226 ms; Electron 44.4.5 / Node 24.21.0 completes in
252 ms. These are single fixture timings, not performance guarantees. Both
true-queue cases reject eight requests after two connections are occupied and
six more requests are admitted under the agent limit; the cleanup barrier resolves and no further HTTP
request reaches the local server. The report also observes eventual peer socket
closure after awaiting the barrier. The native run infers queuing from the two occupied sockets and the agent limit;
the unit test additionally inspects the actual two-socket/six-request queue.
No live query or real circuit evidence exists.

Eight isolated in-memory mutations produce 12 expected failures: omitting socket
closure (four), connection-continuation drain (one), assigned-request close (one),
the custom body cap (one), strict framing (one), complete-end validation (one),
the helper socket observer (one), and terminal-unassigned request settlement
(two real queue timeouts). The 54-test mock baseline passes; the framing mutation
also leaves its encoding-refusal control passing. The final 125-test run includes
both genuine queue cases. Controls change temporary in-memory source only, and
all repository source/test hashes remain frozen.

The frozen full regression passes 11,710 tests with 33 skipped across 474 passing
suites in 386.298 seconds (native access and the existing OpenLV exclusion).
Claude reviewed production, controls, native evidence and documentation; Codex
provided implementation and independent tests. This is engineering review, not a
security audit. The preceding
Railgun whole-source inventories are historical after this shared transport
change. Main remains `f2274ee6`; no dependency, binary pin, IPC, renderer or
production sender is added. Privileged transport and SOCKS lifecycle ownership
stay in the existing main-process network modules.
