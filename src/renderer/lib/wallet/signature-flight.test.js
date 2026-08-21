/**
 * The approval-surface ownership lock, and the hideAllSubscreens()
 * backstop that enforces it.
 *
 * Every approval surface (dapp-tx, dapp-sign, dapp-connect, x402, swarm,
 * vault-unlock) shares one sidebar and takes it over by calling
 * hideAllSubscreens(). A per-module "signature in flight" flag therefore
 * only protects a module from itself — the cross-surface case is what
 * these tests pin down.
 */

async function load() {
  jest.resetModules();
  const flight = await import('./signature-flight.js');
  const state = await import('./wallet-state.js');
  return { flight, state };
}

describe('signature-flight lock', () => {
  test('hideAllSubscreens runs every hider when no signature is in flight', async () => {
    const { state } = await load();
    const hider = jest.fn();
    state.registerScreenHider(hider);

    state.hideAllSubscreens();

    expect(hider).toHaveBeenCalledTimes(1);
  });

  test('hideAllSubscreens refuses — and hides nothing — while a signature is in flight', async () => {
    const { flight, state } = await load();
    const hider = jest.fn();
    state.registerScreenHider(hider);
    const request = { id: 'ledger-tx' };

    flight.beginSignatureFlight(request);

    expect(() => state.hideAllSubscreens()).toThrow(/already in progress/);
    // The screen the device prompt belongs to is still standing: no hider
    // ran, so nothing was torn down or re-enabled underneath it.
    expect(hider).not.toHaveBeenCalled();
  });

  test('the refusal carries the standard "already pending" JSON-RPC code', async () => {
    const { flight, state } = await load();
    flight.beginSignatureFlight({});

    expect(() => state.hideAllSubscreens()).toThrow(
      expect.objectContaining({ code: -32002 })
    );
    expect(flight.signatureInFlightError().code).toBe(-32002);
    expect(() => flight.assertNoSignatureInFlight()).toThrow(
      expect.objectContaining({ code: -32002 })
    );
  });

  test('the lock is released only by the request that took it', async () => {
    const { flight, state } = await load();
    const hider = jest.fn();
    state.registerScreenHider(hider);
    const request = { id: 'a' };

    flight.beginSignatureFlight(request);
    // A superseded request settling late must not hand the sidebar away
    // from the confirmation that currently owns it.
    flight.endSignatureFlight({ id: 'b' });
    expect(flight.isSignatureInFlight()).toBe(true);
    expect(() => state.hideAllSubscreens()).toThrow();

    flight.endSignatureFlight(request);
    expect(flight.isSignatureInFlight()).toBe(false);
    state.hideAllSubscreens();
    expect(hider).toHaveBeenCalledTimes(1);
  });

  // The sidebar's close button, the toolbar toggle and the tab bar are not
  // approval surfaces — they sit in the chrome above whichever screen is up
  // — so they subscribe here to go visibly dead for the flight.
  test('ownership changes are broadcast to chrome subscribers', async () => {
    const { flight } = await load();
    const seen = [];
    const unsubscribe = flight.onSignatureFlightChange((inFlight) => seen.push(inFlight));
    const request = { id: 'a' };

    flight.beginSignatureFlight(request);
    // A superseded release does not flip the state, so it does not notify.
    flight.endSignatureFlight({ id: 'b' });
    flight.endSignatureFlight(request);

    expect(seen).toEqual([true, false]);

    unsubscribe();
    flight.beginSignatureFlight(request);
    expect(seen).toEqual([true, false]);
  });

  test('a screen that takes the sidebar over directly refuses while in flight', async () => {
    const { flight } = await load();
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    expect(flight.refuseSubscreenWhileInFlight('Receive screen')).toBe(false);

    flight.beginSignatureFlight({});
    expect(flight.refuseSubscreenWhileInFlight('Receive screen')).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Receive screen'));

    warn.mockRestore();
  });
});
