# Dependency Updates Playbook

Use this playbook for any dependency update: "update all dependencies", an
Electron bump, a refresh outside the release cycle. The triage rules
(in-range vs out-of-range, native-module checks, audit handling) live in
[`release-process.md` § 2](release-process.md#2-refresh-dependencies); this
file covers scope, the pitfalls a refresh has hit, and the pull request
format. [#830](https://github.com/solardev-xyz/freedom-browser/pull/830) is
the worked example.

## Scope

An update covers all three, not only npm:

- **npm packages**: `npm outdated`, triaged per `release-process.md` § 2.
- **Bundled node binaries**: Ant, freedom-ipfs, libradicle, Arti and Myotis.
  Compare each pin with its latest upstream release and bump the stale ones
  per [`bundled-binaries.md`](bundled-binaries.md). Myotis publishes only
  pre-releases; take the newest non-`rc` tag.
- **Pinned upstream data that tracks a package**: an `@ghostery/adblocker`
  bump re-pins the uBlock scriptlets in `scripts/fetch-adblock-lists.js`
  (`fetch-adblock-lists.test.js` fails until it does), including the GPL-3.0
  source re-derivation its comment block describes.

## Pitfalls

- **Exact pins are held back, not refreshed.** `@earendil-works/pi-coding-agent`,
  `@phala/dcap-qvl` and `pdfjs-dist` are pinned exactly because each is
  qualified or approved at that version. List them in the "held back" table
  with their latest version and whether an advisory affects the pin; bump one
  only on request, in its own change.
- **An exact pin does not freeze its siblings.** Pi 1.0.2 declares its own
  `@earendil-works/*` packages as `^1.0.2`, so a plain `npm update` moves them
  to the newest 1.x underneath a 1.0.2 agent. Pass `npm update` the package
  names to update with the pinned family left out, and confirm the lockfile
  diff has no `@earendil-works/` version change.
- **A transitive advisory under an exact pin takes an override.** When the
  pinned package itself pins the vulnerable version (Pi pins `undici`
  exactly), upgrading the parent does not help; add an `overrides` entry
  scoped to that parent, within the same major.
- **Resolve with the npm CI uses** (Node 24, npm 11.19), as `release-process.md`
  § 2 explains (`nvm install 24` if the host's differs).
- **npm rewrites `package.json`.** `npm install` reflows short arrays such as
  `build.*.extraResources[].filter`. Check `git diff package.json` and keep
  only the version lines you meant to change.
- **An Electron major needs a runtime pass, not just a rebuild.** Experimental
  Chromium APIs move between majors: Electron 45 changed WebMCP's
  `executeTool()` input from JSON text to an object, which only the harness
  e2e specs caught. Run the full harness suite, and re-run any failure on the
  previous Electron before calling it a regression; several specs depend on
  the host (downloaded node binaries, the Linux workspace owner helper).

## Commits

One commit per kind of change, so each can be reverted alone:

1. `chore(deps): refresh in-range bumps, …`: the in-range npm refresh.
2. `build(electron): upgrade Electron to <version>`: an Electron major, with
   any code it forces.
3. One commit per bundled binary, in that binary's own commit style.
4. `fix(deps): …`: overrides for transitive advisories.

Each carries its changelog fragment per
[`changelog-process.md`](changelog-process.md).

## Pull request format

Open the description with version tables, before any prose:

```markdown
| npm package | Before | After  |
| ----------- | ------ | ------ |
| electron    | 44.7.0 | 45.0.0 |

| Bundled      | Before  | After              |
| ------------ | ------- | ------------------ |
| Ant          | v0.5.71 | v0.5.76            |
| freedom-ipfs | v0.4.6  | unchanged (latest) |
```

- The npm table lists every direct dependency that moved, plus any transitive
  one moved by an override.
- The bundled table lists **every** bundled binary, unchanged ones included,
  so a reader sees each was checked.
- Under the tables: the Electron Chromium/Node versions, the held-back exact
  pins (current, latest, advisory at the pin), then one paragraph per commit,
  the `npm audit` count before and after with what remains, and a Testing
  section that names what was **not** run (other platforms, packaged smoke,
  screenshots).

Show the same tables when reporting the update to the user.
