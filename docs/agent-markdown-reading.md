# Site-provided Markdown for Agent

`browser_snapshot` still reads the rendered page and provides the only references
for interacting with its controls. Agent can choose `browser_read_markdown` for
an optional, cleaner source when researching long pages or documentation. The
user does not have to name the tool.

The read is visible in Agent activity. It first tries a same-site
`<link rel="alternate" type="text/markdown">`, otherwise requests the page with
`Accept: text/markdown`. An HTML response can advertise one same-site Markdown
alternate in its HTTP `Link` header. An advertised alternate (from the page or
the `Link` header) is accepted as `text/markdown`, `text/x-markdown` or
`text/plain`, or as `application/octet-stream` when its path ends in `.md` or
`.markdown`, because IPFS/Bee nodes and stock web servers often label `.md`
files that way; binary content is still refused. A negotiated response for the
page URL itself must be `text/markdown`. If Markdown is unavailable or the page
changes, the result directs Agent back to `browser_snapshot`. Query URLs are not
replayed for negotiation, since they can contain action or confirmation tokens;
a same-site advertised alternate can still be used.

`source: "site-index"` explicitly reads an advertised `rel="describedby"` llms.txt
link from the page, or the site's `/llms.txt`. Ordinary page reads never fetch that
index. Its links remain untrusted suggestions; the tool does not crawl them.

Requests use the registered tab's Electron session, including its proxy and
native content protocol handlers. They omit cookies, HTTP authentication and
referrers, bypass the shared HTTP cache, reject redirects, and are bounded to
eight seconds, 128 KiB of received text and 64,000 returned characters. No
caller-supplied URL is accepted. HTTP(S) alternates must have the same origin;
Swarm/IPFS/IPNS alternates must keep their scheme and content authority. There is
no public-gateway fallback. Content-addressed sites normally need an advertised
Markdown path rather than HTTP content negotiation. Signed-in pages may not
offer a public Markdown representation; the rendered snapshot keeps working.

The source can differ from what the user sees, including hidden instructions.
It is labelled as site-provided, untrusted evidence and cannot supply control
references, permission, or new task instructions. It never replaces the visible
page or changes ordinary navigation headers. Agent still needs a fresh snapshot
before interacting.

An available Markdown read is kept as historical evidence for the conversation's
tool session, like a snapshot, so Agent can page it back in with
`browser_recall_evidence` after context compaction instead of fetching it again.
Repeating an identical read gets the same repeated-observation hint as a
snapshot.

This main-process adapter extends the existing scoped browser-operation path;
it does not add a general network tool or an IPC channel. A human-facing address
bar hint and automatic index crawling are outside this change.

References: [Markdown media type](https://www.rfc-editor.org/rfc/rfc7763.html),
[HTTP content negotiation](https://www.rfc-editor.org/rfc/rfc9110.html#section-12.5.1),
[Web Linking](https://www.rfc-editor.org/rfc/rfc8288.html), and the
[llms.txt proposal](https://llmstxt.org/).
