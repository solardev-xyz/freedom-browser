/**
 * Main's Swarm I/O pool (freedom-core design 0015, "Main's Swarm I/O
 * pool"): 64 MiB by default, apart from the chain I/O pool and the Colibri
 * fetch pool; a charge fits whole or not at all; a reservation shrinks,
 * gives back what it is asked to, and closes once; the high-water mark
 * records the most held at once.
 */

const { SWARM_IO_POOL_BYTES, SwarmIoPool, swarmIoPool } = require('./swarm-io-pool');
const { POOL_BYTES } = require('./service-client');
const { COLIBRI_FETCH_POOL_BYTES } = require('../ens/colibri-fetch-pool');

const MIB = 1024 * 1024;

describe("main's Swarm I/O pool", () => {
  test('is 64 MiB, browser-wide, apart from the chain and Colibri pools', () => {
    expect(SWARM_IO_POOL_BYTES).toBe(64 * MIB);
    expect(swarmIoPool.limit).toBe(64 * MIB);
    expect(new SwarmIoPool().limit).toBe(64 * MIB);
    expect([POOL_BYTES, COLIBRI_FETCH_POOL_BYTES]).toEqual([192 * MIB, 128 * MIB]);
    // A 1 MiB `/stamps` call reserves 3.7 MiB (m + 2 × b64(m) + 16 KiB):
    // seventeen fit, the eighteenth doesn't.
    const b64 = (m) => 4 * Math.ceil(m / 3);
    const stamps = MIB + 2 * b64(MIB) + 16 * 1024;
    const pool = new SwarmIoPool();
    const held = Array.from({ length: 17 }, () => pool.reserve(stamps));
    expect(held.every(Boolean)).toBe(true);
    expect(pool.reserve(stamps)).toBeNull();
    expect(pool.held).toBe(17 * stamps);
  });

  test('takes whole or not at all, gives back, and records its high-water mark', () => {
    const pool = new SwarmIoPool(100);
    expect(pool.highWater).toBe(0);
    expect(pool.take(60)).toBe(true);
    expect(pool.take(41)).toBe(false);
    expect([pool.held, pool.highWater]).toEqual([60, 60]);
    expect(pool.take(40)).toBe(true);
    expect([pool.held, pool.highWater]).toEqual([100, 100]);
    pool.release(70);
    expect([pool.held, pool.highWater]).toEqual([30, 100]);
    // Never below nothing; and only byte counts.
    pool.release(1000);
    expect(pool.held).toBe(0);
    for (const odd of [-1, 1.5, NaN, '10', null]) expect(pool.take(odd)).toBe(false);
    pool.release(-5);
    pool.release(1.5);
    expect([pool.held, pool.highWater]).toEqual([0, 100]);
    expect(pool.take(0)).toBe(true);
  });

  test('a reservation shrinks to a length, gives back as asked, and closes once', () => {
    const pool = new SwarmIoPool(100);
    const reservation = pool.reserve(64);
    expect(pool.reserve(37)).toBeNull();
    reservation.shrink(30);
    expect([reservation.held, pool.held]).toEqual([30, 30]);
    // Shrinking to more than it holds takes nothing.
    reservation.shrink(50);
    expect(reservation.held).toBe(30);
    reservation.release(10);
    expect([reservation.held, pool.held]).toEqual([20, 20]);
    // Never more than it holds, nor less than nothing, nor part of a byte.
    reservation.release(-5);
    reservation.release(0.5);
    expect([reservation.held, pool.held]).toEqual([20, 20]);
    reservation.release(1000);
    expect([reservation.held, pool.held]).toEqual([0, 0]);
    reservation.close();
    reservation.close();
    expect(pool.held).toBe(0);
    expect(pool.highWater).toBe(64);
  });

  test("a closed reservation gives back nothing twice, so another's bytes stay held", () => {
    const pool = new SwarmIoPool(100);
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
    expect(() => new SwarmIoPool(-1)).toThrow(TypeError);
    expect(() => new SwarmIoPool(1.5)).toThrow(TypeError);
    const pool = new SwarmIoPool(10);
    expect(() => pool.reserve(1.5)).toThrow(TypeError);
    expect(() => pool.reserve(-1)).toThrow(TypeError);
    expect(pool.reserve(0)).not.toBeNull();
    expect(pool.reserve(11)).toBeNull();
  });
});
