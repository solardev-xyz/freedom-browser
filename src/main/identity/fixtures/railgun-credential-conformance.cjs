/** Repo-only contract checker. The adopting test host supplies genuine contexts.
 * No seed, mnemonic accessor, derivation primitive or runtime credential export.
 */
"use strict";
const assert = require("assert/strict");
const { types } = require("util");
const PURPOSES = Object.freeze([
  "spending-public",
  "spending-sign",
  "viewing",
  "storage-root",
]);
const then = Promise.prototype.then;
const observe = (promise, fulfilled, rejected) => {
  assert.ok(types.isPromise(promise), "Original native promise required");
  return Reflect.apply(then, promise, [fulfilled, rejected]);
};
async function checkCredentialRow({ host, row, createContext }) {
  const results = [];
  for (const purpose of PURPOSES) {
    const context = createContext(row, purpose);
    const { request } = context;
    assert.equal(request.accountIndex, row.accountIndex);
    assert.equal(request.purpose, purpose);
    assert.equal(host.currentSession(), request.vaultSession);
    let release,
      began,
      borrowed,
      finished = false,
      calls = 0,
      work;
    const original = new Promise((resolve) => {
      release = resolve;
    });
    // Consumers must preserve the original, not invoke its caller-owned method.
    Object.defineProperty(original, "then", {
      value() {
        throw Error("Own then must not run");
      },
    });
    const started = new Promise((resolve) => {
      began = resolve;
    });
    try {
      work = host.withMaterial(request, (loan) => {
        assert.equal(++calls, 1, "Exactly one credential callback");
        assert.deepEqual(
          Object.keys(loan).sort(),
          purpose === "storage-root" ? ["bytes", "profileGuard"] : ["bytes"],
        );
        assert.equal(Object.isFrozen(loan), true);
        borrowed = loan.bytes;
        assert.ok(borrowed instanceof Uint8Array && !types.isProxy(borrowed));
        assert.equal(borrowed.byteOffset, 0);
        assert.equal(borrowed.byteLength, 32);
        assert.equal(borrowed.buffer.byteLength, 32);
        assert.ok(borrowed.buffer instanceof ArrayBuffer);
        const expected =
          purpose === "viewing"
            ? row.viewingHex
            : purpose === "storage-root"
              ? row.storageRootHex
              : row.spendingHex;
        assert.equal(
          Buffer.from(borrowed).toString("hex"),
          expected,
          "Credential vector mismatch",
        );
        if (purpose === "storage-root")
          context.assertProfileGuard(loan.profileGuard);
        began();
        return original;
      });
      const settled = observe(
        work,
        (value) => {
          finished = true;
          return value;
        },
        (error) => {
          finished = true;
          throw error;
        },
      );
      // If admission fails before the callback, propagate that original refusal.
      await Promise.race([
        started,
        observe(settled, () => {
          throw Error("Host settled without a live loan");
        }),
      ]);
      await Promise.resolve();
      assert.equal(
        finished,
        false,
        "Host released the original callback early",
      );
      assert.ok(
        borrowed.some((byte) => byte !== 0),
        "Loan wiped before original settlement",
      );
      release();
      assert.equal(await settled, undefined);
      assert.equal(calls, 1);
      assert.ok(
        borrowed.every((byte) => byte === 0),
        "Borrowed credential was not wiped",
      );
      results.push(
        Object.freeze({
          purpose,
          vectorMatched: true,
          originalPromiseRetained: true,
          borrowedBufferWiped: true,
        }),
      );
    } finally {
      release();
      try {
        if (work)
          await observe(
            work,
            () => undefined,
            () => undefined,
          );
      } finally {
        context.close();
      }
    }
  }
  return Object.freeze(results);
}
module.exports = Object.freeze({ PURPOSES, checkCredentialRow });
