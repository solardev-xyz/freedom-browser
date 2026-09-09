const loadModule = async (navState) => {
  jest.resetModules();
  jest.doMock('./tabs.js', () => ({
    getActiveTabState: jest.fn(() => navState),
  }));
  return import('./address-bar-edit.js');
};

describe('address-bar-edit (Chrome "user input in progress")', () => {
  afterEach(() => {
    jest.resetModules();
  });

  test('tracks and clears an uncommitted edit on the active tab', async () => {
    const navState = { addressBarPendingInput: null, addressBarPendingSelection: null };
    const mod = await loadModule(navState);

    expect(mod.isAddressBarEditInProgress()).toBe(false);
    expect(mod.getAddressBarEdit()).toBeNull();

    mod.setAddressBarEdit('half-typed', { start: 3, end: 3, direction: 'none' });
    expect(mod.isAddressBarEditInProgress()).toBe(true);
    expect(mod.getAddressBarEdit()).toBe('half-typed');
    expect(navState.addressBarPendingSelection).toEqual({ start: 3, end: 3, direction: 'none' });

    // An emptied bar is still an edit in progress — Chrome doesn't repaint a
    // bar the user deliberately cleared.
    mod.setAddressBarEdit('');
    expect(mod.isAddressBarEditInProgress()).toBe(true);
    expect(mod.getAddressBarEdit()).toBe('');

    mod.clearAddressBarEdit();
    expect(mod.isAddressBarEditInProgress()).toBe(false);
    expect(navState.addressBarPendingInput).toBeNull();
    expect(navState.addressBarPendingSelection).toBeNull();
  });

  test('writes to an explicitly passed tab state, not just the active one', async () => {
    const activeState = { addressBarPendingInput: null };
    const otherState = { addressBarPendingInput: null };
    const mod = await loadModule(activeState);

    mod.setAddressBarEdit('draft for the other tab', null, otherState);

    expect(otherState.addressBarPendingInput).toBe('draft for the other tab');
    expect(activeState.addressBarPendingInput).toBeNull();
    expect(mod.isAddressBarEditInProgress(otherState)).toBe(true);
    expect(mod.isAddressBarEditInProgress()).toBe(false);
  });

  test('is a no-op when there is no active tab state', async () => {
    const mod = await loadModule(null);

    expect(() => mod.setAddressBarEdit('x')).not.toThrow();
    expect(() => mod.clearAddressBarEdit()).not.toThrow();
    expect(mod.isAddressBarEditInProgress()).toBe(false);
  });

  test('captures and re-applies an input selection', async () => {
    const mod = await loadModule({});

    expect(mod.captureInputSelection(null)).toBeNull();
    expect(mod.captureInputSelection({})).toBeNull();
    expect(
      mod.captureInputSelection({ selectionStart: 2, selectionEnd: 5, selectionDirection: 'forward' })
    ).toEqual({ start: 2, end: 5, direction: 'forward' });

    const setSelectionRange = jest.fn();
    mod.applyInputSelection({ setSelectionRange }, { start: 2, end: 5, direction: 'forward' });
    expect(setSelectionRange).toHaveBeenCalledWith(2, 5, 'forward');

    // Inputs that reject selection ranges must not break the restore path.
    const throwing = {
      setSelectionRange: jest.fn(() => {
        throw new Error('not supported');
      }),
    };
    expect(() => mod.applyInputSelection(throwing, { start: 0, end: 1 })).not.toThrow();
    expect(() => mod.applyInputSelection({}, { start: 0, end: 1 })).not.toThrow();
  });
});
