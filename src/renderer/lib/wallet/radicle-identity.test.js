// The Radicle card's DID (plan B10; freedom-core design 0008, Main's side,
// deviation `locked-did`): on the add-on the status's DID as before; on the
// freedom-radicled service the running node's, a throwaway key's marked,
// and the next start's apart.

const DERIVED = 'did:key:z6MkderivedIdentityFromTheVault0123456789';
const THROWAWAY = 'did:key:z6MkthrowawayKeyOfThisGeneration987654321';
const KEY_FILE = 'did:key:z6MkfromAnOldKeyFileThatMainMustNotRead00';

describe('describeRadicleIdentity', () => {
  let mod;
  beforeAll(async () => {
    mod = await import('./radicle-identity.js');
  });

  const short = (did) => {
    const key = did.replace('did:key:', '');
    return `${key.slice(0, 8)}…${key.slice(-6)}`;
  };

  test("the add-on: the status's DID, as before, and no next-start row", () => {
    expect(mod.describeRadicleIdentity({ addresses: { radicleDid: KEY_FILE } })).toEqual({
      did: KEY_FILE,
      text: short(KEY_FILE),
      title: KEY_FILE,
      next: null,
    });
    expect(mod.describeRadicleIdentity({ addresses: null })).toEqual({
      did: null,
      text: '--',
      title: '',
      next: null,
    });
  });

  test("the service, a node with the derived key: its DID, and no next-start row when it's the same", () => {
    const status = {
      addresses: { radicleDid: DERIVED },
      radicle: { active: { did: DERIVED, ephemeral: false }, nextDid: DERIVED },
    };
    expect(mod.describeRadicleIdentity(status)).toEqual({
      did: DERIVED,
      text: short(DERIVED),
      title: DERIVED,
      next: null,
    });
  });

  test("the service, a throwaway node after a vault was created: its own DID, marked, and the derived one only as the next start's", () => {
    const status = {
      addresses: { radicleDid: THROWAWAY },
      radicle: { active: { did: THROWAWAY, ephemeral: true }, nextDid: DERIVED },
    };
    const view = mod.describeRadicleIdentity(status);
    expect(view.did).toBe(THROWAWAY);
    expect(view.text).toBe(`${short(THROWAWAY)} (${mod.RADICLE_THROWAWAY_LABEL})`);
    expect(view.title).toBe(`${THROWAWAY}\n${mod.RADICLE_THROWAWAY_TITLE}`);
    expect(view.next).toEqual({
      did: DERIVED,
      text: short(DERIVED),
      title: `${DERIVED}\n${mod.RADICLE_NEXT_TITLE}`,
    });
  });

  test('the service, a derived node after the vault was deleted: its DID, and no next start known', () => {
    const status = {
      addresses: null,
      radicle: { active: { did: DERIVED, ephemeral: false }, nextDid: null },
    };
    expect(mod.describeRadicleIdentity(status)).toMatchObject({
      did: DERIVED,
      text: short(DERIVED),
      next: null,
    });
  });

  test("the service, no node running: no DID, whatever addresses says; the next start's alone while unlocked", () => {
    // Locked (deviation locked-did): no Radicle DID shows at all.
    expect(
      mod.describeRadicleIdentity({
        addresses: { radicleDid: null },
        radicle: { active: null, nextDid: null },
      })
    ).toEqual({ did: null, text: '--', title: mod.RADICLE_NOT_RUNNING_TITLE, next: null });
    // A status from an older main, with a DID in addresses, still shows none
    // for the node: only the generation's counts on the service.
    expect(
      mod.describeRadicleIdentity({
        addresses: { radicleDid: KEY_FILE },
        radicle: { active: null, nextDid: DERIVED },
      })
    ).toEqual({
      did: null,
      text: '--',
      title: mod.RADICLE_NOT_RUNNING_TITLE,
      next: { did: DERIVED, text: short(DERIVED), title: `${DERIVED}\n${mod.RADICLE_NEXT_TITLE}` },
    });
  });
});
