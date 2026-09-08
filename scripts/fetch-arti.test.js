/**
 * Guards for the Arti build script's pinned version and toolchain pre-flight.
 *
 * Arti is compiled from crates.io on the release runners, and `cargo install`
 * only reports a too-old toolchain minutes into the dependency build. The MSRV
 * check exists to turn that into an immediate, actionable failure, so it needs
 * to stay correct across bumps.
 */

const { ARTI_VERSION, MIN_RUST_VERSION, compareVersions, checkRustVersion } = require('./fetch-arti');

describe('fetch-arti version pin', () => {
  test('pins a concrete Arti release', () => {
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

  beforeEach(() => {
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
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
    expect(message).toContain(ARTI_VERSION);
  });

  test('passes through output it cannot parse rather than blocking the build', () => {
    // cargo still enforces the MSRV itself; this check only fails fast.
    expect(checkRustVersion('cargo (nightly, unknown build)')).toBe(true);
  });
});
