/**
 * Guards for the Arti build script's pinned version and toolchain pre-flight.
 *
 * Arti is compiled from crates.io on the release runners, and `cargo install`
 * only reports a too-old toolchain minutes into the dependency build. The MSRV
 * check exists to turn that into an immediate, actionable failure, so it needs
 * to stay correct across bumps.
 */

const {
  ARTI_VERSION,
  PINNED_ARTI_VERSION,
  MIN_RUST_VERSION,
  compareVersions,
  checkRustVersion,
} = require('./fetch-arti');

describe('fetch-arti version pin', () => {
  test('pins a concrete Arti release', () => {
    expect(PINNED_ARTI_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(ARTI_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test('declares the pinned release MSRV', () => {
    expect(MIN_RUST_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe('compareVersions', () => {
  test('orders by numeric component, not lexicographically', () => {
    expect(compareVersions('1.9.0', '1.91.0')).toBeLessThan(0);
    expect(compareVersions('1.91.0', '1.9.0')).toBeGreaterThan(0);
    expect(compareVersions('1.91.0', '1.91.0')).toBe(0);
    expect(compareVersions('2.0.0', '1.99.99')).toBeGreaterThan(0);
  });

  test('treats a missing component as zero', () => {
    expect(compareVersions('1.91', '1.91.0')).toBe(0);
    expect(compareVersions('1.91', '1.91.1')).toBeLessThan(0);
  });
});

describe('checkRustVersion', () => {
  let errorSpy;
  let warnSpy;

  beforeEach(() => {
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
    warnSpy.mockRestore();
  });

  test('accepts a toolchain at the MSRV', () => {
    expect(checkRustVersion(`cargo ${MIN_RUST_VERSION} (f2d3ce0bd 2026-03-21)`)).toBe(true);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  test('accepts a newer toolchain', () => {
    expect(checkRustVersion('cargo 1.95.0 (f2d3ce0bd 2026-03-21)')).toBe(true);
  });

  test('rejects a toolchain below the MSRV and names both versions', () => {
    expect(checkRustVersion('cargo 1.89.0 (abcdef012 2025-08-01)')).toBe(false);
    const message = errorSpy.mock.calls.flat().join('\n');
    expect(message).toContain('1.89.0');
    expect(message).toContain(MIN_RUST_VERSION);
    expect(message).toContain(PINNED_ARTI_VERSION);
  });

  // MIN_RUST_VERSION is the *pinned* release's MSRV. An ARTI_VERSION override
  // (the documented local-testing escape hatch, e.g. falling back to a 1.x
  // line) has its own, older MSRV, so an old toolchain must not block it.
  test('warns instead of blocking when ARTI_VERSION overrides the pin', () => {
    expect(checkRustVersion('cargo 1.89.0 (abcdef012 2025-08-01)', '1.4.6')).toBe(true);
    expect(errorSpy).not.toHaveBeenCalled();
    const message = warnSpy.mock.calls.flat().join('\n');
    expect(message).toContain('1.89.0');
    expect(message).toContain(MIN_RUST_VERSION);
    expect(message).toContain('1.4.6');
  });

  test('still blocks a too-old toolchain when the override equals the pin', () => {
    expect(checkRustVersion('cargo 1.89.0 (abcdef012 2025-08-01)', PINNED_ARTI_VERSION)).toBe(
      false
    );
    expect(warnSpy).not.toHaveBeenCalled();
  });

  test('passes through output it cannot parse rather than blocking the build', () => {
    // cargo still enforces the MSRV itself; this check only fails fast.
    expect(checkRustVersion('cargo (nightly, unknown build)')).toBe(true);
  });
});
