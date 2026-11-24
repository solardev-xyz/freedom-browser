/**
 * The pin against the release (freedom-core design 0014, "The protocol"):
 * the version main checks hello against is the release the fetch script
 * pins, so a bump that changes one and not the other fails here. The Colibri
 * release and version number main requires of hello are the pin's, written
 * as a version number should be, the one the fetch contract admits in a
 * prover request, and the one NOTICES names. With the binary, its hello
 * reports them, and the pinned release when it is the downloaded one.
 */

const { PINNED_COLIBRID_VERSION, COLIBRI_VERSION, CLIENT_VERSION } = require('./colibrid-pin');
const { COLIBRI_CLIENT_VERSION } = require('./colibri-fetch-contract');
const { ColibridClient, COLIBRI_VERSION: HELLO_COLIBRI_VERSION } = require('./colibrid-client');
const { makeHop } = require('../core/naming-shell');
const fetcher = require('../../../scripts/fetch-freedom-colibrid');
const { COLIBRID, serviceTest } = require('../../../test/helpers/colibri-service-harness');

jest.mock('../logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

test("main's pinned freedom-colibrid version is the fetch script's pinned release", () => {
  expect(fetcher.PINNED_RELEASE_TAG).toBe(`colibrid-v${PINNED_COLIBRID_VERSION}`);
});

test('hello must name the pinned Colibri and its version number', () => {
  // What colibrid-client.js's validHello requires of `colibri_version`.
  expect(HELLO_COLIBRI_VERSION).toBe(COLIBRI_VERSION);
  const [major, minor, patch] = COLIBRI_VERSION.split('.').map(Number);
  expect(CLIENT_VERSION).toBe((major << 16) | (minor << 8) | patch);
  // The version the fetch contract admits in a prover request's path, and
  // the one validHello requires of `client_version`.
  expect(COLIBRI_CLIENT_VERSION).toBe(CLIENT_VERSION);
});

test("NOTICES names the pinned Colibri as the one freedom-colibrid's C core is", () => {
  const notices = require('node:fs').readFileSync(require.resolve('../../../NOTICES'), 'utf8');
  expect(notices).toContain(`Colibri ${COLIBRI_VERSION}'s C core`);
});

serviceTest(
  "the binary's hello reports the pinned Colibri, and the pinned release when downloaded",
  async () => {
    // Any release (`serviceVersion: null`): a release mismatch shows below,
    // not as a refused handshake.
    const client = new ColibridClient({
      kind: 'private',
      chain: 1,
      command: COLIBRID,
      spawn: require('node:child_process').spawn,
      serviceVersion: null,
      shellVersion: 'test',
      hop: makeHop({ fetch: () => Promise.reject(new Error('no fetch here')) }),
    });
    try {
      const hello = await client.start();
      // validHello already refuses another Colibri or version number; the
      // handshake completing is that check.
      expect(hello).toMatchObject({
        colibri_version: COLIBRI_VERSION,
        client_version: CLIENT_VERSION,
        chain_id: 1,
        network: 'offline',
        build: { prover: false },
      });
      // A binary of the developer's own, or another release, may report any.
      const downloaded =
        !process.env.FREEDOM_COLIBRID_PATH && !process.env.FREEDOM_COLIBRID_RELEASE_TAG;
      if (downloaded) expect(hello.service_version).toBe(PINNED_COLIBRID_VERSION);
    } finally {
      await client.stop();
    }
  },
  30_000
);
