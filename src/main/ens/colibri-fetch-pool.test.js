/**
 * Main's Colibri fetch pool (design 0014, "Bodies", "Budgets"): 128 MiB by
 * default; a reservation fits whole or not at all; it shrinks, gives back
 * what it is asked to, and closes once, never giving back more than it
 * holds.
 */

const {
  COLIBRI_FETCH_POOL_BYTES,
  ColibriFetchPool,
  colibriFetchPool,
} = require('./colibri-fetch-pool');

const MIB = 1024 * 1024;

describe("main's Colibri fetch pool", () => {
  test('is 128 MiB, browser-wide: eight bodies of 16 MiB', () => {
    expect(COLIBRI_FETCH_POOL_BYTES).toBe(128 * MIB);
    expect(colibriFetchPool.limit).toBe(128 * MIB);
    const pool = new ColibriFetchPool();
    const held = Array.from({ length: 8 }, () => pool.reserve(16 * MIB));
    expect(held.every(Boolean)).toBe(true);
    expect(pool.held).toBe(128 * MIB);
    expect(pool.reserve(1)).toBeNull();
    held[0].close();
    expect(pool.reserve(16 * MIB)).not.toBeNull();
  });

  test("a reservation that doesn't fit reserves nothing", () => {
    const pool = new ColibriFetchPool(100);
    const first = pool.reserve(60);
    expect(pool.reserve(41)).toBeNull();
    expect(pool.held).toBe(60);
    expect(pool.reserve(40)).not.toBeNull();
    expect(pool.held).toBe(100);
    first.close();
    expect(pool.held).toBe(40);
  });

  test('shrinks to a length, gives back as asked, and closes once', () => {
    const pool = new ColibriFetchPool(100);
    const reservation = pool.reserve(64);
    reservation.shrink(30);
    expect(reservation.held).toBe(30);
    expect(pool.held).toBe(30);
    // Shrinking to more than it holds takes nothing.
    reservation.shrink(50);
    expect(reservation.held).toBe(30);
    reservation.release(10);
    expect([reservation.held, pool.held]).toEqual([20, 20]);
    // Never more than it holds, nor less than nothing.
    reservation.release(-5);
    reservation.release(1000);
    expect([reservation.held, pool.held]).toEqual([0, 0]);
    reservation.close();
    reservation.close();
    expect(pool.held).toBe(0);
  });

  test('a closed reservation gives back nothing twice', () => {
    const pool = new ColibriFetchPool(100);
    const a = pool.reserve(50);
    const b = pool.reserve(50);
    a.close();
    a.release(50);
    a.shrink(0);
    expect(pool.held).toBe(50);
    b.close();
    expect(pool.held).toBe(0);
  });

  test('takes byte counts only', () => {
    expect(() => new ColibriFetchPool(-1)).toThrow(TypeError);
    const pool = new ColibriFetchPool(10);
    expect(() => pool.reserve(1.5)).toThrow(TypeError);
    expect(() => pool.reserve(-1)).toThrow(TypeError);
    expect(pool.reserve(0)).not.toBeNull();
  });
});
